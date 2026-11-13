// lang: JavaScript, file: frontend/api.js
// API communication layer — REST + Socket.IO (global API)
// FIX: all fetch calls wrapped in try/catch; json() errors caught cleanly

const API_BASE = '/api';
let socket = null;
let roomId = null;
let mySeat = null;

// Helper — fetch + json with clean error propagation
async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    // Try to get the JSON error body; fall back to status text
    try {
      const body = await res.json();
      return { error: body.error || `HTTP ${res.status}` };
    } catch (_) {
      return { error: `HTTP ${res.status}: ${res.statusText}` };
    }
  }
  return res.json();
}

window.API = {
  initSocket() {
    if (typeof io === 'undefined') {
      console.warn('[API] socket.io not loaded');
      return null;
    }
    socket = io({ transports: ['websocket', 'polling'] });
    socket.on('connect',       () => console.log('[Socket] Connected:', socket.id));
    socket.on('disconnect',    reason => console.log('[Socket] Disconnected:', reason));
    socket.on('connect_error', err => console.error('[Socket] Connection error:', err));
    return socket;
  },

  getSocket() { return socket; },

  // ── REST ──────────────────────────────────────────────────────────────────

  async newGame(difficulty = 'medium') {
    return apiFetch(`${API_BASE}/new`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ difficulty })
    });
  },

  async newCoop(difficulty = 'medium', human_seats = [0, 2]) {
    return apiFetch(`${API_BASE}/new-coop`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ difficulty, human_seats })
    });
  },

  async playCard(card, player = 0) {
    return apiFetch(`${API_BASE}/play`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ card, player })
    });
  },

  async playCoop(card, player) {
    return apiFetch(`${API_BASE}/play-coop`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ card, player })
    });
  },

  async getHint(player = 0) {
    return apiFetch(`${API_BASE}/hint?player=${player}`);
  },

  async getState() {
    return apiFetch(`${API_BASE}/state`);
  },

  // ── Socket.IO ─────────────────────────────────────────────────────────────

  createRoom(mode, difficulty, name) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Socket not initialized'));
      socket.emit('create_room', { mode, difficulty, name });
      socket.once('room_created', data => { roomId = data.room_id; mySeat = data.seat; resolve(data); });
      socket.once('join_failed',  err  => reject(new Error(err.error)));
    });
  },

  joinRoom(roomId_, name) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('Socket not initialized'));
      socket.emit('join_room', { room_id: roomId_, name });
      socket.once('room_joined', data => { roomId = data.room_id; mySeat = data.seat; resolve(data); });
      socket.once('join_failed', err  => reject(new Error(err.error)));
    });
  },

  setReady(ready = true)   { socket.emit('ready',     { ready }); },
  startGame()              { socket.emit('start_game'); },
  playCardSocket(card)     { socket.emit('play_card',  { card }); },
  requestHint()            { socket.emit('hint'); },

  onGameState(handler)     { socket.on('game_state',    handler); },
  onGameOver(handler)      { socket.on('game_over',     handler); },
  onPlayFailed(handler)    { socket.on('play_failed',   handler); },
  onHint(handler)          { socket.on('hint',          handler); },
  onPlayerJoined(handler)  { socket.on('player_joined', handler); },
  onPlayerLeft(handler)    { socket.on('player_left',   handler); },
  onPlayerReady(handler)   { socket.on('player_ready',  handler); },

  offAll() {
    if (socket) {
      ['game_state','game_over','play_failed','hint',
       'player_joined','player_left','player_ready'].forEach(e => socket.off(e));
    }
  },

  getRoomId() { return roomId; },
  getMySeat()  { return mySeat; }
};
