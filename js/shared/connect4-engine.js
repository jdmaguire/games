(() => {
  "use strict";

  // Connect Four rules + negamax engine, shared two ways (the same pattern as
  // js/shared/checkers-engine.js):
  //   - as a classic <script> on the page → exposes window.Connect4Engine
  //     (landingRow/winLine for gameplay, aiPickMove as a file:// fallback)
  //   - as a Web Worker (new Worker("js/shared/connect4-engine.js")) → onmessage
  //     runs aiPickMove off the main thread, so the highest levels never jank.
  // The transposition table lives here too, so the live-eval search warms the
  // cache the AI's own move search reuses — no wasted re-searching.

  // Cell codes: 1 red, -1 yellow, 0 empty. board[0] is the TOP row; a dropped
  // disc lands on the highest-indexed empty row of its column. Red moves first.
  const RED = 1, YEL = -1;
  const ROWS = 6, COLS = 7;
  const ORDER = [3, 2, 4, 1, 5, 0, 6]; // centre columns first — sharper alpha-beta cuts

  // Strength levels: search depth + time budget + score noise. `random` is the
  // chance of just playing any legal move — how the lowest levels stay genuinely
  // beatable for young kids, and it fades out gradually so the early levels step
  // up in small pieces. High levels are time-capped, not depth-capped: iterative
  // deepening just plays the deepest ply it finished inside the budget.
  const LEVELS = [
    { label: "1 — first games, great for kids", depth: 1, ms: 60, noise: 240, random: 0.90 },
    { label: "2 — still learning", depth: 2,  ms: 80,   noise: 160, random: 0.70 },
    { label: "3 — beginner",  depth: 2,  ms: 90,   noise: 80,  random: 0.45 },
    { label: "4 — easy",      depth: 3,  ms: 110,  noise: 60,  random: 0.28 },
    { label: "5 — learner",   depth: 4,  ms: 130,  noise: 40,  random: 0.15 },
    { label: "6 — casual",    depth: 5,  ms: 200,  noise: 30,  random: 0.07 },
    { label: "7 — steady",    depth: 6,  ms: 250,  noise: 20,  random: 0 },
    { label: "8 — tricky",    depth: 8,  ms: 350,  noise: 12,  random: 0 },
    { label: "9 — clever",    depth: 10, ms: 500,  noise: 6,   random: 0 },
    { label: "10 — sharp",    depth: 12, ms: 700,  noise: 3,   random: 0 },
    { label: "11 — expert",   depth: 14, ms: 1000, noise: 1,   random: 0 },
    { label: "12 — master",   depth: 17, ms: 1400, noise: 0,   random: 0 },
    { label: "13 — grandmaster", depth: 21, ms: 2000, noise: 0, random: 0 },
    { label: "14 — ruthless", depth: 26, ms: 2800, noise: 0,   random: 0 },
    { label: "15 — merciless", depth: 32, ms: 3500, noise: 0,  random: 0 },
    { label: "16 — good luck!", depth: 42, ms: 4500, noise: 0, random: 0 }, // 42 = every square: perfect play if it ever finishes
  ];

  // ---------- Rules ----------
  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  function landingRow(bd, col) {
    for (let r = ROWS - 1; r >= 0; r--) if (bd[r][col] === 0) return r;
    return -1; // column full
  }

  function genMoves(bd) {
    const out = [];
    for (const c of ORDER) if (bd[0][c] === 0) out.push(c);
    return out;
  }

  function applyMove(bd, col, side) {
    const r = landingRow(bd, col);
    bd[r][col] = side;
    return r;
  }

  function undoMove(bd, col, row) { bd[row][col] = 0; }

  // Allocation-free check used in the hot search path
  function isWinAt(bd, r, c) {
    const side = bd[r][c];
    for (const [dr, dc] of DIRS) {
      let n = 1;
      for (const s of [1, -1]) {
        let rr = r + dr * s, cc = c + dc * s;
        while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && bd[rr][cc] === side) { n++; rr += dr * s; cc += dc * s; }
      }
      if (n >= 4) return true;
    }
    return false;
  }

  // Same test, but returns the winning cells so the UI can spotlight them
  function winLine(bd, r, c) {
    const side = bd[r][c];
    if (side === 0) return null;
    for (const [dr, dc] of DIRS) {
      const line = [[r, c]];
      for (const s of [1, -1]) {
        let rr = r + dr * s, cc = c + dc * s;
        while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && bd[rr][cc] === side) { line.push([rr, cc]); rr += dr * s; cc += dc * s; }
      }
      if (line.length >= 4) return line;
    }
    return null;
  }

  // Every 4-cell window that only one side occupies is scored: a three with a
  // gap is a live threat, a two is a lean; mixed windows are dead. Plus a small
  // bonus for owning the centre column, which crosses the most windows.
  function evaluate(bd) {
    let score = 0;
    for (let r = 0; r < ROWS; r++) score += bd[r][3] * 5;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        for (const [dr, dc] of DIRS) {
          const r3 = r + 3 * dr, c3 = c + 3 * dc;
          if (r3 < 0 || r3 >= ROWS || c3 < 0 || c3 >= COLS) continue;
          let sum = 0, count = 0;
          for (let i = 0; i < 4; i++) {
            const v = bd[r + i * dr][c + i * dc];
            sum += v;
            if (v !== 0) count++;
          }
          if (Math.abs(sum) !== count) continue; // both sides present — dead window
          if (count === 3) score += sum > 0 ? 50 : -50;
          else if (count === 2) score += sum > 0 ? 10 : -10;
          else if (count === 1) score += sum;
        }
      }
    }
    return score; // positive = good for red
  }

  // ---------- Engine: negamax + alpha-beta + iterative deepening ----------
  // A transposition table (Zobrist hash → best score/move, with EXACT/LOWER/UPPER
  // bounds) memoizes every position reached, so deeper iterative-deepening plies
  // reuse shallower searches, transposed move orders share work, and the live
  // eval warms the table for the AI's very next move.
  const TIMEOUT = Symbol("timeout");
  let deadline = 0;

  const TT = new Map();
  const TT_LIMIT = 200000; // clear when full — a long session must not grow forever
  // Two independent 32-bit tables make a 64-bit Zobrist key; the Map is keyed on
  // `lo` and the `hi` half is verified on hit, so a `lo` collision is just a miss
  // — never a wrong move.
  const zTable = (seed) => {
    const t = new Int32Array(ROWS * COLS * 3); // [cell × piece value+1]
    let s = seed; // deterministic LCG, so results are reproducible
    for (let i = 0; i < t.length; i++) t[i] = s = (Math.imul(s, 1103515245) + 12345) | 0;
    return t;
  };
  const ZLO = zTable(0x9E3779B9);
  const ZHI = zTable(0x1F2E3D4C);

  function zobrist(bd) {
    let lo = 0, hi = 0;
    for (let r = 0; r < ROWS; r++) {
      const row = bd[r];
      for (let c = 0; c < COLS; c++) {
        const v = row[c];
        if (v !== 0) {
          const i = (r * COLS + c) * 3 + (v + 1);
          lo ^= ZLO[i];
          hi ^= ZHI[i];
        }
      }
    }
    return { lo, hi };
  }

  function negamax(bd, side, depth, alpha, beta) {
    if (performance.now() > deadline) throw TIMEOUT;
    const moves = genMoves(bd);
    if (moves.length === 0) return 0; // board full = draw
    // Any immediate win ends the node (and keeps the search out of finished
    // positions); the depth bonus prefers quicker wins.
    for (const c of moves) {
      const r = applyMove(bd, c, side);
      const win = isWinAt(bd, r, c);
      undoMove(bd, c, r);
      if (win) return 50000 + depth;
    }
    if (depth <= 0) return side * evaluate(bd);

    const key = zobrist(bd);
    const ent = TT.get(key.lo);
    if (ent && ent.hi === key.hi && ent.side === side && ent.depth >= depth) {
      // Win/loss scores encode distance-to-mate as remaining depth, so an entry
      // written at a deeper search must be re-based to this node's depth —
      // otherwise "loses in 2" and "loses in 4" stop being distinguishable.
      let s = ent.score;
      if (s > 40000) s -= ent.depth - depth;
      else if (s < -40000) s += ent.depth - depth;
      if (ent.flag === 0) return s;                          // EXACT
      if (ent.flag === 1 && s >= beta) return s;             // LOWER bound
      if (ent.flag === 2 && s <= alpha) return s;            // UPPER bound
    }

    // Try the previously-best column first — cheap ordering that sharpens alpha-beta
    let order = moves;
    if (ent && typeof ent.move === "number") {
      const i = moves.indexOf(ent.move);
      if (i > 0) {
        order = moves.slice();
        order.splice(i, 1);
        order.unshift(ent.move);
      }
    }

    const a0 = alpha;
    let best = -Infinity;
    let bestMove = null;
    for (const c of order) {
      const r = applyMove(bd, c, side);
      const v = -negamax(bd, -side, depth - 1, -beta, -alpha);
      undoMove(bd, c, r);
      if (v > best) { best = v; bestMove = c; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    const flag = best <= a0 ? 2 : best >= beta ? 1 : 0; // UPPER / LOWER / EXACT
    if (TT.size > TT_LIMIT) TT.clear();
    TT.set(key.lo, { hi: key.hi, side, depth, score: best, flag, move: bestMove });
    return best;
  }

  // Search on a private copy: a TIMEOUT thrown mid-search skips undoMove calls,
  // which would leave phantom discs applied to the caller's board.
  function aiPickMove(bd0, side, level, ms) {
    const bd = bd0.map((row) => row.slice());
    const lvl = LEVELS[level];
    deadline = performance.now() + (ms || lvl.ms);
    const cols = genMoves(bd);
    if (cols.length === 0) return null;
    const finish = (col, score) => ({ col, row: landingRow(bd0, col), score });
    if (cols.length === 1) return finish(cols[0], side * evaluate(bd));
    // Lowest levels mostly just play something legal, like a young kid would
    if (Math.random() < (lvl.random || 0)) {
      return finish(cols[Math.floor(Math.random() * cols.length)], side * evaluate(bd));
    }
    let scored = cols.map((col) => ({ col, score: 0 }));
    for (let d = 2; d <= lvl.depth; d++) {
      const prev = scored.map((e) => ({ col: e.col, score: e.score }));
      try {
        let a = -Infinity;
        for (const e of scored) {
          const r = applyMove(bd, e.col, side);
          // A move that wins right now outranks any deeper find
          e.score = isWinAt(bd, r, e.col) ? 1000000 : -negamax(bd, -side, d - 1, -Infinity, -a);
          undoMove(bd, e.col, r);
          if (e.score > a) a = e.score;
        }
        scored.sort((x, y) => y.score - x.score); // better ordering for the next depth
      } catch (err) {
        if (err !== TIMEOUT) throw err;
        scored = prev; // discard the partially-scored depth
        break;
      }
      if (performance.now() > deadline) break;
      if (scored[0].score >= 50000) break; // forced win found — deeper adds nothing
    }
    scored.sort((x, y) => y.score - x.score);
    // Noise never blurs a forced result: win/loss scores differ by only 2 per
    // ply, so any margin would lump "lose now" in with "lose in four" and the
    // AI would stop blocking once it saw it was lost either way. Decisive
    // scores pick strictly best — quickest win, longest defence.
    const margin = Math.abs(scored[0].score) >= 40000 ? 0 : (lvl.noise || 0) * 3;
    const candidates = scored.filter((e) => e.score >= scored[0].score - margin);
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return finish(pick.col, scored[0].score);
  }

  const api = { RED, YEL, ROWS, COLS, LEVELS, genMoves, landingRow, applyMove, undoMove, isWinAt, winLine, aiPickMove };

  if (typeof window === "undefined") {
    // Worker context: answer { id, board, side, level, ms } → { id, move }.
    // `ms` overrides the LEVELS budget (the live eval uses a short one so it
    // never delays the AI's real move request queued behind it).
    self.onmessage = (e) => {
      const { id, board, side, level, ms } = e.data;
      let move = null;
      try { move = aiPickMove(board, side, level, ms); }
      catch (err) { move = null; }
      self.postMessage({ id, move });
    };
  } else {
    window.Connect4Engine = api;
  }
})();
