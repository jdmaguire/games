(() => {
  "use strict";

  // Rules + negamax engine live in js/shared/connect4-engine.js. It's loaded as
  // a classic script here (for the rules gameplay needs) and spawned as a Worker
  // for the AI's search, so the search never runs on the main thread. The live
  // eval and the AI move share the Worker's transposition table, so no position
  // is ever searched twice.
  const { RED, YEL, ROWS, COLS, LEVELS, landingRow, winLine, aiPickMove } = window.Connect4Engine;

  const boardEl = document.getElementById("board");
  const discsEl = document.getElementById("discs");
  const colsEl = document.getElementById("cols");
  const statusEl = document.getElementById("status");
  const overlay = document.getElementById("overlay");
  const ovMsg = document.getElementById("ov-msg");
  const lvlSlider = document.getElementById("lvl");
  const lvlLabel = document.getElementById("lvl-label");
  const sideR = document.getElementById("side-r");
  const sideY = document.getElementById("side-y");
  const sideRand = document.getElementById("side-rand");
  const btnNew = document.getElementById("btn-new");
  const btnUndo = document.getElementById("btn-undo");
  const topName = document.getElementById("top-name");
  const botName = document.getElementById("bot-name");
  const evalEl = document.getElementById("eval");
  const evalFill = document.getElementById("eval-fill");
  const evalScoreEl = document.getElementById("eval-score");

  const MENU_MSG = "Drop discs and get four in a row before the robot does!";

  // "Show engine evaluation" toggle shared with chess & checkers
  let showEval = false;
  try { showEval = localStorage.getItem("engine-eval") === "1"; } catch (e) { /* private browsing */ }
  evalEl.hidden = true; // the menu overlay is up at boot; shown when a game starts

  // ---------- Preferences ----------
  let prefs = { level: 0, side: RED, random: false }; // default to the gentlest setting
  try {
    const saved = JSON.parse(localStorage.getItem("connect4-prefs"));
    if (saved && typeof saved.level === "number" && LEVELS[saved.level] && (saved.side === RED || saved.side === YEL)) {
      prefs = saved;
      prefs.random = !!prefs.random;
    }
  } catch (e) { /* private browsing */ }
  function savePrefs() {
    try { localStorage.setItem("connect4-prefs", JSON.stringify(prefs)); } catch (e) { /* private browsing */ }
  }

  // In-progress game persistence (saved at stable points between moves)
  function saveGame() {
    try {
      localStorage.setItem("connect4-game",
        JSON.stringify({ board, turn, side: playerSide, level: prefs.level, snapshots }));
    } catch (e) { /* private browsing */ }
  }
  function clearGameSave() {
    try { localStorage.removeItem("connect4-game"); } catch (e) { /* private browsing */ }
  }

  // ---------- Audio (synth lives in js/shared/audio.js; unlocked on first user gesture) ----------
  const { ensureAudio, beep, thud } = window.GameAudio;
  const sfx = {
    fall:    (ms) => beep(560, 170, Math.max(0.08, ms / 1000), "sine", 0.1), // whistle down with the disc
    land:    () => { thud(0.04, 0.18); beep(170, 115, 0.06, "sine", 0.25); },
    release: () => beep(330, null, 0.04, "square", 0.08), // the hand lets go
    full:    () => beep(150, null, 0.09, "square", 0.12), // tapped a full column
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

  // ---------- Engine worker ----------
  // The AI searches in a Worker (js/shared/connect4-engine.js), so the main
  // thread never blocks. Requests are { id, board, side, level, ms } → replies
  // { id, move }. Both the AI's move and the live eval go through here; they
  // share the Worker's transposition table, so the eval warms the AI's search.
  let engine = null;
  const engineWaiters = new Map(); // id -> { resolve, side, level, ms }
  let engineSeq = 0;               // monotonically increasing request id
  let engineDead = false;
  try {
    engine = new Worker("js/shared/connect4-engine.js");
  } catch (e) {
    engineDead = true; // file:// blocks workers — fall back to the sync engine
  }
  function syncSearch(side, level, ms) {
    try { return aiPickMove(board, side, level, ms); }
    catch (e) { return null; }
  }
  function askEngine(side, level, ms) {
    // Fallback for file://: the classic script above already loaded the same
    // engine, so search in-line instead of dying.
    if (!engine || engineDead) return Promise.resolve(syncSearch(side, level, ms));
    const id = ++engineSeq;
    const p = new Promise((resolve) => engineWaiters.set(id, { resolve, side, level, ms }));
    engine.postMessage({ id, board, side, level, ms });
    return p;
  }
  if (engine) {
    engine.onmessage = (e) => {
      const w = engineWaiters.get(e.data.id);
      if (w) { engineWaiters.delete(e.data.id); w.resolve(e.data.move); }
    };
    engine.onerror = () => {
      engineDead = true; // kill the worker; settle in-flight requests via the sync engine
      engine.terminate();
      for (const w of engineWaiters.values()) w.resolve(syncSearch(w.side, w.level, w.ms));
      engineWaiters.clear();
    };
  }

  // ---------- Live evaluation ----------
  // The eval bar shows a quick negamax score of the current position, searched
  // in the worker on the player's turn. It shares the engine's exact code path,
  // so the number matches what the AI plays — and it warms the transposition
  // table the AI's very next search reuses.
  const EVAL_LEVEL = 8; // LEVELS[8]: depth 14 — plenty to read the position
  const EVAL_MS = 300;  // short eval budget so a pending eval never delays the AI's move
  let evalScore = null; // side-to-move-relative; the eval only runs on the player's
                        // turn, so positive = good for the player
  let evalTimer = null;

  function resetEval() {
    evalScore = null;
    if (showEval) { evalFill.style.width = "50%"; evalScoreEl.textContent = "…"; }
  }

  function paintEval() {
    if (!showEval) return;
    if (evalScore === null) return resetEval();
    const mine = evalScore;
    const share = Math.max(3, Math.min(97, 100 / (1 + Math.exp(-0.01 * mine))));
    evalFill.style.width = share.toFixed(1) + "%";
    evalFill.style.background = playerSide === RED ? "#f87171" : "#facc15";
    evalScoreEl.textContent = mine >= 40000 ? "You can force a win!"
      : mine <= -40000 ? "The robot smells a win…"
      : (mine >= 0 ? "+" : "") + (mine / 100).toFixed(1);
  }

  function quickEval() {
    if (!showEval || gameOver || turn !== playerSide) return;
    const seq = gameSeq;
    askEngine(playerSide, EVAL_LEVEL, EVAL_MS).then((mv) => {
      if (seq !== gameSeq || gameOver || turn !== playerSide) return; // superseded
      if (mv && typeof mv.score === "number") {
        evalScore = mv.score;
        paintEval();
      }
    });
  }

  // Kick the analysis off just after the "Your move" frame has painted
  function scheduleEval() {
    if (!showEval || gameOver) return;
    clearTimeout(evalTimer);
    evalTimer = setTimeout(quickEval, 250);
  }

  // ---------- Game state ----------
  let board, turn, playerSide, aiSide, thinking, gameOver;
  let animating = false;
  let endTimer = null;
  let lastDrop = null;   // [r, c] of the freshest disc, for the marker dot
  let winCells = null;   // the winning cells to spotlight when someone connects
  let snapshots = [];    // undo stack: a board copy per completed player move
  let pendingSnap = null; // board copy taken at the start of the player's turn;
                          // pushed into snapshots when their move completes
  let gameSeq = 0;       // bumped on start/undo — stale engine replies are dropped
  let hand = null;       // the robot's hand element while its move plays out

  function newBoard() {
    return Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
  }

  // ---------- Board rendering ----------
  // #discs spans all 7×7 board units (staging lane + the 6 framed rows), so a
  // falling disc is visible in the open lane, then passes behind the frame and
  // shows through its punched holes. Geometry is built once — Connect Four has
  // no side to flip.
  const cellEls = []; // r * COLS + c -> positioned wrapper inside #discs
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const div = document.createElement("div");
      div.className = "cell";
      div.style.left = (c * 100 / COLS) + "%";
      div.style.top = ((r + 1) * 100 / 7) + "%";
      discsEl.appendChild(div);
      cellEls.push(div);
    }
  }
  for (let c = 0; c < COLS; c++) {
    const strip = document.createElement("div");
    strip.className = "colstrip";
    strip.addEventListener("pointerdown", (e) => { e.preventDefault(); onColumn(c); });
    colsEl.appendChild(strip);
  }

  function render() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = board[r][c];
        const last = lastDrop && lastDrop[0] === r && lastDrop[1] === c;
        const win = winCells && winCells.some(([wr, wc]) => wr === r && wc === c);
        cellEls[r * COLS + c].innerHTML = v === 0 ? "" :
          `<div class="pc ${v === RED ? "red" : "yel"}${last ? " last" : ""}${win ? " winline" : ""}"></div>`;
      }
    }
    boardEl.classList.toggle("busy", !!(thinking || animating || gameOver || turn !== playerSide));
    btnUndo.disabled = thinking || animating || gameOver || turn !== playerSide || snapshots.length === 0;
  }

  function setStatus(t) { statusEl.textContent = t; }

  // `side` is the colour the player has (or has picked in the menu)
  function renderNames(side) {
    boardEl.style.setProperty("--you", side === RED ? "var(--red)" : "var(--yel)");
    const cls = side === RED ? "red" : "yel";
    const youSub = !overlay.classList.contains("hidden") && prefs.random
      ? "Random"
      : (side === RED ? "Red" : "Yellow");
    botName.innerHTML = `<span class="dot ${cls}"></span>You` +
      `<span class="sub">${youSub}</span>`;
    topName.innerHTML = `<span class="dot ${cls === "red" ? "yel" : "red"}"></span>Computer` +
      `<span class="sub">Level ${prefs.level + 1}</span>`;
  }

  // ---------- Drop animation ----------
  // A dropped disc starts in the staging lane and accelerates down into place;
  // duration grows with the fall so short drops stay snappy.
  function dropDisc(col, row, side, done) {
    const seq = gameSeq;
    const ms = 60 + 45 * (row + 1);
    const cell = document.createElement("div");
    cell.className = "cell fall";
    cell.style.left = (col * 100 / COLS) + "%";
    cell.style.top = ((row + 1) * 100 / 7) + "%";
    cell.style.transitionDuration = ms + "ms";
    cell.style.transform = `translateY(${-(row + 1) * 100}%)`;
    cell.innerHTML = `<div class="pc ${side === RED ? "red" : "yel"}"></div>`;
    discsEl.appendChild(cell);
    sfx.fall(ms);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      cell.style.transform = "translateY(0)";
    }));
    setTimeout(() => {
      cell.remove();
      if (seq !== gameSeq) return; // a new game started mid-fall
      board[row][col] = side;
      lastDrop = [row, col];
      sfx.land();
      render();
      done();
    }, ms + 50);
  }

  // ---------- The robot's hand ----------
  // The AI's move plays out as a hand that appears over the middle of the lane
  // holding its disc, glides across to the chosen column, opens, and lets the
  // disc fall. Timings are tight on purpose — it should read, not dawdle.
  function animateAiMove(col, done) {
    const row = landingRow(board, col);
    const seq = gameSeq;
    const slide = Math.min(260, 90 + 40 * Math.abs(col - 3));
    const h = document.createElement("div");
    h.className = "hand";
    h.style.left = (3 * 100 / COLS) + "%";
    h.innerHTML = `<div class="pc ${aiSide === RED ? "red" : "yel"}"></div><span class="mitt">✊</span>`;
    boardEl.appendChild(h);
    hand = h;
    h.style.transition = "opacity 130ms ease, transform 130ms ease";
    requestAnimationFrame(() => requestAnimationFrame(() => h.classList.add("in")));
    setTimeout(() => { // glide over the chosen column (keep the fade-in props transitioning too)
      h.style.transition = `left ${slide}ms ease-in-out, opacity 130ms ease, transform 130ms ease`;
      h.style.left = (col * 100 / COLS) + "%";
    }, 150);
    setTimeout(() => { // open the hand and let the disc go
      if (seq !== gameSeq) { h.remove(); if (hand === h) hand = null; return; }
      h.querySelector(".mitt").textContent = "🖐";
      h.querySelector(".pc").style.visibility = "hidden"; // the falling copy takes over
      h.style.transition = "opacity 200ms ease, transform 200ms ease";
      h.classList.remove("in");
      h.classList.add("out");
      sfx.release();
      setTimeout(() => { h.remove(); if (hand === h) hand = null; }, 240);
      dropDisc(col, row, aiSide, () => done(row));
    }, 150 + slide + 110);
  }

  // ---------- Turn flow ----------
  function beginPlayerTurn() {
    pendingSnap = board.map((r) => r.slice());
    resumePlayerTurn();
    if (!gameOver) saveGame();
  }

  // Same as beginPlayerTurn but without re-arming an undo point (used on restore)
  function resumePlayerTurn() {
    if (board[0].every((v) => v !== 0)) return endGame(0);
    setStatus("Your move");
    render();
    scheduleEval();
  }

  function onColumn(col) {
    ensureAudio();
    if (thinking || animating || gameOver || turn !== playerSide || !overlay.classList.contains("hidden")) return;
    const row = landingRow(board, col);
    if (row < 0) return sfx.full();
    animating = true;
    render(); // greys the hover ghost while the disc is in flight
    dropDisc(col, row, playerSide, () => {
      animating = false;
      afterDrop(row, col, playerSide);
    });
  }

  // Shared post-landing bookkeeping for both sides
  function afterDrop(row, col, side) {
    const line = winLine(board, row, col);
    if (line) { winCells = line; return endGame(side); }
    if (board[0].every((v) => v !== 0)) return endGame(0);
    if (side === playerSide) {
      if (pendingSnap) snapshots.push(pendingSnap); // this move is now undoable
      pendingSnap = null;
      turn = aiSide;
      render();
      saveGame();
      aiTurn();
    } else {
      thinking = false;
      turn = playerSide;
      beginPlayerTurn();
    }
  }

  function aiTurn() {
    thinking = true;
    setStatus("Thinking…");
    render();
    const seq = gameSeq;
    askEngine(aiSide, prefs.level).then((mv) => {
      if (seq !== gameSeq) return; // a new game started while the engine searched
      if (!mv) return endGame(0);  // no legal move = the board is full
      animateAiMove(mv.col, (row) => afterDrop(row, mv.col, aiSide));
    });
  }

  // ---------- Game end / flow ----------
  function endGame(winner) {
    gameOver = true;
    thinking = false;
    clearTimeout(evalTimer);
    evalEl.hidden = true;
    clearGameSave();
    const won = winner === playerSide;
    const msg = winner === 0 ? "Draw — the board is full." : won ? "You win! 🏆" : "You lose. 💀";
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
  }

  function startGame() {
    clearTimeout(endTimer);
    hideBanner();
    if (hand) { hand.remove(); hand = null; }
    for (const el of discsEl.querySelectorAll(".fall")) el.remove();
    board = newBoard();
    playerSide = prefs.random ? (Math.random() < 0.5 ? RED : YEL) : prefs.side;
    aiSide = -playerSide;
    turn = RED; // red always moves first
    thinking = false;
    gameOver = false;
    animating = false;
    lastDrop = null;
    winCells = null;
    snapshots = [];
    pendingSnap = null;
    gameSeq++;
    overlay.classList.add("hidden");
    evalEl.hidden = !showEval;
    resetEval();
    renderNames(playerSide);
    render();
    saveGame();
    if (turn === playerSide) beginPlayerTurn();
    else aiTurn();
  }

  function undoTurn() {
    // Undo the whole last exchange (your move + the engine's reply) in one click,
    // like chess: each snapshot in the stack is one completed player move, so a
    // pop always lands back on your turn with the opposing move reverted too.
    if (thinking || animating || gameOver || turn !== playerSide || snapshots.length === 0) return;
    board = snapshots.pop().map((r) => r.slice());
    pendingSnap = board.map((r) => r.slice()); // the restored turn's pre-move state
    lastDrop = null;
    winCells = null;
    gameSeq++;
    saveGame();
    setStatus("Your move");
    render();
    scheduleEval();
  }

  // ---------- Input: keyboard ----------
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= COLS) onColumn(n - 1);
  });

  // ---------- Setup UI ----------
  function refreshLvlLabel() { lvlLabel.textContent = LEVELS[prefs.level].label; }
  lvlSlider.value = prefs.level;
  refreshLvlLabel();
  lvlSlider.addEventListener("input", () => {
    prefs.level = parseInt(lvlSlider.value, 10);
    refreshLvlLabel();
    renderNames(prefs.side);
    savePrefs();
  });
  function syncSideUI() {
    sideR.classList.toggle("on", !prefs.random && prefs.side === RED);
    sideY.classList.toggle("on", !prefs.random && prefs.side === YEL);
    sideRand.classList.toggle("on", prefs.random);
    renderNames(prefs.side);
  }
  function setSide(side) {
    if (side === RED || side === YEL) {
      prefs.side = side;
      prefs.random = false;
    } else {
      prefs.random = true;
    }
    syncSideUI();
  }
  sideR.addEventListener("click", () => setSide(RED));
  sideY.addEventListener("click", () => setSide(YEL));
  sideRand.addEventListener("click", () => setSide("rand"));
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
    ovMsg.textContent = MENU_MSG;
    overlay.classList.remove("hidden");
  });
  btnUndo.addEventListener("click", undoTurn);

  // Boot: resume a saved game if one exists, otherwise show the menu
  const validBoard = (b) => Array.isArray(b) && b.length === ROWS &&
    b.every((row) => Array.isArray(row) && row.length === COLS && row.every((v) => [-1, 0, 1].includes(v)));
  let resumed = false;
  try {
    const sv = JSON.parse(localStorage.getItem("connect4-game"));
    if (sv && validBoard(sv.board) && (sv.side === RED || sv.side === YEL) && (sv.turn === RED || sv.turn === YEL)) {
      board = sv.board.map((r) => r.slice());
      turn = sv.turn;
      playerSide = sv.side;
      aiSide = -playerSide;
      snapshots = (Array.isArray(sv.snapshots) ? sv.snapshots : []).filter(validBoard);
      if (typeof sv.level === "number" && LEVELS[sv.level]) {
        prefs.level = sv.level;
        lvlSlider.value = prefs.level;
        refreshLvlLabel();
        savePrefs(); // commit the resumed game's difficulty as the remembered one
      }
      prefs.side = playerSide;
      syncSideUI(); // keep a Random pick as-is; the concrete side is just the resumed game's
      thinking = false; gameOver = false; animating = false;
      lastDrop = null; winCells = null;
      pendingSnap = board.map((r) => r.slice()); // the resumed turn's pre-move state
      overlay.classList.add("hidden");
      evalEl.hidden = !showEval;
      resetEval();
      renderNames(playerSide);
      render();
      resumed = true;
      if (turn === playerSide) resumePlayerTurn();
      else aiTurn();
    }
  } catch (e) { /* corrupted save — fall through to the menu */ }
  if (!resumed) {
    board = newBoard();
    playerSide = prefs.side;
    turn = RED;
    renderNames(prefs.side);
    render();
    setStatus("");
  }
})();
