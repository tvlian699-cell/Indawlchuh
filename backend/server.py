# lang: Python 3.11+, file: backend/server.py
# REBUILD:
#  - Private room system with 6-char room codes
#  - Player names stored and broadcast
#  - Seat configuration: each seat can be Human or Bot
#  - POV rotation: snapshot rotated per-player so they always sit at bottom
#  - Emotes + preset chat via socket
#  - Concede (solo + coop mutual confirm)
#  - Menu music hint in static serve
#  - Early 4-tens win detection (from game_engine)

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room
import os, sys, random, string, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from game_controller import GameController
from ai_bot import make_bot, HardBot
from room_manager import RoomManager, Room

BASE_DIR     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="/static")
app.config['SECRET_KEY'] = 'indawlchuh-secret-dev'
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

room_manager = RoomManager()

# Solo session (vs AI, no room)
_session     = None
_concede_pending = None


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _gen_code():
    """6-char uppercase room code e.g. MIZO42"""
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))

def _rotate(lst, by):
    """Rotate a list of 4 items so index `by` becomes index 0."""
    return [lst[(i + by) % 4] for i in range(4)]

def _rotated_snap(snap: dict, my_seat: int, game: GameController) -> dict:
    """
    Returns a copy of the snapshot with all seat-indexed arrays rotated
    so that `my_seat` appears at index 0 (bottom).
    The player's own hand is injected; other hands are hidden.
    """
    if my_seat == 0:
        s = dict(snap)
        s['your_seat']   = 0
        s['your_hand']   = [str(c) for c in game.state.hands[0]]
        s['human_hand']  = s['your_hand']
        s['human_hands'] = {}
        s['is_spectator'] = False
        return s

    rot = my_seat  # rotate everything by this offset
    s   = dict(snap)

    # Rotate per-seat arrays
    s['current_trick']   = _rotate(snap['current_trick'],   rot)
    s['hand_counts']     = _rotate(snap['hand_counts'],     rot)
    s['captured_counts'] = _rotate(snap['captured_counts'], rot)

    # Adjust seat indices
    def remap(seat):
        if seat is None: return None
        return (seat - rot) % 4

    s['whose_turn']     = remap(snap['whose_turn'])
    s['current_leader'] = remap(snap['current_leader'])
    s['your_seat']      = 0   # always 0 from your POV

    # Inject only this player's hand
    s['your_hand']  = [str(c) for c in game.state.hands[my_seat]]
    s['human_hand'] = s['your_hand']

    # Remap log entries
    rotated_log = []
    for e in snap.get('log', []):
        re = dict(e)
        re['player'] = remap(e['player'])
        if 'trick_winner' in re:
            re['trick_winner'] = remap(e['trick_winner'])
        rotated_log.append(re)
    s['log'] = rotated_log

    # Player names rotated
    if 'player_names' in snap:
        s['player_names'] = _rotate(snap['player_names'], rot)

    s['human_hands'] = {}
    s['is_spectator'] = False
    return s


# ─── Shared room/spectator helpers ────────────────────────────────────────────
def _room_names(room):
    cfg = getattr(room, "seat_config", {})
    return [
        room.players[seat].name if seat in room.players
        else cfg.get(seat, cfg.get(str(seat), {})).get("name", f"Bot {seat}")
        for seat in range(4)
    ]


def _spectator_snapshot(snap, room, names=None):
    """Return public match state only; never expose any player's private hand."""
    # Use an allow-list rather than copying the full snapshot and deleting known
    # hand fields. This prevents future snapshot fields from accidentally
    # exposing private cards to spectators. Played cards in current_trick/log and
    # captured card lists are public and remain visible.
    public_fields = (
        "phase", "trump_suit", "led_suit", "current_trick",
        "current_leader", "tricks_played", "whose_turn",
        "hand_counts", "captured_counts", "captured_a", "captured_b",
        "log", "is_coop", "score", "conceded",
    )
    public = {key: snap[key] for key in public_fields if key in snap}
    public["your_hand"] = []
    public["human_hand"] = []
    public["human_hands"] = {}
    public["your_seat"] = 0  # spectators watch from the host's fixed table view
    public["is_spectator"] = True
    public["room_id"] = room.room_id
    public["player_names"] = list(names or _room_names(room))
    return public


