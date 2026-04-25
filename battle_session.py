from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
import random
import uuid
from typing import Optional

from engine.combat import AttackMod, apply_attack, apply_heal
from engine.loader import load_decks, load_enemies
from engine.loot import roll_loot
from engine.models import Card, Deck, EnemyTemplate
from engine.runtime import BattleState, enemy_turn, end_turn, spawn_enemy
from engine.runtime_models import DeckState, EnemyInstance
from engine.turn_hooks import on_turn_end, on_turn_start
from persistence import (
    enemy_to_dict,
    load_save_payload,
    make_save_payload,
    restore_state_from_payload,
    save_current,
)

LOG_LIMIT = 30
ROOM_DEFAULT_COLUMNS = 10
ROOM_DEFAULT_ROWS = 7
ROOM_MIN_COLUMNS = 3
ROOM_MIN_ROWS = 3
ROOM_MAX_COLUMNS = 99
ROOM_MAX_ROWS = 99


class BattleSessionError(ValueError):
    pass


def create_sid() -> str:
    return uuid.uuid4().hex[:12]


def uuid_short() -> str:
    return uuid.uuid4().hex[:10]


def build_core_deck_ids(deck: Deck, rnd: random.Random) -> list[str]:
    card_ids: list[str] = []
    for card in deck.cards:
        card_ids.extend([card.id] * card.weight)
    rnd.shuffle(card_ids)
    return card_ids


def spawn_custom_enemy(
    *,
    name: str,
    hp: int,
    armor: int,
    magic_armor: int,
    draws: int,
    movement: int,
    core_deck: Deck,
    rnd: random.Random,
) -> EnemyInstance:
    return EnemyInstance(
        instance_id=uuid_short(),
        template_id="custom",
        name=name,
        image=None,
        hp_current=hp,
        hp_max=hp,
        armor_current=armor,
        armor_max=armor,
        magic_armor_current=magic_armor,
        magic_armor_max=magic_armor,
        guard_current=0,
        draws_base=draws,
        movement=movement,
        deck_state=DeckState(draw_pile=build_core_deck_ids(core_deck, rnd=rnd), discard_pile=[], hand=[]),
        statuses={},
    )


def spawn_player(name: str) -> EnemyInstance:
    return EnemyInstance(
        instance_id=uuid_short(),
        template_id="player",
        name=name,
        image=None,
        hp_current=0,
        hp_max=0,
        armor_current=0,
        armor_max=0,
        magic_armor_current=0,
        magic_armor_max=0,
        guard_current=0,
        draws_base=0,
        movement=0,
        deck_state=DeckState(draw_pile=[], discard_pile=[], hand=[]),
        statuses={},
    )


def safe_filename(name: str) -> str:
    keep: list[str] = []
    for ch in name.strip():
        if ch.isalnum() or ch in ("-", "_", " "):
            keep.append(ch)
    safe = "".join(keep).strip().replace(" ", "_")
    return safe or "save"


def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


