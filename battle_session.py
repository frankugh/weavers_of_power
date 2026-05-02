from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
import heapq
from pathlib import Path
import random
import uuid
from typing import Optional

from engine.combat import WOUND_CARD_ID, AttackMod, apply_attack, apply_heal
from engine.dungeon import analyze as dungeon_analyze
from engine.dungeon import canonical_edge_key, migrate_to_dungeon, normalize_side
from engine.loader import load_decks, load_enemies
from engine.loot import roll_loot
from engine.models import Card, Deck, EnemyTemplate
from engine.runtime import BattleState, draw_additional_cards, draw_cards, end_turn, spawn_enemy, start_turn
from engine.runtime_models import DeckState, DungeonState, DungeonWall, EnemyInstance, Tile
from persistence import (
    enemy_to_dict,
    load_save_payload,
    make_save_payload,
    restore_state_from_payload,
    save_current,
)

LOG_LIMIT = 30
UNDO_LIMIT = 20
ROOM_DEFAULT_COLUMNS = 10
ROOM_DEFAULT_ROWS = 7
PLAYER_DECK_ID = "human_fighter_lvl1"
HUMAN_FIGHTER_DEFAULTS = {
    "toughness": 4,
    "armor": 1,
    "magic_armor": 0,
    "power": 4,
    "movement": 6,
    "base_guard": 1,
    "initiative_modifier": 2,
}
SUPPORTED_QUICK_ATTACK_MODIFIERS: dict[str, AttackMod] = {
    "stab": "stab",
    "pierce": "pierce",
    "magic_pierce": "magic_pierce",
    "sunder": "sunder",
    "paralyse": "paralyse",
    "paralyze": "paralyse",
}


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
    toughness: int,
    armor: int,
    magic_armor: int,
    power: int,
    movement: int,
    core_deck: Deck,
    rnd: random.Random,
) -> EnemyInstance:
    return EnemyInstance(
        instance_id=uuid_short(),
        template_id="custom",
        name=name,
        image=None,
        toughness_current=toughness,
        toughness_max=toughness,
        armor_current=armor,
        armor_max=armor,
        magic_armor_current=magic_armor,
        magic_armor_max=magic_armor,
        guard_current=0,
        power_base=power,
        movement=movement,
        core_deck_id=core_deck.id,
        deck_state=DeckState(draw_pile=build_core_deck_ids(core_deck, rnd=rnd), discard_pile=[], hand=[]),
        statuses={},
    )


