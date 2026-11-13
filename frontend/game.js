// lang: JavaScript, file: frontend/game.js
// REBUILD:
//  - POV rotation: server sends pre-rotated data, seat 0 is always YOU
//  - Player names displayed on chips
//  - Emotes + preset chat (socket)
//  - Give Up button (losing team only, mutual confirm in multiplayer)
//  - Half-card fix: hand row uses overflow:visible + enough padding
//  - Cards are always private (no teammate hand sharing)

const State = {
  data:       null,
  selected:   null,
  busy:       false,
  logShown:   0,
  _queue:     Promise.resolve(),
  _stallTimer: null,
  _currentTrickCards: [null,null,null,null],
  captures:   {A:0, B:0},
  tens:       {A:[], B:[]},
  stacks:     {A:[], B:[]},
  isCoop:     false,
  isSpectator:false,
  roomId:     null,
  mySeat:     0,          // absolute seat (never changes)
  playerNames: ['You','P1','P2','P3'],  // rotated — index 0 is always YOU

  _concedePending:    false,
  _concedePendingFrom: null,

  get trick() { return this.data?.current_trick ?? [null,null,null,null]; },
  set(d)      { this.data = d; },
  update(p)   { this.data = {...this.data, ...p}; },

  resetFlags() {
    this.busy = false; this.selected = null; this.logShown = 0;
    this._currentTrickCards = [null,null,null,null];
    this.captures = {A:0,B:0}; this.tens = {A:[],B:[]}; this.stacks = {A:[],B:[]};
    this.isCoop = false;
    this.isSpectator = false;
    this._concedePending = false; this._concedePendingFrom = null;
  },

  // After rotation, seat 0 is always the local human
  myHand() {
    if (!this.data || this.isSpectator) return [];
    return this.data.your_hand || this.data.human_hand || [];
  },

  enqueue(task) {
    this._queue = this._queue.then(
      () => task().catch(err => console.error("[Queue]", err))
    );
    return this._queue;
  },

  startWatchdog() {
    if (this._stallTimer) clearTimeout(this._stallTimer);
    this._stallTimer = setTimeout(() => {
      console.error("[Watchdog] stall → recover");
      this._queue = Promise.resolve();
      this.busy   = false;
      renderAll();
      toast("⚠️ Game recovered from stall", 5000);
    }, 20000);
  },
  clearWatchdog() { clearTimeout(this._stallTimer); }
};