def _emit_room_game_update(room, snap, event_name="game_state", names=None):
    """Send rotated private snapshots to players and a hand-free view to spectators."""
    game = room.game
    names = list(names or _room_names(room))
    for seat, player in list(room.players.items()):
        if not player.is_human:
            continue
        rotated = _rotated_snap(snap, seat, game)
        rotated["player_names"] = _rotate(names, seat)
        rotated["room_id"] = room.room_id
        rotated["your_seat"] = seat
        rotated["is_spectator"] = False
        socketio.emit(event_name, rotated, room=player.sid)

    public = _spectator_snapshot(snap, room, names)
    for sid in list(getattr(room, "spectators", set())):
        socketio.emit(event_name, public, room=sid)


def _room_lobby_payload(room):
    cfg = getattr(room, "seat_config", {})
    spectator_names = getattr(room, "spectator_names", {})
    spectators = [
        {"name": spectator_names.get(sid, "Spectator")}
        for sid in list(getattr(room, "spectators", set()))
    ]
    return {
        "room_id": room.room_id,
        "seat_config": cfg,
        "spectators": spectators,
        "game_started": room.game is not None,
    }


def _broadcast_room_lobby(room):
    socketio.emit("room_lobby_update", _room_lobby_payload(room), room=room.room_id)


# ─── Static / index ───────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")

@app.route("/join/<room_id>")
def join_link(room_id):
    """Shareable invite link — just serve index.html, JS handles the code."""
    return send_from_directory(FRONTEND_DIR, "index.html")


# ─── Solo REST API ────────────────────────────────────────────────────────────

@app.route("/api/new", methods=["POST"])
def new_game():
    global _session, _concede_pending
    body       = request.get_json(silent=True) or {}
    difficulty = body.get("difficulty", "medium")
    _session   = GameController(difficulty=difficulty, human_indices=[0])
    _concede_pending = None
    _session._run_ai_turns()
    snap = _session.snapshot()
    snap['player_names'] = ['You', 'P1', 'P2', 'P3']
    return jsonify(snap)


@app.route("/api/state", methods=["GET"])
def get_state():
    if not _session:
        return jsonify({"error": "no game — POST /api/new first"}), 400
    snap = _session.snapshot()
    if _session.state.phase == "done":
        snap["score"] = _session.score()
    return jsonify(snap)


@app.route("/api/play", methods=["POST"])
def play_card():
    if not _session:
        return jsonify({"error": "no game"}), 400
    body   = request.get_json(silent=True) or {}
    card   = body.get("card", "")
    player = body.get("player", 0)
    snap   = _session.human_plays(card, player)
    if _session.state.phase == "done" and "score" not in snap:
        snap["score"] = _session.score()
    return jsonify(snap)


@app.route("/api/hint", methods=["GET"])
def hint():
    if not _session:
        return jsonify({"error": "no game"}), 400
    player = request.args.get("player", 0, type=int)
    return jsonify({"hint": _session.ai_hint(player)})


# ─── Solo concede ─────────────────────────────────────────────────────────────

@app.route("/api/concede", methods=["POST"])
def concede():
    global _session
    if not _session or _session.state.phase == "done":
        return jsonify({"error": "no active game"}), 400
    tens_a = sum(1 for pid in [0,2] for c in _session.state.captured[pid] if c.is_ten)
    tens_b = sum(1 for pid in [1,3] for c in _session.state.captured[pid] if c.is_ten)
    if tens_a >= tens_b:
        return jsonify({"error": "can only give up when losing on tens"}), 400
    _session.state.phase = "done"
    snap = _session.snapshot()
    snap["score"]    = _session.score()
    snap["conceded"] = True
    return jsonify(snap)


# ─── Coop REST ────────────────────────────────────────────────────────────────

