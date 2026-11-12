// Indawlchuh — menu, room creation/joining and in-table private-room setup.
// Create Room: name entry -> room created -> card table waiting room.
// Room seats are configured as Bot (per-seat difficulty) or Open (human join).

'use strict';

let _selectedDiff   = 'medium';
let _inGame         = false;
let _menuMusic      = null;
let _playerName     = localStorage.getItem("indawlchuh_name") || "";
let _currentRoom    = null;
let _isHost         = false;
let _isSpectator    = false;
let _nameEntryCallback = null;
let _seatPickerMode = 'join';
let _pendingJoinCode = '';
let _pendingSeatRequestHandler = null;

// ─── Music ────────────────────────────────────────────────────────────────────
function initMenuMusic() {
  if (_menuMusic) return;
  try {
    _menuMusic = new Audio("/static/menu_music.mpeg");
    _menuMusic.loop = true;
    _menuMusic.volume = 0.45;
  } catch (e) {
    console.warn("[Music]", e);
  }
}

function playMenuMusic() {
  initMenuMusic();
  if (!_menuMusic) return;
  _menuMusic.play().catch(() =>
    document.addEventListener("pointerdown", () => _menuMusic.play().catch(() => {}), { once: true })
  );
}

function stopMenuMusic() {
  if (!_menuMusic) return;
  _menuMusic.pause();
  _menuMusic.currentTime = 0;
}

// ─── Screen management ────────────────────────────────────────────────────────
const ALL_SCREENS = ['main', 'diff', 'options', 'name-entry', 'join-room', 'choose-seat', 'coop'];

// Phone users play in landscape. Browsers that cannot lock orientation show
// the rotate overlay instead of leaving a cramped portrait table on screen.
function _isPhoneDevice() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPod|Android.*Mobile|Windows Phone|webOS/i.test(ua)) return true;
  return !!(window.matchMedia?.("(pointer: coarse)").matches &&
    Math.min(window.screen?.width || 999, window.screen?.height || 999) <= 520);
}

function _updateMobileOrientationGuard() {
  const active = !!_currentRoom || _inGame;
  const phone = _isPhoneDevice();
  const portrait = window.matchMedia?.("(orientation: portrait)").matches ||
    (window.innerHeight > window.innerWidth);
  const overlay = document.getElementById("mobile-rotate-overlay");
  const show = active && phone && portrait;
  if (overlay) overlay.classList.toggle("visible", show);
  document.body.classList.toggle("mobile-room-mode", active && phone);
}

function _requestMobileLandscape() {
  if (!_isPhoneDevice()) return;
  const orientation = window.screen?.orientation;
  const lock = () => {
    if (typeof orientation?.lock !== "function") return;
    try {
      Promise.resolve(orientation.lock("landscape")).catch(err =>
        console.info("[Mobile] Landscape lock unavailable; rotate prompt will be shown", err?.message || err)
      );
    } catch (err) {
      console.info("[Mobile] Landscape lock unavailable; rotate prompt will be shown", err?.message || err);
    }
  };
  // Try the lock immediately, then retry after fullscreen (required by some browsers).
  lock();
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen({navigationUI:"hide"})
      .then(lock)
      .catch(() => {});
  }
  _updateMobileOrientationGuard();
}

window.addEventListener("resize", _updateMobileOrientationGuard);
window.addEventListener("orientationchange", _updateMobileOrientationGuard);
window.screen?.orientation?.addEventListener?.("change", _updateMobileOrientationGuard);

function showScreen(name) {
  const target = document.getElementById('screen-' + name);
  if (!target) {
    console.error(`[Menu] Screen not found: screen-${name}`);
    return false;
  }

  const overlay = document.getElementById('menu-overlay');
  if (overlay) overlay.classList.remove('hidden');

  ALL_SCREENS.forEach(screen => {
    const el = document.getElementById('screen-' + screen);
    if (el) el.style.display = (screen === name) ? 'flex' : 'none';
  });
  target.style.display = 'flex';
  return true;
}

showScreen('main');
playMenuMusic();

// ─── Utility ──────────────────────────────────────────────────────────────────
function _shake(el) {
  if (!el) return;
  el.classList.add("shake");
  setTimeout(() => el.classList.remove("shake"), 500);
}

