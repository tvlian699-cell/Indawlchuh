// file: frontend/pixi-renderer.js
// Drop-in replacement for animations.js — same public API (Anim.deal,
// Anim.flyCard, Anim.banner, Anim.flash, Anim.clearTrick) so game.js
// needs ZERO changes. Renders cards on a PIXI canvas instead of DOM.

const PixiTable = (() => {
  let app = null;
  const cardSprites = new Map(); // key: "seat-slot" -> PIXI.Container

  function init(containerId = "table") {
    const mount = document.getElementById(containerId);
    app = new PIXI.Application({
      resizeTo: mount, backgroundAlpha: 0, antialias: true
    });
    mount.appendChild(app.view);
    app.view.style.position = "absolute";
    app.view.style.inset = "0";
    app.view.style.pointerEvents = "none"; // let DOM hand/UI stay interactive
    return app;
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
      const style = new PIXI.TextStyle({fontFamily: "Georgia", fontSize: 16, fill: suitColor(suit), fontWeight: "bold"});
      const top = new PIXI.Text(`${rank}${suit}`, style);
      top.anchor.set(0.5); top.x = -w/2 + 14; top.y = -h/2 + 14;
      const center = new PIXI.Text(suit, {fontFamily: "Georgia", fontSize: 28, fill: suitColor(suit)});
      center.anchor.set(0.5);
      const bottom = new PIXI.Text(`${rank}${suit}`, style);
      bottom.anchor.set(0.5); bottom.rotation = Math.PI; bottom.x = w/2 - 14; bottom.y = h/2 - 14;
      c.addChild(top, center, bottom);
    }
    c.pivot.set(0, 0);
    return c;
  }

  // Ease + animate a sprite from (sx,sy) to (ex,ey) over duration ms, then call onDone
  function tweenTo(sprite, sx, sy, ex, ey, duration, onDone) {
    sprite.x = sx; sprite.y = sy;
    let t = 0;
    const start = performance.now();
    function frame(now) {
      t = Math.min(1, (now - start) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      sprite.x = sx + (ex - sx) * ease;
      sprite.y = sy + (ey - sy) * ease - Math.sin(t * Math.PI) * 30;
      sprite.scale.set(1 + 0.15 * Math.sin(t * Math.PI));
      if (t < 1) requestAnimationFrame(frame);
      else { sprite.scale.set(1); onDone && onDone(); }
    }
    requestAnimationFrame(frame);
  }

  function seatPos(pid) {
    // Normalized table positions — same layout as CFG.SEAT used before
    const w = app.screen.width, h = app.screen.height;
    const positions = {
      0: {x: w/2, y: h - 60},
      1: {x: 60,  y: h/2},
      2: {x: w/2, y: 60},
      3: {x: w - 60, y: h/2}
    };
    return positions[pid];
  }

  return {
    init,

    async deal() {
      // Quick visual deal burst — 52 sprites fired from center to each seat
      const center = {x: app.screen.width/2, y: app.screen.height/2};
      const order = [1, 2, 3, 0];
      const promises = [];
      for (let r = 0; r < 13; r++) {
        for (const pid of order) {
          promises.push(new Promise(resolve => {
            const sprite = makeCardSprite(null, true);
            app.stage.addChild(sprite);
            const target = seatPos(pid);
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
        const sprite = makeCardSprite(cs, isBack);
        app.stage.addChild(sprite);
        const from = options?.fromRect
          ? {x: options.fromRect.left + options.fromRect.width/2, y: options.fromRect.top + options.fromRect.height/2}
          : seatPos(pid);
        const to = {x: app.screen.width/2, y: app.screen.height/2};
        const duration = options?.duration || 330;
        tweenTo(sprite, from.x, from.y, to.x, to.y, duration, () => {
          try { onLand && onLand(); } catch (e) { console.error(e); }
          app.stage.removeChild(sprite);
          resolve();
        });
      });
    },

    banner(pid, suit) {
      // Keep using the existing DOM banner element — no need to rebuild in Pixi
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

    clearTrick() {
      // Pixi sprites remove themselves after flyCard finishes — nothing to do
    }
  };
})();

// Expose under the SAME name game.js already expects
window.Anim = PixiTable;
window.PixiTable = PixiTable;