@app.route("/api/new-coop", methods=["POST"])
def new_coop():
    global _session, _concede_pending
    body         = request.get_json(silent=True) or {}
    difficulty   = body.get("difficulty", "medium")
    human_seats  = body.get("human_seats", [0, 2])
    # Ensure seat 0 is always human
    if 0 not in human_seats:
        human_seats = [0] + list(human_seats)
    _session   = GameController(difficulty=difficulty, human_indices=human_seats, is_coop=True)
    _concede_pending = None
    _session._run_ai_turns()
    snap = _session.snapshot()
    # Build player names based on who is human
    names = []
    for i in range(4):
        if i == 0: names.append('You')
        elif i in human_seats: names.append(f'P{i} (Human)')
        else: names.append(f'P{i}')
    snap['player_names'] = names
    return jsonify(snap)


@app.route("/api/play-coop", methods=["POST"])
def play_coop():
    if not _session or not _session.is_coop:
        return jsonify({"error": "no coop game"}), 400
    body   = request.get_json(silent=True) or {}
    card   = body.get("card", "")
    player = body.get("player", 0)
    snap   = _session.human_plays(card, player)
    if _session.state.phase == "done" and "score" not in snap:
        snap["score"] = _session.score()
    return jsonify(snap)


# ─── Socket.IO — connection ───────────────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    print(f"[Socket] Connected: {request.sid}")
    # Auto-join from invite link: ?room=XXXXXX in the query string
    room_code = request.args.get("room")
    if room_code:
        emit("invite_room", {"room_id": room_code.upper()})


@socketio.on("disconnect")
def on_disconnect():
    room = room_manager.get_room_by_sid(request.sid)
    if not room:
        return

    room_id = room.room_id
    seat = next((s for s, player in room.players.items() if player.sid == request.sid), None)

    # A host leaving an unstarted room closes the room for seated players and spectators.
    if seat == 0 and room.game is None:
        socketio.emit("room_closed", {"message": "The room host closed the room"}, room=room_id)
        for player in list(room.players.values()):
            room_manager.sid_to_room.pop(player.sid, None)
        for sid in list(getattr(room, "spectators", set())):
            room_manager.sid_to_room.pop(sid, None)
        getattr(room, "spectators", set()).clear()
        getattr(room, "spectator_names", {}).clear()
        room_manager.sid_to_room.pop(request.sid, None)
        room_manager.rooms.pop(room_id, None)
        print(f"[Room] {room_id} closed because its host disconnected")
        return

    if seat is None:
        name = getattr(room, "spectator_names", {}).pop(request.sid, "Spectator")
        getattr(room, "spectators", set()).discard(request.sid)
        room_manager.sid_to_room.pop(request.sid, None)
        if room_id in room_manager.rooms:
            _broadcast_room_lobby(room)
            socketio.emit("spectator_left", {"name": name}, room=room_id)
        print(f"[Socket] spectator {request.sid} left room {room_id}")
        return

    name = room.players[seat].name
    room.players.pop(seat, None)
    room_manager.sid_to_room.pop(request.sid, None)

    if room.game is None:
        cfg = getattr(room, "seat_config", {})
        previous = cfg.get(seat, cfg.get(str(seat), {}))
        cfg[seat] = {
            "type": "open", "name": "Waiting…", "ready": False,
            "difficulty": previous.get("difficulty", "medium"),
        }
        room.seat_config = cfg

    if room_id in room_manager.rooms:
        _broadcast_room_lobby(room)
        socketio.emit("player_left", {
            "seat": seat, "name": name,
            "seat_config": getattr(room, "seat_config", {}),
        }, room=room_id)
    print(f"[Socket] {request.sid} left room {room_id} (seat {seat})")