function toast(message, ms = 3000) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(window._toastT);
  window._toastT = setTimeout(() => el.classList.remove("show"), ms);
}
window.toast = toast;

function _escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function _copyText(value, successMessage, fallbackLabel) {
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value)
      .then(() => toast(successMessage))
      .catch(() => toast(`${fallbackLabel}: ${value}`, 5000));
  } else {
    toast(`${fallbackLabel}: ${value}`, 5000);
  }
}

// ─── Name entry ───────────────────────────────────────────────────────────────
function showNameEntry(backScreen, callback) {
  _nameEntryCallback = callback;
  const back = document.getElementById("name-back-btn");
  if (back) back.setAttribute("onclick", `Menu.showScreen('${backScreen}')`);
  const input = document.getElementById("name-input");
  if (input) input.value = _playerName || "";
  showScreen('name-entry');
}

function confirmName() {
  const input = document.getElementById("name-input");
  const name = (input?.value || "").trim().slice(0, 20);
  if (!name) {
    _shake(input);
    return;
  }
  _playerName = name;
  localStorage.setItem("indawlchuh_name", name);
  const callback = _nameEntryCallback;
  _nameEntryCallback = null;
  if (callback) callback(name);
}

// ─── Vs AI ────────────────────────────────────────────────────────────────────
function startVsAI(diff) {
  _requestMobileLandscape();
  _selectedDiff = diff;
  document.getElementById('diff-select').value = diff;
  const labels = { easy: 'Easy AI', medium: 'Medium AI', hard: 'Hard AI' };
  document.getElementById('diff-badge-label').textContent = labels[diff] || diff;
  _currentRoom = null;
  _isHost = false;
  _isSpectator = false;
  hideMenuShowGame(false);
  window.Game.newGame();
}

// ─── Create Room: name -> table waiting room ──────────────────────────────────
function showCreateRoom() {
  if (_playerName) {
    createRoom();
  } else {
    showNameEntry('coop', () => createRoom());
  }
}

function createRoom() {
  _requestMobileLandscape();
  const sock = API.initSocket();
  if (!sock) {
    toast("Could not connect to server");
    return;
  }

  toast("Creating room…");
  const onCreateFailed = data => toast(data?.error || "Could not create room");
  sock.once("room_created", data => {
    sock.off("join_failed", onCreateFailed);
    _enterRoomWaiting(data);
  });
  sock.once("join_failed", onCreateFailed);
  sock.emit("create_room", {
    name: _playerName || "Host",
    mode: "multiplayer",
    difficulty: "medium"
  });
}

// ─── Join Room ────────────────────────────────────────────────────────────────
function showJoinRoom() {
  if (_playerName) {
    showScreen('join-room');
    _prefillCodeFromURL();
  } else {
    showNameEntry('coop', () => {
      showScreen('join-room');
      _prefillCodeFromURL();
    });
  }
}

function _prefillCodeFromURL() {
  const code = window.location.pathname.match(/\/join\/([A-Z0-9]{6})/i)?.[1]?.toUpperCase();
  if (!code) return;
  const input = document.getElementById("room-code-input");
  if (input) input.value = code;
}

function joinRoom() {
  const input = document.getElementById("room-code-input");
  const code = (input?.value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    _shake(input);
    toast("Enter a 6-character code");
    return;
  }
  if (!_playerName) {
    showNameEntry('join-room', () => _enterRoomAsSpectator(code));
    return;
  }
  _enterRoomAsSpectator(code);
}

function _enterRoomAsSpectator(code) {
  _requestMobileLandscape();
  const sock = API.getSocket() || API.initSocket();
  if (!sock) { toast("Could not connect to server"); return; }
  toast("Entering room lobby…");
  const onEntered = data => {
    sock.off("join_failed", onFailed);
    _enterRoomWaiting(data);
  };
  const onFailed = data => {
    sock.off("room_entered", onEntered);
    toast(data?.error || "Could not enter room");
  };
  sock.once("room_entered", onEntered);
  sock.once("join_failed", onFailed);
  sock.emit("enter_room", {room_id: code, name: _playerName || "Spectator"});
}

