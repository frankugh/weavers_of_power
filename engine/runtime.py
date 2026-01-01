from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
import random
import uuid

from engine.models import Deck, EnemyTemplate, Card
from engine.runtime_models import EnemyInstance, DeckState
from engine.turn_hooks import on_turn_start, on_turn_end
from engine.loot import roll_loot


# --- helpers (stap 1) ---

def roll_range(rng, *, rnd: random.Random) -> int:
    return rnd.randint(rng.min, rng.max)

def roll_random_bool(*, rnd: random.Random) -> bool:
    return bool(rnd.getrandbits(1))

def build_deck_card_ids(core_deck: Deck, specials: tuple[Card, ...]) -> list[str]:
    ids: list[str] = []
    for c in core_deck.cards:
        ids.extend([c.id] * c.weight)
    for s in specials:
        ids.extend([s.id] * s.weight)
    if not ids:
        raise ValueError("Built deck is empty (core + specials).")
    return ids

def uuid4_short() -> str:
    return uuid.uuid4().hex[:10]


# --- spawning (stap 1) ---

def spawn_enemy(
    template: EnemyTemplate,
    decks: dict[str, Deck],
    *,
    rnd: Optional[random.Random] = None,
) -> EnemyInstance:
    rnd = rnd or random

    if template.coreDeck not in decks:
        raise ValueError(f"Enemy template '{template.id}' refers to missing deck '{template.coreDeck}'")

    hp_max = roll_range(template.hp, rnd=rnd)
    armor_max = roll_range(template.armor, rnd=rnd)
    magic_max = roll_range(template.magicArmor, rnd=rnd)
    base_guard = roll_range(template.baseGuard, rnd=rnd)

    core_deck = decks[template.coreDeck]
    card_ids = build_deck_card_ids(core_deck, template.specials)
    rnd.shuffle(card_ids)

    return EnemyInstance(
        instance_id=uuid4_short(),
        template_id=template.id,
        name=template.name,
        image=template.image,

        hp_current=hp_max,
        hp_max=hp_max,

        armor_current=armor_max,
        armor_max=armor_max,

        magic_armor_current=magic_max,
        magic_armor_max=magic_max,

        guard_base=base_guard,
        guard_current=0,

        draws_base=template.draws,
        movement=template.movement,

        deck_state=DeckState(draw_pile=card_ids, discard_pile=[], hand=[]),
        statuses={},
    )


# --- step 2: draw / discard / reshuffle ---

@dataclass(frozen=True)
class DrawResult:
    instance_id: str
    requested: int
    drawn: list[str]           # card ids drawn now
    reshuffled: bool
    draw_pile_after: int
    discard_pile_after: int
    hand_after: int


def _reshuffle_if_needed(ds: DeckState, *, rnd: random.Random) -> bool:
    """
    If draw pile is empty and discard has cards, reshuffle discard into draw.
    Returns True if reshuffle happened.
    """
    if ds.draw_pile:
        return False
    if not ds.discard_pile:
        return False
    ds.draw_pile = ds.discard_pile[:]
    ds.discard_pile.clear()
    rnd.shuffle(ds.draw_pile)
    return True


def draw_cards(enemy: EnemyInstance, n: int, *, rnd: Optional[random.Random] = None) -> DrawResult:
    """
    Draw up to n cards into enemy.deck_state.hand.
    Leaves them there until end_turn() is called.
    """
    if n < 0:
        raise ValueError("n must be >= 0")
    rnd = rnd or random.Random()

    ds = enemy.deck_state
    drawn_now: list[str] = []
    reshuffled_any = False

    for _ in range(n):
        # ensure we have something to draw
        reshuffled_any = _reshuffle_if_needed(ds, rnd=rnd) or reshuffled_any
        if not ds.draw_pile:
            break  # nothing left anywhere
        card_id = ds.draw_pile.pop(0)
        ds.hand.append(card_id)
        drawn_now.append(card_id)

    return DrawResult(
        instance_id=enemy.instance_id,
        requested=n,
        drawn=drawn_now,
        reshuffled=reshuffled_any,
        draw_pile_after=len(ds.draw_pile),
        discard_pile_after=len(ds.discard_pile),
        hand_after=len(ds.hand),
    )


def end_turn(enemy: EnemyInstance) -> None:
    """
    Moves all cards from hand to discard, then clears end-of-turn transient statuses.
    """
    ds = enemy.deck_state
    if ds.hand:
        ds.discard_pile.extend(ds.hand)
        ds.hand.clear()

    on_turn_end(enemy)


def enemy_turn(enemy: EnemyInstance, *, rnd: Optional[random.Random] = None) -> DrawResult:
    """
    Start of turn: reset guard + apply DOT.
    Then draw cards (paralyzed => -1 draw).
    Dead enemies (hp<=0) do not draw.
    """
    on_turn_start(enemy)

    if enemy.hp_current <= 0:
        # No draw when dead
        return DrawResult(
            instance_id=enemy.instance_id,
            requested=0,
            drawn=[],
            reshuffled=False,
            draw_pile_after=len(enemy.deck_state.draw_pile),
            discard_pile_after=len(enemy.deck_state.discard_pile),
            hand_after=len(enemy.deck_state.hand),
        )

    draws = enemy.draws_base
    if "paralyzed" in enemy.statuses:
        draws -= 1
    if draws < 0:
        draws = 0

    return draw_cards(enemy, draws, rnd=rnd)


def roll_loot_for_enemy(enemy: EnemyInstance, template: EnemyTemplate, *, rnd: Optional[random.Random] = None) -> None:
    lr = roll_loot(template, rnd=rnd)
    enemy.rolled_loot = {
        "currency": dict(lr.currency),
        "resources": dict(lr.resources),
        "other": list(lr.other),
    }
    enemy.loot_rolled = True

# --- battle container ---

@dataclass
class BattleState:
    enemies: dict[str, EnemyInstance] = field(default_factory=dict)

    def add_enemy(self, enemy: EnemyInstance) -> None:
        if enemy.instance_id in self.enemies:
            raise ValueError(f"Duplicate instance_id '{enemy.instance_id}'")
        self.enemies[enemy.instance_id] = enemy

    def remove_enemy(self, instance_id: str) -> None:
        self.enemies.pop(instance_id, None)
