# CLAUDE.md

Guidance for Claude Code when working in this repo. Read this first — it exists so you
can find the right ~50 lines to change instead of loading whole files into context.

## What this is

A static collection of browser games, hand-written (vibecoded) and served straight off
GitHub Pages at <https://jdmaguire.github.io/games/>. Built for a kid on an iPad.

- **No build step, no bundler, no package.json, no dependencies to install.**
- **No test suite and no linter.** There is nothing to run to prove a change works.
- Each game is one self-contained HTML file: inline `<style>`, inline `<script>`, vanilla
  JS in an IIFE with `"use strict"`. No frameworks.
- Targets **Safari on iOS (touch)** and **Safari on macOS (keyboard)**. Both input paths
  must keep working for any gameplay change.

## File map

| Path | Lines | What it is |
| --- | --- | --- |
| `index.html` | ~166 | Game-select menu. Cards + `localStorage` progress readout + number-key shortcuts. |
| `snake.html` | ~415 | Snake. Canvas, fixed-timestep loop, swipe/WASD steering. |
| `robot.html` | ~1830 | "Sockbot Showdown" boxing game. **Largest file** — most of it is canvas drawing code. |
| `chess.html` | ~936 | Chess vs Stockfish. DOM board, drag-to-move, Elo slider. |
| `checkers.html` | ~995 | Checkers vs a built-in negamax engine. |
| `readme.md` | 5 | Player-facing blurb. |

### Vendored — do not read these

These are third-party artifacts. Reading any of them wastes a large amount of context and
tells you nothing you need. Treat them as opaque; never open, never edit, never reformat.

| Path | Size | Why not |
| --- | --- | --- |
| `engines/stockfish-18-lite-single.wasm` | **7.3 MB** | Compiled WebAssembly binary. |
| `engines/stockfish-18-lite-single.js` | 21 KB | Minified emscripten glue, 10 lines of no newlines. |
| `lib/chess-1.4.0.mjs` | 107 KB | Upstream chess.js. Consult its public API from docs, not the source. |
| `engines/STOCKFISH-LICENSE.txt` | 35 KB | GPL text. |
| `lib/CHESSJS-LICENSE.txt` | 1.3 KB | License text. |
| `LICENSE` | 18 KB | License text. |

To upgrade one of these, replace the file wholesale from upstream — don't hand-edit.

## How to make a change without reading a whole file

Every game's `<script>` is divided by section-header comments. Get the index first, then
read only the section you need:

```
Grep  pattern: "^\s*// -{3,}"   path: robot.html      # prints "// ---------- Combat ----------" with line numbers
Read  robot.html  offset: 474  limit: 150             # just that section
```

Grep for a symbol before reading anything — `function drawDragon`, `#status`,
`checkers-prefs` — and read a window around the hit. A full `Read` of `robot.html` costs
roughly 25k tokens; a single section costs a few hundred.

### Section index (names, so it stays true as line numbers drift)

- **`snake.html`** — State · Sizing · Game setup · Direction handling · Tick · Render ·
  Main loop · Keyboard · Touch · Boot
- **`robot.html`** — Tuning · Opponent skins · DOM · Audio · Persistent W-L record ·
  Game state · Sizing · Match flow · Combat · Effects · Layout helpers · **Drawing
  (~1050 lines — `drawCpu` and `drawDragon` alone are ~750 of them)** · Main loop ·
  Input: keyboard · Input: touch buttons · Boot
- **`chess.html`** — Preferences · Audio · Win celebration · Engine (Stockfish) ·
  Game state · Board rendering · Material counter · Player input · Drag to move ·
  Move animation · Engine turn · Game end / flow · Setup UI
- **`checkers.html`** — Preferences · Audio · Win celebration · Rules · Engine
  (negamax + alpha-beta) · Game state · Board rendering · Move animation · Material
  counter · Turn flow · Drag to move · Setup UI

## Conventions

- **Theme** lives in `:root` CSS custom properties (`--bg`, `--panel`, `--text`,
  `--muted`, plus per-game accents). Change the variable, not the usages.
- **iOS viewport boilerplate** is identical across pages and load-bearing — the
  `viewport-fit=cover` meta, `touch-action`, `overscroll-behavior: none`,
  `height: 100dvh`, and `env(safe-area-inset-*)` padding stop pull-to-refresh, rubber-band
  scroll, and double-tap zoom. Don't "clean it up."
- **Audio** is a tiny WebAudio synth (`ensureAudio` / `beep` / `thud` / `sfx`) duplicated
  verbatim in `chess.html`, `checkers.html`, and `robot.html`. It must stay unlocked by a
  real user gesture or iOS mutes it. Every call is wrapped in `try/catch` — audio is
  best-effort and must never break gameplay.
- **`localStorage` is always wrapped in `try/catch`** (`/* private browsing */`). Keys in
  use: `snake-best`, `sockbot-record`, `chess-prefs`, `chess-game`, `checkers-prefs`,
  `checkers-game`. `index.html` reads all of them to render card stats — if you rename or
  reshape a key, update `index.html` too.
- **Canvas games** scale by `devicePixelRatio` and derive sizes from a single scale unit
  (e.g. `robot.html`'s `S()`), so nothing is hard-coded in pixels.

## Verification

There is nothing to run — no tests, no build, no lint. So:

1. Keep diffs surgical. Prefer the smallest edit that works over a refactor.
2. Sanity-check syntax on extracted JS with `node --check <file>` where the file is
   standalone JS (won't work on inline `<script>` blocks).
3. To try it by hand, serve over HTTP — `python3 -m http.server` from the repo root, then
   open <http://localhost:8000>. **`file://` will not work for chess**: the Stockfish
   Web Worker and the `chess-1.4.0.mjs` ES-module import are both blocked there.
4. State in the PR description what you could not verify. Do not claim a game was tested
   when it was not.

## Scope

This is a toy repo for a child. Favour small, readable, dependency-free changes. Don't
introduce a build step, a framework, or a package manager without being asked.
