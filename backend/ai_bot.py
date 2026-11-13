# lang: Python 3.11+, file: backend/ai_bot.py
# Dehla Pakad — AI opponent: Easy / Medium / Hard

from __future__ import annotations
import random
from typing import Optional, List
from game_engine import Card, Suit, Rank, GameState, Team, TEAM_OF


class Bot:
    """Base interface — subclass and override pick_card."""

    def __init__(self, player_index: int):
        self.player_index = player_index

    def pick_card(self, state: GameState) -> Card:
        raise NotImplementedError


# ─── Easy — legal random ───────────────────────────────────────────────────────

class EasyBot(Bot):
    def pick_card(self, state: GameState) -> Card:
        return random.choice(state.legal_cards(self.player_index))


# ─── Medium — state-aware heuristic ───────────────────────────────────────────

class MediumBot(Bot):
    def pick_card(self, state: GameState) -> Card:
        legal  = state.legal_cards(self.player_index)
        pid    = self.player_index
        trick  = state.current_trick

        partner_idx    = (pid + 2) % 4
        partner_card   = trick[partner_idx]
        current_winner = self._trick_winner(state)

        # partner is currently winning — play the lowest card to conserve
        if current_winner is not None and TEAM_OF[current_winner] == TEAM_OF[pid]:
            return self._lowest(legal)

        # try to win — highest of led suit, or lowest trump if void
        led_suit_cards = [c for c in legal if c.suit == state.led_suit] if state.led_suit else []
        if led_suit_cards:
            best = max(led_suit_cards, key=lambda c: c.rank.value)
            # only play if it actually beats the current winner
            if current_winner is None or self._card_beats(best, trick[current_winner], state):
                return best
            return self._lowest(legal)   # can't win — throw off low

        # void in led suit — play a trump if one exists and we can win
        if state.trump_suit:
            trumps = [c for c in legal if c.suit == state.trump_suit]
            if trumps:
                return max(trumps, key=lambda c: c.rank.value)

        # nothing clever — throw off lowest non-ten
        non_tens = [c for c in legal if not c.is_ten]
        return self._lowest(non_tens) if non_tens else self._lowest(legal)

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _lowest(self, cards: list[Card]) -> Card:
        return min(cards, key=lambda c: c.rank.value)

    def _trick_winner(self, state: GameState) -> Optional[int]:
        played = [(i, c) for i, c in enumerate(state.current_trick) if c is not None]
        if not played:
            return None
        winner_i, winner_c = played[0]
        for i, c in played[1:]:
            if self._card_beats(c, winner_c, state):
                winner_i, winner_c = i, c
        return winner_i

    def _card_beats(self, challenger: Card, current: Card, state: GameState) -> bool:
        chal_trump = state.trump_suit and challenger.suit == state.trump_suit
        curr_trump = state.trump_suit and current.suit   == state.trump_suit
        if chal_trump and not curr_trump: return True
        if not chal_trump and curr_trump: return False
        if challenger.suit != current.suit: return False
        return challenger.rank > current.rank


# ─── Hard — probabilistic card counting (only observes visible cards) ────────

class HardBot(MediumBot):
    """
    Tracks only cards the bot could actually see:
    - Its own hand (known at deal)
    - Cards played in tricks where it participated
    - Current trick cards played before its turn
    """

    def __init__(self, player_index: int):
        super().__init__(player_index)
        self.seen_cards: set[Card] = set()
        self._initial_hand_recorded = False

    def observe_trick(self, trick_cards: List[Optional[Card]], my_seat: int):
        """
        Call once per completed trick. Only learn cards visible to this bot.
        Visibility rules:
        - Bot sees all 4 cards of any trick it participated in (played a card)
        - Bot sees cards played BEFORE it in the current trick
        
        FIX (Bug #7): participation check was incorrectly using the card list
        as a filter. Now correctly checks if bot's own slot was filled.
        """
        pid = self.player_index
        # FIXED: simply check whether this bot's slot was played in this trick
        participated = trick_cards[pid] is not None

        if participated:
            # Saw the whole trick
            for c in trick_cards:
                if c:
                    self.seen_cards.add(c)
        else:
            # Only saw cards played before bot's turn in this trick
            for i, c in enumerate(trick_cards):
                if c and i < pid:
                    self.seen_cards.add(c)

    def observe_current_trick_partial(self, trick_so_far: List[Optional[Card]]):
        """Call during trick play for cards played before bot's turn."""
        pid = self.player_index
        for i, c in enumerate(trick_so_far):
            if c and i < pid:
                self.seen_cards.add(c)

    def record_initial_hand(self, hand: List[Card]):
        """Call once at game start with bot's own hand."""
        if not self._initial_hand_recorded:
            self.seen_cards.update(hand)
            self._initial_hand_recorded = True

    def pick_card(self, state: GameState) -> Card:
        legal = state.legal_cards(self.player_index)
        pid   = self.player_index

        # Update seen from current trick (cards played before me)
        self.observe_current_trick_partial(state.current_trick)

        current_winner = self._trick_winner(state)
        my_team        = TEAM_OF[pid]

        # count how many 10s are still alive (from bot's knowledge)
        all_tens       = [Card(s, Rank.TEN) for s in Suit]
        live_tens      = [t for t in all_tens if t not in self.seen_cards]
        tens_in_trick  = [c for c in state.current_trick if c and c.is_ten]

        # if a 10 is in the trick and opponent is winning — go for it
        if tens_in_trick and current_winner is not None and TEAM_OF[current_winner] != my_team:
            winning_play = self._best_winner(legal, state)
            if winning_play:
                return winning_play

        # partner winning — dump lowest
        if current_winner is not None and TEAM_OF[current_winner] == my_team:
            return self._lowest(legal)

        # standard medium logic as fallback
        return super().pick_card(state)

    def _best_winner(self, legal: list[Card], state: GameState) -> Optional[Card]:
        """Return the lowest card that beats the current trick winner, or None."""
        current_winner = self._trick_winner(state)
        if current_winner is None:
            return None
        winning_card = state.current_trick[current_winner]
        candidates   = [c for c in legal if self._card_beats(c, winning_card, state)]
        if not candidates:
            return None
        return min(candidates, key=lambda c: c.rank.value)   # cheapest winner


# ─── Factory ──────────────────────────────────────────────────────────────────

def make_bot(player_index: int, difficulty: str = "medium") -> Bot:
    return {
        "easy":   EasyBot,
        "medium": MediumBot,
        "hard":   HardBot,
    }[difficulty](player_index)