@socketio.on("create_room")
def on_create_room(data):
    name = (data.get("name", "Host") or "Host")[:20]
    mode = data.get("mode", "multiplayer")
    difficulty = data.get("difficulty", "medium")
    if difficulty not in ("easy", "medium", "hard"):
        difficulty = "medium"

    # Keep the existing six-character room-code generation.
    for _ in range(20):
        code = _gen_code()
        if code not in room_manager.rooms:
            break
    else:
        emit("join_failed", {"error": "Could not generate a room code. Try again."})
        return

    room = room_manager.create_room(mode, difficulty, request.sid, name)
    # Replace the manager's UUID with the existing short invite code.
    del room_manager.rooms[room.room_id]
    room.room_id = code
    room_manager.rooms[code] = room
    room_manager.sid_to_room[request.sid] = code
    join_room(code)

    seat_config = {
        0: {"type": "human", "name": name, "ready": True},
        1: {"type": "open", "name": "Waiting…", "ready": False, "difficulty": "medium"},
        2: {"type": "open", "name": "Waiting…", "ready": False, "difficulty": "medium"},
        3: {"type": "open", "name": "Waiting…", "ready": False, "difficulty": "medium"},
    }
    room.seat_config = seat_config
    room.spectator_names = {}

    # Preserve the current LAN invite-link behavior.
    try:
        import socket as _sock
        s2 = _sock.socket(_sock.AF_INET, _sock.SOCK_DGRAM)
        s2.connect(("8.8.8.8", 80))
        local_ip = s2.getsockname()[0]
        s2.close()
    except Exception:
        local_ip = "localhost"

    invite_url = f"http://{local_ip}:5000/join/{code}"
    emit("room_created", {
        "room_id": code,
        "mode": mode,
        "difficulty": difficulty,
        "seat": 0,
        "seat_config": seat_config,
        "invite_url": invite_url,
    })
    print(f"[Room] {code} created by {name}")




@socketio.on("enter_room")
def on_enter_room(data):
    """Enter the private room as a spectator; seating is an optional later action."""
    room_id = (data.get("room_id", "") or "").strip().upper()
    name = (data.get("name", "Spectator") or "Spectator")[:20]
    room = room_manager.rooms.get(room_id)
    if not room:
        emit("join_failed", {"error": f"Room {room_id} not found"})
        return

    mapped_room = room_manager.sid_to_room.get(request.sid)
    if mapped_room and mapped_room != room_id:
        emit("join_failed", {"error": "Leave your current room before joining another"})
        return

    seated_at = next((seat for seat, player in room.players.items() if player.sid == request.sid), None)
    is_host = seated_at == 0
    is_spectator = seated_at is None
    if is_spectator:
        room.spectators.add(request.sid)
        if not hasattr(room, "spectator_names"):
            room.spectator_names = {}
        room.spectator_names[request.sid] = name
        room_manager.sid_to_room[request.sid] = room_id
    else:
        name = room.players[seated_at].name
    join_room(room_id)

    payload = _room_lobby_payload(room)
    payload.update({
        "seat": seated_at,
        "is_host": is_host,
        "is_spectator": is_spectator,
        "name": name,
        "invite_url": f"{request.host_url.rstrip('/')}/join/{room_id}",
    })
    emit("room_entered", payload)
    _broadcast_room_lobby(room)
    print(f"[Room] {name} entered {room_id} as {'spectator' if is_spectator else f'seat {seated_at}'}")

    # A late spectator can enter a game already in progress and receive a public view.
    if room.game is not None and is_spectator:
        snap = room.game.snapshot()
        event_name = "game_state"
        if room.game.state.phase == "done":
            snap["score"] = room.game.score()
            event_name = "game_over"
        socketio.emit(event_name, _spectator_snapshot(snap, room), room=request.sid)


@socketio.on("claim_seat")
def on_claim_seat(data):
    """Atomically convert a spectator into a seated human before game start."""
    room = room_manager.get_room_by_sid(request.sid)
    if not room or request.sid not in getattr(room, "spectators", set()):
        emit("seat_claim_failed", {"error": "You are not waiting in this room as a spectator"})
        return
    if room.game is not None:
        emit("seat_claim_failed", {"error": "The game has already started; you can keep watching"})
        return
    try:
        seat = int(data.get("seat"))
    except (TypeError, ValueError):
        emit("seat_claim_failed", {"error": "Choose a valid seat"})
        return
    if seat not in (1, 2, 3):
        emit("seat_claim_failed", {"error": "Choose one of the three guest seats"})
        return

    cfg = getattr(room, "seat_config", {})
    seat_cfg = cfg.get(seat, cfg.get(str(seat), {}))
    if seat in room.players or seat_cfg.get("type") != "open":
        emit("seat_claim_failed", {"error": f"Seat {seat} is no longer available"})
        return

    from room_manager import Player
    name = getattr(room, "spectator_names", {}).pop(request.sid, "Player")
    room.spectators.discard(request.sid)
    room.players[seat] = Player(sid=request.sid, seat=seat, name=name, is_human=True, ready=True)
    cfg[seat] = {"type": "human", "name": name, "ready": True}
    room.seat_config = cfg

    emit("seat_claimed", {"seat": seat, "seat_config": cfg})
    _broadcast_room_lobby(room)
    socketio.emit("player_joined", {"seat": seat, "name": name, "seat_config": cfg},
                  room=room.room_id, include_self=False)
    print(f"[Room] {name} claimed seat {seat} in {room.room_id}")