function _requestRoomSeatChoices(code) {
  const sock = API.getSocket() || API.initSocket();
  if (!sock) { toast("Could not connect to server"); return; }

  _seatPickerMode = 'join';
  _pendingJoinCode = code;
  showScreen('choose-seat');
  const picker = document.getElementById('room-seat-picker');
  if (picker) picker.innerHTML = '<div class="seat-picker-loading">Checking available seats…</div>';

  if (_pendingSeatRequestHandler) sock.off('room_seats', _pendingSeatRequestHandler);
  const onSeats = data => {
    if (!data || String(data.room_id || '').toUpperCase() !== code) return;
    _pendingSeatRequestHandler = null;
    sock.off('room_seats_failed', onSeatLookupFailed);
    _renderSeatPicker(data);
  };
  const onSeatLookupFailed = data => {
    sock.off('room_seats', onSeats);
    _pendingSeatRequestHandler = null;
    if (_seatPickerMode !== 'join' || _pendingJoinCode !== code) return;
    showScreen('join-room');
    toast(data?.error || 'Could not find that room');
  };
  _pendingSeatRequestHandler = onSeats;
  sock.once('room_seats', onSeats);
  sock.once('room_seats_failed', onSeatLookupFailed);
  sock.emit('request_room_seats', {room_id: code});
}

function _requestCurrentRoomSeatChoices() {
  const sock = API.getSocket();
  if (!sock || !_currentRoom) { toast('Room connection is unavailable'); return; }
  _seatPickerMode = 'change';
  showScreen('choose-seat');
  const picker = document.getElementById('room-seat-picker');
  if (picker) picker.innerHTML = '<div class="seat-picker-loading">Checking available seats…</div>';
  if (_pendingSeatRequestHandler) sock.off('room_seats', _pendingSeatRequestHandler);
  const onSeats = data => {
    if (!_currentRoom || String(data?.room_id || '') !== String(_currentRoom.room_id)) return;
    _pendingSeatRequestHandler = null;
    sock.off('room_seats_failed', onSeatLookupFailed);
    _renderSeatPicker(data);
  };
  const onSeatLookupFailed = data => {
    sock.off('room_seats', onSeats);
    _pendingSeatRequestHandler = null;
    toast(data?.error || 'Could not load available seats');
    document.getElementById('menu-overlay')?.classList.add('hidden');
  };
  _pendingSeatRequestHandler = onSeats;
  sock.once('room_seats', onSeats);
  sock.once('room_seats_failed', onSeatLookupFailed);
  sock.emit('request_room_seats', {room_id: _currentRoom.room_id});
}

function _renderSeatPicker(data) {
  const picker = document.getElementById('room-seat-picker');
  const subtitle = document.getElementById('seat-picker-subtitle');
  if (!picker) return;
  const config = data.seat_config || {};
  const available = new Set((data.available_seats || []).map(Number));
  const currentSeat = data.current_seat == null ? null : Number(data.current_seat);
  const positions = {1:'Left side of host', 2:'Opposite the host', 3:'Right side of host'};
  if (subtitle) subtitle.textContent = _seatPickerMode === 'change'
    ? 'Choose another empty seat. Your current seat is marked.'
    : 'Choose the seat you want before joining the table.';

  picker.innerHTML = [1,2,3].map(seat => {
    const cfg = config[seat] || config[String(seat)] || {type:'open'};
    const isCurrent = currentSeat === seat;
    const isAvailable = available.has(seat);
    const isBot = cfg.type === 'bot';
    const isHuman = cfg.type === 'human';
    const canChoose = isAvailable && !isBot && !isHuman;
    const status = isCurrent ? 'Your current seat'
      : canChoose ? 'Available — tap to choose'
      : isBot ? `${String(cfg.difficulty || 'medium').replace(/^./, c => c.toUpperCase())} bot`
      : isHuman ? `${_escapeHTML(cfg.name || 'Occupied')}`
      : 'Not available';
    const label = isCurrent ? 'Current seat' : canChoose ? 'Choose this seat' : isBot ? 'Bot seat' : isHuman ? 'Occupied' : 'Unavailable';
    const disabled = !(canChoose && !isCurrent);
    const classes = `seat-pick-btn${canChoose ? ' available' : ''}${isCurrent ? ' current' : ''}`;
    return `<button type="button" class="${classes}" ${disabled ? 'disabled' : `onclick="Menu.chooseRoomSeat(${seat})"`}>
      <span class="seat-pick-number">${seat}</span>
      <span class="seat-pick-copy"><span class="seat-pick-title">Seat ${seat} · ${positions[seat]}</span><span class="seat-pick-status">${status}</span></span>
      <span class="seat-pick-action">${label}</span>
    </button>`;
  }).join('');

  if (!picker.innerHTML) picker.innerHTML = '<div class="seat-picker-empty">No seats are available.</div>';
  if (_seatPickerMode === 'join' && available.size === 0) {
    picker.innerHTML = '<div class="seat-picker-empty">No open seats are available. Ask the host to open a seat.</div>';
  }
}

