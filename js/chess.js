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
  const sideR = document.getElementById("side-rand");
  const btnNew = document.getElementById("btn-new");
  const btnUndo = document.getElementById("btn-undo");
  const topName = document.getElementById("top-name");
  const botName = document.getElementById("bot-name");
  const topMat = document.getElementById("top-mat");
  const botMat = document.getElementById("bot-mat");
  const evalEl = document.getElementById("eval");
  const evalFill = document.getElementById("eval-fill");
  const evalScoreEl = document.getElementById("eval-score");

  const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  const VALUE = { q: 9, r: 5, b: 3, n: 3, p: 1 };
  const FILES = "abcdefgh";

  // "Show engine evaluation" toggle from the game-select screen
  let showEval = false;
  try { showEval = localStorage.getItem("engine-eval") === "1"; } catch (e) { /* private browsing */ }
  evalEl.hidden = true; // the menu overlay is up at boot; shown when a game starts

  // ---------- Preferences ----------
  let prefs = { elo: 200, side: "w", random: false }; // default to the gentlest setting
  try {
    const saved = JSON.parse(localStorage.getItem("chess-prefs"));
    if (saved && typeof saved.elo === "number") {
      prefs = saved;
      if (prefs.side !== "w" && prefs.side !== "b") prefs.side = "w";
      prefs.random = !!prefs.random;
    }
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

  // ---------- Audio (synth lives in js/shared/audio.js; unlocked on first user gesture) ----------
  const { ensureAudio, beep, thud } = window.GameAudio;
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

  // ---------- Win celebration (banner + confetti live in js/shared/celebrate.js) ----------
  const { showBanner, hideBanner, confetti } = window.GameCelebrate;
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
      if (showEval && line.includes(" score ")) parseScore(line);
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

  // ---------- Live evaluation ----------
  // The eval bar shows what Stockfish thinks of the current position, updated as
  // its search streams `info … score` lines. On the player's turn we keep the
  // engine analysing in the background (go infinite) and stop it before any move.
  let evalWhite = null; // white-relative centipawns (or ±1e6 when mate is known)
  let evalMate = null;  // white's mate-in count, signed (null = no mate found)
  let searchTurn = "w"; // side to move in the position currently being searched
  let analysisOn = false;

  function parseScore(line) {
    const cp = line.match(/score cp (-?\d+)/);
    const mate = line.match(/score mate (-?\d+)/);
    if (cp) {
      evalMate = null;
      evalWhite = searchTurn === "w" ? +cp[1] : -(+cp[1]);
    } else if (mate) {
      evalMate = searchTurn === "w" ? +mate[1] : -(+mate[1]);
      evalWhite = evalMate > 0 ? 1e6 : -1e6;
    } else {
      return;
    }
    paintEval();
  }

  function resetEval() {
    evalWhite = null;
    evalMate = null;
    if (showEval) { evalFill.style.width = "50%"; evalScoreEl.textContent = "…"; }
  }

  function paintEval() {
    if (!showEval) return;
    if (evalWhite === null) return resetEval();
    const mine = playerSide === "w" ? evalWhite : -evalWhite;    // player's advantage
    const mineMate = evalMate === null ? null
      : playerSide === "w" ? evalMate : -evalMate;               // signed, player to deliver
    // lichess's bar mapping: 1 pawn ≈ 59%, then it flattens as the edge grows
    const share = 100 / (1 + Math.exp(-0.00368208 * mine));
    evalFill.style.width = share.toFixed(1) + "%";
    evalFill.style.background = playerSide === "w" ? "#f1f5f9" : "#94a3b8";
    evalScoreEl.textContent = mineMate !== null
      ? (mineMate > 0 ? "M" : "m") + Math.abs(mineMate)
      : (mine >= 0 ? "+" : "") + (mine / 100).toFixed(1);
  }

  function startAnalysis() {
    if (!showEval || !engineOk || gameOver || thinking || animating) return;
    if (game.turn() !== playerSide || analysisOn) return;
    analysisOn = true;
    searchTurn = game.turn();
    engine.postMessage("position startpos" + (uciMoves.length ? " moves " + uciMoves.join(" ") : ""));
    engine.postMessage("go infinite");
  }

  // Send stop and drain the analysis's bestmove so the engine's own searches are
  // never confused with an analysis result. Safe to call when no analysis runs.
  // The 1.5s timeout guards against an infinite search that ends without ever
  // answering "stop" (seen around mating lines): a hung drain must never freeze
  // the engine's next move, and removing the waiter keeps a late reply from being
  // mistaken for the "go movetime" bestmove.
  function stopAnalysis() {
    if (!analysisOn) return Promise.resolve();
    analysisOn = false;
    engine.postMessage("stop");
    return drainBestmove();
  }

  function drainBestmove() {
    return new Promise((res) => {
      const entry = { pred: (l) => l.startsWith("bestmove"), res };
      waiters.push(entry);
      setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i !== -1) waiters.splice(i, 1);
        engine.postMessage("stop"); // force the abort again so the next "go movetime" is clean
        res(); // give up: the engine isn't going to answer
      }, 1500);
    });
  }

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
    const youSub = !overlay.classList.contains("hidden") && prefs.random
      ? "Random"
      : (side === "w" ? "White" : "Black");
    botName.innerHTML = `<span class="chip ${side}">${GLYPH.k}︎</span>You` +
      `<span class="sub">${youSub}</span>`;
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
    await stopAnalysis(); // the background analysis runs on the player's turn
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
        if (!checkGameEnd()) { setStatus("Your move"); startAnalysis(); }
      });
      return;
    }
    searchTurn = game.turn(); // the engine searches the current position, so its
    // info lines are the ongoing evaluation of the position it has to move in
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
      if (!checkGameEnd()) { setStatus("Your move"); startAnalysis(); }
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
    if (analysisOn) { analysisOn = false; engine.postMessage("stop"); } // free the worker
    resetEval();
    evalEl.hidden = true;
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
      syncSideUI();
    }, won ? 5000 : 1600);
    return true;
  }

  async function startGame() {
    if (!engineOk) return;
    clearTimeout(endTimer);
    hideBanner();
    playerSide = prefs.random ? (Math.random() < 0.5 ? "w" : "b") : prefs.side;
    game = new Chess();
    uciMoves = [];
    selected = null;
    legalTargets = [];
    lastMove = null;
    thinking = false;
    gameOver = false;
    overlay.classList.add("hidden");
    evalEl.hidden = !showEval;
    resetEval();
    saveGame();
    buildBoard();
    setStatus("Configuring engine…");
    await configureEngine(prefs.elo);
    if (playerSide === "b") engineMove();
    else { setStatus("Your move"); startAnalysis(); }
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
    prefs.side = saved.side;
    syncSideUI(); // keep a Random pick as-is; the concrete side is just the resumed game's
    prefs.elo = saved.elo;
    eloSlider.value = prefs.elo;
    refreshEloLabel();
    savePrefs(); // commit the resumed game's difficulty as the remembered one
    const last = uciMoves[uciMoves.length - 1];
    lastMove = last ? { from: last.slice(0, 2), to: last.slice(2, 4) } : null;
    selected = null;
    legalTargets = [];
    thinking = false;
    gameOver = false;
    overlay.classList.add("hidden");
    evalEl.hidden = !showEval;
    resetEval();
    buildBoard();
    setStatus("Configuring engine…");
    await configureEngine(prefs.elo);
    if (game.isGameOver()) { checkGameEnd(); return; }
    if (game.turn() !== playerSide) engineMove();
    else { setStatus("Your move"); startAnalysis(); }
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
    // Restart the analysis for the reverted position (it was analysing the old one)
    if (showEval) stopAnalysis().then(startAnalysis);
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
    savePrefs();
  });
  function syncSideUI() {
    sideW.classList.toggle("on", !prefs.random && prefs.side === "w");
    sideB.classList.toggle("on", !prefs.random && prefs.side === "b");
    sideR.classList.toggle("on", prefs.random);
    renderNames(prefs.side);
  }
  function setSide(side) {
    if (side === "w" || side === "b") {
      prefs.side = side;
      prefs.random = false;
    } else {
      prefs.random = true;
    }
    syncSideUI();
  }
  sideW.addEventListener("click", () => setSide("w"));
  sideB.addEventListener("click", () => setSide("b"));
  sideR.addEventListener("click", () => setSide("rand"));
  setSide(prefs.random ? "rand" : prefs.side);

  const evalOpt = document.getElementById("eval-opt");
  evalOpt.checked = showEval;
  evalOpt.addEventListener("change", () => {
    showEval = evalOpt.checked;
    try { localStorage.setItem("engine-eval", showEval ? "1" : "0"); } catch (e) { /* private browsing */ }
  });

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