@socketio.on("request_room_seats")
def on_request_room_seats(data):
    """Return the current room seat map before a guest chooses their seat."""
    room_id = (data.get("room_id", "") or "").strip().upper()
    room = room_manager.rooms.get(room_id)
    if not room:
        emit("room_seats_failed", {"error": f"Room {room_id} not found"})
        return
    if room.game is not None:
        emit("room_seats_failed", {"error": "This game has already started"})
        return

    current_seat = next((s for s, player in room.players.items() if player.sid == request.sid), None)
    cfg = getattr(room, "seat_config", {})
    available = [
        seat for seat in (1, 2, 3)
        if cfg.get(seat, cfg.get(str(seat), {})).get("type") == "open"
        and seat not in room.players
    ]
    # A guest changing seats may keep their existing seat or choose another open one.
    if current_seat in (1, 2, 3):
        available.append(current_seat)

    emit("room_seats", {
        "room_id": room.room_id,
        "seat_config": cfg,
        "available_seats": sorted(set(available)),
        "current_seat": current_seat,
    })


@socketio.on("join_room")
def on_join_room(data):
    room_id = (data.get("room_id", "") or "").strip().upper()
    name = (data.get("name", "Player") or "Player")[:20]
    room = room_manager.rooms.get(room_id)

    if not room:
        emit("join_failed", {"error": f"Room {room_id} not found"})
        return
    if room.game is not None:
        emit("join_failed", {"error": "This game has already started"})
        return
    if room_manager.get_room_by_sid(request.sid):
        emit("join_failed", {"error": "You are already connected to a room"})
        return

    try:
        seat = int(data.get("seat"))
    except (TypeError, ValueError):
        emit("join_failed", {"error": "Choose an available seat first"})
        return
    if seat not in (1, 2, 3):
        emit("join_failed", {"error": "Choose one of the available guest seats"})
        return

    cfg = getattr(room, "seat_config", {})
    seat_cfg = cfg.get(seat, cfg.get(str(seat), {}))
    if seat in room.players or seat_cfg.get("type") != "open":
        emit("join_failed", {"error": f"Seat {seat} is no longer available. Please choose another seat."})
        return

    from room_manager import Player
    player = Player(sid=request.sid, seat=seat, name=name, is_human=True, ready=True)
    room.players[seat] = player
    room_manager.sid_to_room[request.sid] = room_id
    cfg[seat] = {"type": "human", "name": name, "ready": True}
    room.seat_config = cfg
    join_room(room_id)

    try:
        import socket as _sock
        s2 = _sock.socket(_sock.AF_INET, _sock.SOCK_DGRAM)
        s2.connect(("8.8.8.8", 80))
        local_ip = s2.getsockname()[0]
        s2.close()
    except Exception:
        local_ip = "localhost"

    invite_url = f"http://{local_ip}:5000/join/{room_id}"
    emit("room_joined", {
        "room_id": room_id,
        "seat": seat,
        "mode": room.mode,
        "difficulty": room.difficulty,
        "seat_config": cfg,
        "invite_url": invite_url,
    })
    socketio.emit("player_joined", {
        "seat": seat,
        "name": name,
        "seat_config": cfg,
    }, room=room_id, include_self=False)
    print(f"[Room] {name} joined {room_id} as seat {seat}")