function chooseRoomSeat(seat) {
  seat = Number(seat);
  if (![1,2,3].includes(seat)) return;
  const sock = API.getSocket();
  if (!sock) { toast('Room connection is unavailable'); return; }

  if (_seatPickerMode === 'change') {
    if (!_currentRoom) return;
    if (seat === Number(_currentRoom.seat)) {
      document.getElementById('menu-overlay')?.classList.add('hidden');
      return;
    }
    toast('Changing seat…');
    sock.emit('change_seat', {seat});
    return;
  }

  _doJoin(_pendingJoinCode, seat);
}

function _doJoin(code, seat) {
  const sock = API.getSocket() || API.initSocket();
  if (!sock) { toast("Could not connect to server"); return; }

  toast("Joining selected seat…");
  const onJoined = data => {
    sock.off('join_failed', onJoinFailed);
    _enterRoomWaiting(data);
  };
  const onJoinFailed = data => {
    sock.off('room_joined', onJoined);
    toast(data?.error || "Could not join room");
    // Refresh the seat map after a race (for example, another player chose it).
    _requestRoomSeatChoices(code);
  };
  sock.once('room_joined', onJoined);
  sock.once('join_failed', onJoinFailed);
  sock.emit('join_room', {room_id: code, name: _playerName || 'Player', seat});
}

function backFromSeatPicker() {
  if (_seatPickerMode === 'change') {
    document.getElementById('menu-overlay')?.classList.add('hidden');
  } else {
    showScreen('join-room');
  }
}

function openSeatChange() {
  if (_isHost || _isSpectator || !_currentRoom) return;
  _requestCurrentRoomSeatChoices();
}

// ─── In-table private-room waiting state ──────────────────────────────────────
function _enterRoomWaiting(roomData) {
  _currentRoom = {
    ...roomData,
    seat_config: roomData.seat_config || {},
    spectators: roomData.spectators || [],
    room_id: roomData.room_id || "------"
  };
  // A spectator has no seat (null). Number(null) is 0 in JavaScript, so
  // checking Number(roomData.seat) === 0 without a null guard incorrectly
  // turns every spectator into a host and hides the available-seat buttons.
  _isSpectator = Boolean(roomData.is_spectator) || roomData.seat == null;
  _isHost = Boolean(roomData.is_host) ||
    (!_isSpectator && roomData.seat != null && Number(roomData.seat) === 0);
  _currentRoom.is_spectator = _isSpectator;
  _currentRoom.is_host = _isHost;

  const codeEl = document.getElementById("room-room-code");
  if (codeEl) codeEl.textContent = _currentRoom.room_id;
  const badge = document.getElementById('diff-badge-label');
  if (badge) badge.textContent = `Room ${_currentRoom.room_id}`;

  const changeSeatBtn = document.getElementById("room-change-seat-btn");
  if (changeSeatBtn) changeSeatBtn.style.display = (!_isHost && !_isSpectator) ? "inline-flex" : "none";
  _renderRoomSeats();
  _renderSpectatorList();
  _setupRoomSocket();
  hideMenuShowGame(true);
  _updateRoomPanel();
  _updateMobileOrientationGuard();
}

function _seatConfig(seat) {
  const cfg = _currentRoom?.seat_config || {};
  return cfg[seat] || cfg[String(seat)] || { type: "open", name: "Waiting…", ready: false, difficulty: "medium" };
}

