(() => {
  "use strict";

  const COLS = 20;
  const ROWS = 20;
  const START_TICK_MS = 150;
  const MIN_TICK_MS = 70;
  const SPEEDUP_PER_FOOD = 2;
  const SWIPE_THRESHOLD = 24; // px of finger travel before a turn registers
  const FRUITS = ["🍎", "🍒", "🍓", "🍊", "🍋", "🍇", "🍉", "🍑", "🍍", "🥝", "🫐", "🍌"];

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const bestEl = document.getElementById("best");
  const overlay = document.getElementById("overlay");
  const overlayTitle = document.getElementById("overlay-title");
  const overlayScore = document.getElementById("overlay-score");
  const overlayHint = document.getElementById("overlay-hint");

  // roundRect shipped in Safari 16; fall back to plain rects before that
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) {
      this.rect(x, y, w, h);
    };
  }

  const isTouch = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  const startHint = isTouch ? "Swipe anywhere to steer.<br>Tap to start." : "Move with WASD or arrow keys.<br>Space pauses. Press any key to start.";

  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();

  // --- State ---
  let cell = 0;            // cell size in CSS pixels
  let snake, dir, dirQueue, food, score, tickMs, state; // state: "idle" | "playing" | "paused" | "over"
  let lastTime = 0, acc = 0;
  let best = 0;
  try { best = parseInt(localStorage.getItem("snake-best"), 10) || 0; } catch (e) { /* private browsing */ }
  bestEl.textContent = best;

  // --- Sizing (crisp on retina, fits any viewport) ---
  function resize() {
    const hudSpace = 90;
    const size = Math.min(
      Math.min(window.innerWidth, document.documentElement.clientWidth) - 24,
      window.innerHeight - hudSpace - 24,
      520
    );
    cell = Math.floor(size / COLS);
    const cssSize = cell * COLS;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = cssSize + "px";
    canvas.style.height = cssSize + "px";
    canvas.width = cssSize * dpr;
    canvas.height = cssSize * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  // --- Game setup ---
  function reset() {
    const cx = Math.floor(COLS / 2);
    const cy = Math.floor(ROWS / 2);
    snake = [{ x: cx - 1, y: cy }, { x: cx - 2, y: cy }, { x: cx - 3, y: cy }];
    dir = { x: 1, y: 0 };
    dirQueue = [];
    score = 0;
    tickMs = START_TICK_MS;
    scoreEl.textContent = "0";
    placeFood();
  }

  function placeFood() {
    const free = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!snake.some((s) => s.x === x && s.y === y)) free.push({ x, y });
      }
    }
    food = free.length
      ? {
          ...free[Math.floor(Math.random() * free.length)],
          fruit: FRUITS[Math.floor(Math.random() * FRUITS.length)],
        }
      : null;
  }

  function start() {
    reset();
    state = "playing";
    overlay.classList.add("hidden");
    lastTime = 0;
    acc = 0;
  }

  function gameOver() {
    state = "over";
    if (score > best) {
      best = score;
      bestEl.textContent = best;
      try { localStorage.setItem("snake-best", String(best)); } catch (e) { /* private browsing */ }
    }
    showOverlay("Game Over", "Score: " + score, isTouch ? "Tap to play again" : "Press any key to play again");
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
    overlay.classList.remove("hidden");
  }

  // --- Direction handling ---
  // Queue turns so two quick inputs within one tick can't reverse the snake.
  function queueDir(x, y) {
    const last = dirQueue.length ? dirQueue[dirQueue.length - 1] : dir;
    if (last.x === x && last.y === y) return;   // same direction
    if (last.x === -x && last.y === -y) return; // reversal
    if (dirQueue.length < 2) dirQueue.push({ x, y });
  }

  // --- Tick ---
  function tick() {
    if (dirQueue.length) dir = dirQueue.shift();

    // Wrap around the board edges instead of dying at the wall
    const head = {
      x: (snake[0].x + dir.x + COLS) % COLS,
      y: (snake[0].y + dir.y + ROWS) % ROWS,
    };
    // Tail moves out of the way this tick unless we're growing, so exclude it.
    const body = snake.slice(0, -1);
    if (body.some((s) => s.x === head.x && s.y === head.y)) return gameOver();

    snake.unshift(head);
    if (food && head.x === food.x && head.y === food.y) {
      score += 10;
      scoreEl.textContent = score;
      tickMs = Math.max(MIN_TICK_MS, tickMs - SPEEDUP_PER_FOOD);
      placeFood();
      if (!food) return gameOver(); // board full: you win, effectively
    } else {
      snake.pop();
    }
  }

  // --- Render ---
  function drawCell(x, y, fill, inset) {
    const pad = inset || 1;
    const r = Math.max(2, cell * 0.22);
    const px = x * cell + pad;
    const py = y * cell + pad;
    const s = cell - pad * 2;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(px, py, s, s, r);
    ctx.fill();
  }

  function draw() {
    const size = cell * COLS;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? color("--grid-a") : color("--grid-b");
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    if (!snake) return;

    if (food) {
      ctx.font = Math.floor(cell * 0.8) + 'px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(food.fruit, food.x * cell + cell / 2, food.y * cell + cell * 0.56);
    }
    for (let i = snake.length - 1; i >= 1; i--) {
      drawCell(snake[i].x, snake[i].y, color("--snake"));
    }
    const head = snake[0];
    drawCell(head.x, head.y, color("--snake-head"));

    // Eyes on the head, offset toward travel direction
    const cxp = head.x * cell + cell / 2 + dir.x * cell * 0.15;
    const cyp = head.y * cell + cell / 2 + dir.y * cell * 0.15;
    const perp = { x: -dir.y, y: dir.x };
    const eo = cell * 0.16;
    const er = Math.max(1.5, cell * 0.07);
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(cxp + perp.x * eo, cyp + perp.y * eo, er, 0, Math.PI * 2);
    ctx.arc(cxp - perp.x * eo, cyp - perp.y * eo, er, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Main loop (fixed timestep on rAF) ---
  function frame(t) {
    requestAnimationFrame(frame);
    if (state !== "playing") return;
    if (!lastTime) lastTime = t;
    acc += t - lastTime;
    lastTime = t;
    if (acc > 1000) acc = tickMs; // clamp after tab was throttled
    while (acc >= tickMs) {
      acc -= tickMs;
      tick();
      if (state !== "playing") break;
    }
    draw();
  }

  // --- Keyboard (macOS Safari: WASD + arrows) ---
  const KEYS = {
    w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0],
    ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowRight: [1, 0],
  };

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const move = KEYS[key];
    if (move || key === " ") e.preventDefault(); // keep arrows/space from scrolling

    if (state === "idle" || state === "over") {
      start();
      if (move) queueDir(move[0], move[1]);
      return;
    }
    if (key === " ") {
      togglePause();
      return;
    }
    if (state === "playing" && move) queueDir(move[0], move[1]);
  });

  function togglePause() {
    if (state === "playing") {
      state = "paused";
      showOverlay("Paused", null, isTouch ? "Tap to resume" : "Press Space to resume");
    } else if (state === "paused") {
      state = "playing";
      overlay.classList.add("hidden");
      lastTime = 0;
      acc = 0;
    }
  }

  // --- Touch (iOS Safari: swipe to steer, tap to start) ---
  // The anchor point re-centers after each registered turn, so you can steer
  // continuously without lifting your finger.
  let touchAnchor = null;
  let touchMoved = false;

  document.addEventListener("touchstart", (e) => {
    if (e.target.closest && e.target.closest("a")) return; // let link taps through
    e.preventDefault();
    const t = e.changedTouches[0];
    touchAnchor = { x: t.clientX, y: t.clientY };
    touchMoved = false;
  }, { passive: false });

  document.addEventListener("touchmove", (e) => {
    if (e.target.closest && e.target.closest("a")) return;
    e.preventDefault();
    if (!touchAnchor || state !== "playing") return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchAnchor.x;
    const dy = t.clientY - touchAnchor.y;
    if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;
    if (Math.abs(dx) > Math.abs(dy)) {
      queueDir(dx > 0 ? 1 : -1, 0);
    } else {
      queueDir(0, dy > 0 ? 1 : -1);
    }
    touchAnchor = { x: t.clientX, y: t.clientY };
    touchMoved = true;
  }, { passive: false });

  document.addEventListener("touchend", (e) => {
    if (e.target.closest && e.target.closest("a")) return;
    e.preventDefault();
    if (!touchMoved) {
      if (state === "idle" || state === "over") start();
      else if (state === "paused") togglePause();
    }
    touchAnchor = null;
  }, { passive: false });

  // Block pinch-zoom gestures in iOS Safari
  document.addEventListener("gesturestart", (e) => e.preventDefault());

  // Auto-pause when the tab/app goes to background
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state === "playing") togglePause();
  });

  // --- Boot ---
  state = "idle";
  showOverlay("Snake", null, startHint);
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 100));
  resize();
  requestAnimationFrame(frame);
})();
