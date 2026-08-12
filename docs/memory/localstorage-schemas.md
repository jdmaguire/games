---
name: localstorage-schemas
description: "Exact JSON shape and load-time validation of every localStorage key (snake-best, sockbot-record, chess/checkers prefs+game, breakout-best, minesweeper-best)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 71baaf5d-5c78-4c8d-b9bc-18590770c633
  modified: 2026-08-11T00:45:58.313Z
---

Exact value shapes of all localStorage keys (as of 2026-08-10). CLAUDE.md lists the key names; this records the shapes and the validation each game applies on load. `js/index.js` reads all of them to render card stats, so reshaping any key means updating it too.

- `snake-best` / `breakout-best` — stringified integer (`String(best)`), read with `parseInt(x, 10) || 0`.
- `minesweeper-best` (js/minesweeper.js ~line 73) — `{ easy: number, medium: number, hard: number }` seconds. Load keeps each field only if a positive number. Saved on a win when the time beats the stored best for that difficulty. index.js shows the best (min) time across all three.
- `sockbot-record` (js/robot.js ~line 134) — `{ streak: number, best: number, dragonTries: number }`. Load requires numeric `streak` and `best`; `dragonTries` defaults to 0. index.js shows "Best streak" and a 🐉 hint when `dragonTries > 0`.
- `chess-prefs` — `{ elo: number, side: "w"|"b", random: boolean }`, default `{ elo: 200, side: "w", random: false }`. `random: true` means the colour is picked randomly at game start; `side` then just holds the last concrete pick (and the resumed game's side). Load accepts if `elo` is a number; `side` is forced to `"w"` if invalid and `random` coerced to boolean (older saves without it load as `false`).
- `chess-game` — `{ moves: string[] (UCI), side: "w"|"b", elo: number }`. The UCI move list fully reconstructs the position. Boot resumes only if `moves` is all-strings array and `side` is valid; missing `elo` falls back to prefs.
- `checkers-prefs` — `{ level: number (0-9), side: 1|-1, random: boolean }` (RED=1, BLK=-1), default `{ level: 0, side: RED, random: false }`. `random: true` picks the colour randomly at game start. index.js displays `level + 1` as "Engine level N of 10".
- `checkers-game` — `{ board: number[8][8], turn: 1|-1, clock: number, side: 1|-1, level: number, snapshots: [] }`. Board cells must each be in [-2,-1,0,1,2] (validated by `validBoard` at boot). Saved at stable points between moves. `snapshots` is the undo stack: one `{ bd, clock }` per **completed player move**, pushed by `finishPlayerMove` (from a board copy armed at the start of the player's turn, `pendingSnap` — reconstructed as the current board on boot and never persisted itself). Undo pops one snapshot to revert a whole exchange (your move + the engine's reply) and is repeatable back to the opening, mirroring chess. Like chess, it survives refresh because undo saves the reduced `board`/`snapshots`.
- `engine-eval` (js/index.js ~line 41, plus each game's own setup overlay: `#eval-opt` in chess.html/checkers.html, wired in js/chess.js ~line 690 and js/checkers.js ~line 706) — `"1"` or `"0"` (absent = off). "Show the engine's evaluation bar in Chess & Checkers". All three places read/write the same key, so they stay in sync; the bar appears when a game starts. Each game reads it at boot.

Both board games wrap every access in try/catch (`/* private browsing */`) and fall through to the setup menu on a corrupted save. Board-cell encoding is detailed in [[game-engine-internals]].
