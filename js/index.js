(() => {
  "use strict";

  // Surface each game's saved progress on its card (best-effort; storage may be blocked)
  try {
    const best = parseInt(localStorage.getItem("snake-best"), 10);
    if (best > 0) document.getElementById("snake-stat").textContent = "Best score: " + best;
  } catch (e) { /* private browsing */ }
  try {
    const rec = JSON.parse(localStorage.getItem("sockbot-record"));
    if (rec && rec.best > 0) {
      document.getElementById("robot-stat").textContent =
        "Best streak: " + rec.best + (rec.dragonTries > 0 ? " · 🐉 awaits!" : "");
    }
  } catch (e) { /* private browsing */ }
  try {
    const p = JSON.parse(localStorage.getItem("chess-prefs"));
    if (p && p.elo) document.getElementById("chess-stat").textContent = "Engine set to " + p.elo + " Elo";
  } catch (e) { /* private browsing */ }
  try {
    const p = JSON.parse(localStorage.getItem("checkers-prefs"));
    if (p && typeof p.level === "number") {
      document.getElementById("checkers-stat").textContent = "Engine level " + (p.level + 1) + " of 10";
    }
  } catch (e) { /* private browsing */ }

  try {
    const best = parseInt(localStorage.getItem("breakout-best"), 10);
    if (best > 0) document.getElementById("breakout-stat").textContent = "Best score: " + best;
  } catch (e) { /* private browsing */ }
  try {
    const b = JSON.parse(localStorage.getItem("minesweeper-best"));
    let best = Infinity;
    if (b) for (const k of ["easy", "medium", "hard"]) {
      if (typeof b[k] === "number" && b[k] > 0) best = Math.min(best, b[k]);
    }
    if (best < Infinity) document.getElementById("minesweeper-stat").textContent = "Best time: " + best + "s";
  } catch (e) { /* private browsing */ }

  // "Show engine evaluation in Chess & Checkers" toggle
  const evalToggle = document.getElementById("eval-toggle");
  try { evalToggle.checked = localStorage.getItem("engine-eval") === "1"; } catch (e) { /* private browsing */ }
  evalToggle.addEventListener("change", () => {
    try { localStorage.setItem("engine-eval", evalToggle.checked ? "1" : "0"); } catch (e) { /* private browsing */ }
  });

  // Quick keyboard select on desktop
  const KEYS = { 1: "snake.html", 2: "robot.html", 3: "chess.html", 4: "checkers.html", 5: "breakout.html", 6: "minesweeper.html" };
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (KEYS[e.key]) window.location.href = KEYS[e.key];
  });
})();
