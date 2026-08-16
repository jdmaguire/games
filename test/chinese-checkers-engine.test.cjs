"use strict";

// Tests for js/shared/chinese-checkers-engine.js. No framework, no deps:
//
//   node test/chinese-checkers-engine.test.js
//
// Covers the board geometry invariants, the corner-resting rule, the
// anti-blocking win rule (and its strict-team counterpart), gift-refusal by
// the search, and full AI self-play at every seat count — free-for-all and
// teams — asserting every game reaches a legal win with no stalls. Takes
// about a minute: the self-play games run at real engine time budgets.

const fs = require("fs");
const path = require("path");

// The engine is a classic script (an IIFE that publishes on `window`), so
// give it one and let it attach.
global.window = {};
global.performance = require("perf_hooks").performance;
eval(fs.readFileSync(path.join(__dirname, "..", "js", "shared", "chinese-checkers-engine.js"), "utf8"));
const E = global.window.ChineseCheckersEngine;

const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };
const at = (x, z) => E.CELLS.findIndex((c) => c.x === x && c.z === z);
const canRest = (p, i) => E.CORNER[i] < 0 || E.CORNER[i] === p - 1 || E.CORNER[i] === E.targetOf(p);

// ---------- Geometry invariants ----------
assert(E.CELLS.length === 121, "121 cells, got " + E.CELLS.length);
for (let k = 0; k < 6; k++) assert(E.TRI[k].length === 10, "corner " + k + " has 10 cells");
{
  let hexagon = 0;
  for (const { x, z } of E.CELLS) {
    const y = -x - z;
    if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) <= 4) hexagon++;
  }
  assert(hexagon === 61, "61-cell central hexagon, got " + hexagon);
}

// ---------- Start boards: no win fires at the start, teams or not ----------
for (const n of [2, 3, 4, 6]) {
  const bd = E.startBoard(n);
  const counts = {};
  for (const v of bd) counts[v] = (counts[v] || 0) + 1;
  assert(counts[0] === 121 - n * 10, n + "p: empty count");
  for (const p of E.SEATS[n]) {
    assert(counts[p] === 10, n + "p: player " + p + " has 10 marbles");
    assert(!E.isWin(bd, p), n + "p: no win at the start");
    assert(!E.winnerAfter(bd, { from: 0, to: 0 }, p, true), n + "p: no team win at the start");
  }
}

// ---------- Opening moves ----------
{
  const bd = E.startBoard(2);
  const moves = E.genMoves(bd, 1);
  assert(moves.length === 14, "known-correct opening move count, got " + moves.length);
  const seen = new Set();
  for (const m of moves) {
    assert(bd[m.from] === 1 && bd[m.to] === 0 && m.from !== m.to, "legal move");
    assert(canRest(1, m.to), "no resting in a foreign corner");
    assert(m.path[0] === m.from && m.path[m.path.length - 1] === m.to, "path endpoints");
    const key = m.from + ":" + m.to;
    assert(!seen.has(key), "no duplicate (from,to)");
    seen.add(key);
  }
}

// ---------- The corner-resting rule ----------
// A marble next to a foreign corner can neither step nor hop-land into it;
// the corner's owner still can.
{
  const bd = new Array(121).fill(0);
  bd[at(4, 0)] = 1;  // hexagon cell bordering corner 1 (lower-right)
  bd[at(4, 1)] = 4;  // a marble to hop over, sitting in corner 1
  assert(!E.genMoves(bd, 1).some((m) => E.CORNER[m.to] === 1), "no move ends in a foreign corner");
  assert(E.genMoves(bd, 1).length > 0, "the marble can still move elsewhere");
  bd[at(4, 0)] = 2;  // corner 1 IS player 2's home
  assert(E.genMoves(bd, 2).some((m) => m.to === at(4, 2)), "the owner may hop back into their home");
}

// ---------- Anti-blocking win (free-for-all) vs strict team win ----------
{
  const bd = new Array(121).fill(0);
  bd[at(0, 0)] = 1;
  bd[at(0, 1)] = 4;
  for (const i of E.TRI[3]) bd[i] = 4;  // player 1's target, full of the owner
  assert(!E.isWin(bd, 1), "squatters-only full is NOT a win");
  bd[E.TRI[3][0]] = 1;                  // one hole is the incomer's
  assert(E.isWin(bd, 1), "full + at least one of yours IS a win (free-for-all)");
  assert(!E.winnerAfter(bd, { from: 0, to: E.TRI[3][0] }, 1, true),
    "teams: partner marbles never count as squatters");
  bd[E.TRI[3][1]] = 0;                  // open a hole
  assert(!E.isWin(bd, 1), "a hole in the triangle is not a win");
}

