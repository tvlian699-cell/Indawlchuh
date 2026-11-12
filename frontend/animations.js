// lang: JavaScript, file: frontend/animations.js
// Animation system: deal, flyCard, banner, flash, clearTrick
//
// FIXES:
//  - Removed "const CFG" — it shadowed window.CFG set by index.html's inline
//    script, so game.js got a CFG with no SC/NM/SUIT_ORDER/RANK_ORDER → crash.
//    Now always reads window.CFG directly (set before any user interaction).
//  - el.animate().onfinish= is unreliable (GC can drop the Animation object
//    before finish fires). Now stores the reference + uses addEventListener.
//  - Per-card 2 s safety timeout so Promise.all() always resolves.

// ── Shared playing-card face renderer ────────────────────────────────────────
// One renderer is used by the hand, played cards, dragged cards and animations
// so the same card never changes appearance while moving around the table.
const CardFace = (() => {
  const PIPS = {
    '2':  [[50, 15, 0], [50, 85, 1]],
    '3':  [[50, 14, 0], [50, 50, 0], [50, 86, 1]],
    '4':  [[28, 18, 0], [72, 18, 0], [28, 82, 1], [72, 82, 1]],
    '5':  [[28, 18, 0], [72, 18, 0], [50, 50, 0], [28, 82, 1], [72, 82, 1]],
    '6':  [[28, 14, 0], [72, 14, 0], [28, 50, 0], [72, 50, 0], [28, 86, 1], [72, 86, 1]],
    '7':  [[28, 14, 0], [72, 14, 0], [50, 32, 0], [28, 50, 0], [72, 50, 0], [28, 86, 1], [72, 86, 1]],
    '8':  [[28, 12, 0], [72, 12, 0], [28, 37, 0], [72, 37, 0], [28, 63, 1], [72, 63, 1], [28, 88, 1], [72, 88, 1]],
    '9':  [[25, 14, 0], [50, 14, 0], [75, 14, 0], [25, 50, 0], [50, 50, 0], [75, 50, 0], [25, 86, 1], [50, 86, 1], [75, 86, 1]],
    '10': [[28, 10, 0], [72, 10, 0], [28, 30, 0], [72, 30, 0], [28, 50, 0], [72, 50, 0], [28, 70, 1], [72, 70, 1], [28, 90, 1], [72, 90, 1]]
  };

  const SUIT_NAMES = {'♠':'spades', '♥':'hearts', '♦':'diamonds', '♣':'clubs'};
  const COURT = {
    J: {coat:'#244f83', trim:'#c43b32', jewel:'#e7c15a'},
    Q: {coat:'#733d79', trim:'#c43b32', jewel:'#f0d06b'},
    K: {coat:'#28664d', trim:'#bd302d', jewel:'#e7bd4f'}
  };

  function courtHalf(rank) {
    const c = COURT[rank] || COURT.K;
    let headwear = '';
    if (rank === 'J') {
      headwear = `<path d="M35 17 Q22 1 25 0 Q39 4 43 14 Q48 -2 53 0 Q57 7 54 16 Q67 3 73 7 L64 22Z" fill="${c.trim}" stroke="#4a2b22" stroke-width="1.8"/><path d="M42 12 Q48 4 53 12" fill="none" stroke="${c.jewel}" stroke-width="2"/>`;
    } else if (rank === 'Q') {
      headwear = `<path d="M31 18 L34 7 L43 13 L50 3 L57 13 L66 7 L69 19Z" fill="${c.jewel}" stroke="#61451e" stroke-width="1.8"/><circle cx="50" cy="10" r="3" fill="${c.trim}"/><path d="M34 19 H66" stroke="#61451e" stroke-width="2"/>`;
    } else {
      headwear = `<path d="M29 19 L31 6 L42 14 L50 1 L58 14 L69 6 L71 19Z" fill="${c.jewel}" stroke="#61451e" stroke-width="1.8"/><path d="M31 19 H69" stroke="#61451e" stroke-width="2"/><circle cx="50" cy="9" r="3" fill="${c.trim}"/>`;
    }
    return `<g stroke-linejoin="round" stroke-linecap="round">
      <path d="M19 63 Q22 49 37 47 L50 43 L63 47 Q78 49 81 63 L86 67 H14Z" fill="${c.coat}" stroke="#342c25" stroke-width="2"/>
      <path d="M38 48 L50 60 L62 48 L68 67 H32Z" fill="#f5e9c9" stroke="#5b4832" stroke-width="1.4"/>
      <path d="M45 56 L50 63 L55 56 L53 67 H47Z" fill="${c.trim}"/>
      <path d="M25 54 L36 50 L41 67 H21Z M75 54 L64 50 L59 67 H79Z" fill="${c.trim}" stroke="#4c302b" stroke-width="1.2"/>
      <path d="M29 57 L35 60 M71 57 L65 60 M35 52 L40 55 M65 52 L60 55" stroke="${c.jewel}" stroke-width="2"/>
      <ellipse cx="50" cy="30" rx="14" ry="17" fill="#f0c99f" stroke="#563d32" stroke-width="1.7"/>
      <path d="M36 29 Q34 12 50 13 Q66 12 64 29 Q58 21 50 22 Q42 21 36 29Z" fill="#503329" stroke="#3c2924" stroke-width="1.5"/>
      <path d="M42 31 Q45 29 47 31 M53 31 Q56 29 58 31" fill="none" stroke="#34251f" stroke-width="1.4"/>
      <path d="M48 37 Q50 39 52 37" fill="none" stroke="#9a5148" stroke-width="1.3"/>
      ${headwear}
      <circle cx="33" cy="38" r="3" fill="${c.jewel}" stroke="#61451e" stroke-width="1"/>
      <circle cx="67" cy="38" r="3" fill="${c.jewel}" stroke="#61451e" stroke-width="1"/>
      <path d="M17 67 H83" stroke="${c.jewel}" stroke-width="2"/>
    </g>`;
  }

  function courtArt(rank) {
    const top = courtHalf(rank);
    return `<svg class="court-art" viewBox="0 0 100 132" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="96" height="128" rx="5" fill="#fbf2d9" stroke="#9c7937" stroke-width="2"/>
      <rect x="6" y="6" width="88" height="120" rx="3" fill="none" stroke="#c49a45" stroke-width="1"/>
      <path d="M8 12 L16 8 L20 16 L8 24 M92 12 L84 8 L80 16 L92 24 M8 120 L16 124 L20 116 L8 108 M92 120 L84 124 L80 116 L92 108" fill="none" stroke="#bd9a51" stroke-width="1.5"/>
      ${top}
      <g transform="translate(100 132) rotate(180)">${top}</g>
      <path d="M8 66 H92" stroke="#a98748" stroke-width="1.4"/>
      <circle cx="50" cy="66" r="4" fill="#e0bd61" stroke="#9c7937" stroke-width="1"/>
    </svg>`;
  }

  function faceContent(rank, suit) {
    if (rank === 'A') return `<div class="ace-mark">${suit}</div><div class="ace-ornament">✦</div>`;
    if (COURT[rank]) return `<div class="court-wrap">${courtArt(rank)}</div>`;
    const points = PIPS[rank];
    if (!points) return `<div class="ace-mark">${suit}</div>`;
    return `<div class="pip-field">${points.map(([x,y,flip]) =>
      `<span class="pip${flip ? ' pip-flipped' : ''}" style="left:${x}%;top:${y}%">${suit}</span>`
    ).join('')}</div>`;
  }

  function fill(el, cs, extraClass = '') {
    const suit = cs.slice(-1), rank = cs.slice(0, -1);
    const color = window.CFG?.SC?.[suit] || ((suit === '♥' || suit === '♦') ? 'red' : 'black');
    el.className = `card ${color}${rank === '10' ? ' ten-card' : ''}${extraClass ? ' ' + extraClass : ''}`;
    el.dataset.card = cs;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `${rank} of ${SUIT_NAMES[suit] || suit}`);
    el.innerHTML = `<div class="card-corner card-corner-top"><span class="card-rank">${rank}</span><span class="card-suit">${suit}</span></div>` +
      `<div class="card-center">${faceContent(rank, suit)}</div>` +
      `<div class="card-corner card-corner-bottom"><span class="card-rank">${rank}</span><span class="card-suit">${suit}</span></div>`;
    return el;
  }

  function create(cs, extraClass = '') {
    return fill(document.createElement('div'), cs, extraClass);
  }

  function createBack(extraClass = '') {
    const el = document.createElement('div');
    el.className = `card back${extraClass ? ' ' + extraClass : ''}`;
    el.innerHTML = `<span class="card-back-frame"></span><span class="card-back-emblem">♠</span>`;
    el.setAttribute('aria-label', 'Card back');
    return el;
  }

  return {fill, create, createBack};
})();
window.CardFace = CardFace;