@dataclass
class BattleSessionContext:
    root: Path
    saves_dir: Optional[Path] = None
    decks_dir: Optional[Path] = None
    enemies_dir: Optional[Path] = None
    images_dir: Optional[Path] = None
    save_version: int = 2

    def __post_init__(self) -> None:
        self.root = Path(self.root)
        self.decks_dir = Path(self.decks_dir) if self.decks_dir else (self.root / "data" / "decks")
        self.enemies_dir = Path(self.enemies_dir) if self.enemies_dir else (self.root / "data" / "enemies")
        self.images_dir = Path(self.images_dir) if self.images_dir else (self.root / "images")
        self.saves_dir = Path(self.saves_dir) if self.saves_dir else (self.root / "saves")
        self.manual_dir = self.saves_dir / "manual"

        self.saves_dir.mkdir(parents=True, exist_ok=True)
        self.manual_dir.mkdir(parents=True, exist_ok=True)

        self.decks = load_decks(self.decks_dir)
        self.enemy_templates = load_enemies(self.enemies_dir, decks=self.decks, images_dir=self.images_dir)
        self.card_index = self._build_card_index()

    def _build_card_index(self) -> dict[str, Card]:
        index: dict[str, Card] = {}
        for deck in self.decks.values():
            for card in deck.cards:
                index[card.id] = card
        for template in self.enemy_templates.values():
            for special in template.specials:
                index[special.id] = special
        return index

    def current_path(self, sid: str) -> Path:
        return self.saves_dir / f"_current_{sid}.json"

    def metadata(self) -> dict:
        templates = [
            {"id": template_id, "name": template.name, "imageUrl": self.template_image_url(template)}
            for template_id, template in sorted(self.enemy_templates.items(), key=lambda item: item[1].name.lower())
        ]
        decks = [{"id": deck_id, "name": deck.name} for deck_id, deck in sorted(self.decks.items(), key=lambda item: item[1].name.lower())]
        return {"enemyTemplates": templates, "decks": decks}

    def template_image_url(self, template: EnemyTemplate) -> str:
        image = (getattr(template, "image", None) or "").replace("\\", "/").lstrip("/")
        if image.startswith("images/"):
            image = image[len("images/"):]
        if image == "bandid.png":
            image = "bandit.png"
        if not image or not (self.images_dir / image).exists():
            image = "anonymous.png"
        return f"/images/{image}"

    def create_session(self, sid: Optional[str] = None) -> "BattleSession":
        session = BattleSession(context=self, sid=sid or create_sid())
        session.autosave()
        return session

    def load_session(self, sid: str, *, create_if_missing: bool = True) -> "BattleSession":
        session = BattleSession(context=self, sid=sid)
        payload = load_save_payload(self.current_path(sid))
        if payload:
            session.load_from_payload(payload)
            return session
        if not create_if_missing:
            raise BattleSessionError(f"Session '{sid}' not found")
        session.autosave()
        return session


