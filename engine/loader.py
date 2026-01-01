from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from engine.models import (
    Deck, Card, Effect, RangeInt,
    EnemyTemplate, RandomBoolSpec, LootEntry
)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _parse_range(obj: dict, path: str) -> RangeInt:
    return RangeInt(min=int(obj["min"]), max=int(obj["max"]))


def _parse_effect(obj: dict) -> Effect:
    mods = tuple(obj.get("modifiers", []))
    return Effect(type=obj["type"], amount=int(obj["amount"]), modifiers=mods)


def _parse_card(obj: dict) -> Card:
    effects = tuple(_parse_effect(e) for e in obj["effects"])
    return Card(
        id=obj["id"],
        title=obj.get("title", obj["id"]),
        effects=effects,
        weight=int(obj.get("weight", 1)),
    )


def _parse_loot(entries: list[dict]) -> tuple[LootEntry, ...]:
    loot: list[LootEntry] = []
    for e in entries:
        loot.append(LootEntry(
            type=e["type"],
            kind=e.get("kind"),
            min=e.get("min"),
            max=e.get("max"),
            text=e.get("text"),
        ))
    return tuple(loot)


def load_decks(decks_dir: Path) -> dict[str, Deck]:
    decks: dict[str, Deck] = {}
    for p in sorted(decks_dir.glob("*.json")):
        raw = _read_json(p)
        deck = Deck(
            id=raw["id"],
            name=raw.get("name", raw["id"]),
            cards=tuple(_parse_card(c) for c in raw["cards"]),
        )
        errs = deck.validate(f"Deck({p.name})")
        if errs:
            raise ValueError("Deck validation failed:\n- " + "\n- ".join(errs))
        if deck.id in decks:
            raise ValueError(f"Duplicate deck id '{deck.id}' (file {p.name})")
        decks[deck.id] = deck

    if not decks:
        raise ValueError(f"No deck json files found in {decks_dir}")
    return decks


def load_enemies(enemies_dir: Path, decks: dict[str, Deck], images_dir: Path) -> dict[str, EnemyTemplate]:
    enemies: dict[str, EnemyTemplate] = {}
    available_decks = set(decks.keys())

    images_dir_exists = images_dir.exists() and images_dir.is_dir()

    for p in sorted(enemies_dir.glob("*.json")):
        raw = _read_json(p)

        enemy = EnemyTemplate(
            id=raw["id"],
            name=raw.get("name", raw["id"]),
            image=raw.get("image"),

            hp=_parse_range(raw["hp"], f"{p.name}.hp"),
            baseGuard=_parse_range(raw.get("baseGuard", {"min": 0, "max": 0}), f"{p.name}.baseGuard"),
            armor=_parse_range(raw["armor"], f"{p.name}.armor"),
            magicArmor=_parse_range(raw.get("magicArmor", {"min": 0, "max": 0}), f"{p.name}.magicArmor"),

            draws=int(raw.get("draws", 1)),
            movement=int(raw.get("movement", 0)),
            coreDeck=raw["coreDeck"],
            specials=tuple(_parse_card(c) for c in raw["specials"]),

            loot=_parse_loot(raw.get("loot", [])),
        )

        errs = enemy.validate(f"Enemy({p.name})", available_decks=available_decks)
        if errs:
            raise ValueError("Enemy validation failed:\n- " + "\n- ".join(errs))

        # filesystem check for image existence
        if images_dir_exists:
            img_path = images_dir / (enemy.image or "")
            if not img_path.exists():
                raise ValueError(f"Enemy({p.name}).image file not found: {img_path}")

        if enemy.id in enemies:
            raise ValueError(f"Duplicate enemy id '{enemy.id}' (file {p.name})")
        enemies[enemy.id] = enemy

    if not enemies:
        raise ValueError(f"No enemy json files found in {enemies_dir}")
    return enemies
