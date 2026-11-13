# lang: Python 3.11+, file: backend/room_manager.py
# Room management for multiplayer/coop — WebSocket-ready

from __future__ import annotations
import uuid
from typing import Dict, Optional, List, Set
from dataclasses import dataclass, field
from game_controller import GameController


@dataclass
class Player:
    sid: str
    seat: int          # 0-3
    name: str = "Player"
    is_human: bool = True
    ready: bool = False


@dataclass
class Room:
    room_id: str
    mode: str          # "vs_ai" | "coop" | "multiplayer"
    difficulty: str = "medium"
    players: Dict[int, Player] = field(default_factory=dict)  # seat -> Player
    game: Optional[GameController] = None
    spectators: Set[str] = field(default_factory=set)  # sids
    created_at: float = 0.0

    def is_full(self) -> bool:
        if self.mode == "vs_ai":
            return len(self.players) >= 1  # only seat 0 human
        return len(self.players) >= 4

    def get_human_seats(self) -> List[int]:
        return [seat for seat, p in self.players.items() if p.is_human]

    def start_game(self) -> GameController:
        human_seats = self.get_human_seats()
        is_coop = self.mode == "coop"
        self.game = GameController(
            difficulty=self.difficulty,
            human_indices=human_seats,
            is_coop=is_coop
        )
        return self.game


class RoomManager:
    def __init__(self):
        self.rooms: Dict[str, Room] = {}
        self.sid_to_room: Dict[str, str] = {}

    def create_room(self, mode: str, difficulty: str = "medium", creator_sid: str = "", creator_name: str = "Host") -> Room:
        room_id = str(uuid.uuid4())[:8]
        room = Room(room_id=room_id, mode=mode, difficulty=difficulty)

        # Assign creator to seat 0
        player = Player(sid=creator_sid, seat=0, name=creator_name, is_human=True, ready=True)
        room.players[0] = player
        self.sid_to_room[creator_sid] = room_id
        self.rooms[room_id] = room
        return room

    def join_room(self, room_id: str, sid: str, name: str = "Player") -> Optional[Room]:
        room = self.rooms.get(room_id)
        if not room or room.is_full():
            return None

        # Find first available seat
        for seat in range(4):
            if seat not in room.players:
                player = Player(sid=sid, seat=seat, name=name, is_human=True)
                room.players[seat] = player
                self.sid_to_room[sid] = room_id
                return room
        return None

    def leave_room(self, sid: str) -> Optional[str]:
        room_id = self.sid_to_room.pop(sid, None)
        if room_id and room_id in self.rooms:
            room = self.rooms[room_id]
            # Find and remove player
            for seat, player in list(room.players.items()):
                if player.sid == sid:
                    del room.players[seat]
                    break
            # Clean up empty rooms
            if not room.players:
                del self.rooms[room_id]
        return room_id

    def get_room(self, room_id: str) -> Optional[Room]:
        return self.rooms.get(room_id)

    def get_room_by_sid(self, sid: str) -> Optional[Room]:
        room_id = self.sid_to_room.get(sid)
        return self.rooms.get(room_id) if room_id else None

    def set_player_ready(self, sid: str, ready: bool) -> bool:
        room = self.get_room_by_sid(sid)
        if not room:
            return False
        for player in room.players.values():
            if player.sid == sid:
                player.ready = ready
                return True
        return False

    def all_ready(self, room_id: str) -> bool:
        room = self.rooms.get(room_id)
        if not room:
            return False
        return all(p.ready for p in room.players.values() if p.is_human)
