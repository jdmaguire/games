(() => {
  "use strict";

  // Checkers rules + negamax engine, shared two ways:
  //   - as a classic <script> on the page → exposes window.CheckersEngine
  //     (genMoves/applyMove for gameplay, aiPickMove as a file:// fallback)
  //   - as a Web Worker (new Worker("js/shared/checkers-engine.js")) → onmessage
  //     runs aiPickMove off the main thread, so the highest levels never jank.
  // The transposition table lives here too, so the live-eval search warms the
  // cache the AI's own move search reuses — no wasted re-searching.

  // Piece codes: 1 red man, 2 red king, -1 black man, -2 black king, 0 empty.
  // Red starts at the bottom (rows 5-7) and moves up; red moves first.
  const RED = 1, BLK = -1;
  const MAN_DIRS = { [RED]: [[-1, -1], [-1, 1]], [BLK]: [[1, -1], [1, 1]] };
  const KING_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const CROWN_ROW = { [RED]: 0, [BLK]: 7 };

  // Strength levels: search depth + time budget + score noise (Elo labels are rough).
  // `random` is the chance of just playing any legal move — how the lowest levels
  // stay genuinely beatable for young kids.
  const LEVELS = [
    { label: "1 — first games, great for kids", depth: 1, ms: 60, noise: 200, random: 0.85 },
    { label: "2 — ~500 Elo",  depth: 2,  ms: 80,   noise: 80, random: 0.45 },
    { label: "3 — ~700 Elo",  depth: 2,  ms: 80,   noise: 40, random: 0.15 },
    { label: "4 — ~900 Elo",  depth: 3,  ms: 120,  noise: 25, random: 0 },
    { label: "5 — ~1100 Elo", depth: 5,  ms: 200,  noise: 15, random: 0 },
    { label: "6 — ~1300 Elo", depth: 7,  ms: 320,  noise: 8,  random: 0 },
    { label: "7 — ~1500 Elo", depth: 9,  ms: 500,  noise: 4,  random: 0 },
    { label: "8 — ~1700 Elo", depth: 11, ms: 750,  noise: 2,  random: 0 },
    { label: "9 — ~1900 Elo", depth: 13, ms: 1000, noise: 0,  random: 0 },
    { label: "10 — ~2100 Elo", depth: 15, ms: 1500, noise: 0, random: 0 },
  ];

  // ---------- Rules ----------
  const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const sideOf = (v) => (v > 0 ? RED : v < 0 ? BLK : 0);
  const isMan = (v) => v === 1 || v === -1;
  const dirsFor = (v) => (isMan(v) ? MAN_DIRS[sideOf(v)] : KING_DIRS);

  function extendJumps(bd, r, c, piece, path, caps, out) {
    let extended = false;
    for (const [dr, dc] of dirsFor(piece)) {
      const mr = r + dr, mc = c + dc, lr = r + 2 * dr, lc = c + 2 * dc;
      if (!inB(lr, lc)) continue;
      const mid = bd[mr][mc];
      if (mid === 0 || sideOf(mid) === sideOf(piece) || bd[lr][lc] !== 0) continue;
      extended = true;
      const crowns = isMan(piece) && lr === CROWN_ROW[sideOf(piece)];
      bd[r][c] = 0; bd[mr][mc] = 0; bd[lr][lc] = piece;
      path.push([lr, lc]); caps.push([mr, mc]);
      if (crowns) out.push({ path: path.slice(), caps: caps.slice() }); // crowning ends the turn
      else extendJumps(bd, lr, lc, piece, path, caps, out);
      path.pop(); caps.pop();
      bd[lr][lc] = 0; bd[mr][mc] = mid; bd[r][c] = piece;
    }
    if (!extended && path.length > 1) out.push({ path: path.slice(), caps: caps.slice() });
  }

  function genMoves(bd, side) {
    const jumps = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (sideOf(bd[r][c]) !== side) continue;
        extendJumps(bd, r, c, bd[r][c], [[r, c]], [], jumps);
      }
    }
    if (jumps.length) return { moves: jumps, forced: true };
    const moves = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const v = bd[r][c];
        if (sideOf(v) !== side) continue;
        for (const [dr, dc] of dirsFor(v)) {
          const nr = r + dr, nc = c + dc;
          if (inB(nr, nc) && bd[nr][nc] === 0) moves.push({ path: [[r, c], [nr, nc]], caps: [] });
        }
      }
    }
    return { moves, forced: false };
  }

  function applyMove(bd, mv) {
    const [r0, c0] = mv.path[0];
    const [r1, c1] = mv.path[mv.path.length - 1];
    const piece = bd[r0][c0];
    const undo = { r0, c0, r1, c1, piece, caps: mv.caps.map(([r, c]) => [r, c, bd[r][c]]) };
    bd[r0][c0] = 0;
    for (const [cr, cc] of mv.caps) bd[cr][cc] = 0;
    bd[r1][c1] = isMan(piece) && r1 === CROWN_ROW[sideOf(piece)] ? piece * 2 : piece;
    return undo;
  }

  function undoMove(bd, u) {
    bd[u.r1][u.c1] = 0;
    for (const [cr, cc, v] of u.caps) bd[cr][cc] = v;
    bd[u.r0][u.c0] = u.piece;
  }

  // ---------- Engine: negamax + alpha-beta + iterative deepening ----------
  // A transposition table (Zobrist hash → best score/move, with EXACT/LOWER/UPPER
  // bounds) memoizes every position reached, so:
  //   - deeper iterative-deepening plies reuse shallower searches instead of
  //     re-doing them, and reordered multi-jump lines share work;
  //   - the live-eval search warms the table for the AI's very next move.
  const TIMEOUT = Symbol("timeout");
  let deadline = 0;

  const TT = new Map();
  const TT_LIMIT = 200000; // clear when full — a long session must not grow forever
  // Persist mid-game too: the worker lives for the whole tab session (chess's
  // stockfish does the same), so warm entries carry between moves and games.
  // Two independent 32-bit tables make a 64-bit Zobrist key; the Map is keyed on
  // `lo` and the `hi` half is verified on hit, so a `lo` collision is just a miss
  // — never a wrong move.
  const ZLO = (() => {
    const t = new Int32Array(64 * 5); // [square (8*8) × piece value+2]
    let s = 0x9E3779B9; // deterministic LCG, so results are reproducible
    const next = () => (s = (Math.imul(s, 1103515245) + 12345) | 0);
    for (let i = 0; i < t.length; i++) t[i] = next();
    return t;
  })();
  const ZHI = (() => {
    const t = new Int32Array(64 * 5);
    let s = 0x1F2E3D4C; // a different LCG seed, so the halves differ
    const next = () => (s = (Math.imul(s, 1103515245) + 12345) | 0);
    for (let i = 0; i < t.length; i++) t[i] = next();
    return t;
  })();

  function zobrist(bd) {
    let lo = 0, hi = 0;
    for (let r = 0; r < 8; r++) {
      const row = bd[r];
      for (let c = 0; c < 8; c++) {
        const v = row[c];
        if (v !== 0) {
          const i = (r * 8 + c) * 5 + (v + 2);
          lo ^= ZLO[i];
          hi ^= ZHI[i];
        }
      }
    }
    return { lo, hi };
  }

  function samePath(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
    return true;
  }

  function evaluate(bd) {
    let score = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const v = bd[r][c];
        if (v === 0) continue;
        const center = r >= 2 && r <= 5 && c >= 2 && c <= 5 ? 4 : 0;
        if (v === 1) score += 100 + (7 - r) * 4 + (r === 7 ? 6 : 0) + center;
        else if (v === 2) score += 175 + center * 2;
        else if (v === -1) score -= 100 + r * 4 + (r === 0 ? 6 : 0) + center;
        else score -= 175 + center * 2;
      }
    }
    return score; // positive = good for red
  }

  function negamax(bd, side, depth, alpha, beta) {
    if (performance.now() > deadline) throw TIMEOUT;
    const { moves, forced } = genMoves(bd, side);
    if (moves.length === 0) return -50000 - depth; // no moves = loss (prefer later losses)
    if (depth <= 0 && !forced) return side * evaluate(bd); // quiescence: keep resolving captures

    const key = zobrist(bd);
    const ent = TT.get(key.lo);
    if (ent && ent.hi === key.hi && ent.side === side && ent.depth >= depth) {
      if (ent.flag === 0) return ent.score;                          // EXACT
      if (ent.flag === 1 && ent.score >= beta) return ent.score;     // LOWER bound
      if (ent.flag === 2 && ent.score <= alpha) return ent.score;    // UPPER bound
    }

    // Try the previously-best move first — cheap ordering that sharpens alpha-beta
    let order = moves;
    if (ent && ent.move) {
      const i = moves.findIndex((m) => samePath(m.path, ent.move));
      if (i > 0) {
        order = moves.slice();
        order.splice(i, 1);
        order.unshift(moves[i]);
      }
    }

    const a0 = alpha;
    let best = -Infinity;
    let bestMove = null;
    for (const mv of order) {
      const u = applyMove(bd, mv);
      const v = -negamax(bd, -side, depth - 1, -beta, -alpha);
      undoMove(bd, u);
      if (v > best) { best = v; bestMove = mv.path; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    const flag = best <= a0 ? 2 : best >= beta ? 1 : 0; // UPPER / LOWER / EXACT
    if (TT.size > TT_LIMIT) TT.clear();
    TT.set(key.lo, { hi: key.hi, side, depth, score: best, flag, move: bestMove });
    return best;
  }

  // Search on a private copy: a TIMEOUT thrown mid-search skips undoMove calls,
  // which would leave phantom moves applied to the caller's board.
  function aiPickMove(bd0, side, level, ms) {
    const bd = bd0.map((row) => row.slice());
    const lvl = LEVELS[level];
    const maxDepth = lvl.depth;
    deadline = performance.now() + (ms || lvl.ms);
    const { moves } = genMoves(bd, side);
    if (moves.length === 0) return null;
    if (moves.length === 1) { moves[0].score = side * evaluate(bd); return moves[0]; }
    // Lowest levels mostly just play something legal, like a young kid would
    if (Math.random() < (lvl.random || 0)) {
      const m = moves[Math.floor(Math.random() * moves.length)];
      m.score = side * evaluate(bd);
      return m;
    }
    let scored = moves.map((m) => ({ m, score: 0 }));
    for (let d = 2; d <= maxDepth; d++) {
      const prev = scored.map((e) => ({ m: e.m, score: e.score }));
      try {
        let a = -Infinity;
        for (const e of scored) {
          const u = applyMove(bd, e.m);
          e.score = -negamax(bd, -side, d - 1, -Infinity, -a);
          undoMove(bd, u);
          if (e.score > a) a = e.score;
        }
        scored.sort((x, y) => y.score - x.score); // better ordering for the next depth
      } catch (err) {
        if (err !== TIMEOUT) throw err;
        scored = prev; // discard the partially-scored depth
        break;
      }
      if (performance.now() > deadline) break;
    }
    scored.sort((x, y) => y.score - x.score);
    const margin = lvl.noise * 3;
    const candidates = scored.filter((e) => e.score >= scored[0].score - margin);
    const mv = candidates[Math.floor(Math.random() * candidates.length)].m;
    mv.score = scored[0].score;
    return mv;
  }

  const api = { RED, BLK, LEVELS, genMoves, applyMove, undoMove, sideOf, isMan, aiPickMove };

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
    window.CheckersEngine = api;
  }
})();