function _renderRoomSeats() {
  if (!_currentRoom) return;
  const mySeat = _currentRoom.seat == null ? 0 : Number(_currentRoom.seat);
  const visualSlots = {1:"room-seat-slot-1", 2:"room-seat-slot-2", 3:"room-seat-slot-3"};
  const hostName = _escapeHTML(_seatConfig(0).name || "Host");
  const bottomName = _isSpectator ? `${hostName} · Host` : (_playerName || "You");
  const youName = document.getElementById("pname-you");
  if (youName) youName.textContent = bottomName;

  for (const [visualSeatText, elementId] of Object.entries(visualSlots)) {
    const visualSeat = Number(visualSeatText);
    const absoluteSeat = (mySeat + visualSeat) % 4;
    const slot = document.getElementById(elementId);
    if (!slot) continue;

    const config = _seatConfig(absoluteSeat);
    const type = config.type || "open";
    const isBot = type === "bot";
    const isHuman = type === "human";
    const isOpen = type === "open";
    const difficulty = ["easy", "medium", "hard"].includes(config.difficulty) ? config.difficulty : "medium";

    let icon = "?", name = "Open Seat", status = "Waiting for a player", cardClass = "is-open";
    if (isBot) {
      icon = '<svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M8 10h.01M16 10h.01M8 15h8M12 2v3M12 19v3"/></svg>';
      name = _escapeHTML(config.name || `Bot ${absoluteSeat}`);
      status = `${difficulty[0].toUpperCase()}${difficulty.slice(1)} AI`;
      cardClass = "is-bot";
    } else if (isHuman) {
      icon = '<svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';
      name = _escapeHTML(config.name || `Player ${absoluteSeat}`);
      status = "Player joined";
      cardClass = "is-human";
    }

    let controls = "";
    if (_isHost && absoluteSeat !== 0 && !isHuman) {
      const nextMode = isBot ? "Open" : "Bot";
      controls = `<div class="rs-controls">
        <button class="rs-toggle" onclick="Menu.toggleSeatMode(${absoluteSeat})">Switch to ${nextMode}</button>
        ${isBot ? `<select class="rs-difficulty" aria-label="Bot ${absoluteSeat} difficulty" onchange="Menu.setSeatDifficulty(${absoluteSeat}, this.value)">
          <option value="easy" ${difficulty === "easy" ? "selected" : ""}>Easy AI</option>
          <option value="medium" ${difficulty === "medium" ? "selected" : ""}>Medium AI</option>
          <option value="hard" ${difficulty === "hard" ? "selected" : ""}>Hard AI</option>
        </select>` : ""}
      </div>`;
    } else if (!_isHost && isOpen && !_currentRoom.game_started) {
      const action = _isSpectator
        ? `<button class="rs-join-seat" onclick="Menu.claimSeat(${absoluteSeat})">Choose this seat</button>`
        : `<button class="rs-join-seat" onclick="Menu.changeSeatFromTable(${absoluteSeat})">Move here</button>`;
      controls = `<div class="rs-controls">${action}</div>`;
    }

    slot.innerHTML = `<div class="room-seat-card ${cardClass}">
      <div class="rs-icon">${icon}</div><div class="rs-name">${name}</div>
      <div class="rs-status">${isOpen && !_isHost ? "Available seat" : status}</div>${controls}
    </div>`;
  }
  _renderSpectatorList();
}

function _renderSpectatorList() {
  const list = document.getElementById("room-spectator-list");
  const count = document.getElementById("room-spectator-count");
  if (!list || !_currentRoom) return;
  const spectators = Array.isArray(_currentRoom.spectators) ? _currentRoom.spectators : [];
  if (count) count.textContent = String(spectators.length);
  list.innerHTML = spectators.length
    ? spectators.map(s => `<div class="rl-spectator"><span class="rl-spectator-dot"></span><span>${_escapeHTML(s.name || "Spectator")}</span></div>`).join("")
    : '<div class="rl-no-spectators">No spectators waiting</div>';
}

function claimSeat(seat) {
  if (!_currentRoom || !_isSpectator || _currentRoom.game_started) return;
  seat = Number(seat);
  if (![1,2,3].includes(seat)) return;
  const sock = API.getSocket();
  if (!sock) { toast("Room connection is unavailable"); return; }
  toast(`Requesting Seat ${seat}…`);
  sock.emit("claim_seat", {seat});
}

