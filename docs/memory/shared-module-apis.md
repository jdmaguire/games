---
name: shared-module-apis
description: Exact signatures and behavior of window.GameAudio, window.GameCelebrate, window.RobotHand, window.CheckersEngine, window.Connect4Engine, and window.ChineseCheckersEngine so games can call them without reading js/shared/
metadata:
  node_type: memory
  type: project
  originSessionId: 71baaf5d-5c78-4c8d-b9bc-18590770c633
  modified: 2026-08-16T00:00:00.000Z
---

Exact APIs of the shared modules (as of 2026-08-16), so callers never need to re-read `js/shared/audio.js`, `js/shared/celebrate.js`, `js/shared/robot-hand.js`, `js/shared/checkers-engine.js`, `js/shared/connect4-engine.js`, or `js/shared/chinese-checkers-engine.js`:

**`window.GameAudio`** (js/shared/audio.js):
- `ensureAudio()` — lazily creates/resumes the AudioContext; must be called from a real user gesture (iOS). Safe to call repeatedly.
- `beep(f, f2, dur, type, vol, when)` — pitched blip. `f2` (nullable) glides frequency exponentially from `f` over `dur` seconds; `type` is an OscillatorNode type ("sine"|"square"|"triangle"|"sawtooth"); `when` (optional) delays start in seconds.
- `thud(dur, vol)` — percussive decaying white-noise knock.
- All are no-ops until `ensureAudio()` has run, and every body is try/catch — sound must never break gameplay.
- Each game composes its own `sfx` object of named voices from these primitives (e.g. chess `sfx.capture = () => { thud(0.06, 0.22); beep(130, 70, 0.1, "square", 0.16); }`).

**`window.GameCelebrate`** (js/shared/celebrate.js):
- `showBanner(text)` — appends `div.winbanner` to `#wrap` (both board pages have `#wrap`); replaces any existing banner.
- `hideBanner()`.
- `confetti(durMs)` — throwaway full-screen fixed canvas (z-index 50, pointer-events none), 160 pieces, fades in last 600ms, removes itself.

