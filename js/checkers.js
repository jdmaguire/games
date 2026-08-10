(() => {
  "use strict";

  // Piece codes: 1 red man, 2 red king, -1 black man, -2 black king, 0 empty.
  // Red starts at the bottom (rows 5-7) and moves up; red moves first.
  const RED = 1, BLK = -1;
  const MAN_DIRS = { [RED]: [[-1, -1], [-1, 1]], [BLK]: [[1, -1], [1, 1]] };
  const KING_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const CROWN_ROW = { [RED]: 0, [BLK]: 7 };
  const DRAW_PLIES = 80; // plies without a capture or man move -> draw

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
    { label: "10 — ~2100 Elo", depth: 15, ms: 1300, noise: 0, random: 0 },
  ];

  const boardEl = document.getElementById("board");
  const statusEl = document.getElementById("status");
  const overlay = document.getElementById("overlay");
  const ovMsg = document.getElementById("ov-msg");
  const lvlSlider = document.getElementById("lvl");
  const lvlLabel = document.getElementById("lvl-label");
  const sideR = document.getElementById("side-r");
  const sideB = document.getElementById("side-b");
  const btnNew = document.getElementById("btn-new");
  const btnUndo = document.getElementById("btn-undo");
  const topName = document.getElementById("top-name");
  const botName = document.getElementById("bot-name");
  const topMat = document.getElementById("top-mat");
  const botMat = document.getElementById("bot-mat");

  // ---------- Preferences ----------
  let prefs = { level: 0, side: RED }; // default to the gentlest setting
  try {
    const saved = JSON.parse(localStorage.getItem("checkers-prefs"));
    if (saved && typeof saved.level === "number" && (saved.side === RED || saved.side === BLK)) prefs = saved;
  } catch (e) { /* private browsing */ }
  function savePrefs() {
    try { localStorage.setItem("checkers-prefs", JSON.stringify(prefs)); } catch (e) { /* private browsing */ }
  }

  // In-progress game persistence (saved at stable points between moves)
  function saveGame() {
    try {
      localStorage.setItem("checkers-game",
        JSON.stringify({ board, turn, clock, side: playerSide, level: prefs.level, snapshots }));
    } catch (e) { /* private browsing */ }
  }
  function clearGameSave() {
    try { localStorage.removeItem("checkers-game"); } catch (e) { /* private browsing */ }
  }

  // ---------- Audio (tiny WebAudio synth; unlocked on first user gesture) ----------
  let AC = null;
  function ensureAudio() {
    try {
      if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
      if (AC.state === "suspended") AC.resume();
    } catch (e) { AC = null; }
  }
  function beep(f, f2, dur, type, vol, when) {
    if (!AC) return;
    try {
      const t0 = AC.currentTime + (when || 0);
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t0);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(AC.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    } catch (e) { /* audio is best-effort */ }
  }
  function thud(dur, vol) {
    if (!AC) return;
    try {
      const n = Math.floor(AC.sampleRate * dur);
      const buf = AC.createBuffer(1, n, AC.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = AC.createBufferSource(), g = AC.createGain();
      src.buffer = buf;
      g.gain.value = vol;
      src.connect(g).connect(AC.destination);
      src.start();
    } catch (e) { /* audio is best-effort */ }
  }
  const sfx = {
    land:    () => { thud(0.03, 0.15); beep(160, 110, 0.07, "sine", 0.3); },
    capture: () => { thud(0.07, 0.25); beep(110, 60, 0.11, "square", 0.16); },
    promote: () => { beep(523, null, 0.12, "triangle", 0.2); beep(659, null, 0.12, "triangle", 0.2, 0.09); beep(784, null, 0.22, "triangle", 0.22, 0.18); },
    victory: () => {
      const run = [[523, 0], [659, 0.14], [784, 0.28], [1047, 0.42], [784, 0.62], [1047, 0.76]];
      for (const [f, t] of run) beep(f, null, 0.24, "triangle", 0.22, t);
      beep(1319, null, 0.6, "triangle", 0.22, 0.95);
      beep(1047, null, 0.6, "sine", 0.12, 0.95);
    },
  };

  // ---------- Win celebration ----------
  let banner = null;
  function showBanner(text) {
    hideBanner();
    banner = document.createElement("div");
    banner.className = "winbanner";
    banner.textContent = text;
    document.getElementById("wrap").appendChild(banner);
  }
  function hideBanner() {
    if (banner) { banner.remove(); banner = null; }
  }
  function confetti(durMs) {
    const cv = document.createElement("canvas");
    cv.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:50";
    document.body.appendChild(cv);
    const cx = cv.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    cv.width = innerWidth * dpr;
    cv.height = innerHeight * dpr;
    cx.scale(dpr, dpr);
    const colors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#fbbf24"];
    const bits = Array.from({ length: 160 }, () => ({
      x: Math.random() * innerWidth,
      y: -20 - Math.random() * innerHeight * 0.6,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      vy: 100 + Math.random() * 170,
      vx: -40 + Math.random() * 80,
      rot: Math.random() * Math.PI * 2,
      vr: -5 + Math.random() * 10,
      sway: Math.random() * Math.PI * 2,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    let start = null, last = null;
    function frame(t) {
      if (!start) { start = t; last = t; }
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const elapsed = t - start;
      cx.clearRect(0, 0, innerWidth, innerHeight);
      cx.globalAlpha = elapsed > durMs - 600 ? Math.max(0, (durMs - elapsed) / 600) : 1;
      for (const b of bits) {
        b.y += b.vy * dt;
        b.x += (b.vx + Math.sin(b.sway + elapsed / 300) * 30) * dt;
        b.rot += b.vr * dt;
        if (b.y > innerHeight + 20) { b.y = -20; b.x = Math.random() * innerWidth; }
        cx.save();
        cx.translate(b.x, b.y);
        cx.rotate(b.rot);
        cx.fillStyle = b.color;
        cx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        cx.restore();
      }
      if (elapsed < durMs) requestAnimationFrame(frame);
      else cv.remove();
    }
    requestAnimationFrame(frame);
  }
  function celebrate(text) {
    showBanner(text);
    sfx.victory();
    confetti(5000);
  }

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
  const TIMEOUT = Symbol("timeout");
  let deadline = 0;

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
    let best = -Infinity;
    for (const mv of moves) {
      const u = applyMove(bd, mv);
      const v = -negamax(bd, -side, depth - 1, -beta, -alpha);
      undoMove(bd, u);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  function aiPickMove(bd0, side, level) {
    // Search on a private copy: a TIMEOUT thrown mid-search skips undoMove calls,
    // which would leave phantom moves applied to the live board.
    const bd = bd0.map((row) => row.slice());
    const { depth: maxDepth, ms, noise } = LEVELS[level];
    deadline = performance.now() + ms;
    const { moves } = genMoves(bd, side);
    if (moves.length === 0) return null;
    if (moves.length === 1) return moves[0];
    // Lowest levels mostly just play something legal, like a young kid would
    if (Math.random() < (LEVELS[level].random || 0)) {
      return moves[Math.floor(Math.random() * moves.length)];
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
    const margin = noise * 3;
    const candidates = scored.filter((e) => e.score >= scored[0].score - margin);
    return candidates[Math.floor(Math.random() * candidates.length)].m;
  }

  // ---------- Game state ----------
  let board, turn, playerSide, aiSide, clock, thinking, gameOver;
  let animating = false;
  let endTimer = null;
  let selected = null;        // [r, c]
  let activeMoves = [];       // legal sequences (possibly mid-jump continuations)
  let midJump = false;
  let lastPath = [];          // squares to highlight from the previous move
  let snapshots = [];         // undo points, taken at the start of each player turn

  function newBoard() {
    const bd = Array.from({ length: 8 }, () => new Array(8).fill(0));
    for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) if ((r + c) % 2 === 1) bd[r][c] = BLK;
    for (let r = 5; r < 8; r++) for (let c = 0; c < 8; c++) if ((r + c) % 2 === 1) bd[r][c] = RED;
    return bd;
  }

  // ---------- Board rendering ----------
  const cells = [];
  const cellMap = {};
  function buildBoard() {
    boardEl.innerHTML = "";
    cells.length = 0;
    const flip = playerSide === BLK;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const r = flip ? 7 - row : row;
        const c = flip ? 7 - col : col;
        const div = document.createElement("div");
        div.className = "sq " + ((r + c) % 2 === 0 ? "light" : "dark");
        div.dataset.r = r;
        div.dataset.c = c;
        div.addEventListener("pointerdown", (e) => { e.preventDefault(); onDown(e, r, c); });
        boardEl.appendChild(div);
        cells.push(div);
        cellMap[r * 8 + c] = div;
      }
    }
    renderNames(playerSide);
    render();
  }

  // ---------- Move animation ----------
  function flyPiece(fromEl, toEl, html, done, dur) {
    const br = boardEl.getBoundingClientRect();
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const fly = document.createElement("div");
    fly.className = "fly";
    fly.style.width = a.width + "px";
    fly.style.height = a.height + "px";
    fly.style.left = a.left - br.left + "px";
    fly.style.top = a.top - br.top + "px";
    fly.style.transitionDuration = dur + "ms";
    fly.innerHTML = html;
    boardEl.appendChild(fly);
    fromEl.innerHTML = "";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fly.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px)`;
    }));
    setTimeout(() => { fly.remove(); if (done) done(); }, dur + 40);
  }

  function clearHints() {
    for (const div of cells) div.classList.remove("sel", "dot", "can");
  }

  function render() {
    const selKey = selected ? selected[0] * 8 + selected[1] : -1;
    const dots = new Set();
    const canSel = new Set();
    if (!thinking && !gameOver && turn === playerSide) {
      for (const mv of activeMoves) {
        if (midJump || (selected && mv.path[0][0] === selected[0] && mv.path[0][1] === selected[1])) {
          dots.add(mv.path[1][0] * 8 + mv.path[1][1]);
        }
        if (!midJump) canSel.add(mv.path[0][0] * 8 + mv.path[0][1]);
      }
    }
    const lastSet = new Set(lastPath.map(([r, c]) => r * 8 + c));
    for (const div of cells) {
      const r = +div.dataset.r, c = +div.dataset.c;
      const key = r * 8 + c;
      const v = board[r][c];
      div.innerHTML = v !== 0
        ? `<div class="pc ${v > 0 ? "red" : "blk"}">${Math.abs(v) === 2 ? '<span class="crown">★</span>' : ""}</div>`
        : "";
      div.classList.toggle("sel", key === selKey);
      div.classList.toggle("dot", dots.has(key) && v === 0);
      div.classList.toggle("can", canSel.has(key) && v !== 0 && key !== selKey);
      div.classList.toggle("last", lastSet.has(key));
    }
    btnUndo.disabled = thinking || animating || gameOver || turn !== playerSide || midJump || snapshots.length === 0;
    renderMaterial();
  }

  function setStatus(t) { statusEl.textContent = t; }

  // ---------- Material counter ----------
  const PIECES_PER_SIDE = 12;
  function countPieces(side) {
    let n = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (sideOf(board[r][c]) === side) n++;
    return n;
  }

  // Crowning never changes the piece count, so a plain disc per captured piece
  // plus the net difference tells the whole story here.
  function paintMaterial(el, taken, takenSide, net) {
    const cls = takenSide === RED ? "red" : "blk";
    // Math.max guards a hand-edited save with more than 12 pieces on a side
    el.innerHTML = `<span class="disc ${cls}"></span>`.repeat(Math.max(0, taken)) +
      (net > 0 ? `<span class="adv">+${net}</span>` : "");
  }

  function renderMaterial() {
    const opp = -playerSide;
    const mine = countPieces(playerSide), theirs = countPieces(opp);
    paintMaterial(botMat, PIECES_PER_SIDE - theirs, opp, mine - theirs);
    paintMaterial(topMat, PIECES_PER_SIDE - mine, playerSide, theirs - mine);
  }

  // `side` is the colour shown on the bottom row: the live game's side once a game
  // is running, otherwise whatever is picked in the menu.
  function renderNames(side) {
    const cls = side === RED ? "red" : "blk";
    botName.innerHTML = `<span class="disc ${cls}"></span>You` +
      `<span class="sub">${side === RED ? "Red" : "Black"}</span>`;
    topName.innerHTML = `<span class="disc ${cls === "red" ? "blk" : "red"}"></span>Computer` +
      `<span class="sub">Level ${prefs.level + 1}</span>`;
  }

  // ---------- Turn flow ----------
  function beginPlayerTurn() {
    snapshots.push({ bd: board.map((row) => row.slice()), clock });
    resumePlayerTurn();
    if (!gameOver) saveGame();
  }

  // Same as beginPlayerTurn but without recording a new undo point (used on restore)
  function resumePlayerTurn() {
    const { moves, forced } = genMoves(board, playerSide);
    if (moves.length === 0) return endGame(-playerSide);
    if (clock >= DRAW_PLIES) return endGame(0);
    activeMoves = moves;
    selected = null;
    midJump = false;
    setStatus(forced ? "Your move — capture!" : "Your move");
    render();
  }

  // Continue or complete a move to (r, c); returns true if one was played.
  // `instant` lands the piece immediately (drag-drop); otherwise it flies.
  function tryMove(r, c, instant) {
    const matches = activeMoves.filter((mv) =>
      (!midJump ? selected && mv.path[0][0] === selected[0] && mv.path[0][1] === selected[1] : true) &&
      mv.path[1][0] === r && mv.path[1][1] === c
    );
    if (!(selected || midJump) || !matches.length) return false;
    const from = midJump ? selected : matches[0].path[0];
    const pieceBefore = board[from[0]][from[1]];
    const isFinal = matches.every((mv) => mv.path.length === 2);
    const caps = matches[0].caps.length ? [matches[0].caps[0]] : [];
    const land = () => {
      applyMove(board, { path: [from, [r, c]], caps });
      lastPath = [from, [r, c]];
      if (isFinal) {
        const crowned = isMan(pieceBefore) && Math.abs(board[r][c]) === 2;
        clock = caps.length || isMan(pieceBefore) ? 0 : clock + 1;
        render();
        if (crowned) sfx.promote();
        else if (caps.length) sfx.capture();
        else sfx.land();
        finishPlayerMove();
      } else {
        // Mid multi-jump: locked to the same piece, keep going
        clock = 0;
        selected = [r, c];
        midJump = true;
        activeMoves = matches.map((mv) => ({ path: mv.path.slice(1), caps: mv.caps.slice(1) }));
        render();
        sfx.capture();
        setStatus("Keep jumping!");
      }
    };
    clearHints();
    if (instant) { land(); return true; }
    animating = true;
    const fromEl = cellMap[from[0] * 8 + from[1]];
    flyPiece(fromEl, cellMap[r * 8 + c], fromEl.innerHTML, () => {
      animating = false;
      land();
    }, 200);
    return true;
  }

  function onTap(r, c) {
    ensureAudio();
    if (thinking || animating || gameOver || turn !== playerSide || !overlay.classList.contains("hidden")) return;
    if (tryMove(r, c, false)) return;
    if (midJump) return; // locked into the jump sequence

    // (Re)select one of your pieces
    if (sideOf(board[r][c]) === playerSide && activeMoves.some((mv) => mv.path[0][0] === r && mv.path[0][1] === c)) {
      selected = [r, c];
    } else {
      selected = null;
    }
    render();
  }

  // ---------- Drag to move ----------
  let drag = null; // {id, from, x0, y0, active, ghost}

  function onDown(e, r, c) {
    if (drag) return; // ignore extra fingers while a drag is in flight
    onTap(r, c);
    // If that press selected (or is locked to) our piece, arm a drag so it
    // can also be carried straight to its landing square.
    if (selected && selected[0] === r && selected[1] === c && board[r][c] !== 0 &&
        !animating && !thinking && !gameOver && turn === playerSide) {
      drag = { id: e.pointerId, from: [r, c], x0: e.clientX, y0: e.clientY, active: false, ghost: null };
      try { boardEl.setPointerCapture(e.pointerId); } catch (err) { /* older Safari */ }
    }
  }

  function cellAt(e) {
    const br = boardEl.getBoundingClientRect();
    const col = Math.floor((e.clientX - br.left) / (br.width / 8));
    const row = Math.floor((e.clientY - br.top) / (br.height / 8));
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    const flip = playerSide === BLK;
    return [flip ? 7 - row : row, flip ? 7 - col : col];
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return; // still a tap
      drag.active = true;
      const srcEl = cellMap[drag.from[0] * 8 + drag.from[1]];
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.style.width = ghost.style.height = boardEl.getBoundingClientRect().width / 8 + "px";
      ghost.innerHTML = srcEl.innerHTML;
      boardEl.appendChild(ghost);
      if (srcEl.firstChild) srcEl.firstChild.style.opacity = "0.35"; // faint piece stays home
      drag.ghost = ghost;
    }
    const br = boardEl.getBoundingClientRect();
    const s = br.width / 8;
    drag.ghost.style.left = (e.clientX - br.left - s / 2) + "px";
    drag.ghost.style.top = (e.clientY - br.top - s / 2) + "px";
  }

  function onDragEnd(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.active) return; // plain tap — selection already handled on pointerdown
    d.ghost.remove();
    render(); // restore the lifted piece; selection + hints stay for tap play
    if (thinking || animating || gameOver || turn !== playerSide) return;
    const rc = cellAt(e);
    if (rc) tryMove(rc[0], rc[1], true); // an illegal drop just snaps the piece home
  }

  function onDragCancel(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.ghost) drag.ghost.remove();
    drag = null;
    render();
  }

  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
  window.addEventListener("pointercancel", onDragCancel);

  function finishPlayerMove() {
    selected = null;
    midJump = false;
    activeMoves = [];
    turn = aiSide;
    render();
    saveGame();
    aiTurn();
  }

  function aiTurn() {
    const { moves } = genMoves(board, aiSide);
    if (moves.length === 0) return endGame(playerSide);
    if (clock >= DRAW_PLIES) return endGame(0);
    thinking = true;
    setStatus("Thinking…");
    render();
    setTimeout(() => {
      const mv = aiPickMove(board, aiSide, prefs.level);
      const pieceBefore = board[mv.path[0][0]][mv.path[0][1]];
      clock = mv.caps.length || isMan(pieceBefore) ? 0 : clock + 1;
      lastPath = mv.path;
      animateAiMove(mv, pieceBefore, () => {
        thinking = false;
        turn = playerSide;
        beginPlayerTurn();
      });
    }, 60);
  }

  // Play out the AI's move one hop at a time so multi-jumps read clearly
  function animateAiMove(mv, pieceBefore, done) {
    let i = 0;
    const hop = () => {
      const [r0, c0] = mv.path[i];
      const [r1, c1] = mv.path[i + 1];
      const caps = mv.caps[i] ? [mv.caps[i]] : [];
      const fromEl = cellMap[r0 * 8 + c0];
      flyPiece(fromEl, cellMap[r1 * 8 + c1], fromEl.innerHTML, () => {
        applyMove(board, { path: [[r0, c0], [r1, c1]], caps });
        const crowned = isMan(pieceBefore) && Math.abs(board[r1][c1]) === 2;
        render();
        if (crowned) sfx.promote();
        else if (caps.length) sfx.capture();
        else sfx.land();
        i++;
        if (i + 1 < mv.path.length) setTimeout(hop, 90);
        else done();
      }, 200);
    };
    hop();
  }

  function endGame(winner) {
    gameOver = true;
    clearGameSave();
    const won = winner === playerSide;
    const msg = winner === 0 ? "Draw — no progress." : won ? "You win! 🏆" : "You lose. 💀";
    setStatus(msg);
    ovMsg.textContent = msg;
    render();
    // Let the result sink in before offering a new game — with a party if they won
    if (won) celebrate("You win! 🎉");
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      hideBanner();
      overlay.classList.remove("hidden");
    }, won ? 5000 : 1600);
  }

  function startGame() {
    clearTimeout(endTimer);
    hideBanner();
    board = newBoard();
    playerSide = prefs.side;
    aiSide = -prefs.side;
    turn = RED; // red always moves first
    clock = 0;
    thinking = false;
    gameOver = false;
    selected = null;
    midJump = false;
    activeMoves = [];
    lastPath = [];
    snapshots = [];
    overlay.classList.add("hidden");
    buildBoard();
    saveGame();
    if (turn === playerSide) beginPlayerTurn();
    else aiTurn();
  }

  function undoTurn() {
    if (thinking || animating || gameOver || turn !== playerSide || midJump || snapshots.length === 0) return;
    const snap = snapshots.pop();
    board = snap.bd.map((row) => row.slice());
    clock = snap.clock;
    lastPath = [];
    const { moves } = genMoves(board, playerSide);
    activeMoves = moves;
    selected = null;
    saveGame();
    setStatus("Your move");
    render();
  }

  // ---------- Setup UI ----------
  function refreshLvlLabel() { lvlLabel.textContent = LEVELS[prefs.level].label; }
  lvlSlider.value = prefs.level;
  refreshLvlLabel();
  lvlSlider.addEventListener("input", () => {
    prefs.level = parseInt(lvlSlider.value, 10);
    refreshLvlLabel();
    renderNames(prefs.side);
  });
  function setSide(side) {
    prefs.side = side;
    sideR.classList.toggle("on", side === RED);
    sideB.classList.toggle("on", side === BLK);
    renderNames(side);
  }
  sideR.addEventListener("click", () => setSide(RED));
  sideB.addEventListener("click", () => setSide(BLK));
  setSide(prefs.side);

  document.getElementById("start").addEventListener("click", () => {
    ensureAudio();
    savePrefs();
    startGame();
  });
  btnNew.addEventListener("click", () => {
    ovMsg.textContent = "English draughts vs a built-in engine. Captures are mandatory!";
    overlay.classList.remove("hidden");
  });
  btnUndo.addEventListener("click", undoTurn);

  // Boot: resume a saved game if one exists, otherwise show the menu
  const validBoard = (b) => Array.isArray(b) && b.length === 8 &&
    b.every((row) => Array.isArray(row) && row.length === 8 && row.every((v) => [-2, -1, 0, 1, 2].includes(v)));
  let resumed = false;
  try {
    const sv = JSON.parse(localStorage.getItem("checkers-game"));
    if (sv && validBoard(sv.board) && (sv.side === RED || sv.side === BLK) && (sv.turn === RED || sv.turn === BLK)) {
      board = sv.board.map((row) => row.slice());
      turn = sv.turn;
      clock = typeof sv.clock === "number" ? sv.clock : 0;
      playerSide = sv.side;
      aiSide = -playerSide;
      snapshots = Array.isArray(sv.snapshots) ? sv.snapshots : [];
      if (typeof sv.level === "number") {
        prefs.level = sv.level;
        lvlSlider.value = prefs.level;
        refreshLvlLabel();
      }
      setSide(playerSide);
      thinking = false; gameOver = false; midJump = false;
      selected = null; activeMoves = []; lastPath = [];
      overlay.classList.add("hidden");
      buildBoard();
      resumed = true;
      if (turn === playerSide) resumePlayerTurn();
      else aiTurn();
    }
  } catch (e) { /* corrupted save — fall through to the menu */ }
  if (!resumed) {
    board = newBoard();
    playerSide = prefs.side;
    turn = RED;
    buildBoard();
    setStatus("");
  }
})();
