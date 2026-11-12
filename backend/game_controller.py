# lang: Python 3.11+, file: backend/game_controller.py
# Dehla Pakad — session controller

from __future__ import annotations
import json
from typing import Optional, List, Set
from game_engine import build_deck, deal, GameState, Card, Suit, Rank, Team, TEAM_OF
from ai_bot import make_bot, HardBot


class GameController:
    def __init__(
        self,
        difficulty: str = "medium",
        human_indices: Optional[List[int]] = None,
        is_coop: bool = False
    ):
        self.difficulty    = difficulty
        # Always store human_indices as a list, even if caller passes an int
        if human_indices is None:
            self.human_indices = [0]
        elif isinstance(human_indices, int):
            self.human_indices = [human_indices]
        else:
            self.human_indices = list(human_indices)
        self.is_coop = is_coop

        deck  = build_deck()
        hands = list(deal(deck))
        self.state = GameState(hands=hands)

        self.bots = {}
        for i in range(4):
            if i not in self.human_indices:
                self.bots[i] = make_bot(i, difficulty)
                # Give HardBot its initial hand
                if isinstance(self.bots[i], HardBot):
                    self.bots[i].record_initial_hand(hands[i])

        self.turn_order  = self._next_turn_order()
        self.game_log: list[dict] = []

    # ── Public ────────────────────────────────────────────────────────────────

    def snapshot(self) -> dict:
        # Aggregate captured cards by team
        team_a_cards = []
        team_b_cards = []
        for pid, pile in enumerate(self.state.captured):
            if TEAM_OF[pid] == Team.A:
                team_a_cards.extend(str(c) for c in pile)
            else:
                team_b_cards.extend(str(c) for c in pile)

        # For coop: return both human hands
        human_hands = {}
        for hi in self.human_indices:
            human_hands[hi] = [str(c) for c in self.state.hands[hi]]

        return {
            "phase":            self.state.phase,
            "trump_suit":       self.state.trump_suit.value if self.state.trump_suit else None,
            "led_suit":         self.state.led_suit.value   if self.state.led_suit   else None,
            "current_trick":    [str(c) if c else None for c in self.state.current_trick],
            "current_leader":   self.state.current_leader,
            "tricks_played":    self.state.tricks_played,
            "whose_turn":       self.turn_order[0] if self.turn_order else -1,
            "human_hand":       [str(c) for c in self.state.hands[self.human_indices[0]]],  # legacy seat-0
            "human_hands":      human_hands,  # all human seats (coop-aware)
            "human_indices":    self.human_indices,
            "is_coop":          self.is_coop,
            "hand_counts":      [len(h) for h in self.state.hands],
            "captured_counts":  [len(pile) for pile in self.state.captured],
            "captured_a":       team_a_cards,
            "captured_b":       team_b_cards,
            "log":              self.game_log,
        }

    def human_plays(self, card_str: str, player_index: int = 0) -> dict:
        if self.state.phase == "done":
            return {"error": "game is over", **self.snapshot()}

        whose_turn = self.turn_order[0] if self.turn_order else -1
        if whose_turn != player_index:
            return {"error": f"not your turn (player {player_index})", **self.snapshot()}

        if player_index not in self.human_indices:
            return {"error": "this seat is not human", **self.snapshot()}

        card = self._parse_card(card_str)
        if card is None:
            return {"error": f"unrecognised card: {card_str}", **self.snapshot()}

        legal = self.state.legal_cards(player_index)
        if card not in legal:
            return {"error": f"{card_str} is not a legal play", **self.snapshot()}

        result = self._do_play(player_index, card)
        self._advance_turn(result)
        self._run_ai_turns()

        snap = self.snapshot()
        if self.state.phase == "done":
            snap["score"] = self.state.score()
        return snap

    def ai_hint(self, player_index: int = 0) -> str:
        # FIX (Bug #6): use the game's actual difficulty, not always Medium
        bot = make_bot(player_index, self.difficulty)
        card = bot.pick_card(self.state)
        return str(card)

    def score(self) -> dict:
        return self.state.score()

    # ── Internal ──────────────────────────────────────────────────────────────

    def _run_ai_turns(self):
        while (self.state.phase != "done"
               and self.turn_order
               and self.turn_order[0] not in self.human_indices):
            pid  = self.turn_order[0]
            bot  = self.bots[pid]
            card = bot.pick_card(self.state)
            result = self._do_play(pid, card)
            self._advance_turn(result)

    def _do_play(self, player: int, card: Card) -> Optional[object]:
        result = self.state.play_card(player, card)
        entry  = {"player": player, "card": str(card)}
        if result:
            entry["trick_winner"] = result.winner_index
            if result.trump_declared:
                entry["trump_declared"] = result.trump_declared.value
        self.game_log.append(entry)

        # Notify HardBots of the card played (partial trick visible before bot's turn)
        for bot in self.bots.values():
            if isinstance(bot, HardBot):
                bot.observe_current_trick_partial(self.state.current_trick)

        # If trick completed, notify bots of full trick
        if result:
            for bot in self.bots.values():
                if isinstance(bot, HardBot):
                    bot.observe_trick(result.cards, bot.player_index)

        return result

    def _advance_turn(self, trick_result):
        if trick_result:
            self.turn_order = self._build_turn_order(trick_result.winner_index)
        else:
            self.turn_order.pop(0)

    def _next_turn_order(self) -> list[int]:
        return self._build_turn_order(self.state.current_leader)

    def _build_turn_order(self, leader: int) -> list[int]:
        return [(leader + i) % 4 for i in range(4)]

    def _parse_card(self, s: str) -> Optional[Card]:
        suit_map = {
            "♠": Suit.SPADES, "♥": Suit.HEARTS, "♦": Suit.DIAMONDS, "♣": Suit.CLUBS,
            "S": Suit.SPADES, "H": Suit.HEARTS, "D": Suit.DIAMONDS, "C": Suit.CLUBS,
        }
        rank_map = {r.symbol: r for r in Rank}
        s = s.strip()
        for suit_sym, suit in suit_map.items():
            if suit_sym in s:
                rank_sym = s.replace(suit_sym, "").strip()
                rank     = rank_map.get(rank_sym)
                if rank:
                    return Card(suit, rank)
        return None