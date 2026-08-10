// Win banner and confetti for the two board games. Chess and Checkers had a
// byte-identical copy of this; they now share one.
//
// Loaded as a classic script before each game's own script. Each game keeps its own
// celebrate() wrapper, because the victory jingle it plays is game-specific.
(() => {
  "use strict";

  let banner = null;

  // Appended to #wrap, which both board pages have.
  function showBanner(text) {
    hideBanner();
    banner = document.createElement("div");
    banner.className = "winbanner";
    banner.textContent = text;
    document.getElementById("wrap").appendChild(banner);
  }

  function hideBanner() {
    if (banner) { banner.remove(); banner = null; }
  }

  // Throwaway full-screen canvas that removes itself after durMs.
  function confetti(durMs) {
    const cv = document.createElement("canvas");
    cv.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:50";
    document.body.appendChild(cv);
    const cx = cv.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    cv.width = innerWidth * dpr;
    cv.height = innerHeight * dpr;
    cx.scale(dpr, dpr);
    const colors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#fbbf24"];
    const bits = Array.from({ length: 160 }, () => ({
      x: Math.random() * innerWidth,
      y: -20 - Math.random() * innerHeight * 0.6,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      vy: 100 + Math.random() * 170,
      vx: -40 + Math.random() * 80,
      rot: Math.random() * Math.PI * 2,
      vr: -5 + Math.random() * 10,
      sway: Math.random() * Math.PI * 2,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    let start = null, last = null;
    function frame(t) {
      if (!start) { start = t; last = t; }
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const elapsed = t - start;
      cx.clearRect(0, 0, innerWidth, innerHeight);
      cx.globalAlpha = elapsed > durMs - 600 ? Math.max(0, (durMs - elapsed) / 600) : 1;
      for (const b of bits) {
        b.y += b.vy * dt;
        b.x += (b.vx + Math.sin(b.sway + elapsed / 300) * 30) * dt;
        b.rot += b.vr * dt;
        if (b.y > innerHeight + 20) { b.y = -20; b.x = Math.random() * innerWidth; }
        cx.save();
        cx.translate(b.x, b.y);
        cx.rotate(b.rot);
        cx.fillStyle = b.color;
        cx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        cx.restore();
      }
      if (elapsed < durMs) requestAnimationFrame(frame);
      else cv.remove();
    }
    requestAnimationFrame(frame);
  }

  window.GameCelebrate = { showBanner, hideBanner, confetti };
})();
