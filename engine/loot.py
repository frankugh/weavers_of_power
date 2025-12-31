from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
import random

from engine.models import EnemyTemplate, LootEntry


@dataclass(frozen=True)
class LootRoll:
    currency: dict[str, int] = field(default_factory=dict)   # {"cp": 12, "sp": 3, ...}
    resources: dict[str, int] = field(default_factory=dict)  # {"willpower": 1}
    other: tuple[str, ...] = ()                              # free text lines


def _roll_range(mn: int, mx: int, rnd: random.Random) -> int:
    return rnd.randint(mn, mx)


def roll_loot(template: EnemyTemplate, *, rnd: Optional[random.Random] = None) -> LootRoll:
    rnd = rnd or random

    cur: dict[str, int] = {}
    res: dict[str, int] = {}
    other: list[str] = []

    for i, entry in enumerate(template.loot):
        if entry.type in ("currency", "resource"):
            if entry.min is None or entry.max is None or entry.kind is None:
                # should never happen due to validation
                continue
            amount = _roll_range(int(entry.min), int(entry.max), rnd)
            if amount <= 0:
                continue
            if entry.type == "currency":
                cur[entry.kind] = cur.get(entry.kind, 0) + amount
            else:
                res[entry.kind] = res.get(entry.kind, 0) + amount

        elif entry.type == "other":
            if entry.text and entry.text.strip():
                other.append(entry.text.strip())

    return LootRoll(currency=cur, resources=res, other=tuple(other))
