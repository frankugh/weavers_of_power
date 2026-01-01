from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class DeckState:
    draw_pile: list[str] = field(default_factory=list)     # card_ids in shuffle order
    discard_pile: list[str] = field(default_factory=list)
    hand: list[str] = field(default_factory=list)          # cards drawn this turn (ids)

@dataclass
class EnemyInstance:
    instance_id: str
    template_id: str
    name: str
    image: Optional[str]

    hp_current: int
    hp_max: int

    armor_current: int
    armor_max: int

    magic_armor_current: int
    magic_armor_max: int

    guard_base: int = 0
    guard_current: int = 0


    draws_base: int = 1
    movement: int = 0

    rolled_loot: dict = field(default_factory=dict)  # later typener; nu simpel
    loot_rolled: bool = False

    deck_state: DeckState = field(default_factory=DeckState)

    statuses: dict[str, dict] = field(default_factory=dict)
