---
name: game-engine-internals
description: "Chess Stockfish worker protocol + Elo weakening scheme; checkers board encoding, negamax, and the 10-entry LEVELS difficulty table"
metadata: 
  node_type: memory
  type: project
  originSessionId: 71baaf5d-5c78-4c8d-b9bc-18590770c633
  modified: 2026-08-11T00:46:15.675Z
---

Engine internals (as of 2026-08-12) so difficulty/AI changes don't require re-reading the engine sections.

**Chess (`js/chess.js`, "Engine" section ~line 66):**
- `new Worker("engines/stockfish-18-lite-single.js")` (document-relative path). Plain UCI text protocol over `postMessage`; replies matched by an `expect(pred)` promise queue over `onmessage` lines. Boot sends `uci` and waits for `uciok`; worker construction fails on `file://` and shows a "serve over HTTP" message.
- Difficulty (`configureEngine(elo)`): Stockfish's calibrated floor is **1320 Elo** — at ≥1320 it uses `UCI_LimitStrength`/`UCI_Elo`; below that it uses `Skill Level` = `clamp(floor((elo-600)/100), 0, 7)`.
- Two extra weakening knobs: `moveTimeMs(elo)` scales 80ms→1000ms, and `randomMoveChance(elo)` blends in random legal moves below ~900 Elo (~88% random at the 200-Elo default) because Stockfish can't get weak enough alone.
- Live evaluation ("Live evaluation" section ~line 112, opt-in via the `engine-eval` storage flag): when enabled, the engine analyses continuously on the player's turn (`go infinite`, started after each player-facing render and stopped before every engine search) and the first `info … score` line received per position paints a lichess-style bar (`#eval`) under the board. Scores come back side-relative (`searchTurn` flips the sign); mate scores are stored as ±1e6 plus a signed mate count shown as `Mx`/`m-x`. `parseScore` rewrites `evalWhite`/`evalMate` on every line, so the bar tracks the deepening search in place. The eval bar never touches gameplay: `engineMove` always stops the analysis first (`stopAnalysis`), and game over frees the worker. `stopAnalysis` posts `stop` then drains the analysis `bestmove` via `drainBestmove()`, which abandons the wait after 1.5s (and removes its waiter) so a `go infinite` that never answers "stop" — seen around mating lines — can't hang the engine's next move.

**Checkers (rules + engine in `js/shared/checkers-engine.js`; `js/checkers.js` is the UI):**
- Board is `number[8][8]`: 1 red man, 2 red king, -1 black man, -2 black king, 0 empty. `RED = 1`, `BLK = -1`; red starts at the bottom (rows 5–7), moves up (decreasing row), and moves first. Kings crown at `CROWN_ROW = { RED: 0, BLK: 7 }`. 80 plies without capture/man-move = draw (checked by `js/checkers.js`, not the engine).
- Engine: negamax + alpha-beta + iterative deepening from depth 2, plus a **transposition table** (`Map`, Zobrist-keyed; two independent deterministic 32-bit LCG tables `ZLO`/`ZHI` make a 64-bit key, Map keyed on `lo` with `hi` verified on hit so a collision is a miss, never a wrong move; capped at `TT_LIMIT = 200000` and cleared when full). Entries store `{ side, depth, score, flag, move }` with `flag` 0 EXACT / 1 LOWER / 2 UPPER; probe returns on matching `side` + `depth >= depth`, and the stored best move is tried first for move ordering. `negamax` also enforces a `performance.now()` deadline by throwing a `TIMEOUT` symbol (search runs on a private board copy because the throw skips `undoMove`). Quiescence: depth 0 keeps resolving forced captures. `evaluate` is material (man 100, king 175) + advancement + center bonus, positive = good for red.
- Both the AI's move and the live eval run through the same Worker (`askEngine` in `js/checkers.js`; protocol `{ id, board, side, level, ms } → { id, move }`), sharing the one transposition table — so the eval search warms the AI's next move. If the Worker can't start (e.g. `file://`), `askEngine` degrades to calling `aiPickMove` synchronously on the main thread.
- `LEVELS[0..9]` table drives the 10 difficulty levels: `{ label, depth, ms, noise, random }` — depth 1→15, time budget 60→2000ms (ramped up from 60→1300ms; high levels are time-capped, not depth-capped — at 2s level 10 reaches effective depth ~8–11 in middlegames vs depth 3 for level 4, and extra budget beyond ~1s buys little because per-ply cost grows exponentially), `noise` widens the pool of near-best moves picked from at random, `random` is the chance of playing any legal move (0.85 at level 1, 0 from level 4 up) so young kids can win. Iterative deepening caps at the level's `depth`.
- Live evaluation ("Live evaluation" section in `js/checkers.js`, opt-in via the `engine-eval` storage flag): the player's turn ends by scheduling `quickEval` 250ms after the "Your move" render. It calls `askEngine(playerSide, EVAL_LEVEL, EVAL_MS)` — `EVAL_LEVEL = 8` (LEVELS[8]: depth 11), `EVAL_MS = 300` short override so a pending eval never delays the AI's own move request queued behind it — and paints the reply's `.score` on the `#eval` bar (side-relative; `random` is 0 at that level so the score is exact minimax). Stale replies are dropped via a `gameSeq` counter bumped on start/undo.

Persisted shapes for both games are in [[localstorage-schemas]].
