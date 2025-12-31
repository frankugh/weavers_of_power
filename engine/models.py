from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

# --- Enums / literals ---

Modifier = Literal["stab", "pierce", "magic_pierce", "sunder", "paralyse"]
EffectType = Literal["attack", "block"]

LootType = Literal["currency", "resource", "other"]
CurrencyKind = Literal["cp", "sp", "gp"]
ResourceKind = Literal["willpower"]


# --- Basic types ---

@dataclass(frozen=True)
class RangeInt:
    min: int
    max: int

    def validate(self, path: str) -> list[str]:
        errs: list[str] = []
        if self.min < 0 or self.max < 0:
            errs.append(f"{path}: range cannot be negative (min={self.min}, max={self.max})")
        if self.min > self.max:
            errs.append(f"{path}: min > max (min={self.min}, max={self.max})")
        return errs


@dataclass(frozen=True)
class Effect:
    type: EffectType
    amount: int
    modifiers: tuple[Modifier, ...] = ()

    def validate(self, path: str) -> list[str]:
        errs: list[str] = []
        if self.amount <= 0:
            errs.append(f"{path}: effect amount must be > 0 (got {self.amount})")
        return errs


@dataclass(frozen=True)
class Card:
    id: str
    title: str
    effects: tuple[Effect, ...]
    weight: int = 1

    def validate(self, path: str) -> list[str]:
        errs: list[str] = []
        if not self.id:
            errs.append(f"{path}: card id is empty")
        if not self.title:
            errs.append(f"{path}: card title is empty")
        if self.weight <= 0:
            errs.append(f"{path}: card weight must be > 0 (got {self.weight})")
        if not self.effects:
            errs.append(f"{path}: card must have at least 1 effect")
        for i, e in enumerate(self.effects):
            errs += e.validate(f"{path}.effects[{i}]")
        return errs


@dataclass(frozen=True)
class Deck:
    id: str
    name: str
    cards: tuple[Card, ...]

    def validate(self, path: str) -> list[str]:
        errs: list[str] = []
        if not self.id:
            errs.append(f"{path}: deck id is empty")
        if not self.name:
            errs.append(f"{path}: deck name is empty")
        if not self.cards:
            errs.append(f"{path}: deck must have cards")
        seen: set[str] = set()
        for i, c in enumerate(self.cards):
            if c.id in seen:
                errs.append(f"{path}: duplicate card id '{c.id}'")
            seen.add(c.id)
            errs += c.validate(f"{path}.cards[{i}]")
        return errs


# --- Loot ---

@dataclass(frozen=True)
class LootEntry:
    """
    type:
      - currency: kind in {cp,sp,gp}, has min/max
      - resource: kind in {willpower}, has min/max
      - other: free text
    """
    type: LootType
    kind: Optional[str] = None
    min: Optional[int] = None
    max: Optional[int] = None
    text: Optional[str] = None

    def validate(self, path: str) -> list[str]:
        errs: list[str] = []

        if self.type == "currency":
            if self.kind not in ("cp", "sp", "gp"):
                errs.append(f"{path}: currency kind must be cp/sp/gp (got {self.kind})")
            errs += _validate_minmax_required(self.min, self.max, path)

        elif self.type == "resource":
            if self.kind not in ("willpower",):
                errs.append(f"{path}: resource kind must be 'willpower' (got {self.kind})")
            errs += _validate_minmax_required(self.min, self.max, path)

        elif self.type == "other":
            if not self.text or not self.text.strip():
                errs.append(f"{path}: other.text is required and cannot be empty")

        else:
            errs.append(f"{path}: unknown loot type '{self.type}'")

        return errs


def _validate_minmax_required(mn: Optional[int], mx: Optional[int], path: str) -> list[str]:
    errs: list[str] = []
    if mn is None or mx is None:
        errs.append(f"{path}: min/max required")
        return errs
    if mn < 0 or mx < 0:
        errs.append(f"{path}: min/max cannot be negative")
    if mn > mx:
        errs.append(f"{path}: min > max (min={mn}, max={mx})")
    return errs


# --- Enemy template ---

@dataclass(frozen=True)
class RandomBoolSpec:
    mode: Literal["random_bool"] = "random_bool"


@dataclass(frozen=True)
class EnemyTemplate:
    id: str
    name: str
    image: Optional[str]

    hp: RangeInt
    armor: RangeInt
    magicArmor: RangeInt

    draws: int
    movement: int
    coreDeck: str
    specials: tuple[Card, ...]

    loot: tuple[LootEntry, ...]

    def validate(self, path: str, available_decks: set[str]) -> list[str]:
        errs: list[str] = []
        if not self.id:
            errs.append(f"{path}: enemy id is empty")
        if not self.name:
            errs.append(f"{path}: enemy name is empty")

        errs += self.hp.validate(f"{path}.hp")
        errs += self.armor.validate(f"{path}.armor")
        errs += self.magicArmor.validate(f"{path}.magicArmor")

        if self.draws <= 0:
            errs.append(f"{path}.draws must be > 0 (got {self.draws})")

        if self.movement <= 0:
            errs.append(f"{path}.movement must be > 0 (got {self.movement})")

        if self.coreDeck not in available_decks:
            errs.append(f"{path}.coreDeck '{self.coreDeck}' not found among loaded decks")

        if len(self.specials) != 3:
            errs.append(f"{path}.specials must have exactly 3 cards (got {len(self.specials)})")

        seen: set[str] = set()
        for i, c in enumerate(self.specials):
            if c.id in seen:
                errs.append(f"{path}.specials: duplicate special card id '{c.id}'")
            seen.add(c.id)
            errs += c.validate(f"{path}.specials[{i}]")

        if not self.loot:
            errs.append(f"{path}.loot must have at least one entry")
        for i, le in enumerate(self.loot):
            errs += le.validate(f"{path}.loot[{i}]")

        if self.image is None or self.image.strip() == "":
            errs.append(f"{path}.image missing/empty (set to filename in /images)")

        return errs
