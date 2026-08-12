---
name: game-engine-internals
description: "Chess Stockfish worker protocol + Elo weakening scheme; checkers board encoding, negamax, and the 10-entry LEVELS difficulty table"
metadata: 
  node_type: memory
  type: project
  originSessionId: 71baaf5d-5c78-4c8d-b9bc-18590770c633
  modified: 2026-08-11T00:46:15.675Z
---

Engine internals (as of 2026-08-10) so difficulty/AI changes don't require re-reading the engine sections.

**Chess (`js/chess.js`, "Engine" section ~line 66):**
- `new Worker("engines/stockfish-18-lite-single.js")` (document-relative path). Plain UCI text protocol over `postMessage`; replies matched by an `expect(pred)` promise queue over `onmessage` lines. Boot sends `uci` and waits for `uciok`; worker construction fails on `file://` and shows a "serve over HTTP" message.
- Difficulty (`configureEngine(elo)`): Stockfish's calibrated floor is **1320 Elo** — at ≥1320 it uses `UCI_LimitStrength`/`UCI_Elo`; below that it uses `Skill Level` = `clamp(floor((elo-600)/100), 0, 7)`.
- Two extra weakening knobs: `moveTimeMs(elo)` scales 80ms→1000ms, and `randomMoveChance(elo)` blends in random legal moves below ~900 Elo (~88% random at the 200-Elo default) because Stockfish can't get weak enough alone.
- Live evaluation ("Live evaluation" section ~line 112, opt-in via the `engine-eval` storage flag): when enabled, the engine analyses continuously on the player's turn (`go infinite`, started after each player-facing render and stopped before every engine search) and the first `info … score` line received per position paints a lichess-style bar (`#eval`) under the board. Scores come back side-relative (`searchTurn` flips the sign); mate scores are stored as ±1e6 plus a signed mate count shown as `Mx`/`m-x`. `parseScore` rewrites `evalWhite`/`evalMate` on every line, so the bar tracks the deepening search in place. The eval bar never touches gameplay: `engineMove` always stops the analysis first (`stopAnalysis`), and game over frees the worker. `stopAnalysis` posts `stop` then drains the analysis `bestmove` via `drainBestmove()`, which abandons the wait after 1.5s (and removes its waiter) so a `go infinite` that never answers "stop" — seen around mating lines — can't hang the engine's next move.

**Checkers (`js/checkers.js`):**
- Board is `number[8][8]`: 1 red man, 2 red king, -1 black man, -2 black king, 0 empty. `RED = 1`, `BLK = -1`; red starts at the bottom (rows 5–7), moves up (decreasing row), and moves first. Kings crown at `CROWN_ROW = { RED: 0, BLK: 7 }`. 80 plies without capture/man-move = draw.
- Engine ("Engine" section ~line 151): negamax + alpha-beta + iterative deepening from depth 2, with a `performance.now()` deadline enforced via a thrown `TIMEOUT` symbol (search runs on a private board copy because the throw skips `undoMove`). Quiescence: depth 0 keeps resolving forced captures. `evaluate` is material (man 100, king 175) + advancement + center bonus, positive = good for red.
- `LEVELS[0..9]` table at ~line 15 drives the 10 difficulty levels: `{ label, depth, ms, noise, random }` — depth 1→15, time budget 60→1300ms, `noise` widens the pool of near-best moves picked from at random, `random` is the chance of playing any legal move (0.85 at level 1, 0 from level 4 up) so young kids can win.
- Live evaluation ("Live evaluation" section ~line 230, opt-in via the `engine-eval` storage flag): the player's turn ends by scheduling `quickEval` 250ms after the "Your move" render. It calls `aiPickMove(board, playerSide, EVAL_LEVEL)` — `EVAL_LEVEL = 8` (depth 13, 1s budget; `random` is 0 there so the score is exact minimax) — and paints the result on the `#eval` bar from the returned move's new `.score` property (side-relative; the move objects come from `genMoves`, so the property is harmless to `aiTurn`). The search is synchronous and never overlaps the AI's own `aiPickMove`, so it needs no worker and no stop signalling. `aiPickMove`'s single-move and random branches also attach `.score` (`side * evaluate`) so the analysis path always has one.

Persisted shapes for both games are in [[localstorage-schemas]].
