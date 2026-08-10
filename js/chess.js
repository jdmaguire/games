  // Resolved against this module's URL (js/), not the document's, so it needs the ../
  import { Chess } from "../lib/chess-1.4.0.mjs";

  const boardEl = document.getElementById("board");
  const statusEl = document.getElementById("status");
  const overlay = document.getElementById("overlay");
  const ovMsg = document.getElementById("ov-msg");
  const promoEl = document.getElementById("promo");
  const eloSlider = document.getElementById("elo");
  const eloLabel = document.getElementById("elo-label");
  const sideW = document.getElementById("side-w");
  const sideB = document.getElementById("side-b");
  const btnNew = document.getElementById("btn-new");
  const btnUndo = document.getElementById("btn-undo");
  const topName = document.getElementById("top-name");
  const botName = document.getElementById("bot-name");
  const topMat = document.getElementById("top-mat");
  const botMat = document.getElementById("bot-mat");

  const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  const VALUE = { q: 9, r: 5, b: 3, n: 3, p: 1 };
  const FILES = "abcdefgh";

  // ---------- Preferences ----------
  let prefs = { elo: 200, side: "w" }; // default to the gentlest setting
  try {
    const saved = JSON.parse(localStorage.getItem("chess-prefs"));
    if (saved && typeof saved.elo === "number") prefs = saved;
  } catch (e) { /* private browsing */ }
  function savePrefs() {
    try { localStorage.setItem("chess-prefs", JSON.stringify(prefs)); } catch (e) { /* private browsing */ }
  }

  // In-progress game persistence: the UCI move list fully reconstructs the position
  function saveGame() {
    try {
      localStorage.setItem("chess-game", JSON.stringify({ moves: uciMoves, side: playerSide, elo: prefs.elo }));
    } catch (e) { /* private browsing */ }
  }
  function clearGameSave() {
    try { localStorage.removeItem("chess-game"); } catch (e) { /* private browsing */ }
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
    land:    () => { thud(0.025, 0.12); beep(190, 140, 0.06, "sine", 0.3); },
    capture: () => { thud(0.06, 0.22); beep(130, 70, 0.1, "square", 0.16); },
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

  // ---------- Engine (Stockfish 18 lite, single-threaded WASM) ----------
  let engine = null;
  let engineOk = false;
  const waiters = [];
  function expect(pred) {
    return new Promise((res) => waiters.push({ pred, res }));
  }
  function initEngine() {
    try {
      engine = new Worker("engines/stockfish-18-lite-single.js");
    } catch (e) {
      statusEl.textContent = "Engine failed to load";
      ovMsg.textContent = "Couldn't start the engine. Serve this folder over HTTP (python3 -m http.server) — workers don't run from file:// URLs.";
      return;
    }
    engine.onmessage = (e) => {
      const line = String(e.data);
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].pred(line)) { waiters.splice(i, 1)[0].res(line); return; }
      }
    };
    engine.onerror = () => {
      engineOk = false;
      statusEl.textContent = "Engine error";
      ovMsg.textContent = "The engine crashed or failed to load its .wasm file. Serve this folder over HTTP and check engines/ is present.";
      overlay.classList.remove("hidden");
    };
    engine.postMessage("uci");
    expect((l) => l === "uciok").then(() => { engineOk = true; });
  }
  initEngine();

  async function configureEngine(elo) {
    // Stockfish's calibrated Elo floor is 1320; below that, fall back to Skill Level
    if (elo >= 1320) {
      engine.postMessage("setoption name UCI_LimitStrength value true");
      engine.postMessage("setoption name UCI_Elo value " + elo);
    } else {
      engine.postMessage("setoption name UCI_LimitStrength value false");
      const skill = Math.max(0, Math.min(7, Math.floor((elo - 600) / 100)));
      engine.postMessage("setoption name Skill Level value " + skill);
    }
    engine.postMessage("ucinewgame");
    engine.postMessage("isready");
    await expect((l) => l === "readyok");
  }

  function moveTimeMs(elo) {
    return Math.round(Math.max(80, 150 + ((elo - 600) / 2250) * 850)); // 80ms weakest -> 1000ms strongest
  }

  // Below ~900 Elo the engine can't get weak enough on its own, so we blend in
  // random legal moves: ~88% random at 200 Elo (a true beginner's opponent), 0% at 900+.
  function randomMoveChance(elo) {
    return Math.max(0, Math.min(0.9, (900 - elo) / 800));
  }

  // ---------- Game state ----------
  let game = new Chess();
  let uciMoves = [];
  let playerSide = "w";
  let selected = null;      // square like "e2"
  let legalTargets = [];    // verbose moves for the selected piece
  let lastMove = null;      // {from, to}
  let thinking = false;
  let animating = false;
  let gameOver = false;
  let endTimer = null;

  // ---------- Board rendering ----------
  const squares = {};
  function buildBoard() {
    boardEl.innerHTML = "";
    const flip = playerSide === "b";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const r = flip ? 7 - row : row;       // 0 = rank 8
        const c = flip ? 7 - col : col;
        const sq = FILES[c] + (8 - r);
        const div = document.createElement("div");
        div.className = "sq " + ((r + c) % 2 === 0 ? "light" : "dark");
        div.dataset.sq = sq;
        div.addEventListener("pointerdown", (e) => { e.preventDefault(); onSquareDown(e, sq); });
        boardEl.appendChild(div);
        squares[sq] = div;
      }
    }
    renderNames(playerSide);
    render();
  }

  function render() {
    const pos = {};
    for (const row of game.board()) {
      for (const cell of row) {
        if (cell) pos[cell.square] = cell;
      }
    }
    let checkSq = null;
    if (game.inCheck()) {
      for (const [sq, cell] of Object.entries(pos)) {
        if (cell.type === "k" && cell.color === game.turn()) checkSq = sq;
      }
    }
    for (const [sq, div] of Object.entries(squares)) {
      const cell = pos[sq];
      div.innerHTML = cell
        ? `<span class="pc ${cell.color}">${GLYPH[cell.type]}︎</span>`
        : "";
      div.classList.toggle("sel", sq === selected);
      div.classList.toggle("last", !!lastMove && (sq === lastMove.from || sq === lastMove.to));
      div.classList.toggle("chk", sq === checkSq);
      const target = legalTargets.find((m) => m.to === sq);
      div.classList.toggle("dot", !!target && !pos[sq]);
      div.classList.toggle("cap", !!target && !!pos[sq]);
    }
    btnUndo.disabled = thinking || animating || gameOver || game.turn() !== playerSide || uciMoves.length < 2;
    renderMaterial();
  }

  function setStatus(text) { statusEl.textContent = text; }

  // ---------- Material counter ----------
  // Both the captured glyphs and the points come from the same per-type surplus
  // on the board, so a promotion reads consistently (the promoter "loses" a pawn
  // and shows an extra queen) instead of the two disagreeing.
  function materialDiff() {
    const count = { w: {}, b: {} };
    for (const row of game.board()) {
      for (const cell of row) {
        if (cell && cell.type !== "k") count[cell.color][cell.type] = (count[cell.color][cell.type] || 0) + 1;
      }
    }
    const taken = { w: [], b: [] }; // taken[side] = the opponent pieces that side is up
    let score = 0;                  // positive = white ahead
    for (const t of ["q", "r", "b", "n", "p"]) {
      const d = (count.w[t] || 0) - (count.b[t] || 0);
      score += d * VALUE[t];
      const side = d > 0 ? "w" : "b";
      for (let i = 0; i < Math.abs(d); i++) taken[side].push(t);
    }
    return { taken, score };
  }

  function paintMaterial(el, types, net, pieceColor) {
    el.innerHTML = types.map((t) => `<span class="tk ${pieceColor}">${GLYPH[t]}︎</span>`).join("") +
      (net > 0 ? `<span class="adv">+${net}</span>` : "");
  }

  function renderMaterial() {
    const opp = playerSide === "w" ? "b" : "w";
    const { taken, score } = materialDiff();
    const mine = playerSide === "w" ? score : -score;
    paintMaterial(botMat, taken[playerSide], mine, opp);
    paintMaterial(topMat, taken[opp], -mine, playerSide);
  }

  // `side` is the colour shown on the bottom row: the live game's side once a game
  // is running, otherwise whatever is picked in the menu.
  function renderNames(side) {
    const opp = side === "w" ? "b" : "w";
    botName.innerHTML = `<span class="chip ${side}">${GLYPH.k}︎</span>You` +
      `<span class="sub">${side === "w" ? "White" : "Black"}</span>`;
    topName.innerHTML = `<span class="chip ${opp}">${GLYPH.k}︎</span>Stockfish` +
      `<span class="sub">${prefs.elo} Elo</span>`;
  }

  // ---------- Player input ----------
  function onSquareTap(sq) {
    ensureAudio();
    if (thinking || animating || gameOver || !overlay.classList.contains("hidden")) return;
    if (game.turn() !== playerSide) return;

    const target = legalTargets.find((m) => m.to === sq);
    if (selected && target) {
      const promos = legalTargets.filter((m) => m.to === sq && m.promotion);
      if (promos.length) return showPromoPicker(selected, sq);
      return playerMove({ from: selected, to: sq });
    }
    // (re)select own piece
    const piece = game.get(sq);
    if (piece && piece.color === playerSide) {
      selected = sq;
      legalTargets = game.moves({ square: sq, verbose: true });
    } else {
      selected = null;
      legalTargets = [];
    }
    render();
  }

  // ---------- Drag to move ----------
  let drag = null; // {id, from, x0, y0, active, ghost}

  function onSquareDown(e, sq) {
    if (drag) return; // ignore extra fingers while a drag is in flight
    onSquareTap(sq);
    // If that press selected one of our pieces, arm a drag so it can also
    // be carried straight to its target square.
    if (selected === sq && !animating && !thinking && !gameOver) {
      drag = { id: e.pointerId, from: sq, x0: e.clientX, y0: e.clientY, active: false, ghost: null };
      try { boardEl.setPointerCapture(e.pointerId); } catch (err) { /* older Safari */ }
    }
  }

  function squareAt(e) {
    const br = boardEl.getBoundingClientRect();
    const col = Math.floor((e.clientX - br.left) / (br.width / 8));
    const row = Math.floor((e.clientY - br.top) / (br.height / 8));
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    const flip = playerSide === "b";
    const r = flip ? 7 - row : row;
    const c = flip ? 7 - col : col;
    return FILES[c] + (8 - r);
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return; // still a tap
      drag.active = true;
      const srcEl = squares[drag.from];
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
    if (thinking || animating || gameOver) return;
    const sq = squareAt(e);
    const target = sq && legalTargets.find((m) => m.to === sq);
    if (!target) return; // dropped somewhere illegal — the piece snaps home
    const promos = legalTargets.filter((m) => m.to === sq && m.promotion);
    if (promos.length) return showPromoPicker(d.from, sq);
    playerMove({ from: d.from, to: sq }, true);
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

  function showPromoPicker(from, to) {
    promoEl.innerHTML = "";
    for (const p of ["q", "r", "b", "n"]) {
      const b = document.createElement("button");
      b.innerHTML = `<span class="pc ${playerSide}">${GLYPH[p]}︎</span>`;
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        promoEl.classList.remove("show");
        playerMove({ from, to, promotion: p });
      });
      promoEl.appendChild(b);
    }
    promoEl.classList.add("show");
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
    for (const div of Object.values(squares)) div.classList.remove("sel", "dot", "cap");
  }

  function rookSquares(made) {
    if (made.flags.includes("k")) return made.color === "w" ? ["h1", "f1"] : ["h8", "f8"];
    if (made.flags.includes("q")) return made.color === "w" ? ["a1", "d1"] : ["a8", "d8"];
    return null;
  }

  // The move is already applied to `game`; the DOM still shows the old position,
  // so fly the piece from its old square, then re-render and play the landing sound.
  function animateMade(made, done, instant) {
    animating = true;
    clearHints();
    if (instant) { // drag-drop: the piece was carried there by hand, just land it
      animating = false;
      render();
      if (made.promotion) sfx.promote();
      else if (made.captured) sfx.capture();
      else sfx.land();
      done();
      return;
    }
    const rook = rookSquares(made);
    if (rook) flyPiece(squares[rook[0]], squares[rook[1]], squares[rook[0]].innerHTML, null, 180);
    flyPiece(squares[made.from], squares[made.to], squares[made.from].innerHTML, () => {
      animating = false;
      render();
      if (made.promotion) sfx.promote();
      else if (made.captured) sfx.capture();
      else sfx.land();
      done();
    }, 180);
  }

  function playerMove(mv, instant) {
    const made = game.move(mv);
    uciMoves.push(made.from + made.to + (made.promotion || ""));
    lastMove = { from: made.from, to: made.to };
    selected = null;
    legalTargets = [];
    saveGame();
    animateMade(made, () => {
      if (checkGameEnd()) return;
      engineMove();
    }, instant);
  }

  // ---------- Engine turn ----------
  async function engineMove() {
    thinking = true;
    setStatus("Thinking…");
    render();
    if (Math.random() < randomMoveChance(prefs.elo)) {
      await new Promise((res) => setTimeout(res, 350 + Math.random() * 400)); // pretend to think
      const opts = game.moves({ verbose: true });
      const pick = opts[Math.floor(Math.random() * opts.length)];
      thinking = false;
      const made = game.move({ from: pick.from, to: pick.to, promotion: pick.promotion });
      uciMoves.push(made.from + made.to + (made.promotion || ""));
      lastMove = { from: made.from, to: made.to };
      saveGame();
      animateMade(made, () => {
        if (!checkGameEnd()) setStatus("Your move");
      });
      return;
    }
    engine.postMessage("position startpos" + (uciMoves.length ? " moves " + uciMoves.join(" ") : ""));
    engine.postMessage("go movetime " + moveTimeMs(prefs.elo));
    const line = await expect((l) => l.startsWith("bestmove"));
    thinking = false;
    const uci = line.split(/\s+/)[1];
    if (!uci || uci === "(none)") { checkGameEnd(); return; }
    const made = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
    uciMoves.push(uci);
    lastMove = { from: made.from, to: made.to };
    saveGame();
    animateMade(made, () => {
      if (!checkGameEnd()) setStatus("Your move");
    });
  }

  // ---------- Game end / flow ----------
  function checkGameEnd() {
    if (!game.isGameOver()) {
      if (game.inCheck() && game.turn() === playerSide) setStatus("Check!");
      else if (game.turn() === playerSide) setStatus("Your move");
      return false;
    }
    gameOver = true;
    clearGameSave();
    const won = game.isCheckmate() && game.turn() !== playerSide;
    let msg;
    if (game.isCheckmate()) {
      msg = won ? "Checkmate — you win! 🏆" : "Checkmate — you lose. 💀";
    } else if (game.isStalemate()) {
      msg = "Stalemate — draw.";
    } else if (game.isThreefoldRepetition()) {
      msg = "Draw by repetition.";
    } else if (game.isInsufficientMaterial()) {
      msg = "Draw — insufficient material.";
    } else {
      msg = "Draw.";
    }
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
    return true;
  }

  async function startGame() {
    if (!engineOk) return;
    clearTimeout(endTimer);
    hideBanner();
    playerSide = prefs.side;
    game = new Chess();
    uciMoves = [];
    selected = null;
    legalTargets = [];
    lastMove = null;
    thinking = false;
    gameOver = false;
    overlay.classList.add("hidden");
    saveGame();
    buildBoard();
    setStatus("Configuring engine…");
    await configureEngine(prefs.elo);
    if (playerSide === "b") engineMove();
    else setStatus("Your move");
  }

  // Restore an in-progress game after a refresh
  async function resumeGame(saved) {
    const g = new Chess();
    try {
      for (const uci of saved.moves) {
        g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
      }
    } catch (e) {
      clearGameSave(); // corrupted save — fall back to the menu
      buildBoard();
      setStatus("");
      return;
    }
    game = g;
    uciMoves = saved.moves.slice();
    playerSide = saved.side;
    setSide(saved.side);
    prefs.elo = saved.elo;
    eloSlider.value = prefs.elo;
    refreshEloLabel();
    const last = uciMoves[uciMoves.length - 1];
    lastMove = last ? { from: last.slice(0, 2), to: last.slice(2, 4) } : null;
    selected = null;
    legalTargets = [];
    thinking = false;
    gameOver = false;
    overlay.classList.add("hidden");
    buildBoard();
    setStatus("Configuring engine…");
    await configureEngine(prefs.elo);
    if (game.isGameOver()) { checkGameEnd(); return; }
    if (game.turn() !== playerSide) engineMove();
    else setStatus("Your move");
  }

  function undoPair() {
    if (thinking || gameOver || game.turn() !== playerSide || uciMoves.length < 2) return;
    game.undo(); game.undo();
    uciMoves.pop(); uciMoves.pop();
    const hist = game.history({ verbose: true });
    lastMove = hist.length ? { from: hist[hist.length - 1].from, to: hist[hist.length - 1].to } : null;
    selected = null;
    legalTargets = [];
    saveGame();
    render();
    setStatus("Your move");
  }

  // ---------- Setup UI ----------
  function eloDesc(elo) {
    if (elo < 450) return "First games — great for kids";
    if (elo < 800) return "Beginner";
    if (elo < 1100) return "Casual";
    if (elo < 1400) return "Club player";
    if (elo < 1700) return "Strong club";
    if (elo < 2000) return "Expert";
    if (elo < 2300) return "Master";
    if (elo < 2600) return "Grandmaster";
    return "Superhuman";
  }
  function refreshEloLabel() {
    eloLabel.textContent = `${prefs.elo} Elo — ${eloDesc(prefs.elo)}`;
    if (prefs.elo < 1320) eloLabel.textContent += " (approx.)";
  }
  eloSlider.value = prefs.elo;
  refreshEloLabel();
  eloSlider.addEventListener("input", () => {
    prefs.elo = parseInt(eloSlider.value, 10);
    refreshEloLabel();
    renderNames(prefs.side);
  });
  function setSide(side) {
    prefs.side = side;
    sideW.classList.toggle("on", side === "w");
    sideB.classList.toggle("on", side === "b");
    renderNames(side);
  }
  sideW.addEventListener("click", () => setSide("w"));
  sideB.addEventListener("click", () => setSide("b"));
  setSide(prefs.side);

  document.getElementById("start").addEventListener("click", () => {
    ensureAudio();
    savePrefs();
    startGame();
  });
  btnNew.addEventListener("click", () => {
    ovMsg.textContent = "Play against Stockfish 18, right in your browser.";
    overlay.classList.remove("hidden");
  });
  btnUndo.addEventListener("click", undoPair);

  // Boot: resume a saved game if one exists, otherwise show the menu
  let resumed = false;
  try {
    const savedGame = JSON.parse(localStorage.getItem("chess-game"));
    if (engine && savedGame && Array.isArray(savedGame.moves) &&
        savedGame.moves.every((m) => typeof m === "string") &&
        (savedGame.side === "w" || savedGame.side === "b")) {
      if (typeof savedGame.elo !== "number") savedGame.elo = prefs.elo;
      resumed = true;
      resumeGame(savedGame);
    }
  } catch (e) { /* corrupted save — fall through to the menu */ }
  if (!resumed) {
    playerSide = prefs.side; // keeps the menu's pick and the player rows in agreement
    buildBoard();
    setStatus("");
  }
