// file: frontend/pixi-renderer.js
// Pixi animation layer. Drop-in replacement for animations.js.
// Fixes vs the old port:
//  - Uses ResizeObserver (v7's resizeTo only listens to window resize, and
//    #table starts as display:none, so the canvas stayed 0×0 forever).
//  - flyCard now flies to the actual #trick-* DOM slot, not canvas center.
//  - deal() targets the actual hand containers when they have size.
//  - Canvas is z-indexed above #play-layer(50) / #zone-bottom(5).
//  - autoDensity+resolution keeps text crisp on high-DPR phones.

const PixiTable = (() => {
  let app = null;

  function init(containerId = "table") {
    const mount = document.getElementById(containerId);
    if (!mount) { console.error("[PixiTable] mount not found:", containerId); return null; }
    if (app) return app;

    app = new PIXI.Application({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1
    });
    mount.appendChild(app.view);

    Object.assign(app.view.style, {
      position: "absolute",
      inset: "0",
      zIndex: "55",              // above #play-layer (50) and #zone-bottom (5)
      pointerEvents: "none"
    });

    const applySize = () => {
      const w = Math.max(1, mount.clientWidth);
      const h = Math.max(1, mount.clientHeight);
      if (app.screen.width !== w || app.screen.height !== h) {
        app.renderer.resize(w, h);
      }
    };

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(applySize);
      ro.observe(mount);
      app.__ro = ro;
    }
    window.addEventListener("resize", applySize);
    document.addEventListener("fullscreenchange", applySize);
    window.addEventListener("orientationchange", () => setTimeout(applySize, 120));

    applySize();
    return app;
  }

  function ensureSized() {
    if (!app) return false;
    const mount = document.getElementById("table");
    if (!mount) return false;
    const w = Math.max(1, mount.clientWidth);
    const h = Math.max(1, mount.clientHeight);
    if (app.screen.width !== w || app.screen.height !== h) {
      app.renderer.resize(w, h);
    }
    return true;
  }

  function suitColor(suit) {
    return (suit === "♥" || suit === "♦") ? 0xb3182c : 0x1a1a1a;
  }

  function makeCardSprite(cs, isBack = false) {
    const c = new PIXI.Container();
    const w = 60, h = 88;
    const bg = new PIXI.Graphics();
    bg.beginFill(isBack ? 0x14432c : 0xfbf2d9);
    bg.lineStyle(2, 0x9c7937);
    bg.drawRoundedRect(-w/2, -h/2, w, h, 8);
    bg.endFill();
    c.addChild(bg);

    if (isBack) {
      const emblem = new PIXI.Text("♠", {fontSize: 22, fill: 0xe0bd61});
      emblem.anchor.set(0.5);
      c.addChild(emblem);
    } else {
      const suit = cs.slice(-1), rank = cs.slice(0, -1);
      const style = new PIXI.TextStyle({
        fontFamily: "Georgia",
        fontSize: 16,
        fill: suitColor(suit),
        fontWeight: "bold"
      });
      const top = new PIXI.Text(`${rank}${suit}`, style);
      top.anchor.set(0.5); top.x = -w/2 + 14; top.y = -h/2 + 14;
      const center = new PIXI.Text(suit, {
        fontFamily: "Georgia", fontSize: 28, fill: suitColor(suit)
      });
      center.anchor.set(0.5);
      const bottom = new PIXI.Text(`${rank}${suit}`, style);
      bottom.anchor.set(0.5);
      bottom.rotation = Math.PI;
      bottom.x = w/2 - 14;
      bottom.y = h/2 - 14;
      c.addChild(top, center, bottom);
    }
    return c;
  }

  function tweenTo(sprite, sx, sy, ex, ey, duration, onDone) {
    sprite.x = sx; sprite.y = sy;
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      sprite.x = sx + (ex - sx) * ease;
      sprite.y = sy + (ey - sy) * ease - Math.sin(t * Math.PI) * 24;
      sprite.scale.set(1 + 0.10 * Math.sin(t * Math.PI));
      if (t < 1) requestAnimationFrame(frame);
      else { sprite.scale.set(1); onDone && onDone(); }
    }
    requestAnimationFrame(frame);
  }

  function seatPos(pid) {
    const w = app.screen.width, h = app.screen.height;
    const s = (window.CFG && window.CFG.SEAT && window.CFG.SEAT[pid]) || {x: 0.5, y: 0.5};
    return { x: w * s.x, y: h * s.y };
  }

  function tableRectAndScale() {
    const table = document.getElementById("table");
    const rect = table.getBoundingClientRect();
    const scale =
      (window.MobileGameScale && window.MobileGameScale.getScale &&
       window.MobileGameScale.getScale()) || 1;
    return { rect, scale };
  }

  function centerInCanvas(el, tableRect, scale) {
    const r = el.getBoundingClientRect();
    return {
      x: (r.left - tableRect.left + r.width  / 2) / scale,
      y: (r.top  - tableRect.top  + r.height / 2) / scale
    };
  }

  const TRICK_IDS = ["trick-bottom", "trick-left", "trick-top", "trick-right"];

  return {
    init,

    async deal() {
      if (!app) return;
      ensureSized();
      const { rect: tableRect, scale } = tableRectAndScale();
      const center = { x: app.screen.width / 2, y: app.screen.height / 2 };

      const targets = {
        0: document.getElementById("hand-row"),
        1: document.getElementById("hand-left"),
        2: document.getElementById("hand-top"),
        3: document.getElementById("hand-right")
      };

      const order = [1, 2, 3, 0];
      const promises = [];

      for (let r = 0; r < 13; r++) {
        for (const pid of order) {
          promises.push(new Promise(resolve => {
            const sprite = makeCardSprite(null, true);
            app.stage.addChild(sprite);

            let target = seatPos(pid);
            const t = targets[pid];
            if (t) {
              const tr = t.getBoundingClientRect();
              if (tr.width > 4 && tr.height > 4) {
                target = centerInCanvas(t, tableRect, scale);
              }
            }

            tweenTo(sprite, center.x, center.y, target.x, target.y, 150, () => {
              app.stage.removeChild(sprite);
              resolve();
            });
          }));

          await new Promise(r => setTimeout(r, 30));
        }
      }
      await Promise.all(promises);
    },

    flyCard(pid, cs, isBack, onLand, options = {}) {
      return new Promise(resolve => {
        if (!app) {
          try { onLand && onLand(); } catch (_) {}
          resolve();
          return;
        }
        ensureSized();

        const { rect: tableRect, scale } = tableRectAndScale();
        const sprite = makeCardSprite(cs, isBack);
        app.stage.addChild(sprite);

        // From: drag-release rect if provided, else hardcoded seat anchor.
        let from;
        if (options && options.fromRect && Number.isFinite(options.fromRect.left)) {
          const fr = options.fromRect;
          from = {
            x: (fr.left - tableRect.left + fr.width  / 2) / scale,
            y: (fr.top  - tableRect.top  + fr.height / 2) / scale
          };
        } else {
          from = seatPos(pid);
        }

        // To: the real trick slot for this seat.
        let to = { x: app.screen.width / 2, y: app.screen.height / 2 };
        const slot = document.getElementById(TRICK_IDS[pid]);
        if (slot) to = centerInCanvas(slot, tableRect, scale);

        const duration = Number(options && options.duration) || 330;

        tweenTo(sprite, from.x, from.y, to.x, to.y, duration, () => {
          try { onLand && onLand(); } catch (e) { console.error(e); }
          app.stage.removeChild(sprite);
          resolve();
        });
      });
    },

    banner(pid, suit) {
      const el = document.getElementById("trump-banner");
      if (!el) return;
      el.textContent = `${["You","P1","P2","P3"][pid]} declared trump: ${suit}`;
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 2200);
    },

    flash(pid) {
      const el = document.getElementById("twflash");
      if (!el) return;
      el.textContent = `${["You","P1","P2","P3"][pid]} wins the trick!`;
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 950);
    },

    clearTrick() { /* sprites self-remove after flyCard */ }
  };
})();

window.Anim = PixiTable;
window.PixiTable = PixiTable;