// ─── Drag (mouse + touchscreen Pointer Events) ────────────────────────────────
const Drag = {
  active: false, card: null, wrap: null, pointerId: null,
  cardWidth: 60, cardHeight: 88,
  ghost: document.getElementById("drag-ghost"),
  zone:  document.getElementById("trick-area"),

  start(cs, wrap, event) {
    if (this.active || State.isSpectator || State.busy || !State.data || State.data.whose_turn !== 0 || State.data.phase === "done") return;
    if (event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (!this.ghost || !this.zone) return;

    const cardEl = wrap.querySelector('.card');
    const cardRect = cardEl?.getBoundingClientRect();
    this.cardWidth = cardRect?.width || 60;
    this.cardHeight = cardRect?.height || 88;
    this.active = true;
    this.card = cs;
    this.wrap = wrap;
    this.pointerId = event.pointerId;

    if (window.CardFace) window.CardFace.fill(this.ghost, cs, "drag-ghost");
    else {
      const suit = cs.slice(-1), rank = cs.slice(0,-1);
      this.ghost.className = "card drag-ghost " + (window.CFG.SC[suit] || "black");
      this.ghost.innerHTML = `<div class="card-corner card-corner-top"><span class="card-rank">${rank}</span><span class="card-suit">${suit}</span></div><div class="card-center"><div class="ace-mark">${suit}</div></div><div class="card-corner card-corner-bottom"><span class="card-rank">${rank}</span><span class="card-suit">${suit}</span></div>`;
    }

    this.ghost.style.width = `${this.cardWidth}px`;
    this.ghost.style.height = `${this.cardHeight}px`;
    this.move(event);
    this.ghost.classList.add("active");
    wrap.classList.add("dragging");
    this.zone.classList.add("drop-ready");
    try { wrap.setPointerCapture(event.pointerId); } catch (_) { /* document listeners remain as fallback */ }
  },

  move(event) {
    if (!this.active || (this.pointerId != null && event.pointerId !== this.pointerId)) return;
    this.ghost.style.left = `${event.clientX - this.cardWidth / 2}px`;
    this.ghost.style.top  = `${event.clientY - this.cardHeight / 2}px`;
  },

  end(event) {
    if (!this.active || (this.pointerId != null && event.pointerId !== this.pointerId)) return;
    // Sync the ghost to the exact release point before handing its position
    // to the play animation. This lets a dragged card continue from the
    // player's finger/mouse instead of restarting from the seat origin.
    this.move(event);
    const card = this.card;
    const rect = this.zone.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
                   event.clientY >= rect.top && event.clientY <= rect.bottom;
    const sourceRect = inside ? {
      left: parseFloat(this.ghost.style.left) || (event.clientX - this.cardWidth / 2),
      top: parseFloat(this.ghost.style.top) || (event.clientY - this.cardHeight / 2),
      width: this.cardWidth,
      height: this.cardHeight
    } : null;
    this.clear();
    if (inside) submitPlay(card, sourceRect);
    else renderHand();
  },

  cancel() {
    if (!this.active) return;
    this.clear();
    renderHand();
  },

  clear() {
    this.ghost.classList.remove("active");
    if (this.wrap) this.wrap.classList.remove("dragging");
    this.zone.classList.remove("drop-ready");
    this.active = false;
    this.card = null;
    this.wrap = null;
    this.pointerId = null;
  }
};

// Pointer events cover mouse, pen and touch. A card is played only on pointer-up
// inside the existing #trick-area; pointer-up anywhere else cancels the move.
document.addEventListener("pointermove", event => {
  if (!Drag.active || (Drag.pointerId != null && event.pointerId !== Drag.pointerId)) return;
  event.preventDefault();
  Drag.move(event);
}, {passive:false});
document.addEventListener("pointerup", event => { if (Drag.active) Drag.end(event); });
document.addEventListener("pointercancel", event => {
  if (Drag.active && (Drag.pointerId == null || event.pointerId === Drag.pointerId)) Drag.cancel();
});
window.addEventListener("blur", () => Drag.cancel());

// Locate the physical hand card for auto-play (e.g. the turn timer) when no
// pointer drag supplied an explicit release position.
function getHandCardRect(cardCode) {
  const wrap = Array.from(document.querySelectorAll('#hand-row .hwrap'))
    .find(el => el.dataset.card === cardCode);
  const card = wrap?.querySelector('.card');
  if (!card) return null;
  const rect = card.getBoundingClientRect();
  return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
}

async function submitPlay(cs, dragSourceRect = null) {
  if (State.isSpectator || State.busy) return;
  State.busy = true; stopTimer(); State.selected = null;

  State._currentTrickCards[0] = cs;

  const isLocalVsAi = !State.isCoop && !State.roomId;
  const playOrigin = dragSourceRect || getHandCardRect(cs);
  
  State.update({
    your_hand:   (State.data.your_hand||[]).filter(c=>c!==cs),
    human_hand:  (State.data.human_hand||[]).filter(c=>c!==cs),
  });
  renderHand();

  // Use the same smooth animation for both VS AI and Multiplayer
  await Anim.flyCard(0, cs, false, () => {
    if (State.data) {
      if (!Array.isArray(State.data.current_trick)) State.data.current_trick = [null,null,null,null];
      State.data.current_trick[0] = cs;
    }
    renderTrick();
  }, {fromRect: playOrigin, duration: 340});

  let res;
  try {
    if (State.roomId) {
      // Multiplayer: use socket
      API.getSocket()?.emit("play_card", {card: cs});
      // Do NOT set State.busy = false here. Wait for the server response.
      return;
    }
    res = State.isCoop
      ? await API.playCoop(cs, State.mySeat)
      : await API.playCard(cs, 0);
  } catch(err) {
    State.busy = false;
    toast("Network error — is the server running?");
    return;
  }

  if (!res || res.error) {
    State.busy = false;
    toast(res?.error || "Server error");
    if (res) State.set(res);
    renderAll();
    return;
  }
  await processLog(res);
}

async function processLog(data) {
  const serverLog  = data.log || [];
  const newEntries = serverLog.slice(State.logShown);

 if (!newEntries.length) {
  syncScalars(data);
  if (!State.busy) {
    renderAll(); renderGiveUpButton();
    if (data.phase==="done" && data.score) { await sleep(500); showScore(data.score, data.conceded); }
    else if (data.whose_turn === 0) startTimer();
  }
  return;
}

  State.busy = true; // <--- ADD THIS LINE
  State.logShown += newEntries.length;
  State.startWatchdog();

  await State.enqueue(async () => {
    try {
      for (const e of newEntries) {
        // In VS AI, keep the complete trick from the authoritative server log.
        // Record every seat (including the human) before animating the entry so
        // all captured tens are included when the trick is collected.
        if (!State.isCoop && !State.roomId && Number.isInteger(Number(e.player)) &&
            Number(e.player) >= 0 && Number(e.player) < 4 && e.card) {
          State._currentTrickCards[Number(e.player)] = String(e.card);
        }
        await Promise.race([
          processEntry(e),
          sleep(15000).then(()=>{throw new Error("Entry timeout")})
        ]);
        if (e.trick_winner !== undefined) await concludeTrick(e.trick_winner);
      }
    } catch(err) { console.error("[Log]", err); }
    finally {
      State.clearWatchdog();
      syncScalars(data);
      State.busy = false;
      try { renderAll(); } catch(e) { console.error(e); }
      renderGiveUpButton();
      if (data.phase==="done" && data.score) { await sleep(500); showScore(data.score, data.conceded); }
      else if (data.whose_turn === 0) startTimer();
    }
  });

  appendNewLog(newEntries);
}

async function processEntry(e) {
  if (e.player === 0) {
    if (e.trump_declared) {
      State.update({trump_suit: e.trump_declared});
      Anim.banner(0, e.trump_declared); renderTrump(); await sleep(600);
    }
    renderTrick(); return;
  }
  await sleep(200);
  await Promise.race([
    new Promise((res, rej) =>
      Anim.flyCard(e.player, e.card, Boolean(State.isCoop || State.roomId), ()=>{
        try {
          // Record the card for both VS AI and Multiplayer
          State._currentTrickCards[e.player] = e.card;
          State.data.current_trick[e.player] = e.card;
          renderTrick(); res();
        } catch(err){rej(err);}
      })
    ),
    sleep(15000).then(()=>{throw new Error("Entry anim timeout")})
  ]);
  if (e.trump_declared) {
    State.update({trump_suit: e.trump_declared});
    Anim.banner(e.player, e.trump_declared); renderTrump(); await sleep(600);
  }
}

async function concludeTrick(winner) {
  const team       = (winner===0||winner===2) ? 'A' : 'B';
  // A capture is one completed trick: preserve all four played cards as one
  // visual group. The number of cards in the group never changes the capture
  // count; one completed four-card trick increments the count exactly once.
  const trickCards = State._currentTrickCards.filter(Boolean).map(String).slice(0, 4);
  if (trickCards.length !== 4) {
    console.warn(`[Capture] Expected 4 cards in completed trick, received ${trickCards.length}`, State._currentTrickCards);
  }
  State.captures[team]++;
  const tensInTrick = trickCards.filter(card => card.startsWith("10"));
  if (tensInTrick.length) State.tens[team].push(...tensInTrick);
  State.stacks[team].push({
    cards: trickCards,
    tens: tensInTrick,
    winner: Number(winner)
  });
  renderCaptureZone(team);
  await sleep(1400); Anim.flash(winner); await sleep(950);
  Anim.clearTrick();
  State.update({current_trick:[null,null,null,null]});
  State._currentTrickCards = [null,null,null,null];
  renderGiveUpButton();
}

function syncScalars(data) {
  State.update({
    your_hand:       data.your_hand || data.human_hand,
    human_hand:      data.human_hand || data.your_hand,
    hand_counts:     data.hand_counts,
    captured_counts: data.captured_counts,
    trump_suit:      data.trump_suit,
    phase:           data.phase,
    whose_turn:      data.whose_turn,
    tricks_played:   data.tricks_played,
    current_leader:  data.current_leader,
  });
  if (data.score)        State.data.score        = data.score;
  if (data.player_names) State.playerNames        = data.player_names;
}

// Spectators receive authoritative public snapshots, not a player-relative
// hand view. Render those snapshots directly so current-trick cards, captured
// piles, card counts, names and turn state stay visible without replaying a
// player's private/optimistic card animations.
function applySpectatorSnapshot(data) {
  const publicData = {
    ...data,
    your_hand: [],
    human_hand: [],
    human_hands: {},
    is_spectator: true,
    your_seat: 0,
  };
  State.set(publicData);
  State.isSpectator = true;
  State.isCoop = Boolean(publicData.is_coop);
  State.roomId = publicData.room_id || State.roomId;
  State.mySeat = 0;
  if (Array.isArray(publicData.player_names)) {
    State.playerNames = publicData.player_names.slice(0, 4);
  }
  hydrateSpectatorHistory(publicData);
  syncScalars(publicData);
  State.busy = false;
  State.clearWatchdog();
  renderAll();
  renderGiveUpButton();
}

// ─── Socket game events ───────────────────────────────────────────────────────
function setupSocketGameHandlers() {
  const sock = API.getSocket();
  if (!sock) return;

   sock.on("game_state", async data => {
    if (Boolean(data?.is_spectator)) {
      applySpectatorSnapshot(data);
      return;
    }
    State.isSpectator = false;

    if (State.busy) {
      // Queue it. State.data is not updated here; processLog will update it.
      await processLog(data);
    } else {
      // Save the current visual trick BEFORE the server state overwrites it.
      // This allows processLog to animate the new cards from their previous state.
     const prevTrick = State.data ? [...State.data.current_trick] : [null,null,null,null];
      State.set(data);
      State.data.current_trick = prevTrick; // ALWAYS restore to prevent instant overlap
      
      await processLog(data);
    }
  });

  sock.on("game_over", async data => {
    if (Boolean(data?.is_spectator)) {
      applySpectatorSnapshot(data);
    } else {
      State.isSpectator = false;
      State.set(data);
      syncScalars(data);
      renderAll();
    }
    if (data.score) { await sleep(500); showScore(data.score, data.conceded); }
  });

  sock.on("play_failed", data => {
    State.busy = false;
    toast(data.error || "Play failed");
    renderAll();
  });

  sock.on("hint", data => {
    if (data.card) toast(`💡 Try: ${data.card}`);
  });

  // ── Social ──
  sock.on("emote", data => {
    // data.seat is rotated (0 = you)
    showEmoteFloat(data.seat, data.emote);
  });

  sock.on("chat", data => {
    showChatFloat(data.seat, data.name, data.msg);
    appendChatLog(data.name, data.msg);
  });

  // ── Concede ──
  sock.on("concede_requested", data => {
    State._concedePendingFrom = data.requester;  // absolute seat
    _showConcedeBanner();
  });

  sock.on("concede_cancelled", () => {
    State._concedePendingFrom = null;
    State._concedePending     = false;
    _hideConcedeBanner();
    toast("Give up cancelled — keep playing!");
  });

  sock.on("concede_error", data => {
    toast(data.error || "Cannot give up right now");
  });
}

// ─── Give Up ──────────────────────────────────────────────────────────────────
function _shouldShowGiveUp() {
  if (State.isSpectator || !State.data || State.data.phase==="done") return false;
  return State.tens.B.length > State.tens.A.length;
}

function renderGiveUpButton() {
  const btn = document.getElementById("give-up-btn");
  if (!btn) return;
  btn.style.display = _shouldShowGiveUp() ? "flex" : "none";
  if (!_shouldShowGiveUp()) {
    State._concedePending = false;
    State._concedePendingFrom = null;
    _hideConcedeBanner();
  }
}

async function onGiveUp() {
  if (!_shouldShowGiveUp()) return;

  if (State.roomId) {
    // Multiplayer: socket-based mutual concede
    if (State._concedePending) { toast("Waiting for partner to respond…"); return; }
    if (State._concedePendingFrom !== null) { _showConcedeBanner(); return; }
    State._concedePending = true;
    API.getSocket()?.emit("concede_request");
    _showConcedeBanner();
    return;
  }

  // Solo vs AI
  if (!confirm("Give up? Team B wins.")) return;
  try {
    const res  = await fetch("/api/concede", {method:"POST"});
    const data = await res.json();
    if (data.error) { toast(data.error); return; }
    await processLog(data);
  } catch(e) { toast("Network error"); }
}

function _showConcedeBanner() {
  const banner = document.getElementById("concede-banner");
  if (!banner) return;
  if (State._concedePending) {
    banner.innerHTML = `<div class="concede-msg">
      🏳️ You requested to give up — waiting for partner to confirm…
      <button class="concede-cancel-btn" onclick="onCancelConcede()">Cancel</button>
    </div>`;
  } else {
    const name = State.playerNames?.[State._concedePendingFrom] || "Partner";
    banner.innerHTML = `<div class="concede-msg">
      🏳️ <strong>${name}</strong> wants to give up!
      <button class="concede-yes-btn" onclick="_coopConfirmConcede(true)">✔ Confirm</button>
      <button class="concede-no-btn"  onclick="_coopConfirmConcede(false)">✘ Refuse</button>
    </div>`;
  }
  banner.classList.add("show");
}

function _hideConcedeBanner() {
  document.getElementById("concede-banner")?.classList.remove("show");
}

async function onCancelConcede() {
  State._concedePending = false;
  _hideConcedeBanner();
  if (State.roomId) {
    API.getSocket()?.emit("concede_confirm", {confirm: false});
  }
}

async function _coopConfirmConcede(confirmed) {
  _hideConcedeBanner();
  State._concedePending     = false;
  State._concedePendingFrom = null;
  if (State.roomId) {
    API.getSocket()?.emit("concede_confirm", {confirm: confirmed});
    if (!confirmed) toast("Give up refused — keep playing!");
  }
}

// ─── Emotes + Chat ────────────────────────────────────────────────────────────
const EMOTES = ["😤","🎉","😱","🔥","👑","😂"];
const CHAT_MSGS = [
  "Good move!","Lucky!","Watch out!","My tens!","Nice try!",
  "Let's go!","Well played!","That was close!","Focus!","GG!"
];

// Seat positions on table (rotated — 0=bottom, 1=left, 2=top, 3=right)
const SEAT_POS = {
  0: {bottom:"120px", left:"50%", transform:"translateX(-50%)"},
  1: {top:"50%",      left:"20px", transform:"translateY(-50%)"},
  2: {top:"20px",     left:"50%",  transform:"translateX(-50%)"},
  3: {top:"50%",      right:"20px",transform:"translateY(-50%)"}
};

function showEmoteFloat(seat, emote) {
  const tbl = document.getElementById("table");
  if (!tbl) return;
  const el = document.createElement("div");
  el.className = "emote-float";
  el.textContent = emote;
  const pos = SEAT_POS[seat] || SEAT_POS[0];
  Object.assign(el.style, pos, {position:"absolute", zIndex:200});
  tbl.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function showChatFloat(seat, name, msg) {
  const tbl = document.getElementById("table");
  if (!tbl) return;
  const el = document.createElement("div");
  el.className = "chat-float";
  el.innerHTML = `<span class="cf-name">${name}:</span> ${msg}`;
  const pos = SEAT_POS[seat] || SEAT_POS[0];
  Object.assign(el.style, pos, {position:"absolute", zIndex:200});
  tbl.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function appendChatLog(name, msg) {
  const box = document.getElementById("chat-log-box");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "chat-log-entry";
  el.innerHTML = `<span class="cl-name">${name}:</span> ${msg}`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function sendEmote(emote) {
  if (!State.roomId || State.isSpectator) return;
  API.getSocket()?.emit("emote", {emote});
}

function sendChat(msg) {
  if (!State.roomId || State.isSpectator) return;
  API.getSocket()?.emit("chat", {msg});
  // Also show locally
  appendChatLog(State.playerNames?.[0] || "You", msg);
  showChatFloat(0, State.playerNames?.[0] || "You", msg);
}

function toggleSocialPanel() {
  const panel = document.getElementById("social-panel");
  if (!panel) return;
  panel.classList.toggle("open");
}

// Build social panel content (emotes + chat)
function buildSocialPanel() {
  const panel = document.getElementById("social-panel");
  if (!panel) return;
  panel.innerHTML = `
    <div class="sp-section">
      <div class="sp-label">Emotes</div>
      <div class="sp-emotes">${EMOTES.map(e =>
        `<button class="sp-emote-btn" onclick="sendEmote('${e}')">${e}</button>`
      ).join("")}</div>
    </div>
    <div class="sp-section">
      <div class="sp-label">Chat</div>
      <div class="sp-chats">${CHAT_MSGS.map(m =>
        `<button class="sp-chat-btn" onclick="sendChat('${m.replace(/'/g,"\\'")}');toggleSocialPanel()">${m}</button>`
      ).join("")}</div>
    </div>`;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderAll() {
  if (!State.data) return;
  try { renderOpponents();   } catch(e) { console.error(e); }
  try { renderTrick();       } catch(e) { console.error(e); }
  try { renderHand();        } catch(e) { console.error(e); }
  try { renderScore();       } catch(e) { console.error(e); }
  try { renderTrump();       } catch(e) { console.error(e); }
  try { renderStatus();      } catch(e) { console.error(e); }
  try { renderCaptureZone('A'); renderCaptureZone('B'); } catch(e) { console.error(e); }
  try { renderGiveUpButton(); } catch(e) { console.error(e); }
}

function renderOpponents() {
  if (!State.data) return;
  // After rotation: 0=you(bottom) 1=left 2=top 3=right — all show backs
  const names = State.playerNames || ['You','P1','P2','P3'];

  // Update name chips
  const nameMap = {1:"pname-left", 2:"pname-top", 3:"pname-right"};
  for (const [seat, elId] of Object.entries(nameMap)) {
    const el = document.getElementById(elId);
    if (el) el.textContent = names[seat] || `P${seat}`;
  }
  const youEl = document.getElementById("pname-you");
  if (youEl) youEl.textContent = names[0] || "You";

  // A small, lively turn highlight helps the table feel active. Keep this
  // visual-only and scoped to VS AI so Co-op presentation is untouched.
   // Lively turn highlight for ALL modes
  const turnZones = {0:"#zone-bottom .pchip", 1:"#zone-left .pchip", 2:"#zone-top .pchip", 3:"#zone-right .pchip"};
  Object.values(turnZones).forEach(selector => document.querySelector(selector)?.classList.remove("is-active-turn"));
  const activeSelector = turnZones[State.data.whose_turn];
  if (State.data.phase !== "done" && activeSelector) {
    document.querySelector(activeSelector)?.classList.add("is-active-turn");
  }

  [["left",1],["top",2],["right",3]].forEach(([zone, pid]) => {
    const el  = document.getElementById("hand-" + zone);
    const cnt = State.data.hand_counts?.[pid];
    if (!el || cnt==null) return;
    el.innerHTML = "";
    for (let i=0; i<Math.min(cnt,10); i++)
      el.appendChild(Object.assign(document.createElement("div"),{className:"cb"}));
  });

  const hc = State.data.hand_counts;
  if (hc) {
    const ids = {left:"cnt-left",top:"cnt-top",right:"cnt-right",you:"cnt-you"};
    const src = [hc[0],hc[1],hc[2],hc[3]];
    // Compact number badges preserve the count while giving names/avatars more
    // room on narrow landscape phones. The full meaning remains accessible.
    [[ids.left, src[1]], [ids.top, src[2]], [ids.right, src[3]], [ids.you, src[0]]]
      .forEach(([id, count]) => {
        const badge = document.getElementById(id);
        if (!badge) return;
        badge.textContent = String(count);
        badge.title = `${count} cards remaining`;
        badge.setAttribute("aria-label", `${count} cards remaining`);
      });
  }
}

function renderTrick() {
  if (!State.data) return;
  ["bottom","left","top","right"].forEach((slot, pid) => {
    const el = document.getElementById("trick-"+slot); if (!el) return;
    const cs = State.data.current_trick?.[pid];
    const ex = el.querySelector(".card");
    if (!cs) { if (ex) el.innerHTML=""; return; }
    if (ex && ex.dataset.card===cs) return;
    el.innerHTML=""; el.appendChild(mkCard(cs));
  });
}

function sortHand(cards) {
  return [...cards].sort((a,b)=>{
    const sa=a.slice(-1),sb=b.slice(-1),ra=a.slice(0,-1),rb=b.slice(0,-1);
    const ca=window.CFG.SC[sa]==="black"?0:1, cb=window.CFG.SC[sb]==="black"?0:1;
    if(ca!==cb) return ca-cb;
    const soa=window.CFG.SUIT_ORDER[sa]??0, sob=window.CFG.SUIT_ORDER[sb]??0;
    if(soa!==sob) return soa-sob;
    return (window.CFG.RANK_ORDER[rb]??0)-(window.CFG.RANK_ORDER[ra]??0);
  });
}

function renderHand() {
  const row = document.getElementById("hand-row");
  const scroll = document.getElementById("hand-scroll");
  if (!row || !State.data) return;

  // After rotation, whose_turn===0 means it's our turn.
  const myTurn = State.data.whose_turn === 0 && State.data.phase !== "done" && !State.busy;
  const cards = State.myHand();
  row.innerHTML = "";
  if (State.isSpectator || !cards?.length) return;

  // Fit every card into one row. The card width stays comfortable on desktop
  // and scales down on narrow phones; overlap increases only as much as needed.
  const available = Math.max(180, (scroll?.clientWidth || row.parentElement?.clientWidth || window.innerWidth) - 8);
  const isPhone = Boolean(window.Menu?.isPhoneDevice?.()) ||
    (window.matchMedia?.("(pointer: coarse) and (orientation: landscape)").matches);
  const cardWidth = isPhone ? Math.min(60, Math.max(46, Math.floor(available * 0.09))) : 60;
  const cardHeight = Math.round(cardWidth * (88 / 60));
  const maxStride = cardWidth * (isPhone ? 0.82 : 0.57);
  const fitStride = cards.length > 1 ? (available - cardWidth) / (cards.length - 1) : cardWidth;
  const stride = cards.length > 1 ? Math.max(8, Math.min(maxStride, fitStride)) : cardWidth;
  const totalWidth = cardWidth + Math.max(0, cards.length - 1) * stride;

  row.style.width = `${totalWidth}px`;
  row.style.maxWidth = "100%";
  row.style.marginLeft = "auto";
  row.style.marginRight = "auto";

  sortHand(cards).forEach((cs, index, sorted) => {
    const wrap = document.createElement("div");
    wrap.className = "hwrap";
    wrap.dataset.card = cs;
    wrap.style.zIndex = String(index + 1);
    wrap.style.marginRight = index === sorted.length - 1 ? "0" : `${stride - cardWidth}px`;
    if (!myTurn) wrap.classList.add("not-legal");

    const card = mkCard(cs);
    card.style.width = `${cardWidth}px`;
    card.style.height = `${cardHeight}px`;
    card.style.flexShrink = "0";
    wrap.appendChild(card);

    if (myTurn) {
      wrap.addEventListener("pointerdown", event => {
        if (!myTurn || State.busy || Drag.active) return;
        event.preventDefault();
        Drag.start(cs, wrap, event);
      });
    }
    row.appendChild(wrap);
  });
}

let _handResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(_handResizeTimer);
  _handResizeTimer = setTimeout(() => { if (State.data && !Drag.active) renderHand(); }, 100);
});

function mkCard(cs) {
  // Shared face builder keeps hand cards and played cards visually identical.
  if (window.CardFace) return window.CardFace.create(cs);
  // Defensive fallback for a stale/misordered script cache.
  const suit=cs.slice(-1), rank=cs.slice(0,-1);
  const el=document.createElement("div");
  el.className=`card ${(window.CFG.SC[suit] || "black")}${rank==="10"?" ten-card":""}`;
  el.dataset.card=cs;
  el.innerHTML=`<div class="card-corner card-corner-top"><span class="card-rank">${rank}</span><span class="card-suit">${suit}</span></div><div class="card-center"><div class="ace-mark">${suit}</div></div><div class="card-corner card-corner-bottom"><span class="card-rank">${rank}</span><span class="card-suit">${suit}</span></div>`;
  return el;
}

function mkTenMini(cs) {
  const suit=cs.slice(-1),rank=cs.slice(0,-1),col=window.CFG.SC[suit]||"black";
  const el=document.createElement("div");
  el.className=`card ${col} ten-card ten-mini`;
  el.dataset.card=cs;
  el.innerHTML=`<div><div class="rt">${rank}</div><div class="st">${suit}</div></div><div class="sm">${suit}</div><div><div class="rb">${rank}</div><div class="sb">${suit}</div></div>`;
  return el;
}

function renderScore() {
  if (!State.data) return;
  const p = State.data.captured_counts || [0,0,0,0];
  document.getElementById("cnt-a").textContent = p[0]+p[2];
  document.getElementById("cnt-b").textContent = p[1]+p[3];
}

function renderTrump() {
  if (!State.data) return;
  const b=document.getElementById("trump-badge"),s=document.getElementById("trump-sym");
  if (State.data.trump_suit) {
    s.textContent=State.data.trump_suit; b.classList.add("visible");
    b.style.color=window.CFG.SC[State.data.trump_suit]==="red"?"#e05050":"#e8dfc8";
  } else { b.classList.remove("visible"); }
}

function renderStatus() {
  if (!State.data) return;
  const el = document.getElementById("status-inline");
  if (!el) return;
  if (State.data.phase==="done") {
    el.innerHTML=`<span style="color:var(--text-muted)">Game complete — ${State.data.tricks_played} tricks</span>`;
    return;
  }
  const names    = State.playerNames || ['You','P1','P2','P3'];
  const wt       = State.data.whose_turn;
  const isMyTurn = wt===0 && !State.busy;
  el.innerHTML = isMyTurn
    ? `<span class="yt">Your turn</span>`
    : `<span style="color:var(--text-muted)">${names[wt]||"..."}'s turn</span>`;
}

function makeCaptureCardBack() {
  const back = document.createElement("div");
  back.className = "cs-capture-mini-card cs-capture-mini-back";
  back.setAttribute("aria-label", "Captured card face down");
  const emblem = document.createElement("span");
  emblem.className = "cs-capture-mini-emblem";
  emblem.textContent = "✦";
  back.appendChild(emblem);
  return back;
}

function makeCapturedTenCard(cardCode) {
  const suit = String(cardCode).slice(-1);
  const isRed = suit === "♥" || suit === "♦";
  const slot = document.createElement("div");
  slot.className = "cs-capture-card-slot is-ten";
  slot.setAttribute("role", "img");
  slot.setAttribute("aria-label", `Captured ten of ${suit}`);
  slot.title = `${cardCode} captured`;

  const flip = document.createElement("div");
  flip.className = "cs-capture-card-flip";

  const back = makeCaptureCardBack();
  back.classList.add("cs-capture-card-side");

  const face = document.createElement("div");
  face.className = `cs-capture-mini-card cs-capture-mini-face ${isRed ? "red" : "black"}`;
  face.style.transform = "rotateY(180deg)";

  const top = document.createElement("span");
  top.className = "cs-capture-mini-corner top";
  top.textContent = `10${suit}`;
  const centre = document.createElement("span");
  centre.className = "cs-capture-mini-suit";
  centre.textContent = suit;
  const bottom = document.createElement("span");
  bottom.className = "cs-capture-mini-corner bottom";
  bottom.textContent = `10${suit}`;
  face.append(top, centre, bottom);

  [back, face].forEach(side => {
    side.classList.add("cs-capture-card-side");
    side.style.position = "absolute";
    side.style.inset = "0";
    side.style.backfaceVisibility = "hidden";
    side.style.webkitBackfaceVisibility = "hidden";
  });

  flip.append(back, face);
  slot.appendChild(flip);

  // The 10 visibly turns from the same blue card back used by the deck.
  // Only newly added capture groups are animated (see renderCaptureZone).
  requestAnimationFrame(() => {
    if (typeof flip.animate !== "function") {
      flip.style.transform = "rotateY(180deg)";
      return;
    }
    const animation = flip.animate(
      [{ transform: "rotateY(0deg)" }, { transform: "rotateY(180deg)" }],
      { duration: 560, easing: "cubic-bezier(.22,.72,.25,1)", fill: "forwards" }
    );
    animation.addEventListener("finish", () => {
      flip.style.transform = "rotateY(180deg)";
      animation.cancel();
    }, { once: true });
  });
  return slot;
}

function makeCapturedTrickGroup(stack, trickIndex) {
  const group = document.createElement("div");
  group.className = "cs-capture-group";
  const cards = Array.isArray(stack?.cards) ? stack.cards.map(String).slice(0, 4) : [];
  const cardLabels = cards.length ? cards.join(" · ") : "Card details unavailable";
  group.title = `Capture ${trickIndex + 1} — four-card trick: ${cardLabels}`;
  group.setAttribute("aria-label", `Capture ${trickIndex + 1}, four cards`);
  group.dataset.captureIndex = String(trickIndex);

  // Every group always reserves four positions. Missing historical card data
  // is represented by a back, never by silently shrinking the capture group.
  for (let cardIndex = 0; cardIndex < 4; cardIndex++) {
    const cardCode = cards[cardIndex] || null;
    const cardSlot = cardCode && cardCode.startsWith("10")
      ? makeCapturedTenCard(cardCode)
      : document.createElement("div");

    if (!(cardCode && cardCode.startsWith("10"))) {
      cardSlot.className = "cs-capture-card-slot";
      cardSlot.appendChild(makeCaptureCardBack());
      cardSlot.setAttribute("aria-label", "Captured card face down");
    }

    // A short, even overlap makes the four cards read as one captured trick.
    cardSlot.style.left = `${2 + cardIndex * 8}px`;
    cardSlot.style.top = `${cardIndex % 2 ? 2 : 0}px`;
    cardSlot.style.zIndex = String(cardIndex + 1);
    cardSlot.style.transform = `rotate(${[-4, -1, 1, 4][cardIndex]}deg)`;
    group.appendChild(cardSlot);
  }
  return group;
}

function renderCaptureZone(team) {
  const fanEl   = document.getElementById(team === "A" ? "cap-a-fan" : "cap-b-fan");
  const tensEl  = document.getElementById(team === "A" ? "cap-a-tens" : "cap-b-tens");
  const countEl = document.getElementById(team === "A" ? "cap-a-count" : "cap-b-count");
  if (!fanEl) return;

  const allCards = State.stacks[team] || [];
  const tenCount = (State.tens[team] || []).length;
  const totalCaptures = allCards.length;
  const isVsAi = !State.isCoop && !State.roomId;

  if (tensEl) {
    tensEl.textContent = isVsAi ? `10s ${tenCount}/4` : `${tenCount} 🔟`;
  }
  if (countEl) {
    countEl.textContent = `${totalCaptures} ${totalCaptures === 1 ? "capture" : "captures"}`;
  }

  if (isVsAi) {
    const signatures = allCards.map(stack => {
      const cards = Array.isArray(stack?.cards) ? stack.cards.map(String).slice(0, 4) : [];
      return cards.length ? cards.join("|") : "unknown-four-card-capture";
    });

    let previous = [];
    try { previous = JSON.parse(fanEl.dataset.captureGroups || "[]"); }
    catch (_) { previous = []; }
    const canAppend = previous.length <= signatures.length &&
      previous.every((signature, index) => signature === signatures[index]);

    // Keep existing cards and their completed flip animations stable. Append
    // only the new capture; rebuild only when a new game/reset changes history.
    let firstNewGroup = 0;
    if (!canAppend) {
      fanEl.innerHTML = "";
      firstNewGroup = 0;
    } else {
      firstNewGroup = previous.length;
    }

    for (let index = firstNewGroup; index < allCards.length; index++) {
      fanEl.appendChild(makeCapturedTrickGroup(allCards[index], index));
    }
    fanEl.dataset.captureGroups = JSON.stringify(signatures);
    if (signatures.length > firstNewGroup) {
      fanEl.scrollLeft = fanEl.scrollWidth;
    }
    if (!signatures.length) fanEl.innerHTML = "";
    return;
  }

  // Preserve the current Co-op / network-room capture presentation for now.
  const avail = Math.max(fanEl.clientWidth || 200, 100);
  const CARD_W = 28;
  const MAX_CARDS = 13;
  const step = Math.min(18, Math.max(8, Math.floor((avail - CARD_W) / MAX_CARDS)));

  fanEl.innerHTML = "";
  allCards.forEach((stack, i) => {
    const tensInStack = stack.tens || [];
    if (tensInStack.length > 0) {
      tensInStack.forEach(cs => {
        const suit = cs.slice(-1), rank = cs.slice(0, -1);
        const col = window.CFG.SC[suit] || "black";
        const el = document.createElement("div");
        el.className = `cs-card cs-ten ${col}`;
        el.style.cssText = `left:${i * step}px; z-index:${i + 20}`;
        el.title = cs;
        el.innerHTML = `<div class="cs-ten-rank">${rank}</div><div class="cs-ten-suit">${suit}</div>`;
        fanEl.appendChild(el);
      });
    } else {
      const el = document.createElement("div");
      el.className = "cs-card";
      el.style.cssText = `left:${i * step}px; z-index:${i + 1}`;
      fanEl.appendChild(el);
    }
  });
}
// ─── UI helpers ───────────────────────────────────────────────────────────────
let timerIv=null,timerLeft=0,timerTotal=0,toastT=null;
function timerSecs(){return parseInt(document.getElementById("timer-select").value,10);}
function startTimer(){
  stopTimer(); if(State.isSpectator)return; timerTotal=timerSecs(); if(!timerTotal)return;
  timerLeft=timerTotal; _drawTimer(1);
  timerIv=setInterval(()=>{
    timerLeft--;_drawTimer(timerLeft/timerTotal);
    if(timerLeft<=5)document.getElementById("timer-bar").classList.add("urgent");
    if(timerLeft<=0){stopTimer();onTimeout();}
  },1000);
}
function stopTimer(){
  clearInterval(timerIv);timerIv=null;
  const b=document.getElementById("timer-bar");
  b.style.transition="none";b.style.transform="scaleX(1)";b.classList.remove("urgent");
}
function _drawTimer(f){
  const b=document.getElementById("timer-bar");
  b.style.transition="transform 0.95s linear";b.style.transform=`scaleX(${Math.max(0,f)})`;
}
function onTimeout(){
  if(State.isSpectator||!State.data||State.data.phase==="done"||State.busy)return;
  if(State.data.whose_turn!==0)return;
  document.getElementById("tflash").classList.add("show");
  setTimeout(()=>document.getElementById("tflash").classList.remove("show"),400);
  toast("⏱ Time's up — auto-playing!");
  const hand=State.myHand();
  if(hand.length)submitPlay(hand[0]);
}
function toast(m,ms=3000){
  const e=document.getElementById("toast");e.textContent=m;e.classList.add("show");
  clearTimeout(toastT);toastT=setTimeout(()=>e.classList.remove("show"),ms);
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function clearLog(){document.getElementById("log-box").innerHTML="";State.logShown=0;}
function appendNewLog(es){
  const box=document.getElementById("log-box");
  const names=State.playerNames||['You','P1','P2','P3'];
  es.forEach(e=>{
    let t=`${names[e.player]||"P"+e.player} played <b>${e.card}</b>`;
    if(e.trump_declared)t+=` <span class="tt">— trump: ${e.trump_declared}</span>`;
    if(e.trick_winner!==undefined)t+=` · <span class="wt">${names[e.trick_winner]||"P"+e.trick_winner} wins</span>`;
    box.appendChild(Object.assign(document.createElement("div"),{className:"log-entry",innerHTML:t}));
  });
  box.scrollTop=box.scrollHeight;
}
function showScore(sc, conceded=false) {
  const a=sc.winner==="A",t=sc.winner===null;
  document.getElementById("res-emoji").textContent=t?"🤝":a?"🏆":"😔";
  let txt=t?"It's a Tie!":a?"Team A Wins!":"Team B Wins!";
  if(conceded)txt+=" (conceded)";
  document.getElementById("res-text").textContent=txt;
  const reason=sc.team_a_tens!==sc.team_b_tens
    ?`Tens — A: ${sc.team_a_tens} · B: ${sc.team_b_tens}`
    :`Tens tied ${sc.team_a_tens}-${sc.team_b_tens} · Cards — A: ${sc.team_a_cards} · B: ${sc.team_b_cards}`;
  document.getElementById("res-det").textContent=reason;
  document.getElementById("sovl").classList.add("show");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function newGame() {
  stopTimer(); State.resetFlags(); clearLog();
  State.roomId = null;
  _hideConcedeBanner();
  document.getElementById("sovl").classList.remove("show");
  document.getElementById("deal-layer").innerHTML="";
  document.getElementById("play-layer").innerHTML="";
  Anim.clearTrick(); renderGiveUpButton();

  const statusEl=document.getElementById("status");
  statusEl.innerHTML=`<span class="yt">Connecting…</span>`;

  let data;
  try {
    const diff=document.getElementById("diff-select").value;
    data=await API.newGame(diff);
  } catch(err) {
    statusEl.innerHTML=`<span class="err">Could not reach server — start python server.py on port 5000</span>`;
    return;
  }
  if(!data||data.error||!data.human_hand){
    statusEl.innerHTML=`<span class="err">${data?.error||"Server error"}</span>`;
    return;
  }
  State.set(data); State.isCoop=false; State.mySeat=0;
  if(data.player_names) State.playerNames=data.player_names;
  statusEl.innerHTML=`<span class="yt">Dealing…</span>`;
  await Anim.deal(); renderAll();
  if(State.data.whose_turn===0&&State.data.phase!=="done") startTimer();
}

async function newCoopGame(difficulty, humanSeats) {
  stopTimer(); State.resetFlags(); clearLog();
  State.roomId=null;
  _hideConcedeBanner();
  document.getElementById("sovl").classList.remove("show");
  document.getElementById("deal-layer").innerHTML="";
  document.getElementById("play-layer").innerHTML="";
  Anim.clearTrick(); renderGiveUpButton();

  const statusEl=document.getElementById("status");
  statusEl.innerHTML=`<span class="yt">Connecting…</span>`;

  let data;
  try { data=await API.newCoop(difficulty, humanSeats||[0,2]); }
  catch(err) { statusEl.innerHTML=`<span class="err">Could not reach server</span>`; return; }
  if(!data||data.error){statusEl.innerHTML=`<span class="err">${data?.error||"Server error"}</span>`;return;}

  State.set(data); State.isCoop=true; State.mySeat=0;
  if(data.player_names) State.playerNames=data.player_names;
  statusEl.innerHTML=`<span class="yt">Dealing…</span>`;
  await Anim.deal(); renderAll();
  if(State.data.whose_turn===0&&State.data.phase!=="done") startTimer();
}

function hydrateSpectatorHistory(roomData) {
  // Late spectators receive a complete public snapshot. Rebuild the public
  // capture-strip counters without replaying the entire game animation log.
  const log = Array.isArray(roomData.log) ? roomData.log : [];
  State.logShown = log.length;
  State._currentTrickCards = Array.isArray(roomData.current_trick)
    ? roomData.current_trick.slice(0, 4)
    : [null, null, null, null];

  State.captures = {A: 0, B: 0};
  State.tens = {A: [], B: []};
  State.stacks = {A: [], B: []};

  let trickCards = [];
  for (const entry of log) {
    if (entry?.card) trickCards.push(String(entry.card));
    if (entry?.trick_winner === undefined || entry?.trick_winner === null) continue;

    const team = Number(entry.trick_winner) % 2 === 0 ? "A" : "B";
    const cards = trickCards.slice(0, 4);
    const tens = cards.filter(card => card.startsWith("10"));
    State.stacks[team].push({cards, tens, winner: Number(entry.trick_winner)});
    State.tens[team].push(...tens);
    State.captures[team] += 1;
    trickCards = [];
  }

  // Snapshot totals are authoritative. If an older/shortened log is received,
  // pad the visual stack count so spectators still see the correct score.
  const counts = Array.isArray(roomData.captured_counts) ? roomData.captured_counts : [0,0,0,0];
  const expected = {
    A: Math.floor(((Number(counts[0]) || 0) + (Number(counts[2]) || 0)) / 4),
    B: Math.floor(((Number(counts[1]) || 0) + (Number(counts[3]) || 0)) / 4),
  };
  for (const team of ["A", "B"]) {
    while (State.stacks[team].length < expected[team]) {
      State.stacks[team].push({cards: [], tens: [], unknown: true});
    }
    State.captures[team] = Math.max(State.captures[team], expected[team]);
  }

  // The captured-card arrays are public and let a late spectator see the
  // correct ten count even if the log did not include every earlier trick.
  const capturedA = Array.isArray(roomData.captured_a) ? roomData.captured_a : State.tens.A;
  const capturedB = Array.isArray(roomData.captured_b) ? roomData.captured_b : State.tens.B;
  State.tens.A = capturedA.map(String).filter(card => card.startsWith("10"));
  State.tens.B = capturedB.map(String).filter(card => card.startsWith("10"));
}

async function startRoomGame(roomData) {
  // Called after socket game_state arrives for a room game
  stopTimer(); State.resetFlags(); clearLog();
  _hideConcedeBanner();
  document.getElementById("sovl").classList.remove("show");
  document.getElementById("deal-layer").innerHTML="";
  document.getElementById("play-layer").innerHTML="";
  Anim.clearTrick();

  State.set(roomData);
  State.isCoop  = roomData.is_coop || false;
  State.isSpectator = Boolean(roomData.is_spectator);
  if (State.isSpectator) hydrateSpectatorHistory(roomData);
  else State.logShown = 0;
  State.roomId  = roomData.room_id || State.roomId;
  State.mySeat  = roomData.your_seat ?? 0;
  if(roomData.player_names) State.playerNames=roomData.player_names;

  const statusEl=document.getElementById("status");
  statusEl.innerHTML = State.isSpectator
    ? `<span class="yt">Watching live game…</span>`
    : `<span class="yt">Dealing…</span>`;
  // Spectators may join after several tricks have already been played. Their
  // public snapshot is already current, so render it directly instead of
  // replaying a deal animation over incoming live updates.
  if (!State.isSpectator) await Anim.deal();
  else Anim.clearTrick();
  renderAll();
  if(State.data.phase === "done" && roomData.score) {
    await sleep(500);
    showScore(roomData.score, roomData.conceded);
  } else if(State.data.whose_turn===0&&State.data.phase!=="done") startTimer();
}

async function getHint() {
  if(!State.data||State.data.phase==="done"||State.busy)return;
  if(State.roomId){API.getSocket()?.emit("hint");return;}
  try{const d=await API.getHint();if(d&&d.hint)toast(`💡 Try: ${d.hint}`);}
  catch(e){toast("Could not get hint");}
}

window.addEventListener("unhandledrejection",e=>{
  console.error("[Global]",e.reason);e.preventDefault();
  State.busy=false;toast("⚠️ Error recovered",3000);
});

window.Game={
  newGame,newCoopGame,startRoomGame,getHint,
  State,submitPlay,renderAll,startTimer,stopTimer,clearLog,
  onGiveUp,onCancelConcede,renderGiveUpButton,
  sendEmote,sendChat,toggleSocialPanel,buildSocialPanel,
  setupSocketGameHandlers
};

['controls','table','timer-wrap','status','sidebar'].forEach(id=>{
  const el=document.getElementById(id);
  if(el) el.style.display='none';
});