@socketio.on("change_seat")
def on_change_seat(data):
    """Allow a joined guest to move to any currently open seat before play starts."""
    room = room_manager.get_room_by_sid(request.sid)
    if not room or room.game is not None:
        emit("seat_change_failed", {"error": "Seats can only be changed before the game starts"})
        return

    current_seat = next((s for s, player in room.players.items() if player.sid == request.sid), None)
    if current_seat is None:
        emit("seat_change_failed", {"error": "You are not seated in this room"})
        return
    if current_seat == 0:
        emit("seat_change_failed", {"error": "The host keeps the host seat"})
        return

    try:
        new_seat = int(data.get("seat"))
    except (TypeError, ValueError):
        emit("seat_change_failed", {"error": "Choose a valid seat"})
        return
    if new_seat not in (1, 2, 3):
        emit("seat_change_failed", {"error": "Choose one of the guest seats"})
        return
    if new_seat == current_seat:
        emit("seat_changed", {"seat": current_seat, "seat_config": getattr(room, "seat_config", {})})
        return

    cfg = getattr(room, "seat_config", {})
    target_cfg = cfg.get(new_seat, cfg.get(str(new_seat), {}))
    if new_seat in room.players or target_cfg.get("type") != "open":
        emit("seat_change_failed", {"error": f"Seat {new_seat} is occupied or reserved. Choose another seat."})
        return

    player = room.players.pop(current_seat)
    player.seat = new_seat
    room.players[new_seat] = player
    previous = cfg.get(current_seat, cfg.get(str(current_seat), {}))
    cfg[current_seat] = {
        "type": "open", "name": "Waiting…", "ready": False,
        "difficulty": previous.get("difficulty", "medium")
    }
    cfg[new_seat] = {"type": "human", "name": player.name, "ready": True}
    room.seat_config = cfg

    emit("seat_changed", {"seat": new_seat, "seat_config": cfg})
    _broadcast_room_lobby(room)
    socketio.emit("seat_config_updated", {"seat_config": cfg}, room=room.room_id)
    print(f"[Room] {player.name} moved from seat {current_seat} to seat {new_seat} in {room.room_id}")




@socketio.on("set_seat_type")
def on_set_seat_type(data):
    """Host configures an empty seat as Bot or Open, including bot difficulty."""
    room = room_manager.get_room_by_sid(request.sid)
    if not room or room.game is not None:
        return

    host = room.players.get(0)
    if not host or host.sid != request.sid:
        return

    try:
        seat = int(data.get("seat"))
    except (TypeError, ValueError):
        return
    if seat not in (1, 2, 3):
        return

    # A joined human owns the seat and cannot be overwritten by host controls.
    if seat in room.players:
        return

    seat_type = data.get("type", "open")
    if seat_type not in ("bot", "open"):
        return

    cfg = getattr(room, "seat_config", {})
    previous = cfg.get(seat, {})
    difficulty = data.get("difficulty", previous.get("difficulty", "medium"))
    if difficulty not in ("easy", "medium", "hard"):
        difficulty = "medium"

    if seat_type == "bot":
        cfg[seat] = {
            "type": "bot",
            "name": f"Bot {seat}",
            "ready": True,
            "difficulty": difficulty,
        }
    else:
        cfg[seat] = {
            "type": "open",
            "name": "Waiting…",
            "ready": False,
            "difficulty": difficulty,
        }

    room.seat_config = cfg
    _broadcast_room_lobby(room)
    socketio.emit("seat_config_updated", {"seat_config": cfg}, room=room.room_id)


def _all_ready(room) -> bool:
    """Every non-host seat must be either a Bot or a connected human."""
    cfg = getattr(room, "seat_config", {})
    host = room.players.get(0)
    if not host or cfg.get(0, {}).get("type") != "human":
        return False

    for seat in range(1, 4):
        seat_cfg = cfg.get(seat, {})
        if seat_cfg.get("type") == "bot":
            continue
        if seat_cfg.get("type") == "human" and seat in room.players:
            continue
        return False
    return True


