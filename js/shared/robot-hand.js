(() => {
  "use strict";

  // The computer's move, played out as a little hand: it reaches down for the
  // piece, closes around it, carries it across the board — through every landing
  // square of a multi-jump — and opens again to set it down. Loaded as a classic
  // script by chess.html and checkers.html; both call `carry()` where they used
  // to fly the piece across in a straight line.
  //
  // The hand only borrows the piece's markup for the trip: the board still draws
  // itself from its own state. Callers empty the square they picked from in
  // `onGrab` and re-render in `onPlace`, exactly where the old fly did it.
  //
  // Connect Four has its own hand in js/connect4.js — it hovers over a column
  // and opens to drop a disc, which is a different animation on a different grid.

  const REACH = 190; // fade in, reaching down for the piece
  const GRAB = 150;  // fist closes around it
  const PAUSE = 90;  // beat between the hops of a multi-jump
  const PLACE = 160; // fingers open again once it is down
  const GONE = 200;  // ...and the hand lifts away

  let live = null; // { el, timer } of the hand in flight, if any

  // Cancel any hand mid-animation. Games call this when they rebuild the board,
  // so a pending step can't fire its callbacks into the next game.
  function clear() {
    if (!live) return;
    clearTimeout(live.timer);
    live.el.remove();
    live = null;
  }

  // Carry time grows with the distance in squares, so a one-square shuffle stays
  // snappy while a queen's slide across the board doesn't blur past.
  function hopMs(dx, dy, sq) {
    return Math.round(Math.min(400, 110 + 60 * Math.hypot(dx, dy) / sq));
  }

  // stage : the positioned box the hand is placed in. Pass the board's *wrapper*,
  //         not the board — the board clips its overflow, and the hand reaches in
  //         from just above the square it is grabbing from.
  // cells : [fromEl, toEl, ...] — one entry per landing square, so a checkers
  //         multi-jump is just a longer list
  // html  : the piece markup to carry, usually fromEl.innerHTML
  // opts  : { onGrab, onHop(i), onPlace } — `i` indexes `cells`, so it is 1 for
  //         the first landing square
  function carry(stage, cells, html, opts) {
    clear();
    const o = opts || {};
    const br = stage.getBoundingClientRect();
    const at = cells.map((el) => el.getBoundingClientRect());
    const a = at[0];

    const el = document.createElement("div");
    el.className = "hand";
    el.style.width = a.width + "px";
    el.style.height = a.height + "px";
    el.style.left = (a.left - br.left) + "px";
    el.style.top = (a.top - br.top) + "px";
    el.innerHTML = '<div class="held"></div><span class="mitt">🖐</span>';
    stage.appendChild(el);
    const held = el.querySelector(".held");
    const mitt = el.querySelector(".mitt");
    live = { el, timer: 0 };

    // Every step re-checks that this hand is still the live one, so a new game
    // started mid-move ends the sequence instead of racing it.
    const step = (fn, ms) => {
      live.timer = setTimeout(() => { if (live && live.el === el) fn(); }, ms);
    };

    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
    step(grab, REACH);

    function grab() {
      mitt.textContent = "✊";
      held.innerHTML = html;
      if (o.onGrab) o.onGrab(); // the caller empties the square it came from
      step(() => hop(1), GRAB);
    }

    function hop(i) {
      const ms = hopMs(at[i].left - at[i - 1].left, at[i].top - at[i - 1].top, a.width);
      el.style.transition = `transform ${ms}ms ease-in-out, opacity 160ms ease`;
      el.style.transform = `translate(${at[i].left - a.left}px, ${at[i].top - a.top}px)`;
      step(() => {
        if (o.onHop) o.onHop(i);
        if (i + 1 < cells.length) step(() => hop(i + 1), PAUSE);
        else place();
      }, ms + 20);
    }

    function place() {
      mitt.textContent = "🖐";
      held.innerHTML = "";
      if (o.onPlace) o.onPlace(); // the caller re-renders: the piece is really there now
      step(() => {
        el.classList.remove("in"); // fades out and lifts back up, the way it came in
        step(clear, GONE);
      }, PLACE);
    }
  }

  window.RobotHand = { carry, clear };
})();