def spawn_player(
    name: str,
    *,
    toughness: int = HUMAN_FIGHTER_DEFAULTS["toughness"],
    armor: int = HUMAN_FIGHTER_DEFAULTS["armor"],
    magic_armor: int = 0,
    power: int = HUMAN_FIGHTER_DEFAULTS["power"],
    movement: int = HUMAN_FIGHTER_DEFAULTS["movement"],
    base_guard: int = HUMAN_FIGHTER_DEFAULTS["base_guard"],
    initiative_modifier: int = HUMAN_FIGHTER_DEFAULTS["initiative_modifier"],
    player_deck: Optional[Deck] = None,
    rnd: Optional[random.Random] = None,
) -> EnemyInstance:
    deck_state = DeckState(draw_pile=[], discard_pile=[], hand=[])
    if player_deck is not None:
        deck_state = DeckState(
            draw_pile=build_core_deck_ids(player_deck, rnd=rnd or random.Random()),
            discard_pile=[],
            hand=[],
        )
    return EnemyInstance(
        instance_id=uuid_short(),
        template_id="player",
        name=name,
        image=None,
        toughness_current=toughness,
        toughness_max=toughness,
        armor_current=armor,
        armor_max=armor,
        magic_armor_current=magic_armor,
        magic_armor_max=magic_armor,
        guard_base=base_guard,
        guard_current=0,
        power_base=power,
        movement=movement,
        core_deck_id=player_deck.id if player_deck is not None else None,
        initiative_modifier=initiative_modifier,
        deck_state=deck_state,
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


@dataclass(frozen=True)
class QuickAttackStep:
    card_id: str
    card_title: str
    damage: int
    modifiers: tuple[AttackMod, ...]
    unsupported_modifiers: tuple[str, ...] = ()
    manual_effects: tuple[str, ...] = ()


@dataclass(frozen=True)
class DrawResolution:
    card_ids: tuple[str, ...]
    guard_added: int = 0
    extra_drawn: int = 0


@dataclass(frozen=True)
class PlayerDrawResolution:
    card_ids: tuple[str, ...]
    extra_drawn: int = 0
    instructions: tuple[str, ...] = ()
    reshuffle_pending: bool = False


@dataclass
class BattleSessionContext:
    root: Path
    saves_dir: Optional[Path] = None
    decks_dir: Optional[Path] = None
    player_decks_dir: Optional[Path] = None
    enemies_dir: Optional[Path] = None
    images_dir: Optional[Path] = None
    save_version: int = 3

    def __post_init__(self) -> None:
        self.root = Path(self.root)
        self.decks_dir = Path(self.decks_dir) if self.decks_dir else (self.root / "data" / "decks")
        self.player_decks_dir = (
            Path(self.player_decks_dir)
            if self.player_decks_dir
            else (self.root / "data" / "player_decks")
        )
        self.enemies_dir = Path(self.enemies_dir) if self.enemies_dir else (self.root / "data" / "enemies")
        self.images_dir = Path(self.images_dir) if self.images_dir else (self.root / "images")
        self.saves_dir = Path(self.saves_dir) if self.saves_dir else (self.root / "saves")
        self.manual_dir = self.saves_dir / "manual"

        self.saves_dir.mkdir(parents=True, exist_ok=True)
        self.manual_dir.mkdir(parents=True, exist_ok=True)

        self.decks = load_decks(self.decks_dir)
        self.player_decks = load_decks(self.player_decks_dir) if self.player_decks_dir.exists() else {}
        self.enemy_templates = load_enemies(self.enemies_dir, decks=self.decks, images_dir=self.images_dir)
        self.card_index = self._build_card_index()
        self._sessions: dict[str, BattleSession] = {}

    def _build_card_index(self) -> dict[str, Card]:
        index: dict[str, Card] = {}
        for deck in self.decks.values():
            for card in deck.cards:
                index[card.id] = card
        for deck in self.player_decks.values():
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
            {
                "id": template_id,
                "name": template.name,
                "imageUrl": self.template_image_url(template),
                "category": getattr(template, "category", "Uncategorized"),
            }
            for template_id, template in sorted(self.enemy_templates.items(), key=lambda item: item[1].name.lower())
        ]
        decks = [{"id": deck_id, "name": deck.name} for deck_id, deck in sorted(self.decks.items(), key=lambda item: item[1].name.lower())]
        return {"enemyTemplates": templates, "decks": decks}

    def template_image_url(self, template: EnemyTemplate) -> str:
        image = (getattr(template, "image", None) or "").replace("\\", "/").lstrip("/")
        if image.startswith("images/"):
            image = image[len("images/"):]
        if image == "bandid.png":
            image = "Outlaws/bandit.png"
        if not image or not (self.images_dir / image).exists():
            image = "anonymous.png"
        return f"/images/{image}"

    def create_session(self, sid: Optional[str] = None) -> "BattleSession":
        session = BattleSession(context=self, sid=sid or create_sid())
        session.dungeon = migrate_to_dungeon(session.room_columns, session.room_rows, [])
        self._sessions[session.sid] = session
        session.autosave()
        return session

    def load_session(self, sid: str, *, create_if_missing: bool = True) -> "BattleSession":
        if sid in self._sessions:
            session = self._sessions[sid]
            session.turn_skip_notice = []
            return session
        session = BattleSession(context=self, sid=sid)
        payload = load_save_payload(self.current_path(sid))
        if payload:
            session.load_from_payload(payload)
            self._sessions[sid] = session
            return session
        if not create_if_missing:
            raise BattleSessionError(f"Session '{sid}' not found")
        session.dungeon = migrate_to_dungeon(session.room_columns, session.room_rows, [])
        self._sessions[sid] = session
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
    movement_state: Optional[dict] = None
    pending_new_round: bool = False
    encounter_started: bool = False
    initiative_rolled_round: Optional[int] = None
    dungeon: Optional[DungeonState] = None
    turn_skip_notice: list = field(default_factory=list)
    undo_stack: list[dict] = field(default_factory=list)
    redo_stack: list[dict] = field(default_factory=list)
    _rng: random.Random = field(default_factory=random.Random, repr=False)

    def load_from_payload(self, payload: dict, *, load_undo_stack: bool = True) -> None:
        self.state.enemies.clear()
        self.order = []
        self.selected_id = None
        self.active_turn_id = None
        self.turn_in_progress = False
        self.room_columns = ROOM_DEFAULT_COLUMNS
        self.room_rows = ROOM_DEFAULT_ROWS
        self.round = 1
        self.combat_log = []
        self.movement_state = None
        self.undo_stack = []
        self.redo_stack = []
        position_payload_present = any(
            "grid_x" in enemy_raw or "grid_y" in enemy_raw for enemy_raw in payload.get("enemies", []) or []
        )

        (
            loaded_order,
            loaded_selected,
            loaded_active,
            loaded_tip,
            loaded_room,
            loaded_movement_state,
            enemies,
            loaded_round,
            loaded_log,
            loaded_dungeon,
        ) = restore_state_from_payload(payload)
        self.room_columns = int(loaded_room.get("columns", ROOM_DEFAULT_COLUMNS) or ROOM_DEFAULT_COLUMNS)
        self.room_rows = int(loaded_room.get("rows", ROOM_DEFAULT_ROWS) or ROOM_DEFAULT_ROWS)

        for enemy in enemies:
            if self.is_player(enemy):
                self._migrate_player_deck_state(enemy)
            else:
                self._migrate_template_deck_state(enemy)
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
        self._load_movement_state(loaded_movement_state)
        ui_payload = payload.get("ui", {}) or {}
        self.pending_new_round = bool(ui_payload.get("pending_new_round", False))
        self.encounter_started = bool(ui_payload.get("encounter_started", False))
        self.initiative_rolled_round = ui_payload.get("initiative_rolled_round", None)
        self.turn_skip_notice = []
        if load_undo_stack:
            self.undo_stack = [dict(entry) for entry in payload.get("undo_stack", [])][-UNDO_LIMIT:]
            self.redo_stack = [dict(entry) for entry in payload.get("redo_stack", [])][-UNDO_LIMIT:]
        entities = list(self.state.enemies.values())
        if loaded_dungeon is not None:
            self.dungeon = loaded_dungeon
            dungeon_analyze(self.dungeon, entities)
        else:
            self.dungeon = DungeonState()
        if position_payload_present:
            self._clear_out_of_bounds_positions()
        else:
            self._auto_place_unplaced_entities()
        self._ensure_selected()

    def _build_payload(self, *, include_undo_stack: bool = True) -> dict:
        return make_save_payload(
            version=self.context.save_version,
            sid=self.sid,
            order=self.order,
            selected_id=self.selected_id,
            active_turn_id=self.active_turn_id,
            turn_in_progress=self.turn_in_progress,
            pending_new_round=self.pending_new_round,
            encounter_started=self.encounter_started,
            initiative_rolled_round=self.initiative_rolled_round,
            room={"columns": self.room_columns, "rows": self.room_rows},
            round=self.round,
            combat_log=self.combat_log,
            movement_state=self.movement_state,
            enemies=list(self.state.enemies.values()),
            dungeon=self.dungeon,
            undo_stack=self.undo_stack if include_undo_stack else None,
            redo_stack=self.redo_stack if include_undo_stack else None,
        )

    def undo_payload(self) -> dict:
        payload = self._build_payload(include_undo_stack=False)
        payload.pop("saved_at", None)
        return payload

    def remember_undo_state(self, payload: dict) -> None:
        self.undo_stack.append(dict(payload))
        if len(self.undo_stack) > UNDO_LIMIT:
            self.undo_stack = self.undo_stack[-UNDO_LIMIT:]
        self.redo_stack = []

    def autosave(self) -> None:
        save_current(self.context.current_path(self.sid), self._build_payload())

    def snapshot(self) -> dict:
        self._ensure_selected()
        initiative_target_round = (
            self.round + 1 if self.pending_new_round
            else 1 if not self.encounter_started
            else None
        )
        return {
            "sid": self.sid,
            "round": self.round,
            "pendingNewRound": self.pending_new_round,
            "encounterStarted": self.encounter_started,
            "initiativeRolledRound": self.initiative_rolled_round,
            "initiativeTargetRound": initiative_target_round,
            "canRollInitiative": not self.encounter_started or self.pending_new_round,
            "turnSkipNotice": list(self.turn_skip_notice) if self.turn_skip_notice else None,
            "selectedId": self.selected_id,
            "activeTurnId": self.active_turn_id,
            "turnInProgress": self.turn_in_progress,
            "movementState": self._movement_state_snapshot(),
            "room": {"columns": self.room_columns, "rows": self.room_rows},
            "order": list(self.order),
            "enemies": [self._serialize_enemy(instance_id) for instance_id in self._ordered_enemy_ids()],
            "combatLog": list(self.combat_log),
            "canUndo": bool(self.undo_stack),
            "undoDepth": len(self.undo_stack),
            "canRedo": bool(self.redo_stack),
            "redoDepth": len(self.redo_stack),
            "dungeon": self._dungeon_snapshot(),
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

    def delete_manual(self, filename: str) -> None:
        path = self._manual_save_path(filename)
        if not path.exists() or not path.is_file():
            raise BattleSessionError("Save not found")
        path.unlink()
        backup = path.with_suffix(path.suffix + ".bak")
        if backup.exists() and backup.is_file():
            backup.unlink()

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
        toughness: int,
        armor: int,
        magic_armor: int,
        power: int,
        movement: int,
        core_deck_id: str,
    ) -> None:
        if core_deck_id not in self.context.decks:
            raise BattleSessionError(f"Unknown deck '{core_deck_id}'")
        instance = spawn_custom_enemy(
            name=(name.strip() or "Custom"),
            toughness=max(1, int(toughness)),
            armor=max(0, int(armor)),
            magic_armor=max(0, int(magic_armor)),
            power=max(0, int(power)),
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

    def add_player(
        self,
        *,
        name: str = "",
        toughness: int = HUMAN_FIGHTER_DEFAULTS["toughness"],
        armor: int = HUMAN_FIGHTER_DEFAULTS["armor"],
        magic_armor: int = HUMAN_FIGHTER_DEFAULTS["magic_armor"],
        power: int = HUMAN_FIGHTER_DEFAULTS["power"],
        movement: int = HUMAN_FIGHTER_DEFAULTS["movement"],
        base_guard: int = HUMAN_FIGHTER_DEFAULTS["base_guard"],
        initiative_modifier: int = HUMAN_FIGHTER_DEFAULTS["initiative_modifier"],
    ) -> None:
        player_deck = self.context.player_decks.get(PLAYER_DECK_ID)
        if player_deck is None:
            raise BattleSessionError(f"Player deck '{PLAYER_DECK_ID}' is not loaded")
        resolved_name = name.strip() or f"Player {self._next_suffix('Player')}"
        instance = spawn_player(
            resolved_name,
            toughness=max(0, int(toughness)),
            armor=max(0, int(armor)),
            magic_armor=max(0, int(magic_armor)),
            power=max(0, int(power)),
            movement=max(0, int(movement)),
            base_guard=max(0, int(base_guard)),
            initiative_modifier=max(0, int(initiative_modifier)),
            player_deck=player_deck,
            rnd=self._rng,
        )
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
            self.movement_state = None
        elif self.movement_state and self.movement_state.get("entity_id") == instance_id:
            self.movement_state = None
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

    # ------------------------------------------------------------------
    # Dungeon management
    # ------------------------------------------------------------------

    @staticmethod
    def _tile_key_to_xy(key: str) -> tuple[int, int]:
        x, y = key.split(",", 1)
        return int(x), int(y)

    def _dungeon_extents(self) -> dict:
        points: list[tuple[int, int]] = []
        if self.dungeon:
            for key in self.dungeon.tiles.keys():
                points.append(self._tile_key_to_xy(key))
        for entity in self.state.enemies.values():
            if self._has_position(entity):
                points.append((int(entity.grid_x), int(entity.grid_y)))
        if not points:
            return {
                "minX": 0,
                "minY": 0,
                "maxX": -1,
                "maxY": -1,
                "width": 0,
                "height": 0,
            }
        min_x = min(x for x, _y in points)
        max_x = max(x for x, _y in points)
        min_y = min(y for _x, y in points)
        max_y = max(y for _x, y in points)
        return {
            "minX": min_x,
            "minY": min_y,
            "maxX": max_x,
            "maxY": max_y,
            "width": max_x - min_x + 1,
            "height": max_y - min_y + 1,
        }

    def _dungeon_snapshot(self) -> Optional[dict]:
        if self.dungeon is None:
            return None
        ds = self.dungeon
        tiles_out = {
            key: {"tile_type": t.tile_type}
            for key, t in ds.tiles.items()
        }
        walls_out = {
            key: {"wall_type": w.wall_type, "door_open": w.door_open}
            for key, w in ds.walls.items()
        }
        rooms_out = [
            {
                "room_id": r.room_id,
                "cells": r.cells,
            }
            for r in ds.rooms
        ]
        issues_out = [
            {
                "issue_type": i.issue_type,
                "x": i.x,
                "y": i.y,
                "side": i.side,
                "unit_id": i.unit_id,
                "detail": i.detail,
            }
            for i in ds.issues
        ]
        linked_doors_out = {
            key: list(rooms)
            for key, rooms in ds.linked_doors.items()
        }
        cell_to_room_id = {
            f"{c[0]},{c[1]}": r.room_id
            for r in ds.rooms for c in r.cells
        }
        seen: set[str] = set()
        pc_room_ids: list[str] = []
        for r in ds.rooms:
            for e in self.state.enemies.values():
                if (
                    self.is_player(e) and e.grid_x is not None and e.grid_y is not None
                    and cell_to_room_id.get(f"{e.grid_x},{e.grid_y}") == r.room_id
                    and r.room_id not in seen
                ):
                    seen.add(r.room_id)
                    pc_room_ids.append(r.room_id)
        revealed_set = set(ds.revealed_room_ids)
        if ds.fog_of_war_enabled:
            visible_ordered = [
                r.room_id for r in ds.rooms
                if r.room_id in revealed_set or r.room_id in seen
            ]
        else:
            visible_ordered = [r.room_id for r in ds.rooms]
        return {
            "tiles": tiles_out,
            "walls": walls_out,
            "rooms": rooms_out,
            "revealedRoomIds": list(ds.revealed_room_ids),
            "pendingEncounterRoomIds": list(ds.pending_encounter_room_ids),
            "fogOfWarEnabled": ds.fog_of_war_enabled,
            "currentPcRoomIds": pc_room_ids,
            "visibleRoomIds": visible_ordered,
            "extents": self._dungeon_extents(),
            "issues": issues_out,
            "analysisVersion": ds.analysis_version,
            "renderVersion": ds.render_version,
            "linkedDoors": linked_doors_out,
        }

    def _cleanup_walls_around(self) -> None:
        """Remove orphaned wall/door edges after tile changes."""
        to_delete = []
        for key, wall in self.dungeon.walls.items():
            parts = key.split(",")
            x, y, side = int(parts[0]), int(parts[1]), parts[2]
            cell_a = f"{x},{y}"
            cell_b = f"{x + 1},{y}" if side == 'e' else f"{x},{y + 1}"
            tile_a = self.dungeon.tiles.get(cell_a)
            tile_b = self.dungeon.tiles.get(cell_b)
            if wall.wall_type == "wall":
                if tile_a is None and tile_b is None:
                    to_delete.append(key)
            else:  # door
                if tile_a is None or tile_b is None:
                    to_delete.append(key)
        for key in to_delete:
            del self.dungeon.walls[key]

    def edit_dungeon_tiles(self, tile_type: str, cells: list[list[int]]) -> None:
        if tile_type not in ("floor", "void"):
            raise BattleSessionError(f"Unknown tile type '{tile_type}'")
        if self.dungeon is None:
            self.dungeon = DungeonState()
        for cell in cells:
            x, y = int(cell[0]), int(cell[1])
            key = f"{x},{y}"
            if tile_type == "void":
                if key in self.dungeon.tiles:
                    del self.dungeon.tiles[key]
                for entity in self.state.enemies.values():
                    if entity.grid_x == x and entity.grid_y == y:
                        self._set_position(entity, None, None)
                        entity.room_id = None
            else:
                self.dungeon.tiles[key] = Tile(tile_type="floor")
        self._cleanup_walls_around()
        self.dungeon.render_version += 1
        self.autosave()

    def edit_dungeon_walls(self, wall_type: str, edges: list[dict]) -> None:
        if wall_type not in ("wall", "door", "erase"):
            raise BattleSessionError(f"Unknown wall type '{wall_type}'")
        if self.dungeon is None:
            self.dungeon = DungeonState()
        for edge in edges:
            x, y, side = int(edge["x"]), int(edge["y"]), str(edge["side"])
            try:
                key = normalize_side(x, y, side)
            except ValueError as exc:
                raise BattleSessionError(str(exc)) from exc
            if wall_type == "erase":
                self.dungeon.walls.pop(key, None)
            else:
                self.dungeon.walls[key] = DungeonWall(wall_type=wall_type, door_open=False)
        self.dungeon.render_version += 1
        self.autosave()

    def analyze_dungeon(self) -> None:
        if self.dungeon is None:
            self.dungeon = DungeonState()
        dungeon_analyze(self.dungeon, list(self.state.enemies.values()))
        self.autosave()

    def set_door_state(self, x: int, y: int, side: str, open_state: bool) -> None:
        if self.dungeon is None:
            raise BattleSessionError("No dungeon loaded")
        try:
            key = normalize_side(x, y, side)
        except ValueError as exc:
            raise BattleSessionError(str(exc)) from exc
        wall = self.dungeon.walls.get(key)
        if wall is None or wall.wall_type != "door":
            raise BattleSessionError(f"No door at edge {key!r}")

        # Adjacent cells derived from canonical edge key
        parts = key.split(",")
        kx, ky, ks = int(parts[0]), int(parts[1]), parts[2]
        cell_a = (kx, ky)
        cell_b = (kx + 1, ky) if ks == 'e' else (kx, ky + 1)

        selected = self._require_selected_entity()
        if selected.grid_x is None or selected.grid_y is None:
            raise BattleSessionError("Selected unit is not on the map")
        unit_pos = (selected.grid_x, selected.grid_y)
        if unit_pos != cell_a and unit_pos != cell_b:
            raise BattleSessionError("Selected unit is not adjacent to the door")

        link = self.dungeon.linked_doors.get(key)
        if not link or len(link) != 2:
            raise BattleSessionError(f"Door at {key!r} is not linked to two rooms")
        if selected.room_id not in link:
            raise BattleSessionError("Selected unit's room is not linked to this door")

        wall.door_open = open_state
        self.dungeon.render_version += 1

        if open_state:
            new_room_id = link[1] if link[0] == selected.room_id else link[0]
            if new_room_id not in self.dungeon.revealed_room_ids:
                self.dungeon.revealed_room_ids.append(new_room_id)
            if self.encounter_started:
                units_in_new_room = [
                    e for e in self.state.enemies.values()
                    if e.room_id == new_room_id and not self.is_player(e) and not self.is_down(e)
                ]
                if units_in_new_room and new_room_id not in self.dungeon.pending_encounter_room_ids:
                    self.dungeon.pending_encounter_room_ids.append(new_room_id)
            self._add_log(f"{selected.name} opened a door.")
        else:
            self._add_log(f"{selected.name} closed a door.")

        self.autosave()

    def flush_pending_encounter_rooms(self) -> list[str]:
        """Move pending room units into the initiative order. Called at round start."""
        if not self.dungeon or not self.dungeon.pending_encounter_room_ids:
            return []
        added_ids: list[str] = []
        for room_id in list(self.dungeon.pending_encounter_room_ids):
            for entity in self.state.enemies.values():
                if (
                    entity.room_id == room_id
                    and not self.is_player(entity)
                    and not self.is_down(entity)
                    and entity.instance_id not in self.order
                ):
                    self.order.append(entity.instance_id)
                    added_ids.append(entity.instance_id)
        self.dungeon.pending_encounter_room_ids.clear()
        return added_ids

    def set_fog_of_war(self, enabled: bool) -> None:
        if self.dungeon is None:
            raise BattleSessionError("No dungeon loaded")
        self.dungeon.fog_of_war_enabled = enabled
        self.dungeon.render_version += 1
        self.autosave()

    def set_room_revealed(self, room_id: str, revealed: bool) -> None:
        if self.dungeon is None:
            raise BattleSessionError("No dungeon loaded")
        if room_id not in {r.room_id for r in self.dungeon.rooms}:
            raise BattleSessionError(f"Room '{room_id}' not found")
        if revealed:
            if room_id not in self.dungeon.revealed_room_ids:
                self.dungeon.revealed_room_ids.append(room_id)
            if self.encounter_started:
                enemies_there = [
                    e for e in self.state.enemies.values()
                    if e.room_id == room_id and not self.is_player(e) and not self.is_down(e)
                    and e.instance_id not in self.order
                ]
                if enemies_there and room_id not in self.dungeon.pending_encounter_room_ids:
                    self.dungeon.pending_encounter_room_ids.append(room_id)
        else:
            self.dungeon.revealed_room_ids = [r for r in self.dungeon.revealed_room_ids if r != room_id]
            self.dungeon.pending_encounter_room_ids = [
                r for r in self.dungeon.pending_encounter_room_ids if r != room_id
            ]
        self.dungeon.render_version += 1
        self.autosave()


    def _dungeon_blocks_cell(self, x: int, y: int) -> bool:
        """Return True if the dungeon makes cell (x,y) impassable (void/absent tile)."""
        if self.dungeon is None:
            return False
        tile = self.dungeon.tiles.get(f"{x},{y}")
        return tile is None

    def _canonical_edge_between(self, ax: int, ay: int, bx: int, by: int) -> str:
        return canonical_edge_key(ax, ay, bx, by)

    def _wall_blocks_orthogonal(self, x: int, y: int, next_x: int, next_y: int) -> bool:
        """Wall or closed door blocks straight movement between adjacent cells."""
        if not self.dungeon or not self.dungeon.walls:
            return False
        wall = self.dungeon.walls.get(self._canonical_edge_between(x, y, next_x, next_y))
        if wall is None:
            return False
        return wall.wall_type == "wall" or not wall.door_open

    def _edge_has_any_wall(self, x: int, y: int, next_x: int, next_y: int) -> bool:
        """Any wall or door (open or closed) blocks a diagonal side-passage."""
        if not self.dungeon or not self.dungeon.walls:
            return False
        return self._canonical_edge_between(x, y, next_x, next_y) in self.dungeon.walls

    def _diagonal_touches_any_wall(self, x: int, y: int, next_x: int, next_y: int) -> bool:
        """Any wall/door around a diagonal corner blocks slipping past that corner."""
        return (
            self._edge_has_any_wall(x, y, next_x, y)
            or self._edge_has_any_wall(x, y, x, next_y)
            or self._edge_has_any_wall(next_x, next_y, x, next_y)
            or self._edge_has_any_wall(next_x, next_y, next_x, y)
        )

    def _uses_sparse_dungeon_grid(self) -> bool:
        return self.dungeon is not None

    def _position_is_walkable(self, x: Optional[int], y: Optional[int]) -> bool:
        if x is None or y is None:
            return False
        if self._uses_sparse_dungeon_grid():
            return not self._dungeon_blocks_cell(int(x), int(y))
        return self._position_in_bounds_for_room(x, y, self.room_columns, self.room_rows)

    def set_entity_position(self, instance_id: str, x: int, y: int) -> None:
        entity = self.state.enemies.get(instance_id)
        if not entity:
            raise BattleSessionError(f"Entity '{instance_id}' does not exist")
        x = int(x)
        y = int(y)
        if not self._position_in_bounds(x, y):
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is outside the battle map")
        if not self._position_is_walkable(x, y):
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is not walkable")
        occupying = self._entity_at_position(x, y, exclude_id=instance_id, blocking_only=True)
        if occupying:
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is occupied by {occupying.name}")

        self._set_position(entity, x, y)
        self.selected_id = instance_id
        self._add_log(f"Repositioned {entity.name} to ({x + 1}, {y + 1})")
        self.autosave()

    def set_entity_positions(self, placements: list[dict]) -> None:
        if not placements:
            raise BattleSessionError("No positions provided")

        normalized: list[tuple[EnemyInstance, int, int]] = []
        moving_ids: set[str] = set()
        target_positions: set[tuple[int, int]] = set()

        for placement in placements:
            instance_id = str(placement.get("instanceId") or "")
            if not instance_id:
                raise BattleSessionError("Position update is missing an instanceId")
            if instance_id in moving_ids:
                raise BattleSessionError(f"Duplicate position update for '{instance_id}'")
            entity = self.state.enemies.get(instance_id)
            if not entity:
                raise BattleSessionError(f"Entity '{instance_id}' does not exist")

            try:
                x = int(placement.get("x"))
                y = int(placement.get("y"))
            except (TypeError, ValueError) as exc:
                raise BattleSessionError(f"Position update for '{instance_id}' needs numeric x and y") from exc
            if not self._position_in_bounds(x, y):
                raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is outside the battle map")
            if not self._position_is_walkable(x, y):
                raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is not walkable")
            if (x, y) in target_positions:
                raise BattleSessionError(f"Multiple units cannot move to ({x + 1}, {y + 1})")

            moving_ids.add(instance_id)
            target_positions.add((x, y))
            normalized.append((entity, x, y))

        for entity, x, y in normalized:
            occupying = self._entity_at_position(x, y, exclude_ids=moving_ids, blocking_only=True)
            if occupying:
                raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is occupied by {occupying.name}")

        for entity, x, y in normalized:
            self._set_position(entity, x, y)

        self.selected_id = normalized[0][0].instance_id
        self._add_log(f"Repositioned {len(normalized)} unit{'s' if len(normalized) != 1 else ''}")
        self.autosave()

    def copy_entity(self, instance_id: str) -> None:
        source = self.state.enemies.get(instance_id)
        if not source:
            raise BattleSessionError(f"Entity '{instance_id}' does not exist")
        if self.is_player(source):
            raise BattleSessionError("Players cannot be copied")
        if not self._has_position(source):
            raise BattleSessionError(f"{source.name} must be placed before it can be copied")

        if source.template_id == "custom":
            core_deck_id = getattr(source, "core_deck_id", None) or next(iter(self.context.decks.keys()), None)
            if not core_deck_id or core_deck_id not in self.context.decks:
                raise BattleSessionError("Custom enemy copy needs a valid core deck")
            instance = spawn_custom_enemy(
                name=f"{source.name} {self._next_suffix(source.name)}",
                toughness=int(source.toughness_max),
                armor=int(source.armor_max),
                magic_armor=int(source.magic_armor_max),
                power=int(source.power_base),
                movement=int(source.movement),
                core_deck=self.context.decks[core_deck_id],
                rnd=self._rng,
            )
            instance.image = source.image
        else:
            template = self.context.enemy_templates.get(source.template_id)
            if not template:
                raise BattleSessionError(f"Missing template for '{source.name}'")
            instance = spawn_enemy(template, self.context.decks, rnd=self._rng)
            instance.name = f"{template.name} {self._next_suffix(template.name)}"

        position = self._copy_position_for(source)
        if position is None:
            raise BattleSessionError(f"No free adjacent position found for {source.name}")

        self._set_position(instance, position[0], position[1])
        self.state.add_enemy(instance)
        if source.instance_id in self.order:
            self.order.insert(self.order.index(source.instance_id) + 1, instance.instance_id)
        else:
            self.order.append(instance.instance_id)
        self.selected_id = instance.instance_id
        self._add_log(f"Copied {source.name} to {instance.name}")
        self.autosave()

    def move_entity_with_movement(self, instance_id: str, x: int, y: int, *, dash: bool = False) -> None:
        entity = self.state.enemies.get(instance_id)
        if not entity:
            raise BattleSessionError(f"Entity '{instance_id}' does not exist")
        if self.active_turn_id != instance_id:
            raise BattleSessionError("Only the active unit can use Move.")
        if not self._has_position(entity) or not self._position_is_walkable(entity.grid_x, entity.grid_y):
            raise BattleSessionError(f"{entity.name} must be on the battle map to move")

        x = int(x)
        y = int(y)
        if not self._position_in_bounds(x, y):
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is outside the battle map")
        if not self._position_is_walkable(x, y):
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is not walkable")
        occupying = self._entity_at_position(x, y, exclude_id=instance_id, blocking_only=True)
        if occupying:
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is occupied by {occupying.name}")

        movement_state = self._movement_state_for_active()
        movement_used = int(movement_state["movement_used"])
        diagonal_steps_used = int(movement_state["diagonal_steps_used"])
        base_movement = self.effective_movement(entity)
        max_movement = base_movement * 2 if movement_state["dash_used"] else base_movement
        route = self._movement_route_cost(
            entity,
            x,
            y,
            diagonal_steps_used=diagonal_steps_used,
            max_cost=max(base_movement * 2 - movement_used, 0),
        )
        if route is None:
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is not reachable")

        move_cost, diagonal_steps = route
        next_movement_used = movement_used + move_cost
        needs_dash = next_movement_used > base_movement and not movement_state["dash_used"]
        if needs_dash and not dash:
            raise BattleSessionError("This movement requires a Dash action.")
        if needs_dash:
            max_movement = base_movement * 2
        if next_movement_used > max_movement:
            raise BattleSessionError(f"{entity.name} does not have enough movement remaining")

        self._set_position(entity, x, y)
        self.selected_id = instance_id
        movement_state["movement_used"] = next_movement_used
        movement_state["diagonal_steps_used"] = diagonal_steps_used + diagonal_steps
        movement_state["dash_used"] = bool(movement_state["dash_used"] or needs_dash)
        dash_suffix = " using Dash" if needs_dash else ""
        self._add_log(f"Moved {entity.name} to ({x + 1}, {y + 1}) for {move_cost} movement{dash_suffix}")

        if self.is_player(entity) and self.dungeon and self.encounter_started:
            _cell_to_room = {
                f"{c[0]},{c[1]}": r.room_id
                for r in self.dungeon.rooms for c in r.cells
            }
            new_rid = _cell_to_room.get(f"{x},{y}")
            entity.room_id = new_rid
            if new_rid and new_rid not in self.dungeon.revealed_room_ids:
                self.dungeon.revealed_room_ids.append(new_rid)
                enemies_there = [
                    e for e in self.state.enemies.values()
                    if e.room_id == new_rid and not self.is_player(e) and not self.is_down(e)
                ]
                if enemies_there and new_rid not in self.dungeon.pending_encounter_room_ids:
                    self.dungeon.pending_encounter_room_ids.append(new_rid)

        self.autosave()

    def draw_turn(self) -> None:
        entity = self._require_selected_entity()
        if not self._can_take_turn(entity):
            raise BattleSessionError("Down units cannot take a turn.")
        if self.active_turn_id is not None and self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Another unit has the active turn. End that turn first.")

        if self.is_player(entity):
            self._draw_player_turn(entity)
            return

        if self.turn_in_progress:
            raise BattleSessionError("This enemy has already drawn this turn.")

        if self.active_turn_id is None:
            self.active_turn_id = entity.instance_id
            self._start_turn(entity)
            self._reset_movement_state(entity.instance_id)

        result = self._draw_cards_for_turn(entity)
        self.turn_in_progress = True
        entity.quick_attack_used = False
        draw_resolution = self._resolve_draw_effects(entity, result.drawn)
        self._set_visible_draw(entity, list(draw_resolution.card_ids))

        if draw_resolution.card_ids:
            drawn_text = ", ".join(self.card_to_effect_text(card_id) for card_id in draw_resolution.card_ids)
            suffix_parts: list[str] = []
            if draw_resolution.guard_added:
                suffix_parts.append(f"+{draw_resolution.guard_added} guard")
            if draw_resolution.extra_drawn:
                suffix_parts.append(f"+{draw_resolution.extra_drawn} draw")
            suffix = f" ({', '.join(suffix_parts)})" if suffix_parts else ""
            self._add_log(f"{entity.name} draws: {drawn_text}{suffix}")
        else:
            self._add_log(f"{entity.name} draws no cards")

        self.autosave()

    def redraw_turn(self) -> None:
        entity = self._require_selected_entity()
        if self.is_player(entity):
            self._redraw_player_turn(entity)
            return

        if self.active_turn_id is None or self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Redraw applies only to the active enemy.")
        if not self.turn_in_progress:
            raise BattleSessionError("Press Draw before using Redraw.")

        self._discard_current_draw(entity)
        result = self._draw_cards_for_turn(entity)
        entity.quick_attack_used = False
        draw_resolution = self._resolve_draw_effects(entity, result.drawn)
        self._set_visible_draw(entity, list(draw_resolution.card_ids))

        if draw_resolution.card_ids:
            drawn_text = ", ".join(self.card_to_effect_text(card_id) for card_id in draw_resolution.card_ids)
            suffix_parts: list[str] = []
            if draw_resolution.guard_added:
                suffix_parts.append(f"+{draw_resolution.guard_added} guard")
            if draw_resolution.extra_drawn:
                suffix_parts.append(f"+{draw_resolution.extra_drawn} draw")
            suffix = f" ({', '.join(suffix_parts)})" if suffix_parts else ""
            self._add_log(f"{entity.name} redraws: {drawn_text}{suffix}")
        else:
            self._add_log(f"{entity.name} redraws no cards")

        self.autosave()

    def enemy_turn_no_draw(self) -> None:
        entity = self._require_selected_enemy()
        if not self._can_take_turn(entity):
            raise BattleSessionError("Down units cannot take a turn.")
        if self.active_turn_id is not None and self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Another enemy has the active turn. End that turn first.")

        if self.active_turn_id is None:
            self.active_turn_id = entity.instance_id
            self._start_turn(entity)
            self._reset_movement_state(entity.instance_id)
        self.next_turn()

    def end_turn_selected(self) -> None:
        entity = self._require_selected_entity()
        if self.active_turn_id is None or self.active_turn_id != entity.instance_id:
            raise BattleSessionError("End turn applies only to the active unit.")
        if not self.turn_in_progress:
            raise BattleSessionError("Press Draw first (or use Enemy turn without draw).")

        self._finish_turn(entity)
        self.active_turn_id = None
        self.turn_in_progress = False
        self.movement_state = None
        self.autosave()

    def _consume_surprised_skip(self, entity: EnemyInstance) -> bool:
        surprised = entity.statuses.get("surprised")
        if surprised and int(surprised.get("skipRound", 0)) == self.round:
            entity.statuses.pop("surprised")
            self._add_log(f"{entity.name} is surprised and skips round {self.round}.")
            self.turn_skip_notice.append(entity.name)
            return True
        return False

    def start_encounter(self) -> None:
        if self.active_turn_id is not None:
            raise BattleSessionError("Encounter already has an active turn.")

        if self.dungeon and self.dungeon.fog_of_war_enabled:
            _cell_to_room = {
                f"{c[0]},{c[1]}": r.room_id
                for r in self.dungeon.rooms for c in r.cells
            }
            has_pc_room = False
            for e in self.state.enemies.values():
                if self.is_player(e) and e.grid_x is not None:
                    rid = _cell_to_room.get(f"{e.grid_x},{e.grid_y}")
                    has_pc_room = has_pc_room or bool(rid)
                    if rid and rid not in self.dungeon.revealed_room_ids:
                        self.dungeon.revealed_room_ids.append(rid)
            if has_pc_room or self.dungeon.revealed_room_ids:
                _visible_ids = set(self.dungeon.revealed_room_ids)
                self.order = [
                    iid for iid in self.order
                    if (ent := self.state.enemies.get(iid)) and (
                        self.is_player(ent)
                        or (ent.grid_x is not None and _cell_to_room.get(f"{ent.grid_x},{ent.grid_y}") in _visible_ids)
                    )
                ]

        self.turn_skip_notice = []
        for instance_id in self.order:
            entity = self.state.enemies.get(instance_id)
            if not entity or not self._can_take_turn(entity):
                continue
            if self._consume_surprised_skip(entity):
                continue

            self.encounter_started = True
            self.selected_id = entity.instance_id
            self.active_turn_id = entity.instance_id
            self.turn_in_progress = False
            self._start_turn(entity)
            self._reset_movement_state(entity.instance_id)
            self._add_log(f"Active turn: {entity.name}")
            self.autosave()
            return

        self.encounter_started = True
        self.autosave()
        raise BattleSessionError("No units can start encounter.")

    def next_turn(self) -> None:
        self.turn_skip_notice = []
        current_turn_id = self.active_turn_id if self.active_turn_id in self.order else self.selected_id

        if self.active_turn_id is not None:
            active_enemy = self.state.enemies.get(self.active_turn_id)
            if active_enemy:
                self._finish_turn(active_enemy)
            self.active_turn_id = None
            self.turn_in_progress = False
            self.movement_state = None

        wrapped = self._select_next_in_order(current_turn_id)
        if wrapped:
            self.pending_new_round = True
            self._add_log(f"End of round {self.round}")
            self.autosave()
            return

        if self.selected_id:
            entity = self.state.enemies[self.selected_id]
            if self._can_take_turn(entity):
                self.active_turn_id = entity.instance_id
                self.turn_in_progress = False
                self._start_turn(entity)
                self._reset_movement_state(entity.instance_id)
                self._add_log(f"Active turn: {entity.name}")
        self.autosave()

    def start_new_round(self) -> None:
        self.turn_skip_notice = []
        self.pending_new_round = False
        self.round += 1
        self._add_log(f"Round {self.round} begins")
        added = self.flush_pending_encounter_rooms()
        for iid in added:
            e = self.state.enemies.get(iid)
            if e:
                self._add_log(f"{e.name} joins from a revealed room.")
        if added:
            for iid in added:
                entity = self.state.enemies.get(iid)
                if entity and entity.initiative_total is None:
                    roll = self._rng.randint(1, 6)
                    entity.initiative_roll = roll
                    entity.initiative_total = roll + entity.initiative_modifier
                    entity.initiative_mode = "normal"
            original_order = {iid: i for i, iid in enumerate(self.order)}
            self.order = [
                iid for iid, _, _ in sorted(
                    [
                        (iid, self.state.enemies[iid].initiative_total or 0, self.state.enemies[iid].initiative_modifier)
                        for iid in self.order
                        if iid in self.state.enemies
                    ],
                    key=lambda x: (-x[1], -x[2], original_order.get(x[0], 9999)),
                )
            ]
        for instance_id in self.order:
            entity = self.state.enemies.get(instance_id)
            if not entity or not self._can_take_turn(entity):
                continue
            if self._consume_surprised_skip(entity):
                continue
            self.selected_id = entity.instance_id
            self.active_turn_id = entity.instance_id
            self.turn_in_progress = False
            self._start_turn(entity)
            self._reset_movement_state(entity.instance_id)
            self._add_log(f"Active turn: {entity.name}")
            break
        self.autosave()

    def roll_initiative(self, modes: dict) -> None:
        target_round = (
            self.round + 1 if self.pending_new_round
            else 1 if not self.encounter_started
            else None
        )
        if target_round is None:
            raise BattleSessionError("Cannot roll initiative during an active encounter round.")

        added = self.flush_pending_encounter_rooms()
        for iid in added:
            e = self.state.enemies.get(iid)
            if e:
                self._add_log(f"{e.name} joins from a revealed room.")

        if not self.order:
            raise BattleSessionError("No units to roll initiative for.")

        original_order = {iid: i for i, iid in enumerate(self.order)}
        roll_results: list = []

        for instance_id in self.order:
            entity = self.state.enemies.get(instance_id)
            if not entity:
                continue
            mode = modes.get(instance_id, "normal")
            mod = entity.initiative_modifier
            roll = self._rng.randint(1, 6)

            if mode == "advantage":
                total = roll + 2 * mod
            elif mode == "disadvantage":
                total = roll
            else:
                total = roll + mod

            entity.initiative_roll = roll
            entity.initiative_total = total
            entity.initiative_mode = mode

            if mode == "surprised":
                entity.statuses["surprised"] = {"skipRound": target_round}
            elif "surprised" in entity.statuses and entity.statuses["surprised"].get("skipRound") == target_round:
                entity.statuses.pop("surprised")

            roll_results.append((instance_id, total, mod))

        self.order = [
            iid for iid, _, _ in sorted(
                roll_results,
                key=lambda x: (-x[1], -x[2], original_order.get(x[0], 9999)),
            )
        ]
        self.initiative_rolled_round = target_round
        self._add_log(f"Initiative rolled for round {target_round}.")
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
    ) -> Optional[dict]:
        entity = self._require_selected_entity()
        effective_mods = list(modifiers)
        if add_paralyze and "paralyse" not in effective_mods:
            effective_mods.append("paralyse")

        log = apply_attack(
            entity,
            max(0, int(damage)),
            mods=effective_mods,
            reset_toughness_on_deplete=self.is_player(entity),
        )
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
            f"{log.damage_to_hp} to Toughness, Toughness {log.toughness_before}->{log.toughness_after}"
        )
        if log.wounds_added:
            message += f", {log.wounds_added} wound{'s' if log.wounds_added != 1 else ''} added"
        if status_parts:
            message += f" [{', '.join(status_parts)}]"
        self._add_log(message)
        self.autosave()
        if log.wounds_added:
            return {
                "woundEvents": [
                    {
                        "instanceId": entity.instance_id,
                        "name": entity.name,
                        "wounds": log.wounds_added,
                        "toughnessAfter": entity.toughness_current,
                        "toughnessMax": entity.toughness_max,
                    }
                ]
            }
        return None

    def apply_quick_attack_from_active_draw(self) -> dict:
        if not self.active_turn_id:
            raise BattleSessionError("No NPC has the active turn.")
        attacker = self.state.enemies.get(self.active_turn_id)
        if not attacker:
            raise BattleSessionError("Active NPC no longer exists.")
        if self.is_player(attacker):
            raise BattleSessionError("Quick Attack is only available during NPC turns.")
        if not self.turn_in_progress:
            raise BattleSessionError("Press Draw before using Quick Attack.")
        if not attacker.deck_state.hand:
            raise BattleSessionError("Active NPC has no current draw.")
        if getattr(attacker, "quick_attack_used", False):
            raise BattleSessionError("Quick Attack has already been used for this draw.")

        target = self._require_selected_entity()
        if target.instance_id == attacker.instance_id:
            raise BattleSessionError("Select a target other than the active NPC.")
        if self.is_down(target):
            raise BattleSessionError("Quick Attack target is down.")

        steps = self._quick_attack_steps_for(attacker)
        if not steps:
            raise BattleSessionError("Current draw has no attack effects.")

        wound_total = 0
        first_toughness_before = target.toughness_current
        damage_to_toughness = 0
        labels: list[str] = []
        unsupported: list[str] = []
        manual_effects: list[str] = []

        for step in steps:
            log = apply_attack(
                target,
                max(0, int(step.damage)),
                mods=list(step.modifiers),
                reset_toughness_on_deplete=self.is_player(target),
            )
            wound_total += log.wounds_added
            damage_to_toughness += log.damage_to_hp
            labels.append(self._quick_attack_label(step))
            unsupported.extend(step.unsupported_modifiers)
            manual_effects.extend(step.manual_effects)

        manual_items = self._unique_preserve_order([*unsupported, *manual_effects])
        attacks_text = ", ".join(labels)
        message = (
            f"Quick Attack by {attacker.name} on {target.name}: {attacks_text}; "
            f"{damage_to_toughness} to Toughness, Toughness {first_toughness_before}->{target.toughness_current}"
        )
        if wound_total:
            message += f", {wound_total} wound{'s' if wound_total != 1 else ''} added"
        if manual_items:
            message += f"; handle manually: {', '.join(manual_items)}"
        attacker.quick_attack_used = True
        self._add_log(message)
        self.autosave()

        notice = f"Quick Attack: {attacker.name} attacks {target.name} with {attacks_text}."
        if manual_items:
            notice += f" Handle manually: {', '.join(manual_items)}."

        result = {
            "quickAttack": {
                "attackerId": attacker.instance_id,
                "attackerName": attacker.name,
                "targetId": target.instance_id,
                "targetName": target.name,
                "attacks": [self._quick_attack_payload(step) for step in steps],
                "manualItems": manual_items,
            },
            "quickAttackNotice": notice,
        }
        if wound_total:
            result["woundEvents"] = [
                {
                    "instanceId": target.instance_id,
                    "name": target.name,
                    "wounds": wound_total,
                    "toughnessAfter": target.toughness_current,
                    "toughnessMax": target.toughness_max,
                }
            ]
        return result

    def apply_heal_to_selected(self, *, toughness: int, armor: int, magic_armor: int, guard: int) -> None:
        entity = self._require_selected_entity()
        log = apply_heal(
            entity,
            toughness=max(0, int(toughness)),
            armor=max(0, int(armor)),
            magic_armor=max(0, int(magic_armor)),
            guard=max(0, int(guard)),
            toughness_cap=entity.toughness_max,
        )
        self._add_log(
            f"Heal on {entity.name}: Toughness {log.toughness_before}->{log.toughness_after}, "
            f"Armor {log.armor_before}->{log.armor_after}, "
            f"Magic {log.magic_armor_before}->{log.magic_armor_after}, "
            f"Guard {log.guard_before}->{log.guard_after}"
        )
        self.autosave()

    def discard_player_wound(self, instance_id: str) -> None:
        entity = self._require_player_by_id(instance_id)
        deck_state = entity.deck_state
        try:
            deck_state.hand.remove(WOUND_CARD_ID)
        except ValueError as exc:
            raise BattleSessionError(f"{entity.name} has no wound in hand to discard.") from exc

        deck_state.discard_pile.append(WOUND_CARD_ID)
        self._clear_player_ko_if_hand_is_clean(entity)
        self._add_log(f"{entity.name} discards a wound.")
        self.autosave()

    def remove_player_wound(self, instance_id: str, *, confirm_deck: bool = False) -> None:
        entity = self._require_player_by_id(instance_id)
        deck_state = entity.deck_state
        source = ""

        if WOUND_CARD_ID in deck_state.hand:
            deck_state.hand.remove(WOUND_CARD_ID)
            source = "hand"
        elif WOUND_CARD_ID in deck_state.discard_pile:
            deck_state.discard_pile.remove(WOUND_CARD_ID)
            source = "discard"
        elif WOUND_CARD_ID in deck_state.draw_pile:
            if not confirm_deck:
                raise BattleSessionError("Removing a wound from the draw pile requires confirmation.")
            deck_state.draw_pile.remove(WOUND_CARD_ID)
            source = "draw pile"
        else:
            raise BattleSessionError(f"{entity.name} has no wounds to remove.")

        self._clear_player_ko_if_hand_is_clean(entity)
        self._add_log(f"{entity.name} removes a wound from {source}.")
        self.autosave()

    def _charge_action(self, entity: EnemyInstance) -> None:
        entity.actions_used = getattr(entity, "actions_used", 0) + 1

    def channel_pc(self) -> None:
        entity = self._require_selected_entity()
        if not self.is_player(entity):
            raise BattleSessionError("Channel is only available for player characters.")
        entity.draw_bonus_pending = min(3, entity.draw_bonus_pending + 2)
        self._charge_action(entity)
        self._add_log(f"{entity.name} channels (+2 draw bonus, total pending: {entity.draw_bonus_pending})")
        self.autosave()

    def strengthen_pc(self, x: int) -> None:
        entity = self._require_selected_entity()
        if not self.is_player(entity):
            raise BattleSessionError("Strengthen is only available for player characters.")
        x = max(1, int(x))
        before = entity.toughness_current
        entity.toughness_current = min(entity.toughness_max, entity.toughness_current + x)
        gained = entity.toughness_current - before
        if gained > 0:
            entity.draw_bonus_pending = min(3, entity.draw_bonus_pending + gained)
        self._charge_action(entity)
        self._add_log(
            f"{entity.name} strengthened: +{gained} toughness "
            f"({entity.toughness_current}/{entity.toughness_max}), "
            f"draw bonus pending: {entity.draw_bonus_pending}"
        )
        self.autosave()

    def shed_wound(self) -> None:
        entity = self._require_selected_entity()
        if not self.is_player(entity):
            raise BattleSessionError("Shed is only available for player characters.")
        if WOUND_CARD_ID not in entity.deck_state.hand:
            raise BattleSessionError("No wounds in hand to shed.")
        entity.deck_state.hand.remove(WOUND_CARD_ID)
        entity.deck_state.discard_pile.append(WOUND_CARD_ID)
        self._clear_player_ko_if_hand_is_clean(entity)
        self._charge_action(entity)
        self._add_log(f"{entity.name} sheds a wound.")
        self.autosave()

    def disengage_pc(self) -> None:
        entity = self._require_selected_entity()
        if not self.is_player(entity):
            raise BattleSessionError("Disengage is only available for player characters.")
        self._charge_action(entity)
        self._add_log(f"{entity.name} disengages (no opportunity attacks this turn).")
        self.autosave()

    def help_pc(self, target_id: str) -> None:
        helper = self._require_selected_entity()
        if not self.is_player(helper):
            raise BattleSessionError("Help is only available for player characters.")
        target = self.state.enemies.get(target_id)
        if not target:
            raise BattleSessionError(f"Target not found.")
        if not self.is_player(target):
            raise BattleSessionError("Can only help player characters.")
        if target.instance_id == helper.instance_id:
            raise BattleSessionError("Cannot help yourself.")
        if helper.grid_x is None or helper.grid_y is None or target.grid_x is None or target.grid_y is None:
            raise BattleSessionError("Both units must be placed on the map to use Help.")
        dist = max(abs(helper.grid_x - target.grid_x), abs(helper.grid_y - target.grid_y))
        if dist > 1:
            raise BattleSessionError(f"{target.name} is not within 5ft.")
        target.draw_bonus_pending = min(3, target.draw_bonus_pending + 2)
        self._charge_action(helper)
        self._add_log(f"{helper.name} helps {target.name} (+2 draw bonus).")
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

    def undo(self) -> None:
        if not self.undo_stack:
            raise BattleSessionError("Nothing to undo.")
        current_payload = self.undo_payload()
        previous_payload = self.undo_stack.pop()
        remaining_undo_stack = list(self.undo_stack)
        next_redo_stack = list(self.redo_stack)
        next_redo_stack.append(current_payload)
        if len(next_redo_stack) > UNDO_LIMIT:
            next_redo_stack = next_redo_stack[-UNDO_LIMIT:]
        self.load_from_payload(previous_payload, load_undo_stack=False)
        self.undo_stack = remaining_undo_stack
        self.redo_stack = next_redo_stack
        self.autosave()

    def redo(self) -> None:
        if not self.redo_stack:
            raise BattleSessionError("Nothing to redo.")
        current_payload = self.undo_payload()
        next_payload = self.redo_stack.pop()
        remaining_redo_stack = list(self.redo_stack)
        next_undo_stack = list(self.undo_stack)
        next_undo_stack.append(current_payload)
        if len(next_undo_stack) > UNDO_LIMIT:
            next_undo_stack = next_undo_stack[-UNDO_LIMIT:]
        self.load_from_payload(next_payload, load_undo_stack=False)
        self.undo_stack = next_undo_stack
        self.redo_stack = remaining_redo_stack
        self.autosave()

    def save_manual(self, name: str) -> dict:
        filename = f"{safe_filename(name)}_{now_stamp()}.json"
        self._add_log(f"Manual save created: {filename}")
        payload = self._build_payload(include_undo_stack=False)
        path = self.context.manual_dir / filename
        save_current(path, payload)
        self.autosave()
        return {"filename": filename}

    def load_manual(self, filename: str) -> None:
        path = self._manual_save_path(filename)
        payload = load_save_payload(path)
        if not payload:
            raise BattleSessionError("Could not load save")
        self.load_from_payload(payload, load_undo_stack=False)
        self._add_log(f"Loaded save: {path.name}")
        self.autosave()

    def _manual_save_path(self, filename: str) -> Path:
        path = (self.context.manual_dir / filename).resolve()
        manual_root = self.context.manual_dir.resolve()
        if not path.is_relative_to(manual_root) or path.parent != manual_root:
            raise BattleSessionError("Invalid save path")
        return path

    def image_url_for(self, entity: EnemyInstance) -> str:
        image = getattr(entity, "image", None) or ""
        if image.startswith("http://") or image.startswith("https://"):
            return image

        image = image.replace("\\", "/").lstrip("/")
        if image.startswith("images/"):
            image = image[len("images/"):]
        if image == "bandid.png":
            image = "Outlaws/bandit.png"

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

    def _reset_movement_state(self, entity_id: Optional[str]) -> None:
        self.movement_state = (
            {
                "entity_id": entity_id,
                "movement_used": 0,
                "diagonal_steps_used": 0,
                "dash_used": False,
            }
            if entity_id
            else None
        )

    def _load_movement_state(self, movement_state: Optional[dict]) -> None:
        if not self.active_turn_id:
            self.movement_state = None
            return
        if not movement_state or movement_state.get("entity_id") != self.active_turn_id:
            self._reset_movement_state(self.active_turn_id)
            return
        self.movement_state = {
            "entity_id": self.active_turn_id,
            "movement_used": max(0, int(movement_state.get("movement_used", 0) or 0)),
            "diagonal_steps_used": max(0, int(movement_state.get("diagonal_steps_used", 0) or 0)),
            "dash_used": bool(movement_state.get("dash_used", False)),
        }

    def _movement_state_for_active(self) -> dict:
        if not self.active_turn_id:
            raise BattleSessionError("No unit has the active turn.")
        if not self.movement_state or self.movement_state.get("entity_id") != self.active_turn_id:
            self._reset_movement_state(self.active_turn_id)
        return self.movement_state

    def _movement_state_snapshot(self) -> Optional[dict]:
        if not self.active_turn_id or self.active_turn_id not in self.state.enemies:
            return None
        movement_state = self._movement_state_for_active()
        entity = self.state.enemies[self.active_turn_id]
        base_movement = self.effective_movement(entity)
        max_movement = base_movement * 2 if movement_state["dash_used"] else base_movement
        return {
            "entityId": movement_state["entity_id"],
            "movementUsed": movement_state["movement_used"],
            "diagonalStepsUsed": movement_state["diagonal_steps_used"],
            "dashUsed": movement_state["dash_used"],
            "baseMovement": base_movement,
            "maxMovement": max_movement,
            "remainingMovement": max(0, max_movement - movement_state["movement_used"]),
        }

    def _movement_route_cost(
        self,
        entity: EnemyInstance,
        target_x: int,
        target_y: int,
        *,
        diagonal_steps_used: int,
        max_cost: Optional[int] = None,
    ) -> Optional[tuple[int, int]]:
        start = (int(entity.grid_x), int(entity.grid_y))
        target = (int(target_x), int(target_y))
        if start == target:
            return (0, 0)

        occupied = self._occupied_positions(exclude_id=entity.instance_id)
        start_parity = int(diagonal_steps_used) % 2
        queue: list[tuple[int, int, int, int, int, int]] = [(0, 0, 0, start[0], start[1], start_parity)]
        best: dict[tuple[int, int, int], tuple[int, int]] = {(start[0], start[1], start_parity): (0, 0)}
        directions = [
            (-1, -1),
            (0, -1),
            (1, -1),
            (-1, 0),
            (1, 0),
            (-1, 1),
            (0, 1),
            (1, 1),
        ]

        while queue:
            cost, _neg_diagonal_steps, diagonal_steps, x, y, parity = heapq.heappop(queue)
            if best.get((x, y, parity)) != (cost, diagonal_steps):
                continue
            if (x, y) == target:
                return (cost, diagonal_steps)

            for dx, dy in directions:
                next_x = x + dx
                next_y = y + dy
                if not self._position_in_bounds(next_x, next_y):
                    continue
                if (next_x, next_y) in occupied:
                    continue
                if self._dungeon_blocks_cell(next_x, next_y):
                    continue

                is_diagonal = dx != 0 and dy != 0
                if is_diagonal:
                    if self._diagonal_touches_any_wall(x, y, next_x, next_y):
                        continue
                else:
                    if self._wall_blocks_orthogonal(x, y, next_x, next_y):
                        continue
                step_cost = 1
                next_parity = parity
                next_diagonal_steps = diagonal_steps
                if is_diagonal:
                    step_cost = 1 if parity == 0 else 2
                    next_parity = 1 - parity
                    next_diagonal_steps += 1

                next_cost = cost + step_cost
                if max_cost is not None and next_cost > max_cost:
                    continue

                key = (next_x, next_y, next_parity)
                previous = best.get(key)
                next_value = (next_cost, next_diagonal_steps)
                if previous is not None and (
                    previous[0] < next_cost
                    or (previous[0] == next_cost and previous[1] >= next_diagonal_steps)
                ):
                    continue
                best[key] = next_value
                heapq.heappush(
                    queue,
                    (next_cost, -next_diagonal_steps, next_diagonal_steps, next_x, next_y, next_parity),
                )

        return None

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
        if card_id == WOUND_CARD_ID:
            return "Wound"
        card = self.context.card_index.get(card_id)
        if not card:
            return card_id
        if self._has_player_card_metadata(card):
            return self._player_card_text(card)
        parts: list[str] = []
        for effect in card.effects:
            if effect.type == "attack":
                if effect.modifiers:
                    parts.append(f"Attack {effect.amount} ({', '.join(effect.modifiers)})")
                else:
                    parts.append(f"Attack {effect.amount}")
            elif effect.type == "guard":
                parts.append(f"Guard {effect.amount}")
            elif effect.type == "draw":
                parts.append(f"Draw {effect.amount}")
            elif effect.type == "disengage":
                parts.append(f"Disengage {effect.amount}")
            else:
                parts.append(effect.type)
        return " + ".join(parts) if parts else (card.title or card_id)

    @staticmethod
    def _has_player_card_metadata(card: Card) -> bool:
        return bool(
            card.energy_type
            or card.energy_amount
            or card.outcome
            or card.extra_draw
            or card.reshuffle
            or card.instruction
        )

    @staticmethod
    def _player_card_text(card: Card) -> str:
        energy_type = (card.energy_type or "").strip()
        outcome = (card.outcome or "").strip()
        energy_amount = max(0, int(card.energy_amount))
        if energy_type:
            if energy_type.lower() == "void" and energy_amount == 0:
                base = f"{energy_type} {outcome}".strip()
            elif energy_amount > 1:
                base = f"{energy_type} {energy_amount} energy {outcome}".strip()
            elif energy_amount == 1:
                base = f"{energy_type} energy {outcome}".strip()
            else:
                base = f"{energy_type} {outcome}".strip()
        else:
            base = outcome or card.title or card.id

        suffix_parts: list[str] = []
        instruction = (card.instruction or "").strip()
        if card.extra_draw and "draw" not in instruction.lower():
            suffix_parts.append(f"draw {int(card.extra_draw)}")
        if instruction:
            suffix_parts.append(instruction)
        if card.reshuffle:
            suffix_parts.append("reshuffle at end turn")

        return f"{base} ({'; '.join(suffix_parts)})" if suffix_parts else base

    def _player_draw_summary(self, card_ids: list[str]) -> dict:
        outcomes = {"success": 0, "fate": 0, "fail": 0}
        energies: dict[str, int] = {}
        for card_id in card_ids:
            if card_id == WOUND_CARD_ID:
                outcomes["fail"] += 1
                continue
            card = self.context.card_index.get(card_id)
            if not card:
                continue
            outcome = (card.outcome or "").strip().lower()
            if outcome in outcomes:
                outcomes[outcome] += 1
            energy_type = (card.energy_type or "").strip()
            energy_amount = max(0, int(card.energy_amount))
            if energy_type and energy_amount > 0:
                energies[energy_type] = energies.get(energy_type, 0) + energy_amount
        return {
            "outcomes": outcomes,
            "energies": dict(sorted(energies.items(), key=lambda item: item[0].lower())),
        }

    def _quick_attack_steps_for(self, entity: EnemyInstance) -> list[QuickAttackStep]:
        steps: list[QuickAttackStep] = []
        for card_id in list(entity.deck_state.hand):
            card = self.context.card_index.get(card_id)
            if not card:
                continue
            manual_effects = tuple(
                self._effect_label(effect)
                for effect in card.effects
                if effect.type not in {"attack", "guard", "draw"}
            )
            for effect in card.effects:
                if effect.type != "attack":
                    continue
                modifiers: list[AttackMod] = []
                unsupported: list[str] = []
                for modifier in effect.modifiers:
                    normalized = SUPPORTED_QUICK_ATTACK_MODIFIERS.get(str(modifier))
                    if normalized:
                        if normalized not in modifiers:
                            modifiers.append(normalized)
                    else:
                        unsupported.append(str(modifier))
                steps.append(
                    QuickAttackStep(
                        card_id=card_id,
                        card_title=card.title or card_id,
                        damage=int(effect.amount),
                        modifiers=tuple(modifiers),
                        unsupported_modifiers=tuple(unsupported),
                        manual_effects=manual_effects,
                    )
                )
        return steps

    def _quick_attack_payload(self, step: QuickAttackStep) -> dict:
        return {
            "cardId": step.card_id,
            "cardTitle": step.card_title,
            "damage": step.damage,
            "modifiers": list(step.modifiers),
            "unsupportedModifiers": list(step.unsupported_modifiers),
            "manualEffects": list(step.manual_effects),
            "label": self._quick_attack_label(step),
        }

    def _quick_attack_label(self, step: QuickAttackStep) -> str:
        if step.modifiers:
            return f"Attack {step.damage} ({', '.join(step.modifiers)})"
        return f"Attack {step.damage}"

    @staticmethod
    def _effect_label(effect) -> str:
        amount = int(getattr(effect, "amount", 0) or 0)
        return f"{effect.type} {amount}" if amount > 0 else str(effect.type)

    @staticmethod
    def _unique_preserve_order(items: list[str]) -> list[str]:
        seen: set[str] = set()
        unique: list[str] = []
        for item in items:
            if item in seen:
                continue
            seen.add(item)
            unique.append(item)
        return unique

    def draw_list_to_text(self, card_ids: list[str], *, max_items: int = 3) -> str:
        if not card_ids:
            return "—"
        shown = [self.card_to_effect_text(card_id) for card_id in card_ids[:max_items]]
        suffix = f" (+{len(card_ids) - max_items} more)" if len(card_ids) > max_items else ""
        return ", ".join(shown) + suffix

    @staticmethod
    def _wound_count(card_ids: list[str]) -> int:
        return sum(1 for card_id in card_ids if card_id == WOUND_CARD_ID)

    def _player_wound_counts(self, entity: EnemyInstance) -> dict[str, int]:
        deck_state = entity.deck_state
        hand = self._wound_count(list(deck_state.hand))
        discard = self._wound_count(list(deck_state.discard_pile))
        draw_pile = self._wound_count(list(deck_state.draw_pile))
        return {
            "hand": hand,
            "discard": discard,
            "draw_pile": draw_pile,
            "total": hand + discard + draw_pile,
        }

    def _discard_player_non_wound_hand(self, entity: EnemyInstance) -> int:
        deck_state = entity.deck_state
        kept = [card_id for card_id in deck_state.hand if card_id == WOUND_CARD_ID]
        discarded = [card_id for card_id in deck_state.hand if card_id != WOUND_CARD_ID]
        if discarded:
            deck_state.discard_pile.extend(discarded)
        deck_state.hand = kept
        return len(discarded)

    def _clear_player_ko_if_hand_is_clean(self, entity: EnemyInstance) -> None:
        if self.is_player(entity) and self._player_wound_counts(entity)["hand"] == 0:
            entity.is_ko = False

    def visible_draw_for(self, entity: EnemyInstance) -> list[str]:
        return list(getattr(entity, "visible_draw", []))

    def visible_draw_groups_for(self, entity: EnemyInstance) -> list[list[str]]:
        groups = [
            list(group)
            for group in getattr(entity, "draw_groups", [])
            if isinstance(group, list) and group
        ]
        if groups:
            return groups
        visible = self.visible_draw_for(entity)
        return [visible] if visible else []

    def _draw_player_turn(self, entity: EnemyInstance) -> None:
        if self.active_turn_id is None:
            self.active_turn_id = entity.instance_id
            self._start_turn(entity)
            self._reset_movement_state(entity.instance_id)

        if getattr(entity, "power_draw_used", False):
            raise BattleSessionError("This player has already used Draw of Power this turn. Use Redraw instead.")

        bonus = min(entity.draw_bonus_pending, 3)
        entity.draw_bonus_pending = 0
        target_count = self._draw_count_for(entity) + bonus
        hand_wounds = self._player_wound_counts(entity)["hand"]
        draw_count = max(0, target_count - hand_wounds)
        self.turn_in_progress = True
        entity.power_draw_used = True
        entity.quick_attack_used = False

        if target_count > 0 and draw_count == 0 and hand_wounds >= target_count:
            entity.is_ko = True
            self._add_log(f"{entity.name} is KO: wounds in hand prevent Draw of Power.")
            self.autosave()
            return

        result = draw_additional_cards(entity, draw_count, rnd=self._rng)
        draw_resolution = self._resolve_player_draw_effects(entity, result.drawn)
        self._append_visible_draw_group(entity, list(draw_resolution.card_ids))

        if draw_resolution.card_ids:
            drawn_text = ", ".join(self.card_to_effect_text(card_id) for card_id in draw_resolution.card_ids)
            suffix_parts: list[str] = []
            if bonus:
                suffix_parts.append(f"+{bonus} bonus")
            if hand_wounds:
                suffix_parts.append(f"-{hand_wounds} wound")
            if draw_resolution.extra_drawn:
                suffix_parts.append(f"+{draw_resolution.extra_drawn} draw")
            if draw_resolution.reshuffle_pending:
                suffix_parts.append("reshuffle pending")
            suffix = f" ({', '.join(suffix_parts)})" if suffix_parts else ""
            self._add_log(f"{entity.name} draws: {drawn_text}{suffix}")
            for instruction in draw_resolution.instructions:
                self._add_log(f"{entity.name}: {instruction}")
        else:
            self._add_log(f"{entity.name} draws no cards")

        self.autosave()

    def _redraw_player_turn(self, entity: EnemyInstance) -> None:
        if self.active_turn_id is None or self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Redraw applies only to the active player.")
        if not self.turn_in_progress or not getattr(entity, "power_draw_used", False):
            raise BattleSessionError("Press Draw before using Redraw.")

        discarded_count = self._discard_player_non_wound_hand(entity)
        self._set_visible_draw(entity, [])
        target_count = self._draw_count_for(entity)
        hand_wounds = self._player_wound_counts(entity)["hand"]
        draw_count = max(0, target_count - hand_wounds)
        entity.quick_attack_used = False

        if target_count > 0 and draw_count == 0 and hand_wounds >= target_count:
            entity.is_ko = True
            self._add_log(f"{entity.name} is KO: wounds in hand prevent Redraw.")
            self.autosave()
            return

        result = draw_additional_cards(entity, draw_count, rnd=self._rng)
        draw_resolution = self._resolve_player_draw_effects(entity, result.drawn)
        self._append_visible_draw_group(entity, list(draw_resolution.card_ids))

        if draw_resolution.card_ids:
            drawn_text = ", ".join(self.card_to_effect_text(card_id) for card_id in draw_resolution.card_ids)
            suffix_parts: list[str] = []
            if hand_wounds:
                suffix_parts.append(f"-{hand_wounds} wound")
            if discarded_count:
                suffix_parts.append(f"{discarded_count} discarded")
            if draw_resolution.extra_drawn:
                suffix_parts.append(f"+{draw_resolution.extra_drawn} draw")
            if draw_resolution.reshuffle_pending:
                suffix_parts.append("reshuffle pending")
            suffix = f" ({', '.join(suffix_parts)})" if suffix_parts else ""
            self._add_log(f"{entity.name} redraws: {drawn_text}{suffix}")
            for instruction in draw_resolution.instructions:
                self._add_log(f"{entity.name}: {instruction}")
        else:
            self._add_log(f"{entity.name} redraws no cards")

        self.autosave()

    def draw_exact_turn(self, count: int) -> None:
        entity = self._require_selected_entity()
        if not self._can_take_turn(entity):
            raise BattleSessionError("Down units cannot take a turn.")
        if not self.is_player(entity):
            raise BattleSessionError("Draw exact is only available for player characters.")
        if self.active_turn_id is not None and self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Another unit has the active turn. End that turn first.")
        count = max(1, int(count))

        if self.active_turn_id is None:
            self.active_turn_id = entity.instance_id
            self._start_turn(entity)
            self._reset_movement_state(entity.instance_id)

        self._charge_action(entity)
        result = draw_additional_cards(entity, count, rnd=self._rng)
        self.turn_in_progress = True
        entity.quick_attack_used = False

        resolved = list(result.drawn)
        instructions: list[str] = []
        for card_id in resolved:
            card = self.context.card_index.get(card_id)
            if not card:
                continue
            if card.reshuffle:
                entity.pending_reshuffle = True
            instruction = (card.instruction or "").strip()
            if instruction and instruction not in instructions:
                instructions.append(instruction)

        self._append_visible_draw_group(entity, resolved)

        if resolved:
            drawn_text = ", ".join(self.card_to_effect_text(card_id) for card_id in resolved)
            self._add_log(f"{entity.name} draws {count} (no chain): {drawn_text}")
            for instruction in instructions:
                self._add_log(f"{entity.name}: {instruction}")
        else:
            self._add_log(f"{entity.name} draws no cards")

        self.autosave()

    def _draw_count_for(self, entity: EnemyInstance) -> int:
        draws = entity.power_base
        if entity.toughness_current <= 0:
            draws = 0
        if "paralyzed" in entity.statuses:
            draws -= 1
        return max(0, int(draws))

    def _draw_cards_for_turn(self, entity: EnemyInstance):
        return draw_cards(entity, self._draw_count_for(entity), rnd=self._rng)

    def _resolve_player_draw_effects(self, entity: EnemyInstance, card_ids: list[str]) -> PlayerDrawResolution:
        resolved: list[str] = list(card_ids)
        pending: list[str] = list(card_ids)
        extra_drawn = 0
        instructions: list[str] = []
        reshuffle_pending = False
        while pending:
            card_id = pending.pop(0)
            card = self.context.card_index.get(card_id)
            if not card:
                continue
            if card.reshuffle:
                entity.pending_reshuffle = True
                reshuffle_pending = True
            instruction = (card.instruction or "").strip()
            if instruction and instruction not in instructions:
                instructions.append(instruction)
            if card.extra_draw:
                result = draw_additional_cards(entity, max(0, int(card.extra_draw)), rnd=self._rng)
                if result.drawn:
                    resolved.extend(result.drawn)
                    pending.extend(result.drawn)
                    extra_drawn += len(result.drawn)
        return PlayerDrawResolution(
            card_ids=tuple(resolved),
            extra_drawn=extra_drawn,
            instructions=tuple(instructions),
            reshuffle_pending=reshuffle_pending,
        )

    def _resolve_draw_effects(self, entity: EnemyInstance, card_ids: list[str]) -> DrawResolution:
        resolved: list[str] = list(card_ids)
        pending: list[str] = list(card_ids)
        guard_added = 0
        extra_drawn = 0
        while pending:
            card_id = pending.pop(0)
            card = self.context.card_index.get(card_id)
            if not card:
                continue
            for effect in card.effects:
                if effect.type == "guard":
                    apply_heal(entity, guard=int(effect.amount))
                    guard_added += int(effect.amount)
                elif effect.type == "draw":
                    result = draw_additional_cards(entity, max(0, int(effect.amount)), rnd=self._rng)
                    if result.drawn:
                        resolved.extend(result.drawn)
                        pending.extend(result.drawn)
                        extra_drawn += len(result.drawn)
        return DrawResolution(card_ids=tuple(resolved), guard_added=guard_added, extra_drawn=extra_drawn)

    def _guard_from_draw(self, card_ids: list[str]) -> int:
        guard_total = 0
        for card_id in card_ids:
            card = self.context.card_index.get(card_id)
            if not card:
                continue
            for effect in card.effects:
                if effect.type == "guard":
                    guard_total += int(effect.amount)
        return guard_total

    def _discard_current_draw(self, entity: EnemyInstance) -> None:
        deck_state = entity.deck_state
        previous_guard = self._guard_from_draw(list(deck_state.hand))
        if previous_guard:
            extra_guard = max(0, entity.guard_current - int(getattr(entity, "guard_base", 0)))
            entity.guard_current = max(0, entity.guard_current - min(previous_guard, extra_guard))
        if deck_state.hand:
            deck_state.discard_pile.extend(deck_state.hand)
            deck_state.hand.clear()

    def _start_turn(self, entity: EnemyInstance) -> None:
        if self.is_player(entity):
            deck_state = entity.deck_state
            wounds_in_hand = [card_id for card_id in deck_state.hand if card_id == WOUND_CARD_ID]
            deck_state.hand = [card_id for card_id in deck_state.hand if card_id != WOUND_CARD_ID]
            start_log = start_turn(entity)
            deck_state.hand = wounds_in_hand
        else:
            start_log = start_turn(entity)
        self._set_visible_draw(entity, [])
        entity.pending_reshuffle = False
        entity.quick_attack_used = False
        entity.power_draw_used = False
        entity.actions_used = 0
        if start_log.dot_damage:
            self._add_log(f"{entity.name} takes {start_log.dot_damage} DOT")

    def _finish_turn(self, entity: EnemyInstance) -> None:
        if self.is_player(entity):
            self._finish_player_turn(entity)
        else:
            end_turn(entity)
        self._add_log(f"Ended turn: {entity.name}")

    def _finish_player_turn(self, entity: EnemyInstance) -> None:
        end_turn(entity)
        if getattr(entity, "pending_reshuffle", False):
            self._reshuffle_player_deck_at_end(entity)

    def _reshuffle_player_deck_at_end(self, entity: EnemyInstance) -> None:
        deck_state = entity.deck_state
        wounds_in_hand = [card_id for card_id in deck_state.hand if card_id == WOUND_CARD_ID]
        non_wound_hand = [card_id for card_id in deck_state.hand if card_id != WOUND_CARD_ID]
        cards = list(deck_state.draw_pile) + list(deck_state.discard_pile) + non_wound_hand
        deck_state.draw_pile = cards
        deck_state.discard_pile.clear()
        deck_state.hand = wounds_in_hand
        self._rng.shuffle(deck_state.draw_pile)
        entity.pending_reshuffle = False
        self._add_log(f"{entity.name} reshuffles their deck at end of turn.")

    @staticmethod
    def _has_position(entity: EnemyInstance) -> bool:
        return getattr(entity, "grid_x", None) is not None and getattr(entity, "grid_y", None) is not None

    def _set_position(self, entity: EnemyInstance, x: Optional[int], y: Optional[int]) -> None:
        entity.grid_x = int(x) if x is not None else None
        entity.grid_y = int(y) if y is not None else None
        entity.room_id = self._room_id_for_position(entity.grid_x, entity.grid_y)

    def _room_id_for_position(self, x: Optional[int], y: Optional[int]) -> Optional[str]:
        if x is None or y is None or self.dungeon is None:
            return None
        tile = self.dungeon.tiles.get(f"{int(x)},{int(y)}")
        if tile is None:
            return None
        for room in self.dungeon.rooms:
            for cell in room.cells:
                if len(cell) >= 2 and int(cell[0]) == int(x) and int(cell[1]) == int(y):
                    return room.room_id
        return None

    def _sync_all_entity_rooms(self) -> None:
        for entity in self.state.enemies.values():
            entity.room_id = self._room_id_for_position(entity.grid_x, entity.grid_y)

    def _position_in_bounds(self, x: Optional[int], y: Optional[int]) -> bool:
        if x is None or y is None:
            return False
        if self._uses_sparse_dungeon_grid():
            return True
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
            if self._has_position(entity) and not self._position_is_walkable(entity.grid_x, entity.grid_y):
                self._set_position(entity, None, None)

    def _entity_at_position(
        self,
        x: int,
        y: int,
        *,
        exclude_id: Optional[str] = None,
        exclude_ids: Optional[set[str]] = None,
        blocking_only: bool = False,
    ) -> Optional[EnemyInstance]:
        excluded = set(exclude_ids or set())
        if exclude_id is not None:
            excluded.add(exclude_id)
        for entity in self.state.enemies.values():
            if entity.instance_id in excluded:
                continue
            if blocking_only and not self._blocks_position(entity):
                continue
            if self._has_position(entity) and int(entity.grid_x) == x and int(entity.grid_y) == y:
                return entity
        return None

    def _occupied_positions(self, *, exclude_id: Optional[str] = None) -> set[tuple[int, int]]:
        positions: set[tuple[int, int]] = set()
        for entity in self.state.enemies.values():
            if entity.instance_id == exclude_id:
                continue
            if not self._blocks_position(entity):
                continue
            if self._has_position(entity) and self._position_in_bounds(entity.grid_x, entity.grid_y):
                positions.add((int(entity.grid_x), int(entity.grid_y)))
        return positions

    @staticmethod
    def _blocks_position(entity: EnemyInstance) -> bool:
        return not BattleSession.is_down(entity)

    def _candidate_positions(self) -> list[tuple[int, int]]:
        if self._uses_sparse_dungeon_grid():
            positions: list[tuple[int, int]] = []
            for key in self.dungeon.tiles:
                x, y = self._tile_key_to_xy(key)
                positions.append((x, y))
            extents = self._dungeon_extents()
            center_x = (extents["minX"] + extents["maxX"]) / 2
            center_y = (extents["minY"] + extents["maxY"]) / 2
            return sorted(
                positions,
                key=lambda pos: (abs(pos[0] - center_x) + abs(pos[1] - center_y), pos[1], pos[0]),
            )
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

    @staticmethod
    def _clockwise_ring_offsets(radius: int) -> list[tuple[int, int]]:
        offsets: list[tuple[int, int]] = [(radius, 0)]
        for dy in range(1, radius + 1):
            offsets.append((radius, dy))
        for dx in range(radius - 1, -radius - 1, -1):
            offsets.append((dx, radius))
        for dy in range(radius - 1, -radius - 1, -1):
            offsets.append((-radius, dy))
        for dx in range(-radius + 1, radius + 1):
            offsets.append((dx, -radius))
        return offsets

    def _copy_position_for(self, source: EnemyInstance) -> Optional[tuple[int, int]]:
        sx = int(source.grid_x)
        sy = int(source.grid_y)
        occupied = self._occupied_positions()
        candidates = {
            position
            for position in self._candidate_positions()
            if position not in occupied
            and self._position_in_bounds(position[0], position[1])
            and self._position_is_walkable(position[0], position[1])
        }
        if not candidates:
            return None

        max_radius = max(max(abs(x - sx), abs(y - sy)) for x, y in candidates)
        for radius in range(1, max_radius + 1):
            for dx, dy in self._clockwise_ring_offsets(radius):
                position = (sx + dx, sy + dy)
                if position in candidates:
                    return position
        return None

    def _auto_place_entity(self, entity: EnemyInstance) -> bool:
        if self._has_position(entity) and self._position_is_walkable(entity.grid_x, entity.grid_y):
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
            if entity and not (self._has_position(entity) and self._position_is_walkable(entity.grid_x, entity.grid_y)):
                self._auto_place_entity(entity)

    def _ordered_enemy_ids(self) -> list[str]:
        ordered = [instance_id for instance_id in self.order if instance_id in self.state.enemies]
        unordered = [instance_id for instance_id in self.state.enemies.keys() if instance_id not in ordered]
        return ordered + unordered

    def _serialize_enemy(self, instance_id: str) -> dict:
        entity = self.state.enemies[instance_id]
        draw_groups = [
            {
                "label": f"Draw {index + 1}",
                "items": [self.card_to_effect_text(card_id) for card_id in group],
                "summary": self._player_draw_summary(group) if self.is_player(entity) else None,
            }
            for index, group in enumerate(self.visible_draw_groups_for(entity))
        ]
        payload = enemy_to_dict(entity)
        payload.update(
            {
                "image_url": self.image_url_for(entity),
                "is_player": self.is_player(entity),
                "is_down": self.is_down(entity),
                "is_ko": bool(getattr(entity, "is_ko", False)) if self.is_player(entity) else False,
                "quick_attack_used": bool(getattr(entity, "quick_attack_used", False)),
                "effective_movement": self.effective_movement(entity),
                "status_text": self.format_statuses(entity.statuses),
                "current_draw_groups": draw_groups,
                "current_draw_text": [self.card_to_effect_text(card_id) for card_id in self.visible_draw_for(entity)],
                "current_draw_summary": (
                    self._player_draw_summary(self.visible_draw_for(entity))
                    if self.is_player(entity)
                    else None
                ),
                "pending_reshuffle": bool(getattr(entity, "pending_reshuffle", False)),
                "draw_bonus_pending": int(getattr(entity, "draw_bonus_pending", 0)),
                "actions_used": int(getattr(entity, "actions_used", 0)),
                "wounds_in_hand": entity.deck_state.hand.count(WOUND_CARD_ID) if self.is_player(entity) else 0,
                "power_draw_used": bool(getattr(entity, "power_draw_used", False)),
                "wound_counts": self._player_wound_counts(entity) if self.is_player(entity) else None,
                "current_draw_attacks": [
                    self._quick_attack_payload(step)
                    for step in self._quick_attack_steps_for(entity)
                ],
            }
        )
        return payload

    def _add_log(self, message: str) -> None:
        self.combat_log = [message, *self.combat_log][:LOG_LIMIT]

    @staticmethod
    def _set_visible_draw(entity: EnemyInstance, card_ids: list[str]) -> None:
        entity.visible_draw = list(card_ids)
        entity.draw_groups = [list(card_ids)] if card_ids else []

    @staticmethod
    def _append_visible_draw_group(entity: EnemyInstance, card_ids: list[str]) -> None:
        groups = [
            list(group)
            for group in getattr(entity, "draw_groups", [])
            if isinstance(group, list) and group
        ]
        groups.append(list(card_ids))
        entity.draw_groups = groups
        entity.visible_draw = [card_id for group in groups for card_id in group]

    def _migrate_player_deck_state(self, entity: EnemyInstance) -> None:
        player_deck = self.context.player_decks.get(PLAYER_DECK_ID)
        if player_deck is None:
            return
        if getattr(entity, "core_deck_id", None) != PLAYER_DECK_ID:
            entity.core_deck_id = PLAYER_DECK_ID

        deck_state = entity.deck_state
        player_card_ids = {card.id for card in player_deck.cards}
        saved_cards = list(deck_state.draw_pile) + list(deck_state.discard_pile) + list(deck_state.hand)
        if any(card_id in player_card_ids for card_id in saved_cards):
            return

        deck_state.draw_pile.extend(build_core_deck_ids(player_deck, rnd=self._rng))

    def _migrate_template_deck_state(self, entity: EnemyInstance) -> None:
        template = self.context.enemy_templates.get(getattr(entity, "template_id", ""))
        if template is None:
            return
        if not getattr(entity, "core_deck_id", None):
            entity.core_deck_id = template.coreDeck
        core_deck = self.context.decks.get(template.coreDeck)
        if core_deck is None:
            return

        expected_core_ids: list[str] = []
        for card in core_deck.cards:
            expected_core_ids.extend([card.id] * card.weight)
        expected_special_counts = Counter()
        for special in template.specials:
            expected_special_counts.update({special.id: special.weight})

        expected_ids = set(expected_core_ids) | set(expected_special_counts.keys())
        deck_state = entity.deck_state
        saved_cards = list(deck_state.draw_pile) + list(deck_state.discard_pile) + list(deck_state.hand)
        if saved_cards and all(card_id in expected_ids for card_id in saved_cards):
            return

        core_pool = list(expected_core_ids)
        self._rng.shuffle(core_pool)
        special_remaining = Counter(expected_special_counts)

        def migrate_zone(card_ids: list[str]) -> list[str]:
            migrated: list[str] = []
            for card_id in card_ids:
                if special_remaining.get(card_id, 0) > 0:
                    migrated.append(card_id)
                    special_remaining[card_id] -= 1
                    continue
                if core_pool:
                    migrated.append(core_pool.pop(0))
            return migrated

        new_hand = migrate_zone(list(deck_state.hand))
        new_discard = migrate_zone(list(deck_state.discard_pile))
        new_draw = migrate_zone(list(deck_state.draw_pile))

        missing_cards = list(core_pool)
        for card_id, count in special_remaining.items():
            missing_cards.extend([card_id] * count)
        self._rng.shuffle(missing_cards)
        new_draw.extend(missing_cards)

        deck_state.hand = new_hand
        deck_state.discard_pile = new_discard
        deck_state.draw_pile = new_draw
        if getattr(entity, "visible_draw", []) or new_hand:
            self._set_visible_draw(entity, new_hand)

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
            for instance_id in self.order:
                entity = self.state.enemies.get(instance_id)
                if entity and self._can_take_turn(entity):
                    self.selected_id = instance_id
                    return False
            self.selected_id = self.order[0]
            return False
        current_index = self.order.index(anchor_id)
        for offset in range(1, len(self.order) + 1):
            next_index = (current_index + offset) % len(self.order)
            instance_id = self.order[next_index]
            entity = self.state.enemies.get(instance_id)
            if entity and self._can_take_turn(entity):
                if self._consume_surprised_skip(entity):
                    continue
                self.selected_id = instance_id
                return next_index <= current_index
        self.selected_id = anchor_id if anchor_id in self.state.enemies else self.order[0]
        return False

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
        entity = self._require_selected_entity()
        if self.is_player(entity):
            raise BattleSessionError("This action is not available for player cards")
        return entity

    def _require_selected_entity(self) -> EnemyInstance:
        self._ensure_selected()
        if not self.selected_id:
            raise BattleSessionError("No entity selected")
        entity = self.state.enemies.get(self.selected_id)
        if not entity:
            raise BattleSessionError("Selected entity no longer exists")
        return entity

    def _require_player_by_id(self, instance_id: str) -> EnemyInstance:
        entity = self.state.enemies.get(instance_id)
        if not entity:
            raise BattleSessionError(f"Entity '{instance_id}' does not exist")
        if not self.is_player(entity):
            raise BattleSessionError("Wound actions are only available for player characters.")
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
        if BattleSession.is_player(entity):
            return bool(getattr(entity, "is_ko", False))
        return int(getattr(entity, "toughness_current", 0)) <= 0

    def _can_take_turn(self, entity: EnemyInstance) -> bool:
        return not self.is_down(entity)
