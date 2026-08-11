---
name: keep-memory-over-rescanning
description: User wants codebase facts cached in memory instead of rescanned each session; keep those memories current when editing the code they describe
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 71baaf5d-5c78-4c8d-b9bc-18590770c633
  modified: 2026-08-11T00:49:17.790Z
---

On 2026-08-10 the user asked for project memories specifically "so that subsequent requests don't need to keep scanning the code base."

**Why:** This repo has no build/tests, and its guidance (CLAUDE.md, docs/token-notes.md) is heavily oriented around minimizing context spent re-reading files. Memory is the caching layer for facts CLAUDE.md doesn't record.

**How to apply:** Before grepping/reading for shared APIs, storage shapes, or engine tuning, check [[shared-module-apis]], [[localstorage-schemas]], and [[game-engine-internals]] first. Conversely, when an edit changes anything those memories describe (GameAudio/GameCelebrate signatures, a localStorage key's shape, the chess Elo mapping, the checkers LEVELS table), update the memory in the same turn — a stale cache is worse than none. New expensive-to-derive facts uncovered in later sessions should be added as new memories in the same style.

**Repo mirror (added 2026-08-10):** these memories are also checked into the repo at `docs/memory/` so other contributors' sessions get them; CLAUDE.md instructs keeping that copy current. The repo copy is the shared source of truth — when updating a memory here, make the same edit to the matching `docs/memory/` file (and vice versa).