const Anim = {

  async deal() {
    const CFG       = window.CFG;                       // always the full config
    const dealLayer = document.getElementById("deal-layer");
    const tbl       = document.getElementById("table");
    const CW = CFG.CW, CH = CFG.CH;

    const targets = {
      0: document.getElementById("hand-row"),
      1: document.getElementById("hand-left"),
      2: document.getElementById("hand-top"),
      3: document.getElementById("hand-right")
    };

    const uiScale = window.MobileGameScale?.getScale?.() || 1;
    const deckRect = tbl.getBoundingClientRect();
    const deckX = deckRect.width  / uiScale / 2;
    const deckY = deckRect.height / uiScale / 2;

    Object.values(targets).forEach(el => { if (el) el.innerHTML = ""; });

    const promises = [];
    const order = [1, 2, 3, 0];

    for (let r = 0; r < 13; r++) {
      for (const pid of order) {
        const roundIdx  = r;
        const playerIdx = pid;

        promises.push(new Promise(resolve => {
          const flyEl = document.createElement("div");
          flyEl.className = "deal-card";
          flyEl.style.cssText =
            `left:${deckX - CW/2}px;top:${deckY - CH/2}px;` +
            `z-index:${50 + roundIdx * 4 + playerIdx}`;
          dealLayer.appendChild(flyEl);

          const t  = targets[playerIdx];
          const tr = t.getBoundingClientRect();
          const tb = tbl.getBoundingClientRect();
          const dx = (tr.left - tb.left + tr.width  / 2) / uiScale - deckX;
          const dy = (tr.top  - tb.top  + tr.height / 2) / uiScale - deckY;

          const done = () => {
            clearTimeout(safetyTimer);
            if (flyEl.parentNode) flyEl.remove();
            appendTarget(playerIdx, t, CW, CH);
            resolve();
          };

          const safetyTimer = setTimeout(() => {
            console.warn("[Anim.deal] safety timeout pid", playerIdx);
            done();
          }, 2000);

          // Store reference — prevents GC from dropping the Animation object
          const anim = flyEl.animate([
            { transform: "translate(0,0) scale(1) rotate(0deg)",                                                              opacity: 1 },
            { transform: `translate(${dx}px,${dy}px) scale(0.6) rotate(${playerIdx === 0 ? -10 : 10}deg)`, opacity: 1 }
          ], { duration: 150, easing: "cubic-bezier(.2,.8,.3,1)", fill: "forwards" });

          anim.addEventListener("finish", done);
          anim.addEventListener("cancel", done);
        }));

        await sleep(CFG.DEAL_STAGGER || 30);
      }
    }

    await Promise.all(promises);
    await sleep(200);
    dealLayer.innerHTML = "";
  },

   flyCard(pid, cs, isBack, onLand, options = {}) {
    const CFG = window.CFG;
    return new Promise(resolve => {
      const playLayer = document.getElementById("play-layer");
      const tbl = document.getElementById("table");
      const tEl = document.getElementById(["trick-bottom","trick-left","trick-top","trick-right"][pid]);
      const CW = CFG.CW, CH = CFG.CH;
      let timeout = null;
      let anim = null;
      let flyEl = null;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        try { if (onLand) onLand(); }
        catch (err) { console.error("[Anim.flyCard] onLand failed:", err); }
        if (flyEl && flyEl.parentNode) flyEl.remove();
        resolve();
      };

      if (!playLayer || !tbl || !tEl) {
        console.error("[Anim.flyCard] play layer, table, or trick slot missing");
        finish();
        return;
      }

      const uiScale = window.MobileGameScale?.getScale?.() || 1;
      const tR = tEl.getBoundingClientRect();
      const tB = tbl.getBoundingClientRect();
      const ex = (tR.left - tB.left + tR.width / 2) / uiScale - CW / 2;
      const ey = (tR.top - tB.top + tR.height / 2) / uiScale - CH / 2;
      const fromRect = options?.fromRect;
      const hasDragOrigin = Boolean(fromRect && Number.isFinite(fromRect.left) && Number.isFinite(fromRect.top));
      const src = CFG.SEAT[pid];
      const sx = hasDragOrigin ? (fromRect.left - tB.left) / uiScale : tbl.offsetWidth * src.x - CW / 2;
      const sy = hasDragOrigin ? (fromRect.top - tB.top) / uiScale : tbl.offsetHeight * src.y - CH / 2;
      const startW = hasDragOrigin && Number.isFinite(fromRect.width) ? fromRect.width / uiScale : CW;
      const startH = hasDragOrigin && Number.isFinite(fromRect.height) ? fromRect.height / uiScale : CH;
      const midX = (sx + ex) / 2;
      const midY = (sy + ey) / 2 + (pid === 0 ? -22 : pid === 2 ? 22 : 0);
      const midW = (startW + CW) / 2;
      const midH = (startH + CH) / 2;

      flyEl = isBack ? CardFace.createBack("fly-card") : CardFace.create(cs, "fly-card");
      Object.assign(flyEl.style, {
        position: "absolute",
        left: "0px", top: "0px",
        width: `${CW}px`, height: `${CH}px`,
        zIndex: "60", transformOrigin: "center center", willChange: "transform",
        backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden"
      });
      playLayer.appendChild(flyEl);

      const duration = Number(options?.duration) || (isBack ? 350 : 330);
      timeout = setTimeout(() => {
        console.warn("[Anim.flyCard] timeout pid", pid);
        finish();
      }, CFG.FLY_TIMEOUT || 8000);

      try {
        const scale0X = startW / CW;
        const scale0Y = startH / CH;
        const scale1X = midW / CW;
        const scale1Y = midH / CH;

        const tx0 = sx + (startW - CW) / 2;
        const ty0 = sy + (startH - CH) / 2;
        const tx1 = midX + (midW - CW) / 2;
        const ty1 = midY + (midH - CH) / 2;
        const tx2 = ex;
        const ty2 = ey;

        const keyframes = [
          {
            transform: `translate(${tx0}px, ${ty0}px) scale(${scale0X}, ${scale0Y}) rotateZ(${hasDragOrigin ? 5 : 0}deg)`,
            opacity: 1, offset: 0
          },
          {
            transform: `translate(${tx1}px, ${ty1}px) scale(${scale1X}, ${scale1Y}) rotateZ(-1.5deg)`,
            opacity: 1, offset: 0.68
          },
          {
            transform: `translate(${tx2}px, ${ty2}px) scale(1, 1) rotateZ(0deg)`,
            opacity: 1, offset: 1
          }
        ];
        anim = flyEl.animate(keyframes, {
          duration,
          easing: "cubic-bezier(.20,.72,.18,1)",
          fill: "forwards"
        });
        anim.addEventListener("finish", finish, {once:true});
        anim.addEventListener("cancel", finish, {once:true});
      } catch (err) {
        console.error("[Anim.flyCard] animate() threw:", err);
        finish();
      }
    });
  },

  banner(pid, suit) {
    const el = document.getElementById("trump-banner");
    el.textContent = `${["You","P1","P2","P3"][pid]} declared trump: ${suit}`;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2200);
  },

  flash(pid) {
    const CFG = window.CFG;
    const el = document.getElementById("twflash");
    el.textContent = `${["You","P1","P2","P3"][pid]} wins the trick!`;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), CFG.FLASH || 950);
  },

  clearTrick() {
    ["top","left","right","bottom"].forEach(s => {
      const el = document.getElementById("trick-" + s);
      if (el) el.innerHTML = "";
    });
  }
};

function appendTarget(pid, targetEl, CW, CH) {
  if (!targetEl) return;
  if (pid === 0) {
    const c = CardFace.createBack();
    c.style.cssText = `width:${CW}px;height:${CH}px;flex-shrink:0`;
    targetEl.appendChild(c);
  } else {
    targetEl.appendChild(
      Object.assign(document.createElement("div"), { className: "cb" })
    );
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

window.Anim = Anim;