function changeSeatFromTable(seat) {
  if (!_currentRoom || _isHost || _isSpectator || _currentRoom.game_started) return;
  seat = Number(seat);
  if (![1,2,3].includes(seat) || seat === Number(_currentRoom.seat)) return;
  API.getSocket()?.emit("change_seat", {seat});
  toast(`Moving to Seat ${seat}…`);
}

function _roomCanStart() {
  if (!_currentRoom || !_isHost) return false;
  return [1, 2, 3].every(seat => {
    const type = _seatConfig(seat).type;
    return type === "bot" || type === "human";
  });
}

function _updateRoomPanel() {
  const startBtn = document.getElementById("room-start-btn");
  const hint = document.getElementById("room-lobby-hint");
  const canStart = _roomCanStart();
  const assigned = [1,2,3].filter(seat => ["bot", "human"].includes(_seatConfig(seat).type)).length + 1;

  if (startBtn) {
    startBtn.style.display = _isHost && canStart ? "block" : "none";
    startBtn.disabled = !canStart;
  }
  if (hint) {
    if (_isHost) {
      hint.textContent = canStart
        ? "All four seats are filled. You can start the game."
        : `Seats filled: ${assigned}/4. Set an empty seat to Bot or wait for a player to take it.`;
    } else if (_isSpectator) {
      hint.textContent = _currentRoom?.game_started
        ? "You are watching the live game. Players’ private hands are hidden from spectators."
        : "You joined as a spectator. Choose any available seat when you are ready; you can also keep watching.";
    } else {
      hint.textContent = `You are seated at Seat ${_currentRoom?.seat}. You can change to another available seat before the game starts.`;
    }
  }
}

function toggleSeatMode(seat) {
  if (!_isHost || !_currentRoom || ![1, 2, 3].includes(Number(seat))) return;
  const current = _seatConfig(seat);
  if (current.type === "human") return;
  const nextType = current.type === "bot" ? "open" : "bot";
  API.getSocket()?.emit("set_seat_type", {
    seat: Number(seat),
    type: nextType,
    difficulty: current.difficulty || "medium"
  });
}

function setSeatDifficulty(seat, difficulty) {
  if (!_isHost || !_currentRoom || ![1, 2, 3].includes(Number(seat))) return;
  if (! ["easy", "medium", "hard"].includes(difficulty)) return;
  if (_seatConfig(seat).type !== "bot") return;
  API.getSocket()?.emit("set_seat_type", {
    seat: Number(seat),
    type: "bot",
    difficulty
  });
}

// Backwards-compatible wrappers for any older inline references.
function setSeatHuman(seat) {
  if (!_isHost || _seatConfig(seat).type === "human") return;
  API.getSocket()?.emit("set_seat_type", { seat, type: "open" });
}
function setSeatBot(seat) {
  if (!_isHost || _seatConfig(seat).type === "human") return;
  API.getSocket()?.emit("set_seat_type", {
    seat, type: "bot", difficulty: _seatConfig(seat).difficulty || "medium"
  });
}

function hostStartGame() {
  if (!_isHost || !_roomCanStart()) {
    toast("Choose Bot or have a player join every seat first");
    return;
  }
  API.getSocket()?.emit("start_game");
}

function copyRoomCode() {
  const code = _currentRoom?.room_id || document.getElementById("room-room-code")?.textContent?.trim();
  if (!code || code === "------") return;
  _copyText(code, "Room code copied!", "Room code");
}

function copyInviteLink() {
  if (!_currentRoom?.room_id) return;
  const code = _currentRoom.room_id;
  const url = _currentRoom.invite_url || `${location.protocol}//${location.host}/join/${code}`;
  _copyText(url, "Invite link copied!", "Invite link");
}

