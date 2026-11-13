// file: frontend/pixi-renderer.js
// v2 — full CardFace art ported into Pixi (pips + court cards), so the
// flying card and the landed card are visually identical (no more flicker).

const PixiTable = (() => {
  let app = null;

  function init(containerId = "table") {
    const mount = document.getElementById(containerId);
    if (!mount) { console.error("[PixiTable] mount not found:", containerId); return null; }
    if (app) return app;

    app = new PIXI.Application({
      backgroundAlpha: 0, antialias: true, autoDensity: true,
      resolution: window.devicePixelRatio || 1
    });
    mount.appendChild(app.view);
    Object.assign(app.view.style, {position:"absolute", inset:"0", zIndex:"55", pointerEvents:"none"});

    const applySize = () => {
      const w = Math.max(1, mount.clientWidth), h = Math.max(1, mount.clientHeight);
      if (app.screen.width !== w || app.screen.height !== h) app.renderer.resize(w, h);
    };
    if (typeof ResizeObserver !== "undefined") { new ResizeObserver(applySize).observe(mount); }
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
    const w = Math.max(1, mount.clientWidth), h = Math.max(1, mount.clientHeight);
    if (app.screen.width !== w || app.screen.height !== h) app.renderer.resize(w, h);
    return true;
  }

  const RED = 0xb3182c, BLACK = 0x1a1a1a, GOLD = 0xe0bd61;
  function suitColor(suit) { return (suit === "♥" || suit === "♦") ? RED : BLACK; }

  const PIPS = {
    '2':  [[50,15,0],[50,85,1]],
    '3':  [[50,14,0],[50,50,0],[50,86,1]],
    '4':  [[28,18,0],[72,18,0],[28,82,1],[72,82,1]],
    '5':  [[28,18,0],[72,18,0],[50,50,0],[28,82,1],[72,82,1]],
    '6':  [[28,14,0],[72,14,0],[28,50,0],[72,50,0],[28,86,1],[72,86,1]],
    '7':  [[28,14,0],[72,14,0],[50,32,0],[28,50,0],[72,50,0],[28,86,1],[72,86,1]],
    '8':  [[28,12,0],[72,12,0],[28,37,0],[72,37,0],[28,63,1],[72,63,1],[28,88,1],[72,88,1]],
    '9':  [[25,14,0],[50,14,0],[75,14,0],[25,50,0],[50,50,0],[75,50,0],[25,86,1],[50,86,1],[75,86,1]],
    '10': [[28,10,0],[72,10,0],[28,30,0],[72,30,0],[28,50,0],[72,50,0],[28,70,1],[72,70,1],[28,90,1],[72,90,1]]
  };
  const COURT = { J:{coat:0x244f83, jewel:0xe7c15a}, Q:{coat:0x733d79, jewel:0xf0d06b}, K:{coat:0x28664d, jewel:0xe7bd4f} };

  function drawCourtHalf(g, rank, w, h) {
    const c = COURT[rank] || COURT.K;
    const sx = w / 100, sy = (h / 2) / 67;
    g.lineStyle(1.2, 0x342c25, 1);
    g.beginFill(c.coat);
    g.drawRoundedRect(19*sx, 43*sy, 62*sx, 24*sy, 6);
    g.endFill();
    g.beginFill(0xf0c99f);
    g.drawCircle(50*sx, 30*sy, 13*sx);
    g.endFill();
    g.beginFill(c.jewel);
    if (rank === 'K') g.drawRect(42*sx, 2*sy, 16*sx, 6*sy);
    else if (rank === 'Q') g.drawCircle(50*sx, 8*sy, 5*sx);
    else g.drawRect(40*sx, 4*sy, 20*sx, 5*sy);
    g.endFill();
  }

  function makeCourtArt(rank, w, h) {
    const c = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.lineStyle(1, 0x9c7937, 1);
    bg.beginFill(0xfbf2d9);
    bg.drawRoundedRect(-w/2, -h/2, w, h, 4);
    bg.endFill();
    c.addChild(bg);

    const top = new PIXI.Graphics();
    top.x = -w/2; top.y = -h/2;
    drawCourtHalf(top, rank, w, h);
    c.addChild(top);

    const bottom = new PIXI.Graphics();
    bottom.x = w/2; bottom.y = h/2; bottom.rotation = Math.PI;
    drawCourtHalf(bottom, rank, w, h);
    c.addChild(bottom);

    const divider = new PIXI.Graphics();
    divider.lineStyle(1, 0xa98748, 1);
    divider.moveTo(-w/2+4, 0).lineTo(w/2-4, 0);
    c.addChild(divider);
    return c;
  }

  function makeCardSprite(cs, isBack = false) {
    const c = new PIXI.Container();
    const w = 60, h = 88;
    const bg = new PIXI.Graphics();
    bg.lineStyle(2, 0x9c7937);
    bg.beginFill(isBack ? 0x14432c : 0xfbf2d9);
    bg.drawRoundedRect(-w/2, -h/2, w, h, 8);
    bg.endFill();
    c.addChild(bg);

    if (isBack) {
      const emblem = new PIXI.Text("♠", {fontSize: 22, fill: GOLD});
      emblem.anchor.set(0.5);
      c.addChild(emblem);
      return c;
    }

    const suit = cs.slice(-1), rank = cs.slice(0, -1);
    const col = suitColor(suit);
    const cornerStyle = new PIXI.TextStyle({fontFamily:"Georgia", fontSize:12, fill:col, fontWeight:"bold", align:"center"});

    const topCorner = new PIXI.Text(`${rank}\n${suit}`, cornerStyle);
    topCorner.x = -w/2 + 5; topCorner.y = -h/2 + 4;
    const botCorner = new PIXI.Text(`${rank}\n${suit}`, cornerStyle);
    botCorner.anchor.set(0.5,0.5); botCorner.x = w/2 - 10; botCorner.y = h/2 - 12; botCorner.rotation = Math.PI;
    c.addChild(topCorner, botCorner);

       if (rank === 'A') {
      const mark = new PIXI.Text(suit, {fontFamily:"Georgia", fontSize: 30, fill: col});
      mark.anchor.set(0.5);
      c.addChild(mark);
      const orn = new PIXI.Text("✦", {fontFamily:"Georgia", fontSize: 9, fill: 0xc7a45b});
      orn.anchor.set(0.5);
      orn.y = 20;
      c.addChild(orn);
    } else if (COURT[rank]) {
      const art = makeCourtArt(rank, w - 10, h - 20);
      c.addChild(art);
    } else {
      const pts = PIPS[rank] || [];
      pts.forEach(([px, py, flip]) => {
        const pip = new PIXI.Text(suit, {fontFamily:"Georgia", fontSize: 11, fill: col});
        pip.anchor.set(0.5);
        pip.x = -w/2 + w*0.14 + (px/100)*(w*0.72);
        pip.y = -h/2 + h*0.17 + (py/100)*(h*0.66);
        if (flip) pip.rotation = Math.PI;
        c.addChild(pip);
      });
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
    const s = (window.CFG && window.CFG.SEAT && window.CFG.SEAT[pid]) || {x:0.5, y:0.5};
    return {x: w*s.x, y: h*s.y};
  }
  function tableRectAndScale() {
    const table = document.getElementById("table");
    const rect = table.getBoundingClientRect();
    const scale = (window.MobileGameScale && window.MobileGameScale.getScale && window.MobileGameScale.getScale()) || 1;
    return {rect, scale};
  }
  function centerInCanvas(el, tableRect, scale) {
    const r = el.getBoundingClientRect();
    return { x: (r.left - tableRect.left + r.width/2)/scale, y: (r.top - tableRect.top + r.height/2)/scale };
  }
  const TRICK_IDS = ["trick-bottom","trick-left","trick-top","trick-right"];

  return {
    init,

    async deal() {
      if (!app) return;
      ensureSized();
      const ts = tableRectAndScale(); const tableRect = ts.rect, scale = ts.scale;
      const center = {x: app.screen.width/2, y: app.screen.height/2};
      const targets = {0:document.getElementById("hand-row"),1:document.getElementById("hand-left"),
                        2:document.getElementById("hand-top"),3:document.getElementById("hand-right")};
      const order = [1,2,3,0];
      const promises = [];
      for (let r=0; r<13; r++) {
        for (const pid of order) {
          promises.push(new Promise(resolve => {
            const sprite = makeCardSprite(null, true);
            app.stage.addChild(sprite);
            let target = seatPos(pid);
            const t = targets[pid];
            if (t) { const tr = t.getBoundingClientRect(); if (tr.width>4 && tr.height>4) target = centerInCanvas(t, tableRect, scale); }
            tweenTo(sprite, center.x, center.y, target.x, target.y, 150, () => { app.stage.removeChild(sprite); resolve(); });
          }));
          await new Promise(r => setTimeout(r, 30));
        }
      }
      await Promise.all(promises);
    },

    flyCard(pid, cs, isBack, onLand, options) {
      options = options || {};
      return new Promise(resolve => {
        if (!app) { try { onLand && onLand(); } catch(_) {} resolve(); return; }
        ensureSized();
        const ts = tableRectAndScale(); const tableRect = ts.rect, scale = ts.scale;
        const sprite = makeCardSprite(cs, isBack);
        app.stage.addChild(sprite);

        let from;
        if (options.fromRect && Number.isFinite(options.fromRect.left)) {
          const fr = options.fromRect;
          from = {x:(fr.left-tableRect.left+fr.width/2)/scale, y:(fr.top-tableRect.top+fr.height/2)/scale};
        } else from = seatPos(pid);

        let to = {x: app.screen.width/2, y: app.screen.height/2};
        const slot = document.getElementById(TRICK_IDS[pid]);
        if (slot) to = centerInCanvas(slot, tableRect, scale);

        const duration = Number(options.duration) || 330;
        tweenTo(sprite, from.x, from.y, to.x, to.y, duration, () => {
          try { onLand && onLand(); } catch(e) { console.error(e); }
          app.stage.removeChild(sprite);
          resolve();
        });
      });
    },

    banner(pid, suit) {
      const el = document.getElementById("trump-banner");
      if (!el) return;
      el.textContent = (["You","P1","P2","P3"][pid]) + " declared trump: " + suit;
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 2200);
    },
    flash(pid) {
      const el = document.getElementById("twflash");
      if (!el) return;
      el.textContent = (["You","P1","P2","P3"][pid]) + " wins the trick!";
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 950);
    },
    clearTrick() {}
  };
})();

window.Anim = PixiTable;
window.PixiTable = PixiTable;
