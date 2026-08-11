# CLAUDE.md

Guidance for Claude Code when working in this repo. Read this first — it exists so you
can find the right ~50 lines to change instead of loading whole files into context.

## What this is

A static collection of browser games, hand-written (vibecoded) and served straight off
GitHub Pages at <https://jdmaguire.github.io/games/>. Built for a kid on an iPad.

- **No build step, no bundler, no package.json, no dependencies to install.**
- **No test suite and no linter.** There is nothing to run to prove a change works.
- Vanilla JS, one IIFE per game with `"use strict"`. No frameworks.
- Targets **Safari on iOS (touch)** and **Safari on macOS (keyboard)**. Both input paths
  must keep working for any gameplay change.

## File map

Each page is a thin HTML shell plus a stylesheet and a script, so you only load the layer
you are changing. Markup, styling, and logic are three separate reads now.

| Page | Shell | Styles | Logic |
| --- | --- | --- | --- |
| Game-select menu | `index.html` (~54) | `css/index.css` (85) | `js/index.js` (38) |
| Snake | `snake.html` (~28) | `css/snake.css` (76) | `js/snake.js` (309) |
| Sockbot Showdown | `robot.html` (~32) | `css/robot.css` (107) | `js/robot.js` (**1656**) |
| Chess | `chess.html` (~49) | `css/chess.css` (184) | `js/chess.js` (612) |
| Checkers | `checkers.html` (~48) | `css/checkers.css` (180) | `js/checkers.js` (675) |
| Breakout | `breakout.html` (~33) | `css/breakout.css` (77) | `js/breakout.js` (462) |

Shared, loaded by the pages that need them:

| Path | Lines | What |
| --- | --- | --- |
| `js/shared/audio.js` | 58 | WebAudio synth: `window.GameAudio` = `{ ensureAudio, beep, thud }`. |
| `js/shared/celebrate.js` | 74 | `window.GameCelebrate` = `{ showBanner, hideBanner, confetti }`. |

Other: `readme.md` (player blurb), `docs/token-notes.md` (what this repo costs to work in
and what is still worth splitting), `docs/claude-settings.json` (copy-in settings),
`docs/memory/` (cached codebase facts — see below).

## Cached codebase facts — `docs/memory/`

`docs/memory/` holds facts that are expensive to re-derive from the code but too detailed
for this file: exact `GameAudio`/`GameCelebrate` signatures, the JSON shape and load
validation of every `localStorage` key, and the chess/checkers engine internals
(Elo-weakening scheme, `LEVELS` table, board encoding). `docs/memory/MEMORY.md` is the
index.

**Check these files before grepping or reading source for anything they cover.** And keep
them true: any change to code they describe — a shared-module signature, a storage key's
shape, an engine tuning knob — must update the matching `docs/memory/` file in the same
commit. A stale entry is worse than none; if you catch one that no longer matches the
code, fix it even if your change didn't cause the drift.

### Vendored — do not read these

Third-party artifacts, replaced wholesale from upstream, never hand-edited. Reading any of
them burns a large amount of context and tells you nothing you need.

| Path | Size | Why not |
| --- | --- | --- |
| `engines/stockfish-18-lite-single.wasm` | **7.3 MB** | Compiled WebAssembly binary. |
| `engines/stockfish-18-lite-single.js` | 21 KB | Minified emscripten glue, 10 lines, no newlines. |
| `lib/chess-1.4.0.mjs` | 107 KB | Upstream chess.js. Use its documented API, not its source. |
| `engines/STOCKFISH-LICENSE.txt` | 35 KB | GPL text. |
| `lib/CHESSJS-LICENSE.txt` | 1.3 KB | License text. |
| `LICENSE` | 18 KB | License text. |

`.gitattributes` already marks these `-diff` so git stops printing them.
`docs/claude-settings.json` denies reading them outright — copy it into place:

```
mkdir -p .claude && cp docs/claude-settings.json .claude/settings.json
```

## How to make a change without reading a whole file

`js/robot.js` is still big. Its `<script>` is divided by section-header comments, as are
the other games'. Get the index first, then read only the section you need:

```
Grep  pattern: "^\s*// -{3,}"   path: js/robot.js     # prints "// ---------- Combat ----------" with line numbers
Read  js/robot.js  offset: 337  limit: 150            # just that section
```