function _setupRoomSocket() {
  const sock = API.getSocket();
  if (!sock) return;

  ["player_joined", "player_left", "seat_config_updated", "seat_changed", "seat_change_failed",
   "seat_claimed", "seat_claim_failed", "room_lobby_update", "room_closed", "room_start_failed"]
    .forEach(eventName => sock.off(eventName));

  const updateLobby = data => {
    if (!_currentRoom || !data) return;
    if (data.seat_config) _currentRoom.seat_config = data.seat_config;
    if (data.spectators) _currentRoom.spectators = data.spectators;
    if (data.game_started != null) _currentRoom.game_started = Boolean(data.game_started);
    _renderRoomSeats();
    _renderSpectatorList();
    _updateRoomPanel();
  };

  sock.on("room_lobby_update", updateLobby);
  sock.on("player_joined", data => {
    if (!_currentRoom) return;
    updateLobby(data);
    toast(`${data.name || "A player"} took a seat`);
  });
  sock.on("player_left", data => {
    if (!_currentRoom) return;
    updateLobby(data);
    toast(`${data.name || "A player"} left the table`);
  });
  sock.on("seat_config_updated", updateLobby);

  sock.on("seat_claimed", data => {
    if (!_currentRoom || data?.seat == null) return;
    _currentRoom.seat = Number(data.seat);
    _currentRoom.is_spectator = false;
    _isSpectator = false;
    _currentRoom.seat_config = data.seat_config || _currentRoom.seat_config;
    const changeSeatBtn = document.getElementById("room-change-seat-btn");
    if (changeSeatBtn) changeSeatBtn.style.display = "inline-flex";
    _renderRoomSeats();
    _updateRoomPanel();
    toast(`You are now seated at Seat ${data.seat}`);
  });
  sock.on("seat_claim_failed", data => {
    toast(data?.error || "That seat is no longer available");
    updateLobby(_currentRoom);
  });

  sock.on("seat_changed", data => {
    if (!_currentRoom || data?.seat == null) return;
    _currentRoom.seat = Number(data.seat);
    _currentRoom.seat_config = data.seat_config || _currentRoom.seat_config;
    _currentRoom.spectators = data.spectators || _currentRoom.spectators;
    _isSpectator = false;
    document.getElementById('menu-overlay')?.classList.add('hidden');
    _renderRoomSeats();
    _updateRoomPanel();
    toast(`You moved to Seat ${_currentRoom.seat}`);
  });
  sock.on("seat_change_failed", data => {
    toast(data?.error || 'Could not change seat');
    if (_seatPickerMode === 'change') _requestCurrentRoomSeatChoices();
  });
  sock.on("room_start_failed", data => toast(data?.error || "The room is not ready yet"));
  sock.on("room_closed", data => {
    toast(data?.message || "The room host closed the room");
    leaveRoom();
  });

  const startWatching = data => {
    if (!_currentRoom) return;
    sock.off("game_state", startWatching);
    sock.off("game_over", startWatching);
    data.room_id = _currentRoom.room_id;
    data.your_seat = _isSpectator ? 0 : Number(_currentRoom.seat ?? 0);
    data.is_spectator = _isSpectator;
    hideMenuShowGame(false);
    window.Game.setupSocketGameHandlers();
    if (!_isSpectator) window.Game.buildSocialPanel();
    const socialBtn = document.getElementById("social-btn");
    if (socialBtn) socialBtn.style.display = _isSpectator ? "none" : "flex";
    window.Game.startRoomGame(data);
  };
  // Works both when the room starts after joining and when a spectator joins an active game.
  sock.once("game_state", startWatching);
  sock.once("game_over", startWatching);
}

// ─── Menu -> game/table ────────────────────────────────────────────────────────
function hideMenuShowGame(waitingRoom = false) {
  document.getElementById('menu-overlay').classList.add('hidden');

  const shell = document.getElementById('game-shell');
  const table = document.getElementById('table');
  const roomPanel = document.getElementById('room-lobby-panel');
  if (shell) shell.style.display = 'flex';
  if (table) {
    table.style.display = 'grid';
    table.classList.toggle('room-waiting', waitingRoom);
  }
  if (roomPanel) roomPanel.style.display = waitingRoom ? 'flex' : 'none';

  const timer = document.getElementById('timer-wrap');
  if (timer) timer.style.display = waitingRoom ? 'none' : 'block';

  document.getElementById('game-top-bar').classList.add('visible');
  _inGame = !waitingRoom;
  stopMenuMusic();
  _updateMobileOrientationGuard();

  const controls = document.getElementById("controls-inline");
  if (controls) controls.style.display = _currentRoom ? "none" : "flex";

  const socialBtn = document.getElementById("social-btn");
  if (socialBtn) socialBtn.style.display = (_currentRoom && !waitingRoom) ? "flex" : "none";
  const changeSeatBtn = document.getElementById("room-change-seat-btn");
  if (changeSeatBtn) changeSeatBtn.style.display = (waitingRoom && !_isHost && !_isSpectator) ? "inline-flex" : "none";
}

