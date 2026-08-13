(() => {
  "use strict";

  // --- Tuning ---
  const DIFFS = {
    easy:   { cols: 9,  rows: 9,  mines: 10 },
    medium: { cols: 16, rows: 16, mines: 40 },
    hard:   { cols: 16, rows: 30, mines: 99 },
  };
  const LONG_PRESS_MS = 450; // hold to flag on touch
  const TAP_SLOP = 12;       // px of finger travel that still counts as a tap
  const NUM_COLORS = ["", "#60a5fa", "#4ade80", "#f87171", "#c084fc", "#fb923c", "#2dd4bf", "#f1f5f9", "#94a3b8"];

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const minesEl = document.getElementById("mines");
  const timeEl = document.getElementById("time");
  const faceEl = document.getElementById("face");
  const flagModeEl = document.getElementById("flag-mode");
  const overlay = document.getElementById("overlay");
  const overlayTitle = document.getElementById("overlay-title");
  const overlayScore = document.getElementById("overlay-score");
  const overlayHint = document.getElementById("overlay-hint");
  const viewBoardEl = document.getElementById("view-board");

  // roundRect shipped in Safari 16; fall back to plain rects before that
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) {
      this.rect(x, y, w, h);
    };
  }

  const isTouch = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  const startHint = isTouch
    ? "Tap a square to clear it.<br>Press and hold to plant a flag."
    : "Click to clear, right-click to flag.<br>Or use arrows / WASD + Space / F.";
  if (isTouch) flagModeEl.hidden = false;

  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // --- Audio (unlocked by the first real gesture, or iOS stays silent) ---
  const GA = window.GameAudio;
  const sfx = {
    reveal: () => GA.beep(440, 560, 0.05, "triangle", 0.05),
    flag: () => GA.beep(660, 880, 0.06, "square", 0.05),
    unflag: () => GA.beep(880, 660, 0.06, "square", 0.04),
    win: () => [0, 1, 2, 3, 4].forEach((i) => GA.beep(523 * Math.pow(2, i / 2), null, 0.14, "square", 0.05, i * 0.1)),
    lose: () => { GA.beep(300, 80, 0.4, "sawtooth", 0.07); GA.thud(0.25, 0.12); },
  };

  // --- State ---
  // state: "idle" | "playing" | "won" | "lost"
  let diff = "easy";
  let COLS, ROWS, MINES;
  let grid = [];    // grid[y][x] = { mine, adj, revealed, flag, hit }
  let revealed = 0; // count of cleared safe cells
  let flags = 0;
  let cursor = { x: 0, y: 0 };
  let started = false; // mines placed and the timer running
  let startTime = 0;
  let pausedAt = null;
  let seconds = 0;
  let over = false;
  let state = "idle";
  let flagMode = false;
  let dirty = true;
  let overlayTimer = null; // delays the win/lost screen so the final field shows first

  let best = { easy: 0, medium: 0, hard: 0 };
  try {
    const b = JSON.parse(localStorage.getItem("minesweeper-best"));
    if (b) for (const k of ["easy", "medium", "hard"]) {
      if (typeof b[k] === "number" && b[k] > 0) best[k] = b[k];
    }
  } catch (e) { /* private browsing */ }

  // --- Sizing (crisp on retina, fits any viewport) ---
  let cell = 0;

  // Keep the board's long side along the screen's long side (hard is 16×30),
  // transposing a game in progress so rotating the device never strands a
  // tall board on a wide screen. A transpose keeps every cell's neighbours.
  function orient() {
    const landscape = window.innerWidth > window.innerHeight;
    if ((landscape && ROWS > COLS) || (!landscape && COLS > ROWS)) {
      if (grid.length) grid = grid[0].map((_, x) => grid.map((row) => row[x]));
      [COLS, ROWS] = [ROWS, COLS];
      [cursor.x, cursor.y] = [cursor.y, cursor.x];
    }
  }

  function resize() {
    orient();
    const hudSpace = 128;
    const maxW = Math.min(window.innerWidth, document.documentElement.clientWidth) - 24;
    const maxH = window.innerHeight - hudSpace - 24;
    cell = Math.max(8, Math.min(48, Math.floor(maxW / COLS), Math.floor(maxH / ROWS)));
    const w = cell * COLS, h = cell * ROWS;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  }

  // Map a pointer position to its board square, if it lands on the board.
  function cellFromEvent(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = Math.floor(((clientX - r.left) / r.width) * COLS);
    const y = Math.floor(((clientY - r.top) / r.height) * ROWS);
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return null;
    return { x, y };
  }

  // --- Game setup ---
  function newBoard() {
    grid = [];
    for (let y = 0; y < ROWS; y++) {
      grid[y] = [];
      for (let x = 0; x < COLS; x++) {
        grid[y][x] = { mine: false, adj: 0, revealed: false, flag: false, hit: false };
      }
    }
    revealed = 0;
    flags = 0;
    started = false;
    over = false;
    pausedAt = null;
    seconds = 0;
    startTime = 0;
    timeEl.textContent = "0";
    minesEl.textContent = MINES;
    faceEl.textContent = "🙂";
    cursor = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
    dirty = true;
  }

  // Mines are placed on the first reveal, with the clicked square and its
  // neighbours guaranteed clear — first-click safety, modern-minesweeper style.
  function placeMines(safeX, safeY) {
    const safe = new Set();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = safeX + dx, y = safeY + dy;
        if (x >= 0 && x < COLS && y >= 0 && y < ROWS) safe.add(y * COLS + x);
      }
    }
    let placed = 0;
    while (placed < MINES) {
      const x = Math.floor(Math.random() * COLS);
      const y = Math.floor(Math.random() * ROWS);
      if (grid[y][x].mine || safe.has(y * COLS + x)) continue;
      grid[y][x].mine = true;
      placed++;
    }
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!grid[y][x].mine) grid[y][x].adj = countMines(x, y);
      }
    }
  }

  function countMines(x, y) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && grid[ny][nx].mine) n++;
      }
    }
    return n;
  }

  function flagAdjacent(x, y) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && grid[ny][nx].flag) n++;
      }
    }
    return n;
  }

  // Reveal one square, flooding through empty cells. A mine ends the game.
  function reveal(x, y) {
    const c = grid[y][x];
    if (c.revealed || c.flag) return;
    c.revealed = true;
    if (c.mine) return lose(x, y);
    revealed++;
    if (c.adj === 0) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) reveal(nx, ny);
        }
      }
    }
    if (revealed === COLS * ROWS - MINES) win();
  }

  // Chord: a revealed number with all its mines flagged clears the rest.
  function chord(x, y) {
    const c = grid[y][x];
    if (!c.revealed || c.adj === 0 || flagAdjacent(x, y) !== c.adj) return;
    sfx.reveal();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && !grid[ny][nx].revealed && !grid[ny][nx].flag) {
          reveal(nx, ny);
        }
      }
    }
  }

  function toggleFlag(x, y) {
    if (over) return;
    if (x >= COLS || y >= ROWS) return; // long-press cell captured before a rotation transposed the board
    const c = grid[y][x];
    if (c.revealed) return;
    c.flag = !c.flag;
    flags += c.flag ? 1 : -1;
    minesEl.textContent = Math.max(0, MINES - flags);
    sfx[c.flag ? "flag" : "unflag"]();
    dirty = true;
  }

  // --- Match flow ---
  function start() {
    clearTimeout(overlayTimer); // a restart during the delay must not pop the old result
    newBoard();
    state = "playing";
    overlay.classList.add("hidden");
    dirty = true;
  }

  function elapsed() {
    return Math.round((performance.now() - startTime) / 1000);
  }

  function lose(hitX, hitY) {
    over = true;
    state = "lost";
    faceEl.textContent = "😵";
    grid[hitY][hitX].hit = true;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (grid[y][x].mine) grid[y][x].revealed = true;
      }
    }
    sfx.lose();
    // Leave the field up for a beat so the player can see which mine got them
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() =>
      showOverlay("Boom!", "You hit a mine.", isTouch ? "Tap to play again" : "Press any key to play again"), 3000);
    dirty = true;
  }

  function win() {
    over = true;
    state = "won";
    faceEl.textContent = "😎";
    const t = elapsed();
    if (!best[diff] || t < best[diff]) {
      best[diff] = t;
      try { localStorage.setItem("minesweeper-best", JSON.stringify(best)); } catch (e) { /* private browsing */ }
    }
    minesEl.textContent = "0";
    // Flag every mine so the cleared field reads clearly
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (grid[y][x].mine) grid[y][x].flag = true;
      }
    }
    sfx.win();
    window.GameCelebrate.confetti(1600);
    // Let the cleared field and the confetti have the stage first
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() =>
      showOverlay("Cleared!", "Time: " + t + "s", isTouch ? "Tap to play again" : "Press any key to play again"), 2500);
    dirty = true;
  }

  function showOverlay(title, scoreText, hint) {
    overlayTitle.textContent = title;
    if (scoreText) {
      overlayScore.hidden = false;
      overlayScore.textContent = scoreText;
    } else {
      overlayScore.hidden = true;
    }
    overlayHint.innerHTML = hint;
    viewBoardEl.hidden = !over; // only a finished field is worth a look back
    overlay.classList.remove("hidden");
  }

  // Shared entry point for "the player wants a new game".
  function primaryAction() {
    GA.ensureAudio();
    if (state !== "playing") {
      start();
      return true;
    }
    return false;
  }

  // One tap/click on a board square. With the flag-mode toggle on, taps flag.
  function tapCell(x, y) {
    GA.ensureAudio();
    const c = grid[y][x];
    if (flagMode) {
      if (!c.revealed) toggleFlag(x, y);
      return;
    }
    if (!started) {
      placeMines(x, y);
      started = true;
      startTime = performance.now();
    }
    if (c.revealed) chord(x, y);
    else if (!c.flag) { sfx.reveal(); reveal(x, y); }
    dirty = true;
  }

  function applyDiff(d) {
    diff = d;
    const df = DIFFS[d];
    COLS = df.cols; ROWS = df.rows; MINES = df.mines;
    document.querySelectorAll(".diff").forEach((b) => b.classList.toggle("active", b.dataset.diff === d));
    resize();
    start();
  }

  // --- Render ---
  function drawEmoji(emoji, x, y) {
    ctx.font = Math.floor(cell * 0.62) + 'px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(emoji, x * cell + cell / 2, y * cell + cell * 0.55);
  }

  // A bright hand-drawn pennant — the 🚩 emoji renders too dim on some systems.
  function drawFlag(x, y) {
    const cx = x * cell, cy = y * cell;
    const poleW = Math.max(2, cell * 0.07);
    const poleX = cx + cell * 0.26;
    const top = cy + cell * 0.18;
    const bottom = cy + cell * 0.82;
    // knob + pole
    ctx.fillStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.roundRect(poleX, cy + cell * 0.12, poleW * 1.8, cell * 0.1, poleW * 0.5);
    ctx.fill();
    ctx.fillRect(poleX, top, poleW, bottom - top);
    // bright red pennant
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.moveTo(poleX + poleW, top + cell * 0.04);
    ctx.lineTo(poleX + poleW + cell * 0.66, cy + cell * 0.42);
    ctx.lineTo(poleX + poleW, cy + cell * 0.64);
    ctx.closePath();
    ctx.fill();
  }

  function draw() {
    const w = COLS * cell, h = ROWS * cell;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color("--play");
    ctx.fillRect(0, 0, w, h);

    const gap = Math.max(1, Math.round(cell * 0.06));
    const radius = Math.max(2, cell * 0.12);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const c = grid[y][x];
        const px = x * cell + gap, py = y * cell + gap;
        const s = cell - gap * 2;
        if (c.revealed) {
          ctx.fillStyle = c.hit ? color("--mine-hit") : color("--cell-open");
          ctx.beginPath();
          ctx.roundRect(px, py, s, s, radius);
          ctx.fill();
          if (c.mine) {
            drawEmoji("💣", x, y);
          } else if (c.adj > 0) {
            ctx.fillStyle = NUM_COLORS[c.adj];
            ctx.font = "800 " + Math.floor(cell * 0.58) + 'px -apple-system, "Segoe UI", sans-serif';
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(c.adj, px + s / 2, py + s / 2 + cell * 0.03);
          }
        } else {
          // Hidden square: raised tile with a soft top highlight
          ctx.fillStyle = color("--cell");
          ctx.beginPath();
          ctx.roundRect(px, py, s, s, radius);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.06)";
          ctx.beginPath();
          ctx.roundRect(px + 1, py + 1, s - 2, s * 0.45, radius * 0.6);
          ctx.fill();
          if (c.flag) {
            drawFlag(x, y);
            // Wrong flag, revealed only once the game is over
            if (over && !c.mine) {
              ctx.strokeStyle = "#f87171";
              ctx.lineWidth = Math.max(2, cell * 0.09);
              const o = s * 0.22;
              ctx.beginPath();
              ctx.moveTo(px + o, py + o); ctx.lineTo(px + s - o, py + s - o);
              ctx.moveTo(px + s - o, py + o); ctx.lineTo(px + o, py + s - o);
              ctx.stroke();
            }
          }
        }
      }
    }

    // Keyboard / hover cursor
    if (state === "playing" && !over) {
      ctx.strokeStyle = color("--accent");
      ctx.lineWidth = Math.max(2, cell * 0.09);
      ctx.strokeRect(cursor.x * cell + 1.5, cursor.y * cell + 1.5, cell - 3, cell - 3);
    }
  }

  // --- Main loop (timer ticks once per second; board redraws on demand) ---
  function frame() {
    requestAnimationFrame(frame);
    if (state === "playing" && started && !over) {
      const s = elapsed();
      if (s !== seconds) {
        seconds = s;
        timeEl.textContent = s;
      }
    }
    if (dirty) {
      dirty = false;
      draw();
    }
  }

  // --- Input: keyboard (macOS Safari) ---
  const MOVE_KEYS = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
  };

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const move = MOVE_KEYS[key];

    if (state !== "playing" || over) {
      if (move || key === " " || key === "Enter" || key === "f") {
        e.preventDefault();
        start();
      }
      return;
    }
    if (move) {
      e.preventDefault();
      cursor.x = clamp(cursor.x + move[0], 0, COLS - 1);
      cursor.y = clamp(cursor.y + move[1], 0, ROWS - 1);
      dirty = true;
    } else if (key === " " || key === "Enter") {
      e.preventDefault();
      tapCell(cursor.x, cursor.y);
    } else if (key === "f") {
      e.preventDefault();
      toggleFlag(cursor.x, cursor.y);
    }
  });

  // --- Input: touch (iOS Safari: tap to clear, hold to flag) ---
  let touchStart = null;
  let touchMoved = false;
  let longPressTimer = null;
  let longPressFired = false;

  const isControl = (el) => el && el.closest && el.closest("a, button");

  document.addEventListener("touchstart", (e) => {
    if (isControl(e.target)) return; // let links and buttons work
    e.preventDefault();
    const t = e.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY };
    touchMoved = false;
    longPressFired = false;
    clearTimeout(longPressTimer);
    if (state === "playing" && !over && !flagMode) {
      const p = cellFromEvent(t.clientX, t.clientY);
      if (p) {
        longPressTimer = setTimeout(() => {
          longPressFired = true;
          GA.ensureAudio();
          toggleFlag(p.x, p.y);
        }, LONG_PRESS_MS);
      }
    }
  }, { passive: false });

  document.addEventListener("touchmove", (e) => {
    if (isControl(e.target)) return;
    e.preventDefault();
    if (!touchStart) return;
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - touchStart.x) > TAP_SLOP || Math.abs(t.clientY - touchStart.y) > TAP_SLOP) {
      touchMoved = true;
      clearTimeout(longPressTimer);
    }
  }, { passive: false });

  document.addEventListener("touchend", (e) => {
    if (isControl(e.target)) return;
    e.preventDefault();
    clearTimeout(longPressTimer);
    const t = e.changedTouches[0];
    if (!touchMoved && !longPressFired) {
      if (state === "playing" && !over) {
        const p = cellFromEvent(t.clientX, t.clientY);
        if (p) tapCell(p.x, p.y);
      } else {
        primaryAction();
      }
    }
    touchStart = null;
  }, { passive: false });

  // Block pinch-zoom gestures in iOS Safari
  document.addEventListener("gesturestart", (e) => e.preventDefault());

  // --- Input: mouse (desktop only; iOS synthesises mouse events after touches) ---
  if (!isTouch) {
    canvas.addEventListener("mousemove", (e) => {
      const p = cellFromEvent(e.clientX, e.clientY);
      if (p && (p.x !== cursor.x || p.y !== cursor.y)) {
        cursor = p;
        dirty = true;
      }
    });

    canvas.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (e.button === 2) {
        const p = cellFromEvent(e.clientX, e.clientY);
        if (p && state === "playing" && !over) toggleFlag(p.x, p.y);
        return;
      }
      if (state === "playing" && !over) {
        const p = cellFromEvent(e.clientX, e.clientY);
        if (p) tapCell(p.x, p.y);
      } else {
        primaryAction();
      }
    });

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    overlay.addEventListener("mousedown", (e) => { e.preventDefault(); primaryAction(); });
  }

  // --- Controls: difficulty, restart, flag mode ---
  document.querySelectorAll(".diff").forEach((btn) => {
    btn.addEventListener("click", () => {
      GA.ensureAudio();
      applyDiff(btn.dataset.diff);
    });
  });

  faceEl.addEventListener("click", () => {
    GA.ensureAudio();
    start();
  });

  // Hide the win/lost screen to study the final field; any restart gesture still works
  viewBoardEl.addEventListener("mousedown", (e) => e.stopPropagation()); // don't trip the overlay's tap-to-restart
  viewBoardEl.addEventListener("click", (e) => {
    e.stopPropagation();
    GA.ensureAudio();
    overlay.classList.add("hidden");
  });

  flagModeEl.addEventListener("click", () => {
    GA.ensureAudio();
    flagMode = !flagMode;
    flagModeEl.classList.toggle("active", flagMode);
    flagModeEl.textContent = flagMode ? "🚩 On" : "🚩 Flag";
  });

  // Pause the clock while the app is in the background
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state === "playing" && started && !over) {
      pausedAt = performance.now();
    } else if (!document.hidden && pausedAt) {
      startTime += performance.now() - pausedAt;
      pausedAt = null;
    }
  });

  // --- Boot ---
  const df = DIFFS[diff];
  COLS = df.cols; ROWS = df.rows; MINES = df.mines;
  document.querySelectorAll(".diff").forEach((b) => b.classList.toggle("active", b.dataset.diff === diff));
  newBoard();
  showOverlay("Minesweeper", best.easy > 0 ? "Best: " + best.easy + "s" : null, startHint);
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 100));
  resize();
  requestAnimationFrame(frame);
})();