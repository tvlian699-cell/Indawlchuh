# lang: Python 3.11+, file: backend/game_engine.py
# Dehla Pakad — core rules engine: deck, trump, trick resolution, scoring
#
# SCORING FIX:
#   - Tens captured is the PRIMARY win condition (most tens wins)
#   - If tens are tied (2-2), count total cards captured — more cards wins
#   - If a team captures all 4 tens mid-game, game ends immediately
#   - There is NO draw: 52 cards can't split 26-26 when tens are unequal,
#     and when tens are equal (2-2), remaining 48 cards always break the tie

from __future__ import annotations
import random
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Optional


# ─── Card primitives ──────────────────────────────────────────────────────────

class Suit(Enum):
    SPADES   = "♠"
    HEARTS   = "♥"
    DIAMONDS = "♦"
    CLUBS    = "♣"

class Rank(Enum):
    TWO   = (2,  "2")
    THREE = (3,  "3")
    FOUR  = (4,  "4")
    FIVE  = (5,  "5")
    SIX   = (6,  "6")
    SEVEN = (7,  "7")
    EIGHT = (8,  "8")
    NINE  = (9,  "9")
    TEN   = (10, "10")
    JACK  = (11, "J")
    QUEEN = (12, "Q")
    KING  = (13, "K")
    ACE   = (14, "A")

    def __init__(self, value: int, symbol: str):
        self._value_ = value
        self.symbol  = symbol

    def __lt__(self, other):  return self.value < other.value
    def __le__(self, other):  return self.value <= other.value
    def __gt__(self, other):  return self.value > other.value
    def __ge__(self, other):  return self.value >= other.value


@dataclass(frozen=True)
class Card:
    suit: Suit
    rank: Rank

    @property
    def is_ten(self) -> bool:
        return self.rank == Rank.TEN

    def __str__(self) -> str:
        return f"{self.rank.symbol}{self.suit.value}"

    def __repr__(self) -> str:
        return self.__str__()


# ─── Deck ─────────────────────────────────────────────────────────────────────

def build_deck() -> list[Card]:
    return [Card(suit, rank) for suit in Suit for rank in Rank]

def deal(deck: list[Card]) -> tuple[list[Card], list[Card], list[Card], list[Card]]:
    d = deck[:]
    random.shuffle(d)
    return d[0:13], d[13:26], d[26:39], d[39:52]


# ─── Game state ───────────────────────────────────────────────────────────────

class Team(Enum):
    A = auto()   # players 0 and 2
    B = auto()   # players 1 and 3

TEAM_OF = {0: Team.A, 1: Team.B, 2: Team.A, 3: Team.B}


@dataclass
class TrickResult:
    winner_index:   int
    cards:          list[Card]
    trump_declared: Optional[Suit]