function _disconnectRoomSocket() {
  const sock = API.getSocket();
  if (sock) sock.disconnect();
}

function _showMenuAfterRoomExit(screen = 'main') {
  if (window.Game?.stopTimer) window.Game.stopTimer();
  _disconnectRoomSocket();
  _currentRoom = null;
  _isHost = false;
  _isSpectator = false;
  _inGame = false;
  _updateMobileOrientationGuard();

  const shell = document.getElementById('game-shell');
  const table = document.getElementById('table');
  const roomPanel = document.getElementById('room-lobby-panel');
  if (shell) shell.style.display = 'none';
  if (table) {
    table.style.display = 'none';
    table.classList.remove('room-waiting');
  }
  if (roomPanel) roomPanel.style.display = 'none';
  const timer = document.getElementById('timer-wrap');
  if (timer) timer.style.display = 'none';

  document.getElementById('game-top-bar').classList.remove('visible');
  document.getElementById('menu-overlay').classList.remove('hidden');
  document.getElementById('sovl').classList.remove('show');

  const socialBtn = document.getElementById("social-btn");
  const controls = document.getElementById("controls-inline");
  if (socialBtn) socialBtn.style.display = "none";
  if (controls) controls.style.display = "flex";
  const changeSeatBtn = document.getElementById("room-change-seat-btn");
  if (changeSeatBtn) changeSeatBtn.style.display = "none";

  showScreen(screen);
  playMenuMusic();
}

function leaveRoom() {
  _showMenuAfterRoomExit('coop');
}

function returnToMenu() {
  _showMenuAfterRoomExit('main');
}

function confirmExit() {
  if (confirm('Exit Indawlchuh?')) window.close();
}

// ─── Options ──────────────────────────────────────────────────────────────────
function segSelect(groupId, btn) {
  document.querySelectorAll('#' + groupId + ' .seg-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function cardStyleSelect(thumb) {
  document.querySelectorAll('#opt-cardstyle .card-thumb').forEach(t => t.classList.remove('active'));
  thumb.classList.add('active');
}

document.getElementById('opt-music')?.addEventListener('change', function() {
  document.getElementById('opt-music-lbl').textContent = this.checked ? 'On' : 'Off';
  if (this.checked) playMenuMusic(); else stopMenuMusic();
});

document.getElementById('opt-sfx')?.addEventListener('change', function() {
  document.getElementById('opt-sfx-lbl').textContent = this.checked ? 'On' : 'Off';
});

document.getElementById('opt-vol')?.addEventListener('input', function() {
  document.getElementById('opt-vol-lbl').textContent = this.value + '%';
  this.style.background = `linear-gradient(to right,#c9873a ${this.value}%,rgba(255,255,255,.12) ${this.value}%)`;
  if (_menuMusic) _menuMusic.volume = this.value / 100;
});

(function() {
  const volume = document.getElementById('opt-vol');
  if (volume) {
    volume.style.background = `linear-gradient(to right,#c9873a ${volume.value}%,rgba(255,255,255,.12) ${volume.value}%)`;
  }
})();

function saveOptions() {
  document.getElementById('menu-overlay').classList.remove('hidden');
  showScreen('main');
  if (_inGame) document.getElementById('menu-overlay').classList.add('hidden');
  toast('Options saved');
}

// ─── Expose globally ──────────────────────────────────────────────────────────
window.Menu = {
  showScreen,
  startVsAI,
  showCreateRoom,
  createRoom,
  showJoinRoom,
  joinRoom,
  chooseRoomSeat,
  claimSeat,
  changeSeatFromTable,
  backFromSeatPicker,
  openSeatChange,
  confirmName,
  toggleSeatMode,
  setSeatDifficulty,
  setSeatHuman,
  setSeatBot,
  hostStartGame,
  copyRoomCode,
  copyInviteLink,
  leaveRoom,
  returnToMenu,
  confirmExit,
  segSelect,
  cardStyleSelect,
  saveOptions,
  playMenuMusic,
  stopMenuMusic,
  isPhoneDevice: _isPhoneDevice
};
