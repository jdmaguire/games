(() => {
  "use strict";

  // --- Tuning ---
  // All gameplay math happens in a fixed 100 x 140 logical playfield. Rendering
  // multiplies by `scale`, so nothing below is in pixels and the game plays the
  // same on a phone and on a desktop window.
  const LW = 100, LH = 140;

  const COLS = 9, ROWS = 6;
  const BRICK_TOP = 14, BRICK_SIDE = 3, BRICK_GAP = 0.9, BRICK_H = 4.2;
  const BRICK_W = (LW - BRICK_SIDE * 2 - BRICK_GAP * (COLS - 1)) / COLS;
  const ROW_COLORS = ["#f87171", "#fb923c", "#fbbf24", "#4ade80", "#38bdf8", "#a78bfa"];
  const ROW_POINTS = [60, 50, 40, 30, 20, 10];
  const TOUGH_FROM_LEVEL = 3;   // from here up, the top two rows take two hits

  const PADDLE_Y = LH - 9;
  const PADDLE_H = 2.6;
  const PADDLE_W = 20;          // level 1 width; shrinks a little each level
  const PADDLE_W_MIN = 12;
  const PADDLE_SHRINK = 1.4;    // per level
  const PADDLE_SPEED = 100;     // logical units/sec when steering by keyboard

  const BALL_R = 1.5;
  const BALL_SPEED = 58;        // level 1 launch speed
  const BALL_SPEED_MAX = 108;
  const SPEEDUP_PER_BRICK = 0.22;
  const SPEEDUP_PER_LEVEL = 4;
  const MAX_BOUNCE = 1.05;      // radians off vertical at the very edge of the paddle (~60°)

  const START_LIVES = 3;
  const TAP_SLOP = 12;          // px of finger travel that still counts as a tap

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const levelEl = document.getElementById("level");
  const livesEl = document.getElementById("lives");
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
  const startHint = isTouch
    ? "Slide your finger to move the paddle.<br>Tap to launch the ball."
    : "Move with ← → or A / D.<br>Space launches and pauses.";

  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // --- Audio (unlocked by the first real gesture, or iOS stays silent) ---
  const GA = window.GameAudio;
  const sfx = {
    brick: () => GA.beep(520, 760, 0.05, "square", 0.05),
    tough: () => GA.beep(300, 360, 0.06, "square", 0.05),
    paddle: () => GA.beep(230, 300, 0.07, "triangle", 0.06),
    wall: () => GA.beep(170, 190, 0.05, "triangle", 0.04),
    launch: () => GA.beep(400, 700, 0.09, "square", 0.05),
    lose: () => { GA.beep(300, 80, 0.4, "sawtooth", 0.07); GA.thud(0.25, 0.12); },
    level: () => [0, 1, 2, 3].forEach((i) => GA.beep(440 * Math.pow(2, i / 4), null, 0.18, "square", 0.05, i * 0.09)),
    over: () => [0, 1, 2].forEach((i) => GA.beep(320 - i * 70, null, 0.3, "sawtooth", 0.06, i * 0.16)),
  };

  // --- State ---
  // state: "idle" | "playing" | "paused" | "levelclear" | "over"
  let scale = 1;
  let state = "idle";
  let bricks = [], remaining = 0;
  let paddle, ball, onPaddle, score, level, lives, speed, paddleW;
  let lastTime = 0;
  const held = new Set();

  let best = 0;
  try { best = parseInt(localStorage.getItem("breakout-best"), 10) || 0; } catch (e) { /* private browsing */ }

  // --- Sizing (crisp on retina, fits any viewport) ---
  function resize() {
    const hudSpace = 90;
    const maxW = Math.min(window.innerWidth, document.documentElement.clientWidth) - 24;
    const maxH = window.innerHeight - hudSpace - 24;
    const w = Math.max(200, Math.min(maxW, maxH * (LW / LH), 460));
    const h = w * (LH / LW);
    scale = w / LW;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  // --- Game setup ---
  function buildBricks() {
    bricks = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        bricks.push({
          x: BRICK_SIDE + c * (BRICK_W + BRICK_GAP),
          y: BRICK_TOP + r * (BRICK_H + BRICK_GAP),
          row: r,
          hp: level >= TOUGH_FROM_LEVEL && r < 2 ? 2 : 1,
        });
      }
    }
    remaining = bricks.length;
  }

  function setupLevel() {
    paddleW = Math.max(PADDLE_W_MIN, PADDLE_W - (level - 1) * PADDLE_SHRINK);
    speed = Math.min(BALL_SPEED_MAX, BALL_SPEED + (level - 1) * SPEEDUP_PER_LEVEL);
    paddle = { x: LW / 2 };
    buildBricks();
    resetBall();
    levelEl.textContent = "Level " + level;
  }

  // Park the ball on the paddle until the player launches it.
  function resetBall() {
    onPaddle = true;
    ball = { x: paddle.x, y: PADDLE_Y - BALL_R - 0.2, vx: 0, vy: 0 };
  }

  function launch() {
    if (!onPaddle) return;
    onPaddle = false;
    const a = (Math.random() * 0.5 - 0.25) - Math.PI / 2; // upward, slightly off vertical
    ball.vx = Math.cos(a) * speed;
    ball.vy = Math.sin(a) * speed;
    sfx.launch();
  }

  function newGame() {
    score = 0;
    level = 1;
    lives = START_LIVES;
    scoreEl.textContent = "0";
    updateLives();
    setupLevel();
    state = "playing";
    overlay.classList.add("hidden");
    lastTime = 0;
  }

  function updateLives() {
    livesEl.textContent = lives > 0 ? "●".repeat(lives) : "–";
  }

  function addScore(n) {
    score += n;
    scoreEl.textContent = score;
  }

  function loseLife() {
    lives--;
    updateLives();
    sfx.lose();
    if (lives <= 0) return gameOver();
    speed = Math.min(BALL_SPEED_MAX, BALL_SPEED + (level - 1) * SPEEDUP_PER_LEVEL);
    resetBall();
  }

  function levelClear() {
    state = "levelclear";
    sfx.level();
    window.GameCelebrate.confetti(1600);
    showOverlay("Level " + level + " Cleared!", "Score: " + score,
      isTouch ? "Tap for level " + (level + 1) : "Press Space for level " + (level + 1));
  }

  function nextLevel() {
    level++;
    setupLevel();
    state = "playing";
    overlay.classList.add("hidden");
    lastTime = 0;
  }

  function gameOver() {
    state = "over";
    sfx.over();
    if (score > best) {
      best = score;
      try { localStorage.setItem("breakout-best", String(best)); } catch (e) { /* private browsing */ }
    }
    showOverlay("Game Over", "Score: " + score,
      "Best: " + best + "<br>" + (isTouch ? "Tap to play again" : "Press any key to play again"));
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

  function togglePause() {
    if (state === "playing") {
      state = "paused";
      showOverlay("Paused", null, isTouch ? "Tap to resume" : "Press Space to resume");
    } else if (state === "paused") {
      state = "playing";
      overlay.classList.add("hidden");
      lastTime = 0;
    }
  }

  // --- Physics ---
  function movePaddle(dt) {
    let d = 0;
    if (held.has("left")) d -= 1;
    if (held.has("right")) d += 1;
    if (d) paddle.x += d * PADDLE_SPEED * dt;
    paddle.x = clamp(paddle.x, paddleW / 2, LW - paddleW / 2);
  }

  // One integration sub-step. Kept short enough (see step()) that the ball can
  // never skip past a brick or the paddle between frames.
  function moveBall(dt) {
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Walls
    if (ball.x < BALL_R) { ball.x = BALL_R; ball.vx = Math.abs(ball.vx); sfx.wall(); }
    else if (ball.x > LW - BALL_R) { ball.x = LW - BALL_R; ball.vx = -Math.abs(ball.vx); sfx.wall(); }
    if (ball.y < BALL_R) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy); sfx.wall(); }

    // Paddle: where you hit it decides the angle, classic Breakout style.
    if (ball.vy > 0 &&
        ball.y + BALL_R >= PADDLE_Y && ball.y - BALL_R <= PADDLE_Y + PADDLE_H &&
        Math.abs(ball.x - paddle.x) <= paddleW / 2 + BALL_R) {
      const t = clamp((ball.x - paddle.x) / (paddleW / 2), -1, 1);
      const a = t * MAX_BOUNCE;
      ball.vx = Math.sin(a) * speed;
      ball.vy = -Math.cos(a) * speed;
      ball.y = PADDLE_Y - BALL_R;
      sfx.paddle();
      return;
    }

    hitBricks();

    // Below the paddle: that ball is gone
    if (ball.y - BALL_R > LH) loseLife();
  }

  function hitBricks() {
    for (const b of bricks) {
      if (b.hp <= 0) continue;
      // Circle vs rect: nearest point on the brick to the ball centre
      const nx = clamp(ball.x, b.x, b.x + BRICK_W);
      const ny = clamp(ball.y, b.y, b.y + BRICK_H);
      const dx = ball.x - nx, dy = ball.y - ny;
      if (dx * dx + dy * dy > BALL_R * BALL_R) continue;

      // Flip whichever axis is least overlapped — that's the face we came in through
      const ox = BRICK_W / 2 + BALL_R - Math.abs(ball.x - (b.x + BRICK_W / 2));
      const oy = BRICK_H / 2 + BALL_R - Math.abs(ball.y - (b.y + BRICK_H / 2));
      if (ox < oy) ball.vx = -ball.vx; else ball.vy = -ball.vy;

      b.hp--;
      if (b.hp > 0) {
        sfx.tough();
      } else {
        sfx.brick();
        remaining--;
        addScore(ROW_POINTS[b.row]);
        speed = Math.min(BALL_SPEED_MAX, speed + SPEEDUP_PER_BRICK);
        const m = Math.hypot(ball.vx, ball.vy) || 1;
        ball.vx = (ball.vx / m) * speed;
        ball.vy = (ball.vy / m) * speed;
        if (remaining === 0) levelClear();
      }
      return; // one brick per sub-step, so we never flip the same axis twice
    }
  }

  function step(dt) {
    movePaddle(dt);
    if (onPaddle) {
      ball.x = paddle.x;
      ball.y = PADDLE_Y - BALL_R - 0.2;
      return;
    }
    const dist = Math.hypot(ball.vx, ball.vy) * dt;
    const steps = Math.max(1, Math.ceil(dist / (BALL_R * 0.8)));
    const sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      moveBall(sdt);
      if (state !== "playing" || onPaddle) return;
    }
  }

  // --- Render ---
  function rrect(x, y, w, h, r, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x * scale, y * scale, w * scale, h * scale, r * scale);
    ctx.fill();
  }

  function draw() {
    const w = LW * scale, h = LH * scale;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color("--play");
    ctx.fillRect(0, 0, w, h);
    if (!ball) return;

    for (const b of bricks) {
      if (b.hp <= 0) continue;
      rrect(b.x, b.y, BRICK_W, BRICK_H, 0.9, ROW_COLORS[b.row]);
      // Two-hit bricks wear a bright cap until the first hit knocks it off
      if (b.hp > 1) rrect(b.x + 0.7, b.y + 0.6, BRICK_W - 1.4, BRICK_H * 0.3, 0.5, "rgba(255,255,255,0.65)");
      else rrect(b.x + 0.7, b.y + 0.6, BRICK_W - 1.4, BRICK_H * 0.2, 0.4, "rgba(255,255,255,0.22)");
    }

    rrect(paddle.x - paddleW / 2, PADDLE_Y, paddleW, PADDLE_H, PADDLE_H / 2, color("--paddle"));
    rrect(paddle.x - paddleW / 2 + 1, PADDLE_Y + 0.5, paddleW - 2, PADDLE_H * 0.35, PADDLE_H * 0.2, "rgba(255,255,255,0.45)");

    ctx.fillStyle = color("--ball");
    ctx.shadowColor = color("--paddle");
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(ball.x * scale, ball.y * scale, BALL_R * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // --- Main loop ---
  function frame(t) {
    requestAnimationFrame(frame);
    if (state === "playing") {
      if (!lastTime) lastTime = t;
      const dt = Math.min(0.05, (t - lastTime) / 1000); // clamp after tab throttling
      lastTime = t;
      step(dt);
    }
    draw();
  }

  // --- Shared entry point for "the player did something" ---
  function primaryAction() {
    GA.ensureAudio();
    if (state === "idle" || state === "over") newGame();
    else if (state === "levelclear") nextLevel();
    else if (state === "paused") togglePause();
    else if (onPaddle) launch();
    else return false;
    return true;
  }

  // --- Input: keyboard (macOS Safari) ---
  const LEFT_KEYS = { a: 1, ArrowLeft: 1 };
  const RIGHT_KEYS = { d: 1, ArrowRight: 1 };
  const keyName = (e) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = keyName(e);
    const steer = LEFT_KEYS[key] || RIGHT_KEYS[key];
    if (steer || key === " " || key === "ArrowUp" || key === "ArrowDown") e.preventDefault();

    if (state === "idle" || state === "over") { primaryAction(); return; }
    if (key === " ") {
      GA.ensureAudio();
      if (state === "levelclear") nextLevel();
      else if (onPaddle && state === "playing") launch();
      else togglePause();
      return;
    }
    if (LEFT_KEYS[key]) held.add("left");
    if (RIGHT_KEYS[key]) held.add("right");
  });

  window.addEventListener("keyup", (e) => {
    const key = keyName(e);
    if (LEFT_KEYS[key]) held.delete("left");
    if (RIGHT_KEYS[key]) held.delete("right");
  });
  window.addEventListener("blur", () => held.clear());

  // --- Input: touch (iOS Safari) ---
  // The paddle tracks your finger's x anywhere on screen, so your hand never has
  // to cover the ball. A tap that didn't slide launches / starts / resumes.
  let touchStart = null;
  let touchMoved = false;

  function steerTo(clientX) {
    if (!paddle) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    paddle.x = clamp(((clientX - r.left) / r.width) * LW, paddleW / 2, LW - paddleW / 2);
  }

  document.addEventListener("touchstart", (e) => {
    if (e.target.closest && e.target.closest("a")) return; // let link taps through
    e.preventDefault();
    GA.ensureAudio();
    const t = e.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY };
    touchMoved = false;
    if (state === "playing") steerTo(t.clientX);
  }, { passive: false });

  document.addEventListener("touchmove", (e) => {
    if (e.target.closest && e.target.closest("a")) return;
    e.preventDefault();
    if (!touchStart) return;
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - touchStart.x) > TAP_SLOP || Math.abs(t.clientY - touchStart.y) > TAP_SLOP) {
      touchMoved = true;
    }
    if (state === "playing") steerTo(t.clientX);
  }, { passive: false });

  document.addEventListener("touchend", (e) => {
    if (e.target.closest && e.target.closest("a")) return;
    e.preventDefault();
    if (!touchMoved) primaryAction();
    touchStart = null;
  }, { passive: false });

  // Block pinch-zoom gestures in iOS Safari
  document.addEventListener("gesturestart", (e) => e.preventDefault());

  // --- Input: mouse (desktop only; iOS synthesises mouse events after touches) ---
  if (!isTouch) {
    window.addEventListener("mousemove", (e) => { if (state === "playing") steerTo(e.clientX); });
    canvas.addEventListener("mousedown", (e) => { e.preventDefault(); primaryAction(); });
  }

  // Auto-pause when the tab/app goes to background
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state === "playing") togglePause();
  });

  // --- Boot ---
  level = 1;
  score = 0;
  lives = START_LIVES;
  setupLevel();
  updateLives();
  showOverlay("Breakout", best > 0 ? "Best: " + best : null, startHint);
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 100));
  resize();
  requestAnimationFrame(frame);
})();