@socketio.on("start_game")
def on_start_game():
    room = room_manager.get_room_by_sid(request.sid)
    if not room or room.game is not None:
        return

    host = room.players.get(0)
    if not host or host.sid != request.sid:
        emit("room_start_failed", {"error": "Only the host can start the game"})
        return
    if not _all_ready(room):
        emit("room_start_failed", {"error": "Every seat must be a Bot or have a player joined"})
        return

    _start_room_game(room.room_id)


def _start_room_game(room_id: str):
    room = room_manager.rooms.get(room_id)
    if not room or room.game is not None or not _all_ready(room):
        return

    cfg = getattr(room, "seat_config", {})
    human_indices = [s for s in range(4)
                     if cfg.get(s, {}).get("type") == "human" and s in room.players]
    if 0 not in human_indices:
        return

    is_coop = len(human_indices) == 2 and set(human_indices) == {0, 2}
    game = GameController(
        difficulty=room.difficulty,
        human_indices=human_indices,
        is_coop=is_coop,
    )

    # GameController accepts one default difficulty; replace each room bot with
    # the difficulty selected for that specific seat and initialize card memory.
    for seat in range(4):
        if seat in human_indices:
            continue
        seat_cfg = cfg.get(seat, {})
        bot_difficulty = seat_cfg.get("difficulty", room.difficulty)
        if bot_difficulty not in ("easy", "medium", "hard"):
            bot_difficulty = "medium"
        bot = make_bot(seat, bot_difficulty)
        if isinstance(bot, HardBot):
            bot.record_initial_hand(game.state.hands[seat])
        game.bots[seat] = bot

    room.game = game

    names = []
    for seat in range(4):
        if seat in room.players:
            names.append(room.players[seat].name)
        else:
            names.append(cfg.get(seat, {}).get("name", f"Bot {seat}"))

    snap = game.snapshot()
    snap["player_names"] = names
    _emit_room_game_update(room, snap, "game_state", names)

    if game.turn_order and game.turn_order[0] not in game.human_indices:
        _run_ai(room_id)

    print(f"[Game] Started in room {room_id}, humans={human_indices}")





def _run_ai(room_id: str):
    room = room_manager.rooms.get(room_id)
    if not room or not room.game: return

    game  = room.game
    cfg   = getattr(room, 'seat_config', {})
    names = [
        room.players[s].name if s in room.players else cfg.get(s, {}).get('name', f'Bot {s}')
        for s in range(4)
    ]

    while (game.state.phase != "done"
           and game.turn_order
           and game.turn_order[0] not in game.human_indices):
        pid    = game.turn_order[0]
        bot    = game.bots[pid]
        card   = bot.pick_card(game.state)
        result = game._do_play(pid, card)
        game._advance_turn(result)

    snap = game.snapshot()
    snap['player_names'] = names

    if game.state.phase == "done":
        snap['score'] = game.score()

    evt = "game_over" if game.state.phase == "done" else "game_state"
    _emit_room_game_update(room, snap, evt, names)


@socketio.on("play_card")
def on_play_card(data):
    room = room_manager.get_room_by_sid(request.sid)
    if not room or not room.game:
        emit("play_failed", {"error": "no active game"})
        return

    game      = room.game
    card_str  = data.get("card", "")
    cfg       = getattr(room, 'seat_config', {})
    names     = [
        room.players[s].name if s in room.players else cfg.get(s, {}).get('name', f'Bot {s}')
        for s in range(4)
    ]

    # Find this player's absolute seat
    abs_seat = next((s for s, p in room.players.items() if p.sid == request.sid), None)
    if abs_seat is None or abs_seat not in game.human_indices:
        emit("play_failed", {"error": "not your seat"})
        return

    snap = game.human_plays(card_str, abs_seat)
    if "error" in snap:
        emit("play_failed", snap)
        return

    snap['player_names'] = names
    if game.state.phase == "done" and "score" not in snap:
        snap["score"] = game.score()

    # Fan out private player views and a public, hand-free spectator view.
    evt = "game_over" if game.state.phase == "done" else "game_state"
    _emit_room_game_update(room, snap, evt, names)

    if game.state.phase != "done":
        _run_ai(room.room_id)