**`window.RobotHand`** (js/shared/robot-hand.js) — the computer's hand in chess, checkers & chinese checkers:
- `carry(stage, cells, html, opts)` — plays the whole pick-up → carry → put-down. `stage` must be the board's **wrapper** (`#wrap`), not `#board`, which clips its overflow; `cells` is `[fromEl, toEl, ...]`, one entry per landing square, so a checkers multi-jump is just a longer list; `html` is the piece markup to carry (usually `fromEl.innerHTML`).
- `opts` = `{ onGrab, onHop(i), onPlace }`. `onGrab` fires when the fist closes — the caller empties the square it came from there; `onHop(i)` fires on each landing (`i` indexes `cells`, so 1 is the first); `onPlace` fires as the fingers open — the caller re-renders there. The hand only borrows the markup: the board still draws itself from its own state.
- `clear()` — cancels a hand mid-move (removes the element, kills the pending step so its callbacks can't fire into the next game). All three games call it from `startGame`, and chess also resets `animating` there, because a cancelled hand never runs the `onPlace` that would have.
- Timings are module constants: reach 190ms, grab 150ms, per-hop 110–400ms scaled by distance in squares, 90ms between hops, place 160ms, fade 200ms. Play continues from `onPlace` (~550ms in for a single hop); the fade-out just overlaps the next turn. Markup is `div.hand > (div.held + span.mitt)`, styled per game in `css/chess.css` / `css/checkers.css` / `css/chinese-checkers.css` (which sizes the mitt off its `--hole` var instead of a board eighth).
- Connect Four is NOT a caller — its hand hovers over a column and drops a disc, and lives in `js/connect4.js` (see [[game-engine-internals]]).

All of these load as classic scripts before each game's script; this also works for the module `js/chess.js` because module scripts are deferred. See [[localstorage-schemas]] and [[game-engine-internals]] for the other cached codebase facts.

**`window.CheckersEngine`** (js/shared/checkers-engine.js) — dual-purpose rules + engine:
- Loaded as a **classic script** on `checkers.html` (before `js/checkers.js`) → exposes `window.CheckersEngine = { RED, BLK, LEVELS, genMoves, applyMove, undoMove, sideOf, isMan, aiPickMove }`. `RED = 1`, `BLK = -1`; `LEVELS[0..9]` is the difficulty table `{ label, depth, ms, noise, random }`.
- Also spawned as a **Worker** (`new Worker("js/shared/checkers-engine.js")`) for the AI's search and live eval. Request `{ id, board, side, level, ms }` → reply `{ id, move }`, where `move` is a `{ path, caps, score }` object or `null`. `ms` overrides the LEVELS budget (eval uses a short one).
- `aiPickMove(bd0, side, level, ms)` returns `null` when no legal moves, otherwise a `{ path, caps, score }` object (`.score` is side-relative, positive = good for that side; only meaningful after a full search). `side` is the side TO MOVE.
- A single transposition table (`Map`, Zobrist-keyed, capped at 200k entries) persists across all searches in one page session — the live eval warms the AI's very next search. `negamax` probes it for EXACT/LOWER/UPPER bounds and reorders moves by the stored best move.
- When Workers are blocked (`file://`), `js/checkers.js` calls `aiPickMove` synchronously as a fallback instead of dying.

**`window.Connect4Engine`** (js/shared/connect4-engine.js) — same dual-purpose pattern as CheckersEngine:
- Classic script on `connect4.html` → `window.Connect4Engine = { RED, YEL, ROWS, COLS, LEVELS, genMoves, landingRow, applyMove, undoMove, isWinAt, winLine, aiPickMove }`. `RED = 1` (moves first), `YEL = -1`, `ROWS = 6`, `COLS = 7`; board is `number[6][7]` with `board[0]` the top row.
- Also spawned as a Worker with the identical `{ id, board, side, level, ms } → { id, move }` protocol; here `move` is `{ col, row, score }` or `null`. `landingRow(bd, col)` → row a disc would land in, or -1 if the column is full. `winLine(bd, r, c)` → array of the winning cells through (r,c), or null. Same transposition table + `file://` sync-fallback story as checkers; engine details in [[game-engine-internals]].

**`window.ChineseCheckersEngine`** (js/shared/chinese-checkers-engine.js) — same dual-purpose pattern, but geometry ships with it:
- Classic script on `chinese-checkers.html` → `{ CELLS, CORNER, TRI, SEATS, LEVELS, targetOf, startBoard, genMoves, applyMove, undoMove, isWin, aiPickMove }`. The board is a **flat `number[121]`** (the star, in the engine's fixed cell order): 0 empty or player id 1–6, where id = home corner + 1. Corners are numbered by screen position — 0 bottom (always the human), 1 lower-right, 2 upper-right, 3 top, 4 upper-left, 5 lower-left — and `targetOf(p) = (p + 2) % 6` is the opposite corner.
- Geometry exports: `CELLS` = `[{ x, z }]` cube coords (y implied, for layout: `px = √3·(x + z/2)`, `py = 1.5·z`); `CORNER[i]` = corner index or -1 for the central hexagon; `TRI[k]` = the 10 cell indices of corner k; `SEATS` = `{ 2: [1,4], 3: [1,3,5], 4: [1,2,4,5], 6: [1..6] }` (3-player targets are empty corners; 4-player leaves an opposite pair unused). `startBoard(players)` / `isWin(bd, p)` (all 10 target holes hold p's marbles).
- A move is `{ from, to, path }` — nothing is captured and a hop chain can stop anywhere legal, so the destination fully determines it; `path` (every landing hole) exists for the animations. `genMoves(bd, p)` dedupes by destination and **never emits a destination inside a foreign corner triangle** — a move may only end in the hexagon, the mover's own corner, or their target (passing through foreign corners mid-chain is legal). `applyMove(bd, mv)` **returns the moved value**, which `undoMove(bd, mv, v)` takes back — a different shape from the other two engines.
- Worker protocol identical: `{ id, board, side, level, ms } → { id, move }`, `move` is `{ from, to, path, gain, score }` or null. Same `askEngine` wrapper + `file://` sync fallback in `js/chinese-checkers.js`. Search internals (max-n, not negamax) in [[game-engine-internals]].
