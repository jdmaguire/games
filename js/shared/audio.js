// Tiny WebAudio synth. Chess, Checkers, and Sockbot Showdown all had a byte-identical
// copy of this; they now share one.
//
// Loaded as a classic script before each game's own script. That works for the classic
// game scripts and for chess.js too, because module scripts are deferred and run after
// every classic script in the document has already executed.
//
// iOS leaves an AudioContext suspended until a real user gesture, so each game calls
// ensureAudio() from its first tap or keypress. Every call is wrapped in try/catch: sound
// is best-effort and must never take gameplay down with it.
(() => {
  "use strict";

  let AC = null;

  function ensureAudio() {
    try {
      if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
      if (AC.state === "suspended") AC.resume();
    } catch (e) { AC = null; }
  }

  // A pitched blip. Pass f2 to glide from f to f2 over dur; when delays the start.
  function beep(f, f2, dur, type, vol, when) {
    if (!AC) return;
    try {
      const t0 = AC.currentTime + (when || 0);
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t0);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(AC.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    } catch (e) { /* audio is best-effort */ }
  }

  // A percussive knock: decaying white noise.
  function thud(dur, vol) {
    if (!AC) return;
    try {
      const n = Math.floor(AC.sampleRate * dur);
      const buf = AC.createBuffer(1, n, AC.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = AC.createBufferSource(), g = AC.createGain();
      src.buffer = buf;
      g.gain.value = vol;
      src.connect(g).connect(AC.destination);
      src.start();
    } catch (e) { /* audio is best-effort */ }
  }

  // Each game keeps its own sfx object on top of these — the voices differ per game.
  window.GameAudio = { ensureAudio, beep, thud };
})();