@socketio.on("hint")
def on_hint():
    room = room_manager.get_room_by_sid(request.sid)
    if not room or not room.game: return
    abs_seat = next((s for s, p in room.players.items() if p.sid == request.sid), None)
    if abs_seat is not None:
        emit("hint", {"card": room.game.ai_hint(abs_seat)})


# ─── Socket.IO — social: emotes + chat ───────────────────────────────────────

ALLOWED_CHAT = {
    "Good move!", "Lucky!", "Watch out!", "My tens!",
    "Nice try!", "Let's go!", "Well played!",
    "That was close!", "Focus!", "GG!"
}

ALLOWED_EMOTES = {"😤", "🎉", "😱", "🔥", "👑", "😂"}

@socketio.on("emote")
def on_emote(data):
    room = room_manager.get_room_by_sid(request.sid)
    if not room: return
    emote = data.get("emote", "")
    if emote not in ALLOWED_EMOTES: return
    abs_seat = next((s for s, p in room.players.items() if p.sid == request.sid), None)
    if abs_seat is None: return
    socketio.emit("emote", {"seat": abs_seat, "emote": emote}, room=room.room_id)


@socketio.on("chat")
def on_chat(data):
    room = room_manager.get_room_by_sid(request.sid)
    if not room: return
    msg = data.get("msg", "")
    if msg not in ALLOWED_CHAT: return
    abs_seat = next((s for s, p in room.players.items() if p.sid == request.sid), None)
    if abs_seat is None: return
    cfg   = getattr(room, 'seat_config', {})
    name  = room.players[abs_seat].name if abs_seat in room.players else f"P{abs_seat}"
    socketio.emit("chat", {"seat": abs_seat, "name": name, "msg": msg}, room=room.room_id)


# ─── Socket.IO — concede (multiplayer mutual) ─────────────────────────────────

_room_concede = {}   # room_id -> {"requester": abs_seat}

@socketio.on("concede_request")
def on_concede_request():
    room = room_manager.get_room_by_sid(request.sid)
    if not room or not room.game or room.game.state.phase == "done": return
    abs_seat = next((s for s, p in room.players.items() if p.sid == request.sid), None)
    if abs_seat is None: return

    # Only losing team can request
    game   = room.game
    tens_a = sum(1 for pid in [0,2] for c in game.state.captured[pid] if c.is_ten)
    tens_b = sum(1 for pid in [1,3] for c in game.state.captured[pid] if c.is_ten)
    my_team_losing = (TEAM_OF_SEAT(abs_seat) == "A" and tens_b > tens_a) or \
                     (TEAM_OF_SEAT(abs_seat) == "B" and tens_a > tens_b)
    if not my_team_losing:
        emit("concede_error", {"error": "Only the losing team can give up"})
        return

    if room.room_id in _room_concede:
        emit("concede_error", {"error": "A concede request is already pending"})
        return

    _room_concede[room.room_id] = {"requester": abs_seat}
    socketio.emit("concede_requested", {"requester": abs_seat}, room=room.room_id)


@socketio.on("concede_confirm")
def on_concede_confirm(data):
    room = room_manager.get_room_by_sid(request.sid)
    if not room or not room.game: return
    pending = _room_concede.get(room.room_id)
    if not pending: return

    abs_seat  = next((s for s, p in room.players.items() if p.sid == request.sid), None)
    confirmed = data.get("confirm", False)

    _room_concede.pop(room.room_id, None)

    if not confirmed:
        socketio.emit("concede_cancelled", {"by": abs_seat}, room=room.room_id)
        return

    game = room.game
    game.state.phase = "done"
    snap = game.snapshot()
    snap["score"]    = game.score()
    snap["conceded"] = True

    cfg   = getattr(room, 'seat_config', {})
    names = [
        room.players[s].name if s in room.players else cfg.get(s, {}).get('name', f'Bot {s}')
        for s in range(4)
    ]
    snap['player_names'] = names

    _emit_room_game_update(room, snap, "game_over", names)


def TEAM_OF_SEAT(seat):
    return "A" if seat in (0, 2) else "B"


# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))

    print("=" * 55)
    print("Indawlchuh Game Server")
    print(f"Server running on port: {port}")
    print("=" * 55)

    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        debug=False
    )