// ---------- Strict team win: both partners fully home ----------
{
  const bd = new Array(121).fill(0);
  for (const i of E.TRI[3]) bd[i] = 1;  // player 1 fully home (target = corner 3)
  for (const i of E.TRI[0]) bd[i] = 4;  // partner 4 fully home (target = corner 0)
  const mv = { from: at(0, 0), to: E.TRI[3][0] };
  assert(E.winnerAfter(bd, mv, 1, true) === 1, "team wins when both partners are strictly home");
  assert(!E.winnerAfter(bd, mv, 2, true), "another seat's move can't complete this team's win");
  const hole = E.TRI[0][0];
  bd[hole] = 0;
  assert(!E.winnerAfter(bd, mv, 1, true), "no team win while the partner is one marble short");
}

// ---------- The search must not gift a win by re-filling its own home ----------
// Corner 3: 8 green (4) + 1 red (1) squatting the tip, one hole empty. Green
// has a legal in-home shuffle that fills it — which would hand red the win.
{
  const bd = new Array(121).fill(0);
  const empty = at(1, -5);
  for (const i of E.TRI[3]) bd[i] = 4;
  bd[at(4, -8)] = 1;   // red squats the tip
  bd[empty] = 0;       // ...and one home hole is open
  bd[at(0, 0)] = 4;    // a free green marble with plenty of harmless moves
  bd[at(0, 4)] = 1;    // another red so red has moves too
  assert(E.genMoves(bd, 4).some((m) => m.to === empty), "the gifting shuffle is a legal move");
  for (let t = 0; t < 5; t++) {
    const mv = E.aiPickMove(bd, 4, 4, 300, false);
    assert(mv && mv.to !== empty, "AI refuses to re-fill its home and gift the win (trial " + t + ")");
  }
}

// ---------- Self-play: reach a win at every count, free-for-all and teams ----------
function selfPlay(players, level, ms, maxMoves, teams) {
  const bd = E.startBoard(players);
  const seats = E.SEATS[players];
  let ti = 0, moves = 0;
  const t0 = performance.now();
  while (moves < maxMoves) {
    const p = seats[ti];
    const mv = E.aiPickMove(bd, p, level, ms, teams);
    if (!mv) { ti = (ti + 1) % seats.length; continue; } // fully blocked: skip, like the UI
    assert(bd[mv.from] === p && bd[mv.to] === 0, "AI move is legal");
    assert(canRest(p, mv.to), "AI move respects the corner-resting rule");
    if (moves % 10 === 0) {
      for (const m of E.genMoves(bd, p)) assert(canRest(p, m.to), "genMoves respects the corner-resting rule");
    }
    E.applyMove(bd, mv);
    moves++;
    const w = E.winnerAfter(bd, mv, p, teams);
    if (w) {
      const label = teams ? "team " + w + "&" + E.partnerOf(w) : "player " + w;
      console.log(players + "p" + (teams ? " TEAMS" : "") + " level " + (level + 1) + ": " + label +
        " wins after " + moves + " moves (" + ((performance.now() - t0) / moves).toFixed(0) + "ms/move avg)");
      return;
    }
    ti = (ti + 1) % seats.length;
  }
  assert(false, players + "p" + (teams ? " TEAMS" : "") + " level " + (level + 1) +
    " stalled: no win in " + maxMoves + " moves");
}
selfPlay(2, 4, 80, 400, false);   // level 5
selfPlay(3, 3, 60, 600, false);   // level 4
selfPlay(4, 2, 40, 3000, false);  // level 3 — noisy near-greedy play converges slowly and unevenly
selfPlay(6, 5, 60, 1200, false);  // level 6
selfPlay(2, 9, 150, 400, false);  // level 10 — deterministic top level must not cycle
selfPlay(4, 4, 60, 1500, true);   // team games run until BOTH partners are home
selfPlay(6, 3, 40, 2500, true);
selfPlay(4, 6, 100, 1500, true);  // a searching level must coordinate the double-done finish

console.log("ALL PASS");
