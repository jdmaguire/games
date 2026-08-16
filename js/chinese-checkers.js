(() => {
  "use strict";

  // Board geometry, rules (genMoves/applyMove), and the max-n search engine
  // live in js/shared/chinese-checkers-engine.js. It's loaded as a classic
  // script here (for the rules gameplay needs) and spawned as a Worker for the
  // AI's search, so the search never runs on the main thread.
  const { CELLS, CORNER, TRI, SEATS, LEVELS, targetOf, partnerOf, startBoard, genMoves, applyMove, winnerAfter, aiPickMove } =
    window.ChineseCheckersEngine;

  const HUMAN = 1; // the human always plays the bottom corner
  const NAMES = ["Red", "Orange", "Yellow", "Green", "Blue", "Purple"]; // by corner

  const boardEl = document.getElementById("board");
  const wrapEl = document.getElementById("wrap");
  const statusEl = document.getElementById("status");
  const seatsEl = document.getElementById("seats");
  const overlay = document.getElementById("overlay");
  const ovMsg = document.getElementById("ov-msg");
  const lvlSlider = document.getElementById("lvl");
  const lvlLabel = document.getElementById("lvl-label");
  const btnNew = document.getElementById("btn-new");
  const btnUndo = document.getElementById("btn-undo");
  const btnView = document.getElementById("btn-view");
  const playerBtns = { 2: document.getElementById("pl-2"), 3: document.getElementById("pl-3"),
                       4: document.getElementById("pl-4"), 6: document.getElementById("pl-6") };
  const teamsRow = document.getElementById("teams-row");
  const teamsOpt = document.getElementById("teams-opt");
  const OV_BLURB = "Race your marbles across the star — step to a neighbouring hole, " +
    "or chain hops over any marbles. You can't stop inside another colour's triangle. " +
    "First to fill the far triangle wins!";

  // ---------- Preferences ----------
  let prefs = { level: 0, players: 2, teams: false }; // default to the gentlest setting
  try {
    const saved = JSON.parse(localStorage.getItem("chinese-checkers-prefs"));
    if (saved && typeof saved.level === "number" && LEVELS[saved.level] && SEATS[saved.players]) {
      prefs = saved;
      prefs.teams = !!prefs.teams;
    }
  } catch (e) { /* private browsing */ }
  function savePrefs() {
    try { localStorage.setItem("chinese-checkers-prefs", JSON.stringify(prefs)); } catch (e) { /* private browsing */ }
  }

  // In-progress game persistence (saved at stable points between moves)
  function saveGame() {
    try {
      localStorage.setItem("chinese-checkers-game",
        JSON.stringify({ board, turn: seats[turnIdx], players: seats.length, teams, level: prefs.level, snapshots }));
    } catch (e) { /* private browsing */ }
  }
  function clearGameSave() {
    try { localStorage.removeItem("chinese-checkers-game"); } catch (e) { /* private browsing */ }
  }

  // ---------- Audio (synth lives in js/shared/audio.js; unlocked on first user gesture) ----------
  const { ensureAudio, beep, thud } = window.GameAudio;
  const sfx = {
    pick: () => beep(520, 380, 0.05, "sine", 0.09), // the robot's hand closing on a marble
    hop:  () => beep(760, 560, 0.05, "sine", 0.12), // each hop of a chain
    land: () => { thud(0.03, 0.12); beep(340, 220, 0.06, "sine", 0.22); },
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
  // The AI searches in a Worker (js/shared/chinese-checkers-engine.js), so the
  // main thread never blocks. Requests are { id, board, side, level, ms } →
  // replies { id, move }, the same protocol as checkers and Connect Four.
  let engine = null;
  const engineWaiters = new Map(); // id -> { resolve, side, level, ms }
  let engineSeq = 0;               // monotonically increasing request id
  let engineDead = false;
  try {
    engine = new Worker("js/shared/chinese-checkers-engine.js");
  } catch (e) {
    engineDead = true; // file:// blocks workers — fall back to the sync engine
  }
  function syncSearch(side, level, ms) {
    try { return aiPickMove(board, side, level, ms, teams); }
    catch (e) { return null; }
  }
  function askEngine(side, level, ms) {
    if (!engine || engineDead) return Promise.resolve(syncSearch(side, level, ms));
    const id = ++engineSeq;
    const p = new Promise((resolve) => engineWaiters.set(id, { resolve, side, level, ms }));
    engine.postMessage({ id, board, side, level, ms, teams });
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

  // ---------- Game state ----------
  let board, seats, turnIdx, thinking, gameOver;
  let teams = false;          // this game is opposite-corner pairs (4 or 6 players)
  let started = false;        // a real game has begun (guards the setup preview)
  let animating = false;
  let endTimer = null;
  let selected = null;        // cell index of the picked-up marble
  let activeMoves = [];       // the player's legal moves this turn
  let lastPath = [];          // holes to highlight from the previous move
  let snapshots = [];         // undo stack: a board copy per completed player move
  let pendingSnap = null;     // board copy taken at the start of the player's turn
  let gameSeq = 0;            // bumped on start/undo — stale engine replies are dropped

  const playerTurn = () => seats[turnIdx] === HUMAN;

  // ---------- Board layout & rendering ----------
  // Cube coords → the classic pointy-top hex layout. Everything is derived
  // from one unit: the distance between adjacent holes is √3.
  const SQ3 = Math.sqrt(3);
  const HOLE = 1.55; // hole diameter, in the same units
  const pos = CELLS.map(({ x, z }) => ({ px: SQ3 * (x + z / 2), py: 1.5 * z }));
  let minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
  for (const { px, py } of pos) {
    minPx = Math.min(minPx, px); maxPx = Math.max(maxPx, px);
    minPy = Math.min(minPy, py); maxPy = Math.max(maxPy, py);
  }
  const W = maxPx - minPx + HOLE, H = maxPy - minPy + HOLE;

  // The star-shaped board face: the true outline (6 tips + 6 notches of the
  // hexagram), scaled out a touch for a rim, clipped on a div that is itself
  // 16% bigger than the hole grid so the tips have room.
  const STAR_PTS = [
    [0, 12], [2 * SQ3, 6], [6 * SQ3, 6], [4 * SQ3, 0], [6 * SQ3, -6], [2 * SQ3, -6],
    [0, -12], [-2 * SQ3, -6], [-6 * SQ3, -6], [-4 * SQ3, 0], [-6 * SQ3, 6], [-2 * SQ3, 6],
  ];
  const starClip = "polygon(" + STAR_PTS.map(([vx, vy]) =>
    (50 + (vx * 1.19) / (W * 1.16) * 100).toFixed(2) + "% " +
    (50 + (vy * 1.19) / (H * 1.16) * 100).toFixed(2) + "%").join(", ") + ")";

  const cellEls = [];
  function buildBoard() {
    boardEl.innerHTML = "";
    cellEls.length = 0;
    boardEl.style.aspectRatio = W + " / " + H;
    const star = document.createElement("div");
    star.id = "star";
    star.style.clipPath = starClip;
    boardEl.appendChild(star);
    for (let i = 0; i < CELLS.length; i++) {
      const div = document.createElement("div");
      div.className = "hole" + (CORNER[i] >= 0 ? " h" + CORNER[i] : "");
      div.style.width = (HOLE / W * 100) + "%";
      div.style.height = (HOLE / H * 100) + "%";
      div.style.left = ((pos[i].px - minPx) / W * 100) + "%";
      div.style.top = ((pos[i].py - minPy) / H * 100) + "%";
      boardEl.appendChild(div);
      cellEls.push(div);
    }
    render();
  }

  // Nearest hole to a pointer event (holes are small, so the whole board is a
  // hit target and the closest centre within half a hole-spacing wins)
  function cellFromEvent(e) {
    const br = boardEl.getBoundingClientRect();
    const ux = (e.clientX - br.left) / br.width * W + minPx - HOLE / 2;
    const uy = (e.clientY - br.top) / br.height * H + minPy - HOLE / 2;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < pos.length; i++) {
      const dx = pos[i].px - ux, dy = pos[i].py - uy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD <= 0.75 ? best : -1; // (√3 / 2)² — inside one hole-spacing of a centre
  }

  const marbleHtml = (p) => `<div class="pc c${p - 1}"></div>`;

  function clearHints() {
    for (const div of cellEls) div.classList.remove("sel", "dot", "can");
  }

  function render() {
    const dots = new Set();
    const canSel = new Set();
    if (!thinking && !gameOver && playerTurn()) {
      for (const mv of activeMoves) {
        if (selected !== null && mv.from === selected) dots.add(mv.to);
        canSel.add(mv.from);
      }
    }
    const lastSet = new Set(lastPath);
    for (let i = 0; i < cellEls.length; i++) {
      const div = cellEls[i];
      const v = board[i];
      div.innerHTML = v !== 0 ? marbleHtml(v) : "";
      div.classList.toggle("sel", i === selected);
      div.classList.toggle("dot", dots.has(i) && v === 0);
      div.classList.toggle("can", canSel.has(i) && i !== selected);
      div.classList.toggle("last", lastSet.has(i));
    }
    btnUndo.disabled = thinking || animating || gameOver || !playerTurn() || snapshots.length === 0;
    renderSeats();
  }

  function setStatus(t) { statusEl.textContent = t; }

  // ---------- Seat chips ----------
  // One chip per player showing how many of their marbles are home, with the
  // side to move highlighted — the multi-player stand-in for checkers'
  // two player rows.
  function countHome(p) {
    let n = 0;
    for (const i of TRI[targetOf(p)]) if (board[i] === p) n++;
    return n;
  }

  function renderSeats() {
    const chip = (p) => {
      const active = started && !gameOver && seats[turnIdx] === p;
      return `<div class="chip${active ? " turn" : ""}"><span class="disc c${p - 1}"></span>` +
        `<span>${p === HUMAN ? "You" : NAMES[p - 1]}</span><span class="home">${countHome(p)}/10</span></div>`;
    };
    if (teams) {
      // Partners sit opposite: the first half of the seats each pair with
      // the seat whose home is their target
      const pairs = seats.slice(0, seats.length / 2).map((p) => [p, partnerOf(p)]);
      seatsEl.innerHTML = pairs.map((g) => `<div class="team">${g.map(chip).join("")}</div>`).join("");
    } else {
      seatsEl.innerHTML = seats.map(chip).join("");
    }
  }

  // ---------- Move animation ----------
  const RobotHand = window.RobotHand; // the engine's hand (js/shared/robot-hand.js)

  // The player's marble flies itself: one glide per hop of the chain, so a big
  // jump still reads one hop at a time.
  function flyPath(path, html, done) {
    const br = boardEl.getBoundingClientRect();
    const rects = path.map((i) => cellEls[i].getBoundingClientRect());
    const a = rects[0];
    const fly = document.createElement("div");
    fly.className = "fly";
    fly.style.width = a.width + "px";
    fly.style.height = a.height + "px";
    fly.style.left = (a.left - br.left) + "px";
    fly.style.top = (a.top - br.top) + "px";
    fly.innerHTML = html;
    boardEl.appendChild(fly);
    cellEls[path[0]].innerHTML = "";
    let i = 1;
    const glide = () => {
      const ms = Math.round(Math.min(360, 90 +
        55 * Math.hypot(rects[i].left - rects[i - 1].left, rects[i].top - rects[i - 1].top) / a.width));
      fly.style.transitionDuration = ms + "ms";
      fly.style.transform = `translate(${rects[i].left - a.left}px, ${rects[i].top - a.top}px)`;
      setTimeout(() => {
        if (i + 1 < rects.length) { sfx.hop(); i++; glide(); }
        else { fly.remove(); done(); }
      }, ms + 30);
    };
    requestAnimationFrame(() => requestAnimationFrame(glide));
  }

  // ---------- Player input ----------
  // Complete the move to hole `to` if it's legal; returns true if one played.
  // A turn is one choice of destination — hop chains are picked whole, so
  // there is no mid-jump state to track. `instant` lands the marble
  // immediately (drag-drop); otherwise it flies hop by hop.
  function tryMove(to, instant) {
    if (selected === null) return false;
    const mv = activeMoves.find((m) => m.from === selected && m.to === to);
    if (!mv) return false;
    const land = () => {
      applyMove(board, mv);
      lastPath = mv.path.slice();
      render();
      sfx.land();
      finishPlayerMove(mv);
    };
    clearHints();
    if (instant) { land(); return true; }
    animating = true;
    flyPath(mv.path, marbleHtml(HUMAN), () => {
      animating = false;
      land();
    });
    return true;
  }

  function onTap(i) {
    ensureAudio();
    if (thinking || animating || gameOver || !playerTurn() || !overlay.classList.contains("hidden")) return;
    if (tryMove(i, false)) return;
    // (Re)select one of your marbles
    if (board[i] === HUMAN && activeMoves.some((mv) => mv.from === i)) {
      selected = i;
    } else {
      selected = null;
    }
    render();
  }

  // ---------- Drag to move ----------
  let drag = null; // {id, from, x0, y0, active, ghost}

  boardEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const i = cellFromEvent(e);
    if (i < 0 || drag) return; // off the holes, or extra fingers mid-drag
    onTap(i);
    // If that press selected our marble, arm a drag so it can also be carried
    // straight to its landing hole.
    if (selected === i && board[i] === HUMAN &&
        !animating && !thinking && !gameOver && playerTurn()) {
      drag = { id: e.pointerId, from: i, x0: e.clientX, y0: e.clientY, active: false, ghost: null };
      try { boardEl.setPointerCapture(e.pointerId); } catch (err) { /* older Safari */ }
    }
  });

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return; // still a tap
      drag.active = true;
      const srcEl = cellEls[drag.from];
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      const s = boardEl.getBoundingClientRect().width * HOLE / W;
      ghost.style.width = ghost.style.height = s + "px";
      ghost.innerHTML = srcEl.innerHTML;
      boardEl.appendChild(ghost);
      if (srcEl.firstChild) srcEl.firstChild.style.opacity = "0.35"; // faint marble stays home
      drag.ghost = ghost;
    }
    const br = boardEl.getBoundingClientRect();
    const s = br.width * HOLE / W;
    drag.ghost.style.left = (e.clientX - br.left - s / 2) + "px";
    drag.ghost.style.top = (e.clientY - br.top - s / 2) + "px";
  }

  function onDragEnd(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.active) return; // plain tap — selection already handled on pointerdown
    d.ghost.remove();
    render(); // restore the lifted marble; selection + hints stay for tap play
    if (thinking || animating || gameOver || !playerTurn()) return;
    const i = cellFromEvent(e);
    if (i >= 0) tryMove(i, true); // an illegal drop just snaps the marble home
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

  // ---------- Turn flow ----------
  function beginPlayerTurn() {
    pendingSnap = board.slice();
    resumePlayerTurn();
    if (!gameOver) saveGame();
  }

  // Same as beginPlayerTurn but without re-arming an undo point (used on restore)
  function resumePlayerTurn() {
    activeMoves = genMoves(board, HUMAN);
    selected = null;
    if (activeMoves.length === 0) {
      // Effectively impossible on this board, but never strand the game
      setStatus("No moves — skipped!");
      render();
      setTimeout(() => { if (!gameOver) { advanceTurn(); nextTurn(); } }, 900);
      return;
    }
    setStatus("Your move");
    render();
  }

  function finishPlayerMove(mv) {
    if (pendingSnap) snapshots.push(pendingSnap); // this move is now undoable
    pendingSnap = null;
    selected = null;
    activeMoves = [];
    // winnerAfter (engine) covers the anti-blocking hand-over in free-for-all
    // games and the strict both-partners-home win in team games
    const w = winnerAfter(board, mv, HUMAN, teams);
    if (w) return endGame(w);
    advanceTurn();
    render();
    saveGame();
    nextTurn();
  }

  function advanceTurn() { turnIdx = (turnIdx + 1) % seats.length; }

  function nextTurn() {
    if (gameOver) return;
    if (playerTurn()) beginPlayerTurn();
    else aiTurn(seats[turnIdx]);
  }

  function aiTurn(p) {
    thinking = true;
    setStatus(NAMES[p - 1] + " is thinking…");
    render();
    const seq = gameSeq;
    askEngine(p, prefs.level).then((mv) => {
      if (seq !== gameSeq) return; // a new game started while the engine searched
      if (!mv) { // completely blocked (effectively impossible) — skip the turn
        thinking = false;
        advanceTurn();
        nextTurn();
        return;
      }
      lastPath = mv.path.slice();
      animateAiMove(p, mv, () => {
        thinking = false;
        const w = winnerAfter(board, mv, p, teams);
        if (w) return endGame(w);
        advanceTurn();
        saveGame();
        nextTurn();
      });
    });
  }

  // Play out the AI's move with the robot's hand (js/shared/robot-hand.js): it
  // picks the marble up, carries it through every hop of the chain, and sets
  // it down at the end.
  function animateAiMove(p, mv, done) {
    const fromEl = cellEls[mv.from];
    RobotHand.carry(wrapEl, mv.path.map((i) => cellEls[i]), marbleHtml(p), {
      onGrab: () => { fromEl.innerHTML = ""; sfx.pick(); },
      onHop: (i) => { if (i < mv.path.length - 1) sfx.hop(); }, // the last landing gets the land sound
      onPlace: () => {
        applyMove(board, mv);
        render(); // the marble is really down now
        sfx.land();
        done();
      },
    });
  }

  // ---------- Game end / flow ----------
  function endGame(winner) {
    gameOver = true;
    clearGameSave();
    // In a team game the winner id stands for its whole pair
    const winners = teams ? [winner, partnerOf(winner)] : [winner];
    const won = winners.includes(HUMAN);
    const msg = won
      ? (teams ? "Your team wins! 🏆" : "You win! 🏆")
      : winners.map((p) => NAMES[p - 1]).join(" & ") + (teams ? " win. 💀" : " wins. 💀");
    setStatus(msg);
    ovMsg.textContent = msg;
    render();
    // Let the result sink in before offering a new game — with a party if they won
    if (won) celebrate(teams ? "Team win! 🎉" : "You win! 🎉");
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      hideBanner();
      btnView.hidden = false; // a finished game is on the board — offer a look back
      overlay.classList.remove("hidden");
    }, won ? 5000 : 1600);
  }

  function startGame() {
    clearTimeout(endTimer);
    hideBanner();
    RobotHand.clear(); // a hand still mid-move belongs to the game being replaced
    board = startBoard(prefs.players);
    seats = SEATS[prefs.players].slice();
    teams = prefs.teams && (prefs.players === 4 || prefs.players === 6);
    turnIdx = 0; // the human moves first
    started = true;
    thinking = false;
    gameOver = false;
    selected = null;
    activeMoves = [];
    lastPath = [];
    snapshots = [];
    pendingSnap = null;
    gameSeq++;
    overlay.classList.add("hidden");
    buildBoard();
    saveGame();
    beginPlayerTurn();
  }

  function undoTurn() {
    // Undo the whole last exchange (your move + every robot's reply) in one
    // click: each snapshot is the board at the start of one of your turns.
    if (thinking || animating || gameOver || !playerTurn() || snapshots.length === 0) return;
    board = snapshots.pop().slice();
    turnIdx = 0;
    pendingSnap = board.slice(); // the restored turn's pre-move state
    lastPath = [];
    activeMoves = genMoves(board, HUMAN);
    selected = null;
    gameSeq++;
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
    savePrefs();
  });

  function syncPlayersUI() {
    for (const n of [2, 3, 4, 6]) playerBtns[n].classList.toggle("on", prefs.players === n);
    teamsRow.hidden = prefs.players !== 4 && prefs.players !== 6; // pairs need an even star
    teamsOpt.checked = prefs.teams;
  }
  function setPlayers(n) {
    prefs.players = n;
    syncPlayersUI();
    savePrefs();
    if (!started) { // preview the seating behind the menu
      board = startBoard(n);
      seats = SEATS[n].slice();
      teams = prefs.teams && (n === 4 || n === 6);
      turnIdx = 0;
      render();
    }
  }
  for (const n of [2, 3, 4, 6]) playerBtns[n].addEventListener("click", () => setPlayers(n));
  teamsOpt.addEventListener("change", () => {
    prefs.teams = teamsOpt.checked;
    savePrefs();
    if (!started) { // regroup the seat chips behind the menu
      teams = prefs.teams && (prefs.players === 4 || prefs.players === 6);
      render();
    }
  });
  syncPlayersUI();

  document.getElementById("start").addEventListener("click", () => {
    ensureAudio();
    savePrefs();
    startGame();
  });
  btnNew.addEventListener("click", () => {
    ovMsg.textContent = OV_BLURB;
    btnView.hidden = !gameOver;
    overlay.classList.remove("hidden");
  });
  btnUndo.addEventListener("click", undoTurn);
  // Step out of the menu to study the finished board; New Game brings it back
  btnView.addEventListener("click", () => overlay.classList.add("hidden"));

  // ---------- Boot: resume a saved game if one exists, otherwise show the menu ----------
  function validBoard(b, players) {
    if (!Array.isArray(b) || b.length !== CELLS.length || !SEATS[players]) return false;
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const v of b) {
      if (!Number.isInteger(v) || v < 0 || v > 6) return false;
      counts[v]++;
    }
    for (let p = 1; p <= 6; p++) {
      if (counts[p] !== (SEATS[players].includes(p) ? 10 : 0)) return false;
    }
    return true;
  }
  let resumed = false;
  try {
    const sv = JSON.parse(localStorage.getItem("chinese-checkers-game"));
    if (sv && validBoard(sv.board, sv.players) && SEATS[sv.players].includes(sv.turn)) {
      board = sv.board.slice();
      seats = SEATS[sv.players].slice();
      teams = sv.teams === true && (sv.players === 4 || sv.players === 6);
      turnIdx = seats.indexOf(sv.turn);
      snapshots = (Array.isArray(sv.snapshots) ? sv.snapshots : []).filter((b) => validBoard(b, sv.players));
      if (typeof sv.level === "number" && LEVELS[sv.level]) {
        prefs.level = sv.level;
        lvlSlider.value = prefs.level;
        refreshLvlLabel();
      }
      prefs.players = sv.players;
      prefs.teams = teams;
      syncPlayersUI();
      savePrefs(); // commit the resumed game's setup as the remembered one
      started = true;
      thinking = false;
      gameOver = false;
      selected = null;
      activeMoves = [];
      lastPath = [];
      pendingSnap = board.slice(); // the resumed turn's pre-move state
      overlay.classList.add("hidden");
      buildBoard();
      resumed = true;
      if (playerTurn()) resumePlayerTurn();
      else aiTurn(seats[turnIdx]);
    }
  } catch (e) { /* corrupted save — fall through to the menu */ }
  if (!resumed) {
    board = startBoard(prefs.players);
    seats = SEATS[prefs.players].slice();
    teams = prefs.teams && (prefs.players === 4 || prefs.players === 6);
    turnIdx = 0;
    buildBoard();
    setStatus("");
  }
})();
