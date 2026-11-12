# lang: Python 3.11+, file: backend/test_engine.py
# pytest tests for game_engine.py

import pytest
from game_engine import (
    GameState, Card, Suit, Rank, build_deck, deal, Team, TEAM_OF, TrickResult
)


class TestDeck:
    def test_deck_size(self):
        deck = build_deck()
        assert len(deck) == 52

    def test_deck_unique(self):
        deck = build_deck()
        assert len(set(str(c) for c in deck)) == 52

    def test_deal_distribution(self):
        deck = build_deck()
        h1, h2, h3, h4 = deal(deck)
        assert len(h1) == len(h2) == len(h3) == len(h4) == 13
        all_cards = h1 + h2 + h3 + h4
        assert len(set(str(c) for c in all_cards)) == 52


class TestCardComparison:
    def test_rank_order(self):
        assert Rank.TWO < Rank.THREE < Rank.TEN < Rank.JACK < Rank.QUEEN < Rank.KING < Rank.ACE

    def test_suit_values(self):
        assert Suit.SPADES.value == "♠"
        assert Suit.HEARTS.value == "♥"
        assert Suit.DIAMONDS.value == "♦"
        assert Suit.CLUBS.value == "♣"


class TestTrickResolution:
    def setup_method(self):
        self.hands = [[], [], [], []]
        self.state = GameState(hands=self.hands)

    def test_highest_led_suit_wins(self):
        self.state.trump_suit = Suit.SPADES
        self.state.led_suit = Suit.HEARTS
        self.state.current_leader = 0
        self.state.current_trick = [
            Card(Suit.HEARTS, Rank.KING),   # 0 led
            Card(Suit.HEARTS, Rank.ACE),    # 1 wins
            Card(Suit.HEARTS, Rank.QUEEN),  # 2
            Card(Suit.HEARTS, Rank.JACK),   # 3
        ]
        result = self.state._resolve_trick(None)
        assert result.winner_index == 1
        assert len(self.state.captured[1]) == 4

    def test_trump_beats_led_suit(self):
        self.state.trump_suit = Suit.SPADES
        self.state.led_suit = Suit.HEARTS
        self.state.current_leader = 0
        self.state.current_trick = [
            Card(Suit.HEARTS, Rank.ACE),    # 0 led
            Card(Suit.SPADES, Rank.TWO),    # 1 trump - wins
            Card(Suit.HEARTS, Rank.KING),   # 2
            Card(Suit.HEARTS, Rank.QUEEN),  # 3
        ]
        result = self.state._resolve_trick(None)
        assert result.winner_index == 1

    def test_higher_trump_wins(self):
        self.state.trump_suit = Suit.SPADES
        self.state.led_suit = Suit.HEARTS
        self.state.current_leader = 0
        self.state.current_trick = [
            Card(Suit.HEARTS, Rank.ACE),
            Card(Suit.SPADES, Rank.TWO),    # low trump
            Card(Suit.SPADES, Rank.KING),   # high trump - wins
            Card(Suit.HEARTS, Rank.KING),
        ]
        result = self.state._resolve_trick(None)
        assert result.winner_index == 2

    def test_void_cannot_win_without_trump(self):
        self.state.trump_suit = None
        self.state.led_suit = Suit.HEARTS
        self.state.current_leader = 0
        self.state.current_trick = [
            Card(Suit.HEARTS, Rank.KING),
            Card(Suit.SPADES, Rank.ACE),    # void, no trump
            Card(Suit.HEARTS, Rank.QUEEN),
            Card(Suit.HEARTS, Rank.JACK),
        ]
        result = self.state._resolve_trick(None)
        assert result.winner_index == 0  # led suit wins


class TestScoring:
    def setup_method(self):
        self.hands = [[], [], [], []]
        self.state = GameState(hands=self.hands)

    def test_team_a_wins_more_cards(self):
        self.state.captured[0] = [Card(Suit.SPADES, Rank.ACE)] * 15
        self.state.captured[2] = [Card(Suit.HEARTS, Rank.KING)] * 15
        self.state.captured[1] = [Card(Suit.DIAMONDS, Rank.QUEEN)] * 11
        self.state.captured[3] = [Card(Suit.CLUBS, Rank.JACK)] * 11
        score = self.state.score()
        assert score["winner"] == "A"
        assert score["team_a_cards"] == 30
        assert score["team_b_cards"] == 22

    def test_tiebreak_by_tens(self):
        self.state.captured[0] = [Card(Suit.SPADES, Rank.TEN), Card(Suit.HEARTS, Rank.TEN)] + [Card(Suit.DIAMONDS, Rank.ACE)] * 24
        self.state.captured[2] = []
        self.state.captured[1] = [Card(Suit.DIAMONDS, Rank.TEN), Card(Suit.CLUBS, Rank.TEN), Card(Suit.SPADES, Rank.TEN)] + [Card(Suit.HEARTS, Rank.KING)] * 23
        self.state.captured[3] = []
        score = self.state.score()
        assert score["winner"] == "B"
        assert score["team_a_tens"] == 2
        assert score["team_b_tens"] == 3

    def test_perfect_tie(self):
        self.state.captured[0] = [Card(Suit.SPADES, Rank.TEN)] + [Card(Suit.DIAMONDS, Rank.ACE)] * 25
        self.state.captured[2] = []
        self.state.captured[1] = [Card(Suit.HEARTS, Rank.TEN)] + [Card(Suit.CLUBS, Rank.KING)] * 25
        self.state.captured[3] = []
        score = self.state.score()
        assert score["winner"] is None
        assert score["team_a_cards"] == 26
        assert score["team_b_cards"] == 26


class TestLegalCards:
    def test_first_card_any(self):
        hands = [
            [Card(Suit.SPADES, Rank.ACE), Card(Suit.HEARTS, Rank.KING)],
            [], [], []
        ]
        state = GameState(hands=hands)
        legal = state.legal_cards(0)
        assert len(legal) == 2

    def test_must_follow_suit(self):
        hands = [
            [Card(Suit.SPADES, Rank.ACE), Card(Suit.HEARTS, Rank.KING)],
            [], [], []
        ]
        state = GameState(hands=hands)
        state.led_suit = Suit.SPADES
        legal = state.legal_cards(0)
        assert len(legal) == 1
        assert legal[0].suit == Suit.SPADES

    def test_void_can_play_any(self):
        hands = [
            [Card(Suit.HEARTS, Rank.KING), Card(Suit.DIAMONDS, Rank.QUEEN)],
            [], [], []
        ]
        state = GameState(hands=hands)
        state.led_suit = Suit.SPADES
        legal = state.legal_cards(0)
        assert len(legal) == 2


class TestTrumpDeclaration:
    def test_trump_declared_when_void(self):
        hands = [
            [Card(Suit.SPADES, Rank.ACE)],  # only spades
            [], [], []
        ]
        state = GameState(hands=hands)
        state.led_suit = Suit.HEARTS
        result = state.play_card(0, Card(Suit.SPADES, Rank.ACE))
        assert state.trump_suit == Suit.SPADES
        assert state.trump_declarer == 0

    def test_no_trump_if_has_led_suit(self):
        hands = [
            [Card(Suit.HEARTS, Rank.ACE), Card(Suit.SPADES, Rank.KING)],
            [], [], []
        ]
        state = GameState(hands=hands)
        state.led_suit = Suit.HEARTS
        result = state.play_card(0, Card(Suit.SPADES, Rank.KING))
        assert state.trump_suit is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])