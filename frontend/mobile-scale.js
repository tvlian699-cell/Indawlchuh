/* Indawlchuh mobile game canvas scaler.
 * Uses the live landscape viewport so one layout scales consistently across
 * different Android phone models, resolutions, and aspect ratios.
 */
(function () {
  "use strict";

  const DESIGN_WIDTH = 960;
  const DESIGN_HEIGHT = 480;
  const MIN_SCALE = 0.48;
  const MAX_SCALE = 1.18;
  let currentScale = 1;
  let pending = false;

  function update() {
    pending = false;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const width = Math.max(1, viewport?.width || root.clientWidth || window.innerWidth || 1);
    const height = Math.max(1, viewport?.height || root.clientHeight || window.innerHeight || 1);

    const fitScale = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
    currentScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fitScale));

    root.style.setProperty("--mobile-ui-scale", currentScale.toFixed(5));
    root.style.setProperty("--mobile-ui-width", `${(width / currentScale).toFixed(2)}px`);
    root.style.setProperty("--mobile-ui-height", `${(height / currentScale).toFixed(2)}px`);
  }

  function scheduleUpdate() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  }

  window.MobileGameScale = Object.freeze({
    getScale() {
      return document.body?.classList.contains("mobile-room-mode") ? currentScale : 1;
    },
    update: scheduleUpdate
  });

  update();
  window.addEventListener("resize", scheduleUpdate, { passive: true });
  window.addEventListener("orientationchange", () => setTimeout(scheduleUpdate, 80), { passive: true });
  document.addEventListener("fullscreenchange", scheduleUpdate);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleUpdate, { passive: true });
    window.visualViewport.addEventListener("scroll", scheduleUpdate, { passive: true });
  }
})();
