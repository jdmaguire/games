# What this repo costs to work in

Notes from the pass on issue #4. Read `CLAUDE.md` first; this file is the background.

## Where the tokens went

Everything was one file per page — markup, styling, and all the logic inline. So any
change loaded all of it, whatever you were actually touching.

| Page | Was | Now: shell + styles + logic |
| --- | --- | --- |
| `index.html` | 166 | 47 + 84 + 33 |
| `snake.html` | 415 | 28 + 76 + 309 |
| `chess.html` | 936 | 49 + 184 + 612 |
| `checkers.html` | 995 | 48 + 180 + 661 |
| `robot.html` | 1831 | 32 + 107 + 1656 |

A colour tweak to Sockbot Showdown went from 1831 lines to 107. A markup fix went from
1831 to 32. Only logic changes still pay for logic. On top of that, `ensureAudio`/`beep`/
`thud` existed three times over and the win banner and confetti twice, all byte-identical;
they now live in `js/shared/` once, which took 235 duplicated lines down to 132 shared
ones.

The other cost was accidental. Six vendored files — a 7.3 MB Stockfish `.wasm`, its 21 KB
of minified glue, 107 KB of chess.js, three license texts — dwarf all the hand-written
code and are worth nothing to read, since they are replaced wholesale from upstream rather
than edited. `.gitattributes` now marks them `-diff`, and `docs/claude-settings.json`
denies reading them.

## Copy the settings file into place

This is the step that has to happen by hand:

```
mkdir -p .claude && cp docs/claude-settings.json .claude/settings.json
git add .claude/settings.json && git commit -m "Add Claude Code project settings"
```

Worth committing rather than leaving local: `.claude/settings.json` is project settings, so
the `@claude` GitHub Action honours the same deny list. Otherwise the guard only protects
your laptop and the Action can still read the 7.3 MB blob.

## Still worth doing

**`js/robot.js` is 1656 lines and about 18k tokens.** It is the one file where a logic
change is still expensive. Roughly 1050 of those lines are the Drawing section, and
`drawCpu` plus `drawDragon` are about 750 on their own — pure canvas painting that has no
reason to load when you are editing combat or input handling. Splitting it out is the
biggest remaining win.

It was left alone deliberately. Those functions read a lot of surrounding closure state
(`ctx`, `W`, `H`, `now`, `cpu`, `player`, `S()`, `springOffset()`), so extracting them
means either ES modules with a shared state module or threading an explicit context
object. Both are real refactors of a 1600-line file, and this repo has no tests and no way
to assert the game still looks right. It wants a human who can load the page and throw a
few punches, not a blind mechanical move.

**Prompt caching needs no repo change.** `claude-code-action` already caches the prompt
prefix. What helps is a *stable* prefix, which is why `CLAUDE.md` is worth keeping edited
rarely and deliberately — churn there invalidates the cache on every run. `fetch-depth: 1`
in the workflow is already right.

**One thing this pass could not touch:** `.github/workflows/claude.yml`. The GitHub App
is not permitted to modify workflow files, so any tuning there — `claude_args` to bound
turns, a smaller model for routine work — has to be done by hand. Check the
[action's inputs](https://github.com/anthropics/claude-code-action) for the current flags
rather than trusting a list written here.
