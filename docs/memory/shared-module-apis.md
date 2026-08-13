---
name: shared-module-apis
description: Exact signatures and behavior of window.GameAudio, window.GameCelebrate, and window.CheckersEngine so games can call them without reading js/shared/
metadata: 
  node_type: memory
  type: project
  originSessionId: 71baaf5d-5c78-4c8d-b9bc-18590770c633
  modified: 2026-08-12T00:00:00.000Z
---

Exact APIs of the shared modules (as of 2026-08-12), so callers never need to re-read `js/shared/audio.js`, `js/shared/celebrate.js`, or `js/shared/checkers-engine.js`:

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

Both load as classic scripts before each game's script; this also works for the module `js/chess.js` because module scripts are deferred. See [[localstorage-schemas]] and [[game-engine-internals]] for the other cached codebase facts.

**`window.CheckersEngine`** (js/shared/checkers-engine.js) — dual-purpose rules + engine:
- Loaded as a **classic script** on `checkers.html` (before `js/checkers.js`) → exposes `window.CheckersEngine = { RED, BLK, LEVELS, genMoves, applyMove, undoMove, sideOf, isMan, aiPickMove }`. `RED = 1`, `BLK = -1`; `LEVELS[0..9]` is the difficulty table `{ label, depth, ms, noise, random }`.
- Also spawned as a **Worker** (`new Worker("js/shared/checkers-engine.js")`) for the AI's search and live eval. Request `{ id, board, side, level, ms }` → reply `{ id, move }`, where `move` is a `{ path, caps, score }` object or `null`. `ms` overrides the LEVELS budget (eval uses a short one).
- `aiPickMove(bd0, side, level, ms)` returns `null` when no legal moves, otherwise a `{ path, caps, score }` object (`.score` is side-relative, positive = good for that side; only meaningful after a full search). `side` is the side TO MOVE.
- A single transposition table (`Map`, Zobrist-keyed, capped at 200k entries) persists across all searches in one page session — the live eval warms the AI's very next search. `negamax` probes it for EXACT/LOWER/UPPER bounds and reorders moves by the stored best move.
- When Workers are blocked (`file://`), `js/checkers.js` calls `aiPickMove` synchronously as a fallback instead of dying.