Grep for a symbol before reading anything — `function drawDragon`, `#status`,
`checkers-prefs` — and read a window around the hit. A full `Read` of `js/robot.js` costs
somewhere around 18k tokens; a single section costs a few hundred. See
`docs/token-notes.md` for the rest.

### Section index (names, so it stays true as line numbers drift)

- **`js/snake.js`** — State · Sizing · Game setup · Direction handling · Tick · Render ·
  Main loop · Keyboard · Touch · Boot
- **`js/robot.js`** — Tuning · Opponent skins · DOM · Audio · Persistent W-L record ·
  Game state · Sizing · Match flow · Combat · Effects · Layout helpers · **Drawing
  (~1050 lines — `drawCpu` and `drawDragon` alone are ~750 of them)** · Main loop ·
  Input: keyboard · Input: touch buttons · Boot
- **`js/chess.js`** — Preferences · Audio · Win celebration · Engine (Stockfish) ·
  Game state · Board rendering · Material counter · Player input · Drag to move ·
  Move animation · Engine turn · Game end / flow · Setup UI
- **`js/checkers.js`** — Preferences · Audio · Win celebration · Rules · Engine
  (negamax + alpha-beta) · Game state · Board rendering · Move animation · Material
  counter · Turn flow · Drag to move · Setup UI
- **`js/breakout.js`** — Tuning · Audio · State · Sizing · Game setup · Physics ·
  Render · Main loop · Input: keyboard · Input: touch · Input: mouse · Boot.
  Gameplay runs in a fixed 100 × 140 logical playfield; `scale` is the only
  pixels-per-unit number, so tuning constants never mention pixels.

## Conventions

- **Script loading.** Games load as classic `<script src>` at the end of `<body>`, with
  their shared dependencies immediately before them. `js/chess.js` is the one
  `type="module"`, because it imports chess.js. Keep it that way: converting the others to
  modules would break opening them from `file://`. Module specifiers resolve against the
  module's URL, which is why `js/chess.js` imports `../lib/chess-1.4.0.mjs`, while its
  `new Worker("engines/…")` stays document-relative and correct.
- **Theme** lives in `:root` CSS custom properties (`--bg`, `--panel`, `--text`,
  `--muted`, plus per-game accents). Change the variable, not the usages.
- **iOS viewport boilerplate** in each shell is identical and load-bearing — the
  `viewport-fit=cover` meta, `touch-action`, `overscroll-behavior: none`,
  `height: 100dvh`, and `env(safe-area-inset-*)` padding stop pull-to-refresh, rubber-band
  scroll, and double-tap zoom. Don't "clean it up."
- **Audio** must stay unlocked by a real user gesture or iOS mutes it — each game calls
  `ensureAudio()` from its first tap or keypress. Every call in `js/shared/audio.js` is
  wrapped in `try/catch`: sound is best-effort and must never break gameplay. Each game
  keeps its own `sfx` object of named voices on top of the shared primitives.
- **`localStorage` is always wrapped in `try/catch`** (`/* private browsing */`). Keys in
  use: `snake-best`, `sockbot-record`, `chess-prefs`, `chess-game`, `checkers-prefs`,
  `checkers-game`, `breakout-best`. `js/index.js` reads all of them to render card stats — if you rename or
  reshape a key, update it too.
- **Canvas games** scale by `devicePixelRatio` and derive sizes from a single scale unit
  (e.g. `js/robot.js`'s `S()`), so nothing is hard-coded in pixels.

## Verification

There is nothing to run — no tests, no build, no lint. So:

1. Keep diffs surgical. Prefer the smallest edit that works over a refactor.
2. Syntax-check standalone JS with `node --check js/<file>.js`.
3. To try it by hand, serve over HTTP — `python3 -m http.server` from the repo root, then
   open <http://localhost:8000>. **`file://` will not work for chess**: the Stockfish
   Web Worker and the `chess-1.4.0.mjs` module import are both blocked there.
4. State in the PR description what you could not verify. Do not claim a game was tested
   when it was not.

## Scope

This is a toy repo for a child. Favour small, readable, dependency-free changes. Don't
introduce a build step, a framework, or a package manager without being asked.
