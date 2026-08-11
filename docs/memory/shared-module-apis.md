---
name: shared-module-apis
description: Exact signatures and behavior of window.GameAudio and window.GameCelebrate so games can call them without reading js/shared/
metadata: 
  node_type: memory
  type: project
  originSessionId: 71baaf5d-5c78-4c8d-b9bc-18590770c633
  modified: 2026-08-11T00:45:45.212Z
---

Exact APIs of the two shared modules (as of 2026-08-10), so callers never need to re-read `js/shared/audio.js` / `js/shared/celebrate.js`:

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
