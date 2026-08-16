(() => {
  "use strict";

  // Chinese checkers rules + search engine, shared two ways like
  // js/shared/checkers-engine.js:
  //   - as a classic <script> → window.ChineseCheckersEngine (board geometry +
  //     genMoves/applyMove for gameplay, aiPickMove as a file:// fallback)
  //   - as a Web Worker → onmessage answers { id, board, side, level, ms }
  //     with { id, move }, so the search never janks the main thread.
  //
  // The game seats 2, 3, 4 or 6 players, so negamax doesn't apply; the search
  // is max-n: every node returns a score vector (one entry per player) and the
  // player to move picks the child that maximises their own entry. A Zobrist
  // transposition table memoizes those vectors across iterative-deepening
  // passes and between moves. There is no alpha-beta here — max-n can't prune
  // soundly — so the table plus a top-K move cap is what keeps it fast.
  //
  // Board: the 121-hole star, flattened to one array. Cube coordinates
  // (x + y + z = 0): a cell is on the board iff it is inside either of the two
  // big overlapping triangles, { x,y,z ≥ -4 } or { x,y,z ≤ 4 }. Cell values:
  // 0 empty, or 1-6 = the player whose home corner is value-1. Corners are
  // numbered by screen position (+z points down the screen): 0 bottom (the
  // human), 1 lower-right, 2 upper-right, 3 top, 4 upper-left, 5 lower-left.
  // A player's target is the corner opposite their home. Nothing is ever
  // captured, and a jump chain may stop anywhere the mover is allowed to rest
  // (any hexagon hole, their own corner, or their target — never a foreign
  // corner), so a move is fully described by { from, to }; `path` (every
  // landing hole) comes along for the animations.

  // ---------- Board geometry ----------
  const CELLS = [];                          // [{ x, z }] — y is implied (-x-z)
  const IDX = new Int16Array(17 * 17).fill(-1);
  const kxz = (x, z) => (x + 8) * 17 + (z + 8);
  for (let z = -8; z <= 8; z++) {
    for (let x = -8; x <= 8; x++) {
      const y = -x - z;
      if (y < -8 || y > 8) continue;
      if (!((x >= -4 && y >= -4 && z >= -4) || (x <= 4 && y <= 4 && z <= 4))) continue;
      IDX[kxz(x, z)] = CELLS.length;
      CELLS.push({ x, z });
    }
  }
  const N = CELLS.length; // 121

  const cellAt = (x, z) => (x < -8 || x > 8 || z < -8 || z > 8) ? -1 : IDX[kxz(x, z)];

  // The six hex directions as (dx, dz); dy is implied
  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const NBR = new Int16Array(N * 6); // one step
  const JMP = new Int16Array(N * 6); // two steps — the landing hole of a hop
  for (let i = 0; i < N; i++) {
    const { x, z } = CELLS[i];
    for (let d = 0; d < 6; d++) {
      NBR[i * 6 + d] = cellAt(x + DIRS[d][0], z + DIRS[d][1]);
      JMP[i * 6 + d] = cellAt(x + 2 * DIRS[d][0], z + 2 * DIRS[d][1]);
    }
  }

  // Corner membership (-1 = the central hexagon) and each corner's 10 cells
  const CORNER = new Int8Array(N);
  const TRI = [[], [], [], [], [], []];
  for (let i = 0; i < N; i++) {
    const { x, z } = CELLS[i];
    const y = -x - z;
    const k = z >= 5 ? 0 : y <= -5 ? 1 : x >= 5 ? 2 : z <= -5 ? 3 : y >= 5 ? 4 : x <= -5 ? 5 : -1;
    CORNER[i] = k;
    if (k >= 0) TRI[k].push(i);
  }

  // Player ids are home corner + 1; the human is always 1 (bottom corner).
  // Targets are opposite corners. Seatings follow the consulted rules: with 3
  // players every other corner (so all targets are empty), with 4 two opposite
  // pairs (the two unused corners also opposite each other).
  const SEATS = { 2: [1, 4], 3: [1, 3, 5], 4: [1, 2, 4, 5], 6: [1, 2, 3, 4, 5, 6] };
  const targetOf = (p) => (p + 2) % 6;

  // Hex distance from every cell to the far tip of each corner — the yardstick
  // the whole eval is built on ("how many rows from home").
  const TIPS = TRI.map((tri) => {
    let tip = tri[0], best = -1;
    for (const i of tri) {
      const { x, z } = CELLS[i];
      const d = (Math.abs(x) + Math.abs(-x - z) + Math.abs(z)) / 2;
      if (d > best) { best = d; tip = i; }
    }
    return tip;
  });
  const DIST = TIPS.map((tip) => {
    const t = CELLS[tip];
    const out = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      const dx = CELLS[i].x - t.x, dz = CELLS[i].z - t.z;
      out[i] = (Math.abs(dx) + Math.abs(dx + dz) + Math.abs(dz)) / 2;
    }
    return out;
  });

  // Strength levels. `myMoves` is the horizon in *own* moves — the search depth
  // in plies is 1 + (myMoves - 1) × seats, so it adapts to the player count.
  // `k`/`kOpp` cap how many candidate moves the searcher / its opponents keep
  // per node. `random` is the chance of just playing any non-backward move —
  // how the lowest levels stay beatable for young kids (noise is in eval
  // points; one forward step ≈ 10).
  const LEVELS = [
    { label: "1 — first games, great for kids", myMoves: 1, ms: 60,   noise: 25, random: 0.8, k: 8,  kOpp: 3 },
    { label: "2 — learning the hops",  myMoves: 1, ms: 60,   noise: 14, random: 0.4, k: 8,  kOpp: 3 },
    { label: "3 — casual",             myMoves: 1, ms: 60,   noise: 7,  random: 0.1, k: 8,  kOpp: 3 },
    { label: "4 — steady",             myMoves: 2, ms: 250,  noise: 6,  random: 0,   k: 10, kOpp: 4 },
    { label: "5 — sharp",              myMoves: 2, ms: 350,  noise: 4,  random: 0,   k: 12, kOpp: 4 },
    { label: "6 — strong",             myMoves: 3, ms: 500,  noise: 3,  random: 0,   k: 12, kOpp: 5 },
    { label: "7 — very strong",        myMoves: 3, ms: 700,  noise: 2,  random: 0,   k: 14, kOpp: 5 },
    { label: "8 — expert",             myMoves: 4, ms: 900,  noise: 1,  random: 0,   k: 14, kOpp: 6 },
    { label: "9 — master",             myMoves: 4, ms: 1200, noise: 0,  random: 0,   k: 16, kOpp: 6 },
    { label: "10 — grandmaster",       myMoves: 5, ms: 1600, noise: 0,  random: 0,   k: 16, kOpp: 8 },
  ];

  // ---------- Rules ----------
  function startBoard(players) {
    const bd = new Array(N).fill(0);
    for (const p of SEATS[players]) for (const i of TRI[p - 1]) bd[i] = p;
    return bd;
  }

  // Individual win, free-for-all games: your target triangle is completely
  // full AND at least one marble in it is yours. With no squatters that is
  // exactly "moved your last marble across"; when the triangle's owner parks
  // marbles at home, they count as filled for you — the anti-blocking rule,
  // without which a parked marble makes the incomer's win literally
  // unreachable. (At the start of a game the target is full of the owner's
  // ten marbles and none are yours, so nothing fires until they vacate a hole
  // and you claim it.)
  function isWin(bd, p) {
    let mine = false;
    for (const i of TRI[targetOf(p)]) {
      const v = bd[i];
      if (v === 0) return false;
      if (v === p) mine = true;
    }
    return mine;
  }

  // Strictly home: all ten target holes hold p's own marbles. This is the
  // per-player test in TEAM games — your partner sits opposite, so your
  // target is *their* home, and counting their yet-to-leave marbles as
  // squatters would hand out wins for swapping two marbles. Partners
  // cooperate, so no anti-blocking is needed inside a team (and the
  // corner-resting rule keeps everyone else out of both corners entirely).
  function isDone(bd, p) {
    for (const i of TRI[targetOf(p)]) if (bd[i] !== p) return false;
    return true;
  }

  // The player opposite p: the owner of p's target corner. In a team game
  // that is p's partner; in a free-for-all it is the one player p could gift
  // a win to by re-filling their own home.
  const partnerOf = (p) => targetOf(p) + 1;

  // The winner created by p's move, or 0. After p moves, the only possible
  // new winner is p themselves or (free-for-all only) the player aiming at
  // p's home corner — p just re-filled its last hole, and the anti-blocking
  // rule means that *hands over* the win. Teams win strictly: both partners
  // fully home; only the mover's own team can complete on the mover's move,
  // and the returned id is the mover (map it to the team in the caller).
  function winnerAfter(bd, mv, p, teams) {
    if (teams) return isDone(bd, p) && isDone(bd, partnerOf(p)) ? p : 0;
    if (isWin(bd, p)) return p;
    if (CORNER[mv.to] === p - 1) {
      const q = partnerOf(p);
      if (bd.indexOf(q) >= 0 && isWin(bd, q)) return q;
    }
    return 0;
  }

  // Move generation. A turn is either one step to an adjacent empty hole, or a
  // chain of hops over any adjacent marble (own or an opponent's) into the
  // empty hole directly beyond — direction changes allowed, stop anywhere.
  // One restriction on where a move may END: never inside a corner triangle
  // that is another colour's home base — only your own corner and your
  // designated target are resting places. Hopping *through* a foreign corner
  // mid-chain is fine, so the filter applies to emitted destinations, not to
  // the BFS expansion.
  // Only the destination matters, so hop chains are a BFS over landing holes;
  // `parent` rebuilds one legal path for the animation. The bookkeeping arrays
  // are generation-stamped so they never need clearing between marbles.
  const visAt = new Int32Array(N);  // BFS visited (landing holes)
  const seenAt = new Int32Array(N); // destinations already emitted for this marble
  const parent = new Int16Array(N);
  const queue = new Int16Array(N);
  let gen = 0;

  function genMoves(bd, p) {
    const home = p - 1, tgt = targetOf(p);
    const canRest = (c) => CORNER[c] < 0 || CORNER[c] === home || CORNER[c] === tgt;
    const out = [];
    for (let i = 0; i < N; i++) {
      if (bd[i] !== p) continue;
      gen++;
      seenAt[i] = gen; // never emit a move that goes nowhere
      for (let d = 0; d < 6; d++) {
        const j = NBR[i * 6 + d];
        if (j >= 0 && bd[j] === 0 && seenAt[j] !== gen) {
          seenAt[j] = gen;
          if (canRest(j)) out.push({ from: i, to: j, path: [i, j] });
        }
      }
      // The hopping marble is airborne: its own hole is empty for the rest of
      // the chain, but it may not end the turn back where it started.
      bd[i] = 0;
      visAt[i] = gen;
      queue[0] = i;
      let head = 0, tail = 1;
      while (head < tail) {
        const c = queue[head++];
        for (let d = 0; d < 6; d++) {
          const m = NBR[c * 6 + d], l = JMP[c * 6 + d];
          if (m < 0 || l < 0 || bd[m] === 0 || bd[l] !== 0 || visAt[l] === gen) continue;
          visAt[l] = gen;
          parent[l] = c;
          queue[tail++] = l;
          if (seenAt[l] !== gen) { // a step to the same hole already covers it
            seenAt[l] = gen;
            if (canRest(l)) {
              const path = [l];
              for (let a = c; ; a = parent[a]) { path.push(a); if (a === i) break; }
              path.reverse();
              out.push({ from: i, to: l, path });
            }
          }
        }
      }
      bd[i] = p;
    }
    return out;
  }

  // Nothing is captured, so apply/undo is two writes; the return value is the
  // marble for undoMove.
  function applyMove(bd, mv) {
    const v = bd[mv.from];
    bd[mv.from] = 0;
    bd[mv.to] = v;
    return v;
  }
  function undoMove(bd, mv, v) {
    bd[mv.to] = 0;
    bd[mv.from] = v;
  }

  // ---------- Engine: max-n + iterative deepening + transposition table ----------
  const TIMEOUT = Symbol("timeout");
  let deadline = 0;
  let seats = [];   // ascending player ids present in the searched game
  let rootSide = 0; // the player the AI is choosing for (gets the wide move cap)
  let teamsOn = false; // team game: each mover maximises its team's summed score
  let lvlK = 8, lvlKopp = 3;

  const TT = new Map();
  const TT_LIMIT = 120000; // clear when full — entries hold a 7-slot vector each
  // Two independent 32-bit tables make a 64-bit Zobrist key, exactly like
  // checkers-engine.js: the Map is keyed on `lo`, the `hi` half (and the side
  // to move) is verified on hit, so a collision is just a miss.
  const ZLO = (() => {
    const t = new Int32Array(N * 7); // [cell × value 0-6]
    let s = 0x7C4D9A31; // deterministic LCG, so results are reproducible
    const next = () => (s = (Math.imul(s, 1103515245) + 12345) | 0);
    for (let i = 0; i < t.length; i++) t[i] = next();
    return t;
  })();
  const ZHI = (() => {
    const t = new Int32Array(N * 7);
    let s = 0x2B8E1F63; // a different LCG seed, so the halves differ
    const next = () => (s = (Math.imul(s, 1103515245) + 12345) | 0);
    for (let i = 0; i < t.length; i++) t[i] = next();
    return t;
  })();

  function zobrist(bd) {
    let lo = 0, hi = 0;
    for (let i = 0; i < N; i++) {
      const v = bd[i];
      if (v !== 0) { lo ^= ZLO[i * 7 + v]; hi ^= ZHI[i * 7 + v]; }
    }
    return { lo, hi };
  }

  // Game over: the winning side's entries spike and every other seat's
  // craters, so the search chases its own wins, blocks other players' wins
  // when it can, and never gifts one by re-filling its own home. In a team
  // game the winner's partner shares the spike. Remaining depth = sooner, so
  // wins are taken quickly and losses put off.
  function terminalVec(bd, winner, depth) {
    const vec = evalAll(bd);
    const b = 100000 + depth * 100;
    const pw = teamsOn ? partnerOf(winner) : 0;
    for (const s of seats) vec[s] += s === winner || s === pw ? b : -b;
    return vec;
  }

  // Static eval, one score per player: mostly "how close are my marbles to the
  // tip of my target corner" (a forward step ≈ +10, so a 4-hop chain ≈ +40),
  // a small bonus per marble already parked in the target triangle, and a
  // straggler penalty on the most-lagging marble so nobody gets left home.
  const LAG = new Int8Array(7);
  function evalAll(bd) {
    const vec = new Float64Array(7);
    LAG.fill(0);
    for (let i = 0; i < N; i++) {
      const p = bd[i];
      if (p === 0) continue;
      const t = targetOf(p);
      const d = DIST[t][i];
      vec[p] += (16 - d) * 10 + (CORNER[i] === t ? 14 : 0);
      if (d > LAG[p]) LAG[p] = d;
    }
    for (let p = 1; p <= 6; p++) vec[p] -= 6 * LAG[p];
    return vec;
  }

  function search(bd, si, depth, lo, hi) {
    if (performance.now() > deadline) throw TIMEOUT;
    if (depth <= 0) return evalAll(bd);
    const p = seats[si];
    const ent = TT.get(lo);
    // `tm` must match: team and free-for-all searches back up different
    // terminal values for the same position, and the table outlives games.
    if (ent && ent.hi === hi && ent.side === p && ent.tm === teamsOn && ent.depth >= depth) return ent.vec;

    const moves = genMoves(bd, p);
    const ni = (si + 1) % seats.length;
    if (moves.length === 0) return search(bd, ni, depth - 1, lo, hi); // fully blocked: turn skips

    const t = targetOf(p);
    for (const m of moves) m.gain = DIST[t][m.from] - DIST[t][m.to];
    moves.sort((a, b) => b.gain - a.gain);
    // Try the previously-best move first — cheap ordering that steers the cap
    if (ent && ent.hi === hi && ent.side === p && ent.move) {
      const i = moves.findIndex((m) => m.from === ent.move.from && m.to === ent.move.to);
      if (i > 0) { const [m] = moves.splice(i, 1); moves.unshift(m); }
    }
    const cap = p === rootSide ? lvlK : lvlKopp;
    if (moves.length > cap) moves.length = cap;

    const pp = teamsOn ? partnerOf(p) : 0; // the mover plays for its team's sum
    let best = null, bestVec = null, bestSc = -Infinity;
    for (const mv of moves) {
      const v = applyMove(bd, mv);
      const w = winnerAfter(bd, mv, p, teamsOn);
      let vec;
      if (w) {
        vec = terminalVec(bd, w, depth);
      } else {
        const dlo = ZLO[mv.from * 7 + v] ^ ZLO[mv.to * 7 + v];
        const dhi = ZHI[mv.from * 7 + v] ^ ZHI[mv.to * 7 + v];
        vec = search(bd, ni, depth - 1, lo ^ dlo, hi ^ dhi);
      }
      undoMove(bd, mv, v);
      const sc = pp ? vec[p] + vec[pp] : vec[p];
      if (sc > bestSc) { bestSc = sc; bestVec = vec; best = mv; }
    }
    if (TT.size > TT_LIMIT) TT.clear();
    TT.set(lo, { hi, side: p, tm: teamsOn, depth, vec: bestVec, move: best });
    return bestVec;
  }

  // Search on a private copy: a TIMEOUT thrown mid-search skips undoMove calls,
  // which would leave phantom moves applied to the caller's board.
  function aiPickMove(bd0, side, level, ms, teams) {
    const bd = bd0.slice();
    const lvl = LEVELS[level];
    deadline = performance.now() + (ms || lvl.ms);
    teamsOn = !!teams;
    seats = [];
    for (let p = 1; p <= 6; p++) if (bd.indexOf(p) >= 0) seats.push(p);
    const si = seats.indexOf(side);
    if (si < 0) return null;

    const moves = genMoves(bd, side);
    if (moves.length === 0) return null;
    const t = targetOf(side);
    for (const m of moves) m.gain = DIST[t][m.from] - DIST[t][m.to];
    if (moves.length === 1) { moves[0].score = 0; return moves[0]; }
    // Lowest levels mostly play any move that at least isn't backwards,
    // like a young kid pushing marbles around
    if (Math.random() < (lvl.random || 0)) {
      const pool = moves.filter((m) => m.gain >= 0);
      const pick = pool.length ? pool : moves;
      const m = pick[Math.floor(Math.random() * pick.length)];
      m.score = m.gain * 10;
      return m;
    }

    rootSide = side;
    lvlK = lvl.k;
    lvlKopp = lvl.kOpp;
    moves.sort((a, b) => b.gain - a.gain);
    const rootMoves = moves.slice(0, Math.max(lvl.k * 2, 16)); // the root looks wider
    // Greedy scores are the depth-1 result and the fallback if time runs out
    let scored = rootMoves.map((m) => ({ m, score: m.gain * 10 }));
    const ni = (si + 1) % seats.length;
    const maxDepth = 1 + (lvl.myMoves - 1) * seats.length;
    const root = zobrist(bd);
    for (let d = 2; d <= maxDepth; d++) {
      const prev = scored.map((e) => ({ m: e.m, score: e.score }));
      try {
        for (const e of scored) {
          const v = applyMove(bd, e.m);
          const w = winnerAfter(bd, e.m, side, teamsOn);
          if (w === side) {
            e.score = 1000000;
          } else if (w) {
            e.score = -1000000; // re-filling our own home hands the game away
          } else {
            const dlo = ZLO[e.m.from * 7 + v] ^ ZLO[e.m.to * 7 + v];
            const dhi = ZHI[e.m.from * 7 + v] ^ ZHI[e.m.to * 7 + v];
            const vec = search(bd, ni, d - 1, root.lo ^ dlo, root.hi ^ dhi);
            e.score = teamsOn ? vec[side] + vec[partnerOf(side)] : vec[side];
          }
          undoMove(bd, e.m, v);
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
    // Noise never blurs a win: decisive scores pick strictly best
    const margin = scored[0].score >= 100000 ? 0 : lvl.noise * 3;
    const candidates = scored.filter((e) => e.score >= scored[0].score - margin);
    const mv = candidates[Math.floor(Math.random() * candidates.length)].m;
    mv.score = scored[0].score;
    return mv;
  }

  const api = {
    CELLS, CORNER, TRI, SEATS, LEVELS,
    targetOf, partnerOf, startBoard, genMoves, applyMove, undoMove,
    isWin, isDone, winnerAfter, aiPickMove,
  };

  if (typeof window === "undefined") {
    // Worker context: answer { id, board, side, level, ms, teams } →
    // { id, move } — the checkers/connect4 protocol plus the teams flag.
    self.onmessage = (e) => {
      const { id, board, side, level, ms, teams } = e.data;
      let move = null;
      try { move = aiPickMove(board, side, level, ms, teams); }
      catch (err) { move = null; }
      self.postMessage({ id, move });
    };
  } else {
    window.ChineseCheckersEngine = api;
  }
})();