@dataclass
class GameState:
    hands:          list[list[Card]]      # index = player (0-3)
    trump_suit:     Optional[Suit]  = None
    trump_declarer: Optional[int]   = None
    led_suit:       Optional[Suit]  = None
    current_trick:  list[Optional[Card]] = field(default_factory=lambda: [None]*4)
    captured:       list[list[Card]]     = field(default_factory=lambda: [[] for _ in range(4)])
    tricks_played:  int             = 0
    current_leader: int             = 0    # who leads the current trick
    phase:          str             = "play"   # "play" | "done"

    # ── Legal moves ──────────────────────────────────────────────────────────

    def legal_cards(self, player: int) -> list[Card]:
        hand = self.hands[player]
        if not hand:
            return []
        # first card of the trick — anything goes
        if self.led_suit is None:
            return hand[:]
        # must follow suit if possible
        same_suit = [c for c in hand if c.suit == self.led_suit]
        return same_suit if same_suit else hand[:]

    # ── Play a card ──────────────────────────────────────────────────────────

    def play_card(self, player: int, card: Card) -> Optional[TrickResult]:
        """
        Places card into the current trick slot.
        If player is void in led suit and plays a different suit,
        that suit becomes trump (first declaration wins).
        Returns TrickResult when all 4 slots are filled, else None.
        """
        assert card in self.hands[player], f"{player} doesn't hold {card}"
        self.hands[player].remove(card)
        self.current_trick[player] = card

        # trump declaration — void in led suit, playing a different suit
        newly_declared = None
        if (self.led_suit is not None
                and card.suit != self.led_suit
                and self.trump_suit is None
                and not any(c.suit == self.led_suit for c in self.hands[player])):
            self.trump_suit     = card.suit
            self.trump_declarer = player
            newly_declared      = card.suit

        # set led suit from first card of trick
        if self.led_suit is None:
            self.led_suit = card.suit

        # check if trick is complete
        if all(c is not None for c in self.current_trick):
            return self._resolve_trick(newly_declared)
        return None

    # ── Trick resolution ─────────────────────────────────────────────────────

    def _resolve_trick(self, newly_declared: Optional[Suit]) -> TrickResult:
        cards  = list(self.current_trick)
        winner = self.current_leader

        for i, card in enumerate(cards):
            if self._beats(card, cards[winner]):
                winner = i

        # award cards to winner
        self.captured[winner].extend(c for c in cards if c is not None)
        self.tricks_played  += 1
        self.current_leader  = winner

        result = TrickResult(
            winner_index   = winner,
            cards          = [c for c in cards if c is not None],
            trump_declared = newly_declared,
        )

        # reset trick state
        self.current_trick = [None] * 4
        self.led_suit      = None

        # End condition 1: all hands empty
        if all(len(h) == 0 for h in self.hands):
            self.phase = "done"

        # End condition 2: one team captured all 4 tens (early win)
        elif self._one_team_has_all_tens():
            self.phase = "done"

        return result

    def _one_team_has_all_tens(self) -> bool:
        """Returns True if any single team holds all 4 tens in their captures."""
        tens_a = sum(1 for pid in [0, 2] for c in self.captured[pid] if c.is_ten)
        tens_b = sum(1 for pid in [1, 3] for c in self.captured[pid] if c.is_ten)
        return tens_a == 4 or tens_b == 4

    def _beats(self, challenger: Card, current: Card) -> bool:
        chal_trump = self.trump_suit and challenger.suit == self.trump_suit
        curr_trump = self.trump_suit and current.suit   == self.trump_suit

        if chal_trump and not curr_trump: return True
        if not chal_trump and curr_trump: return False
        if challenger.suit != current.suit: return False
        return challenger.rank > current.rank

    # ── Scoring ──────────────────────────────────────────────────────────────

    def score(self) -> dict:
        """
        SCORING RULES (Dehla Pakad / Indawlchuh):
          1. PRIMARY:   team with MORE tens wins outright (3-1, 4-0, 3-0 etc.)
          2. TIEBREAK:  if tens are equal (2-2), team with MORE total cards wins
          3. No true draw is possible — 52 cards, so card counts always differ
             when tens are tied.
        """
        team_cards = {Team.A: [], Team.B: []}
        for pid, pile in enumerate(self.captured):
            team_cards[TEAM_OF[pid]].extend(pile)

        count_a = len(team_cards[Team.A])
        count_b = len(team_cards[Team.B])
        tens_a  = sum(1 for c in team_cards[Team.A] if c.is_ten)
        tens_b  = sum(1 for c in team_cards[Team.B] if c.is_ten)

        # PRIMARY: tens decide the winner
        if tens_a != tens_b:
            winner = Team.A if tens_a > tens_b else Team.B

        # TIEBREAK: tens are equal (2-2) — most cards wins
        else:
            if count_a > count_b:
                winner = Team.A
            elif count_b > count_a:
                winner = Team.B
            else:
                # True mathematical draw (shouldn't happen with 52 cards, but be safe)
                winner = None

        # Serialize winner as plain string — Team enum is not JSON-serializable
        if winner is None:
            winner_str = None
        elif winner == Team.A:
            winner_str = "A"
        else:
            winner_str = "B"

        return {
            "team_a_cards": count_a, "team_b_cards": count_b,
            "team_a_tens":  tens_a,  "team_b_tens":  tens_b,
            "winner": winner_str,
        }