@dataclass
class BattleSession:
    context: BattleSessionContext
    sid: str
    state: BattleState = field(default_factory=BattleState)
    order: list[str] = field(default_factory=list)
    selected_id: Optional[str] = None
    active_turn_id: Optional[str] = None
    turn_in_progress: bool = False
    room_columns: int = ROOM_DEFAULT_COLUMNS
    room_rows: int = ROOM_DEFAULT_ROWS
    round: int = 1
    combat_log: list[str] = field(default_factory=list)
    _rng: random.Random = field(default_factory=random.Random, repr=False)

    def load_from_payload(self, payload: dict) -> None:
        self.state.enemies.clear()
        self.order = []
        self.selected_id = None
        self.active_turn_id = None
        self.turn_in_progress = False
        self.room_columns = ROOM_DEFAULT_COLUMNS
        self.room_rows = ROOM_DEFAULT_ROWS
        self.round = 1
        self.combat_log = []
        position_payload_present = any(
            "grid_x" in enemy_raw or "grid_y" in enemy_raw for enemy_raw in payload.get("enemies", []) or []
        )

        (
            loaded_order,
            loaded_selected,
            loaded_active,
            loaded_tip,
            loaded_room,
            enemies,
            loaded_round,
            loaded_log,
        ) = restore_state_from_payload(payload)
        self.room_columns, self.room_rows = self._normalized_room_size(
            loaded_room.get("columns", ROOM_DEFAULT_COLUMNS),
            loaded_room.get("rows", ROOM_DEFAULT_ROWS),
        )

        for enemy in enemies:
            self.state.add_enemy(enemy)

        self.order = [instance_id for instance_id in loaded_order if instance_id in self.state.enemies]
        if loaded_selected in self.state.enemies:
            self.selected_id = loaded_selected
        elif self.order:
            self.selected_id = self.order[0]

        if loaded_active in self.state.enemies:
            self.active_turn_id = loaded_active
            self.turn_in_progress = bool(loaded_tip)
            if not self.turn_in_progress:
                self._set_visible_draw(self.state.enemies[loaded_active], [])

        self.round = max(1, int(loaded_round or 1))
        self.combat_log = list(loaded_log or [])[:LOG_LIMIT]
        if position_payload_present:
            self._clear_out_of_bounds_positions()
        else:
            self._auto_place_unplaced_entities()
        self._ensure_selected()

    def _build_payload(self) -> dict:
        return make_save_payload(
            version=self.context.save_version,
            sid=self.sid,
            order=self.order,
            selected_id=self.selected_id,
            active_turn_id=self.active_turn_id,
            turn_in_progress=self.turn_in_progress,
            room={"columns": self.room_columns, "rows": self.room_rows},
            round=self.round,
            combat_log=self.combat_log,
            enemies=list(self.state.enemies.values()),
        )

    def autosave(self) -> None:
        save_current(self.context.current_path(self.sid), self._build_payload())

    def snapshot(self) -> dict:
        self._ensure_selected()
        return {
            "sid": self.sid,
            "round": self.round,
            "selectedId": self.selected_id,
            "activeTurnId": self.active_turn_id,
            "turnInProgress": self.turn_in_progress,
            "room": {"columns": self.room_columns, "rows": self.room_rows},
            "order": list(self.order),
            "enemies": [self._serialize_enemy(instance_id) for instance_id in self._ordered_enemy_ids()],
            "combatLog": list(self.combat_log),
        }

    def list_manual_saves(self) -> list[dict]:
        entries: list[dict] = []
        for path in sorted(self.context.manual_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            payload = load_save_payload(path)
            saved_at = (payload or {}).get("saved_at")
            entries.append(
                {
                    "filename": path.name,
                    "savedAt": saved_at,
                    "label": path.stem,
                }
            )
        return entries

    def select(self, instance_id: str) -> None:
        if instance_id not in self.state.enemies:
            raise BattleSessionError(f"Entity '{instance_id}' does not exist")
        self.selected_id = instance_id
        self.autosave()

    def add_enemy_from_template(self, template_id: str) -> None:
        if template_id not in self.context.enemy_templates:
            raise BattleSessionError(f"Unknown template '{template_id}'")
        template = self.context.enemy_templates[template_id]
        instance = spawn_enemy(template, self.context.decks, rnd=self._rng)
        instance.name = f"{template.name} {self._next_suffix(template.name)}"
        self.state.add_enemy(instance)
        self._auto_place_entity(instance)
        self.order.append(instance.instance_id)
        self.selected_id = instance.instance_id
        self._add_log(f"Added enemy: {instance.name}")
        self.autosave()

    def add_custom_enemy(
        self,
        *,
        name: str,
        hp: int,
        armor: int,
        magic_armor: int,
        draws: int,
        movement: int,
        core_deck_id: str,
    ) -> None:
        if core_deck_id not in self.context.decks:
            raise BattleSessionError(f"Unknown deck '{core_deck_id}'")
        instance = spawn_custom_enemy(
            name=(name.strip() or "Custom"),
            hp=max(1, int(hp)),
            armor=max(0, int(armor)),
            magic_armor=max(0, int(magic_armor)),
            draws=max(0, int(draws)),
            movement=max(0, int(movement)),
            core_deck=self.context.decks[core_deck_id],
            rnd=self._rng,
        )
        self.state.add_enemy(instance)
        self._auto_place_entity(instance)
        self.order.append(instance.instance_id)
        self.selected_id = instance.instance_id
        self._add_log(f"Added custom enemy: {instance.name}")
        self.autosave()

    def add_player(self) -> None:
        instance = spawn_player(f"Player {self._next_suffix('Player')}")
        self.state.add_enemy(instance)
        self._auto_place_entity(instance)
        self.order.append(instance.instance_id)
        self.selected_id = instance.instance_id
        self._add_log(f"Added player: {instance.name}")
        self.autosave()

    def delete_entity(self, instance_id: str) -> None:
        entity = self.state.enemies.get(instance_id)
        if not entity:
            raise BattleSessionError(f"Entity '{instance_id}' does not exist")
        if self.active_turn_id == instance_id:
            self.active_turn_id = None
            self.turn_in_progress = False
        self.state.remove_enemy(instance_id)
        if instance_id in self.order:
            self.order.remove(instance_id)
        if self.selected_id == instance_id:
            self.selected_id = None
        self._ensure_selected()
        self._add_log(f"Removed entity: {entity.name}")
        self.autosave()

    def move_in_order(self, instance_id: str, direction: int) -> None:
        if instance_id not in self.order:
            raise BattleSessionError(f"Entity '{instance_id}' is not in round order")
        if direction not in (-1, 1):
            raise BattleSessionError("direction must be -1 or 1")
        index = self.order.index(instance_id)
        new_index = index + direction
        if new_index < 0 or new_index >= len(self.order):
            return
        self.order[index], self.order[new_index] = self.order[new_index], self.order[index]
        entity = self.state.enemies[instance_id]
        self._add_log(f"Moved {entity.name} {'up' if direction < 0 else 'down'} in round order")
        self.autosave()

    def set_room_size(self, columns: int, rows: int, *, auto_place_out_of_bounds: bool = False) -> None:
        next_columns, next_rows = self._normalized_room_size(columns, rows)
        out_of_bounds = [
            entity
            for entity in self.state.enemies.values()
            if self._has_position(entity)
            and not self._position_in_bounds_for_room(entity.grid_x, entity.grid_y, next_columns, next_rows)
        ]
        if out_of_bounds and not auto_place_out_of_bounds:
            names = ", ".join(entity.name for entity in out_of_bounds[:4])
            suffix = f" and {len(out_of_bounds) - 4} more" if len(out_of_bounds) > 4 else ""
            raise BattleSessionError(f"Resize would move {len(out_of_bounds)} unit(s): {names}{suffix}")

        self.room_columns = next_columns
        self.room_rows = next_rows
        if out_of_bounds:
            for entity in out_of_bounds:
                self._set_position(entity, None, None)
            self._auto_place_unplaced_entities([entity.instance_id for entity in out_of_bounds])

        self._add_log(f"Battle map resized to {self.room_columns}x{self.room_rows}")
        self.autosave()

    def set_entity_position(self, instance_id: str, x: int, y: int) -> None:
        entity = self.state.enemies.get(instance_id)
        if not entity:
            raise BattleSessionError(f"Entity '{instance_id}' does not exist")
        x = int(x)
        y = int(y)
        if not self._position_in_bounds(x, y):
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is outside the battle map")
        occupying = self._entity_at_position(x, y, exclude_id=instance_id)
        if occupying:
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is occupied by {occupying.name}")

        self._set_position(entity, x, y)
        self.selected_id = instance_id
        self._add_log(f"Moved {entity.name} to ({x + 1}, {y + 1})")
        self.autosave()

    def draw_turn(self) -> None:
        entity = self._require_selected_enemy()
        if self.active_turn_id is not None and self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Another enemy has the active turn. End that turn first.")

        self.active_turn_id = entity.instance_id
        self.turn_in_progress = True

        result = enemy_turn(entity, rnd=self._rng)
        self._set_visible_draw(entity, list(result.drawn))

        guard_added = 0
        for card_id in result.drawn:
            card = self.context.card_index.get(card_id)
            if not card:
                continue
            for effect in card.effects:
                if effect.type == "guard":
                    apply_heal(entity, guard=int(effect.amount))
                    guard_added += int(effect.amount)

        if result.drawn:
            drawn_text = ", ".join(self.card_to_effect_text(card_id) for card_id in result.drawn)
            suffix = f" (+{guard_added} guard)" if guard_added else ""
            self._add_log(f"{entity.name} draws: {drawn_text}{suffix}")
        else:
            self._add_log(f"{entity.name} draws no cards")

        self.autosave()

    def enemy_turn_no_draw(self) -> None:
        entity = self._require_selected_enemy()
        if self.active_turn_id is not None and self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Another enemy has the active turn. End that turn first.")

        self.active_turn_id = entity.instance_id
        self.turn_in_progress = False
        self._set_visible_draw(entity, [])
        start_log = on_turn_start(entity)
        end_log = on_turn_end(entity)
        self.active_turn_id = None
        self.turn_in_progress = False

        parts = [f"{entity.name} resolves turn without draw"]
        if start_log.dot_damage:
            parts.append(f"DOT {start_log.dot_damage}")
        if end_log.removed_statuses:
            parts.append(f"cleared {', '.join(end_log.removed_statuses)}")
        self._add_log(" | ".join(parts))
        self.autosave()

    def end_turn_selected(self) -> None:
        entity = self._require_selected_enemy()
        if self.active_turn_id is None or self.active_turn_id != entity.instance_id:
            raise BattleSessionError("End turn applies only to the active enemy.")
        if not self.turn_in_progress:
            raise BattleSessionError("Press Draw first (or use Enemy turn without draw).")

        end_turn(entity)
        self.active_turn_id = None
        self.turn_in_progress = False
        self._add_log(f"Ended turn: {entity.name}")
        self.autosave()

    def next_turn(self) -> None:
        current_turn_id = self.active_turn_id if self.active_turn_id in self.order else self.selected_id

        if self.active_turn_id is not None:
            active_enemy = self.state.enemies.get(self.active_turn_id)
            if active_enemy and not self.is_player(active_enemy):
                if self.turn_in_progress:
                    end_turn(active_enemy)
                    self._add_log(f"Ended turn: {active_enemy.name}")
            self.active_turn_id = None
            self.turn_in_progress = False

        wrapped = self._select_next_in_order(current_turn_id)
        if wrapped:
            self.round += 1
            self._add_log(f"Round {self.round} begins")

        if self.selected_id:
            entity = self.state.enemies[self.selected_id]
            self.active_turn_id = entity.instance_id
            self.turn_in_progress = False
            self._set_visible_draw(entity, [])
            self._add_log(f"Active turn: {entity.name}")
        self.autosave()

    def apply_attack_to_selected(
        self,
        *,
        damage: int,
        modifiers: list[AttackMod],
        add_burn: bool,
        add_poison: bool,
        add_slow: bool,
        add_paralyze: bool,
    ) -> None:
        entity = self._require_selected_enemy()
        effective_mods = list(modifiers)
        if add_paralyze and "paralyse" not in effective_mods:
            effective_mods.append("paralyse")

        log = apply_attack(entity, max(0, int(damage)), mods=effective_mods)
        if add_burn:
            self._add_status_stack(entity, "burn", 1)
        if add_poison:
            self._add_status_stack(entity, "poison", 1)
        if add_slow:
            self._set_transient_status(entity, "slowed")

        status_parts: list[str] = []
        if add_burn:
            status_parts.append("burn")
        if add_poison:
            status_parts.append("poison")
        if add_slow:
            status_parts.append("slowed")
        if add_paralyze:
            status_parts.append("paralyzed")

        message = (
            f"Attack on {entity.name}: {log.input_damage} in, "
            f"{log.damage_to_hp} to HP, HP {log.hp_before}->{log.hp_after}"
        )
        if status_parts:
            message += f" [{', '.join(status_parts)}]"
        self._add_log(message)
        self.autosave()

    def apply_heal_to_selected(self, *, hp: int, armor: int, magic_armor: int, guard: int) -> None:
        entity = self._require_selected_enemy()
        log = apply_heal(
            entity,
            hp=max(0, int(hp)),
            armor=max(0, int(armor)),
            magic_armor=max(0, int(magic_armor)),
            guard=max(0, int(guard)),
        )
        self._add_log(
            f"Heal on {entity.name}: HP {log.hp_before}->{log.hp_after}, "
            f"Armor {log.armor_before}->{log.armor_after}, "
            f"Magic {log.magic_armor_before}->{log.magic_armor_after}, "
            f"Guard {log.guard_before}->{log.guard_after}"
        )
        self.autosave()

    def roll_loot_for_selected(self) -> None:
        entity = self._require_selected_enemy()
        if entity.template_id == "custom":
            raise BattleSessionError("Custom enemies have no template loot.")
        template = self.context.enemy_templates.get(entity.template_id)
        if not template:
            raise BattleSessionError(f"Missing template for '{entity.name}'")
        loot_result = roll_loot(template, rnd=self._rng)
        entity.rolled_loot = {
            "currency": dict(loot_result.currency),
            "resources": dict(loot_result.resources),
            "other": list(loot_result.other),
        }
        entity.loot_rolled = True
        self._add_log(f"Loot rolled for {entity.name}")
        self.autosave()

    def save_manual(self, name: str) -> dict:
        filename = f"{safe_filename(name)}_{now_stamp()}.json"
        self._add_log(f"Manual save created: {filename}")
        payload = self._build_payload()
        path = self.context.manual_dir / filename
        save_current(path, payload)
        self.autosave()
        return {"filename": filename}

    def load_manual(self, filename: str) -> None:
        path = (self.context.manual_dir / filename).resolve()
        manual_root = self.context.manual_dir.resolve()
        if not path.is_relative_to(manual_root):
            raise BattleSessionError("Invalid save path")
        payload = load_save_payload(path)
        if not payload:
            raise BattleSessionError("Could not load save")
        self.load_from_payload(payload)
        self._add_log(f"Loaded save: {path.name}")
        self.autosave()

    def image_url_for(self, entity: EnemyInstance) -> str:
        image = getattr(entity, "image", None) or ""
        if image.startswith("http://") or image.startswith("https://"):
            return image

        image = image.replace("\\", "/").lstrip("/")
        if image.startswith("images/"):
            image = image[len("images/"):]
        if image == "bandid.png":
            image = "bandit.png"

        if not image or not (self.context.images_dir / image).exists():
            template = self.context.enemy_templates.get(getattr(entity, "template_id", ""))
            fallback = (getattr(template, "image", None) or "").replace("\\", "/").lstrip("/")
            if fallback.startswith("images/"):
                fallback = fallback[len("images/"):]
            if fallback and (self.context.images_dir / fallback).exists():
                image = fallback
            else:
                image = "anonymous.png"

        return f"/images/{image}"

    def effective_movement(self, entity: EnemyInstance) -> int:
        if "slowed" in getattr(entity, "statuses", {}):
            return max(0, int(entity.movement) // 2)
        return int(entity.movement)

    def format_statuses(self, statuses: dict) -> str:
        if not statuses:
            return "—"
        parts: list[str] = []
        for key, value in statuses.items():
            if isinstance(value, dict) and "stacks" in value:
                parts.append(f"{key}({value.get('stacks')})")
            else:
                parts.append(key)
        return ", ".join(parts)

    def card_to_effect_text(self, card_id: str) -> str:
        card = self.context.card_index.get(card_id)
        if not card:
            return card_id
        parts: list[str] = []
        for effect in card.effects:
            if effect.type == "attack":
                if effect.modifiers:
                    parts.append(f"Attack {effect.amount} ({', '.join(effect.modifiers)})")
                else:
                    parts.append(f"Attack {effect.amount}")
            elif effect.type == "guard":
                parts.append(f"Guard {effect.amount}")
            else:
                parts.append(effect.type)
        return " + ".join(parts) if parts else (card.title or card_id)

    def draw_list_to_text(self, card_ids: list[str], *, max_items: int = 3) -> str:
        if not card_ids:
            return "—"
        shown = [self.card_to_effect_text(card_id) for card_id in card_ids[:max_items]]
        suffix = f" (+{len(card_ids) - max_items} more)" if len(card_ids) > max_items else ""
        return ", ".join(shown) + suffix

    def visible_draw_for(self, entity: EnemyInstance) -> list[str]:
        return list(getattr(entity, "visible_draw", []))

    @staticmethod
    def _normalized_room_size(columns: int, rows: int) -> tuple[int, int]:
        columns = int(columns)
        rows = int(rows)
        if columns < ROOM_MIN_COLUMNS or columns > ROOM_MAX_COLUMNS:
            raise BattleSessionError(
                f"columns must be between {ROOM_MIN_COLUMNS} and {ROOM_MAX_COLUMNS}"
            )
        if rows < ROOM_MIN_ROWS or rows > ROOM_MAX_ROWS:
            raise BattleSessionError(f"rows must be between {ROOM_MIN_ROWS} and {ROOM_MAX_ROWS}")
        return columns, rows

    @staticmethod
    def _has_position(entity: EnemyInstance) -> bool:
        return getattr(entity, "grid_x", None) is not None and getattr(entity, "grid_y", None) is not None

    @staticmethod
    def _set_position(entity: EnemyInstance, x: Optional[int], y: Optional[int]) -> None:
        entity.grid_x = int(x) if x is not None else None
        entity.grid_y = int(y) if y is not None else None

    def _position_in_bounds(self, x: Optional[int], y: Optional[int]) -> bool:
        return self._position_in_bounds_for_room(x, y, self.room_columns, self.room_rows)

    @staticmethod
    def _position_in_bounds_for_room(
        x: Optional[int],
        y: Optional[int],
        columns: int,
        rows: int,
    ) -> bool:
        if x is None or y is None:
            return False
        return 0 <= int(x) < columns and 0 <= int(y) < rows

    def _clear_out_of_bounds_positions(self) -> None:
        for entity in self.state.enemies.values():
            if self._has_position(entity) and not self._position_in_bounds(entity.grid_x, entity.grid_y):
                self._set_position(entity, None, None)

    def _entity_at_position(
        self,
        x: int,
        y: int,
        *,
        exclude_id: Optional[str] = None,
    ) -> Optional[EnemyInstance]:
        for entity in self.state.enemies.values():
            if entity.instance_id == exclude_id:
                continue
            if self._has_position(entity) and int(entity.grid_x) == x and int(entity.grid_y) == y:
                return entity
        return None

    def _occupied_positions(self, *, exclude_id: Optional[str] = None) -> set[tuple[int, int]]:
        positions: set[tuple[int, int]] = set()
        for entity in self.state.enemies.values():
            if entity.instance_id == exclude_id:
                continue
            if self._has_position(entity) and self._position_in_bounds(entity.grid_x, entity.grid_y):
                positions.add((int(entity.grid_x), int(entity.grid_y)))
        return positions

    def _candidate_positions(self) -> list[tuple[int, int]]:
        center_x = (self.room_columns - 1) / 2
        center_y = (self.room_rows - 1) / 2
        positions = [
            (x, y)
            for y in range(self.room_rows)
            for x in range(self.room_columns)
        ]
        return sorted(
            positions,
            key=lambda pos: (abs(pos[0] - center_x) + abs(pos[1] - center_y), pos[1], pos[0]),
        )

    def _first_free_position(self, *, exclude_id: Optional[str] = None) -> Optional[tuple[int, int]]:
        occupied = self._occupied_positions(exclude_id=exclude_id)
        for position in self._candidate_positions():
            if position not in occupied:
                return position
        return None

    def _auto_place_entity(self, entity: EnemyInstance) -> bool:
        if self._has_position(entity) and self._position_in_bounds(entity.grid_x, entity.grid_y):
            return True
        position = self._first_free_position(exclude_id=entity.instance_id)
        if position is None:
            self._set_position(entity, None, None)
            return False
        self._set_position(entity, position[0], position[1])
        return True

    def _auto_place_unplaced_entities(self, instance_ids: Optional[list[str]] = None) -> None:
        ids = instance_ids if instance_ids is not None else self._ordered_enemy_ids()
        for instance_id in ids:
            entity = self.state.enemies.get(instance_id)
            if entity and not (self._has_position(entity) and self._position_in_bounds(entity.grid_x, entity.grid_y)):
                self._auto_place_entity(entity)

    def _ordered_enemy_ids(self) -> list[str]:
        ordered = [instance_id for instance_id in self.order if instance_id in self.state.enemies]
        unordered = [instance_id for instance_id in self.state.enemies.keys() if instance_id not in ordered]
        return ordered + unordered

    def _serialize_enemy(self, instance_id: str) -> dict:
        entity = self.state.enemies[instance_id]
        payload = enemy_to_dict(entity)
        payload.update(
            {
                "image_url": self.image_url_for(entity),
                "is_player": self.is_player(entity),
                "is_down": self.is_down(entity),
                "effective_movement": self.effective_movement(entity),
                "status_text": self.format_statuses(entity.statuses),
                "current_draw_text": [self.card_to_effect_text(card_id) for card_id in self.visible_draw_for(entity)],
            }
        )
        return payload

    def _add_log(self, message: str) -> None:
        self.combat_log = [message, *self.combat_log][:LOG_LIMIT]

    @staticmethod
    def _set_visible_draw(entity: EnemyInstance, card_ids: list[str]) -> None:
        entity.visible_draw = list(card_ids)

    def _ensure_selected(self) -> None:
        if self.selected_id and self.selected_id not in self.state.enemies:
            self.selected_id = None
        if self.selected_id is None and self.order:
            self.selected_id = self.order[0]

    def _select_next_in_order(self, current_id: Optional[str] = None) -> bool:
        if not self.order:
            self.selected_id = None
            return False
        anchor_id = current_id if current_id in self.order else self.selected_id
        if anchor_id not in self.order:
            self.selected_id = self.order[0]
            return False
        current_index = self.order.index(anchor_id)
        next_index = (current_index + 1) % len(self.order)
        self.selected_id = self.order[next_index]
        return next_index == 0

    def _next_suffix(self, base_name: str) -> int:
        max_found = 0
        for entity in self.state.enemies.values():
            parts = entity.name.rsplit(" ", 1)
            if len(parts) == 2 and parts[0] == base_name and parts[1].isdigit():
                max_found = max(max_found, int(parts[1]))
            elif entity.name == base_name:
                max_found = max(max_found, 1)
        return max_found + 1

    def _require_selected_enemy(self) -> EnemyInstance:
        self._ensure_selected()
        if not self.selected_id:
            raise BattleSessionError("No entity selected")
        entity = self.state.enemies.get(self.selected_id)
        if not entity:
            raise BattleSessionError("Selected entity no longer exists")
        if self.is_player(entity):
            raise BattleSessionError("This action is not available for player cards")
        return entity

    def _add_status_stack(self, entity: EnemyInstance, name: str, stacks: int = 1) -> None:
        current = entity.statuses.get(name)
        if isinstance(current, dict):
            entity.statuses[name] = {"stacks": int(current.get("stacks", 0)) + stacks}
        else:
            entity.statuses[name] = {"stacks": stacks}

    def _set_transient_status(self, entity: EnemyInstance, name: str) -> None:
        entity.statuses[name] = {"stacks": 1}

    @staticmethod
    def is_player(entity: EnemyInstance) -> bool:
        return getattr(entity, "template_id", "") == "player"

    @staticmethod
    def is_down(entity: EnemyInstance) -> bool:
        return (not BattleSession.is_player(entity)) and int(getattr(entity, "hp_current", 0)) <= 0
