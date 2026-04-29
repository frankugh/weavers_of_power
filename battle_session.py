from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import heapq
from pathlib import Path
import random
import uuid
from typing import Optional

from engine.combat import AttackMod, apply_attack, apply_heal
from engine.loader import load_decks, load_enemies
from engine.loot import roll_loot
from engine.models import Card, Deck, EnemyTemplate
from engine.runtime import BattleState, draw_cards, end_turn, spawn_enemy, start_turn
from engine.runtime_models import DeckState, EnemyInstance
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
        deck_state=DeckState(draw_pile=build_core_deck_ids(core_deck, rnd=rnd), discard_pile=[], hand=[]),
        statuses={},
    )


def spawn_player(
    name: str,
    *,
    toughness: int = 0,
    armor: int = 0,
    magic_armor: int = 0,
    power: int = 0,
    movement: int = 6,
) -> EnemyInstance:
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
        guard_current=0,
        power_base=power,
        movement=movement,
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
    movement_state: Optional[dict] = None
    pending_new_round: bool = False
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
        self._load_movement_state(loaded_movement_state)
        ui_payload = payload.get("ui", {}) or {}
        self.pending_new_round = bool(ui_payload.get("pending_new_round", False))
        if load_undo_stack:
            self.undo_stack = [dict(entry) for entry in payload.get("undo_stack", [])][-UNDO_LIMIT:]
            self.redo_stack = [dict(entry) for entry in payload.get("redo_stack", [])][-UNDO_LIMIT:]
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
            room={"columns": self.room_columns, "rows": self.room_rows},
            round=self.round,
            combat_log=self.combat_log,
            movement_state=self.movement_state,
            enemies=list(self.state.enemies.values()),
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
        return {
            "sid": self.sid,
            "round": self.round,
            "pendingNewRound": self.pending_new_round,
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
        toughness: int = 0,
        armor: int = 0,
        magic_armor: int = 0,
        power: int = 0,
        movement: int = 6,
    ) -> None:
        resolved_name = name.strip() or f"Player {self._next_suffix('Player')}"
        instance = spawn_player(
            resolved_name,
            toughness=max(0, int(toughness)),
            armor=max(0, int(armor)),
            magic_armor=max(0, int(magic_armor)),
            power=max(0, int(power)),
            movement=max(0, int(movement)),
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
        occupying = self._entity_at_position(x, y, exclude_id=instance_id, blocking_only=True)
        if occupying:
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is occupied by {occupying.name}")

        self._set_position(entity, x, y)
        self.selected_id = instance_id
        self._add_log(f"Repositioned {entity.name} to ({x + 1}, {y + 1})")
        self.autosave()

    def move_entity_with_movement(self, instance_id: str, x: int, y: int, *, dash: bool = False) -> None:
        entity = self.state.enemies.get(instance_id)
        if not entity:
            raise BattleSessionError(f"Entity '{instance_id}' does not exist")
        if self.active_turn_id != instance_id:
            raise BattleSessionError("Only the active unit can use Move.")
        if not self._has_position(entity) or not self._position_in_bounds(entity.grid_x, entity.grid_y):
            raise BattleSessionError(f"{entity.name} must be on the battle map to move")

        x = int(x)
        y = int(y)
        if not self._position_in_bounds(x, y):
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is outside the battle map")
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
        self.autosave()

    def draw_turn(self) -> None:
        entity = self._require_selected_enemy()
        if not self._can_take_turn(entity):
            raise BattleSessionError("Down units cannot take a turn.")
        if self.active_turn_id is not None and self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Another enemy has the active turn. End that turn first.")
        if self.turn_in_progress:
            raise BattleSessionError("This enemy has already drawn this turn.")

        if self.active_turn_id is None:
            self.active_turn_id = entity.instance_id
            self._start_turn(entity)
            self._reset_movement_state(entity.instance_id)

        result = self._draw_cards_for_turn(entity)
        self.turn_in_progress = True
        self._set_visible_draw(entity, list(result.drawn))

        guard_added = self._apply_draw_guard(entity, result.drawn)
        if result.drawn:
            drawn_text = ", ".join(self.card_to_effect_text(card_id) for card_id in result.drawn)
            suffix = f" (+{guard_added} guard)" if guard_added else ""
            self._add_log(f"{entity.name} draws: {drawn_text}{suffix}")
        else:
            self._add_log(f"{entity.name} draws no cards")

        self.autosave()

    def redraw_turn(self) -> None:
        entity = self._require_selected_enemy()
        if self.active_turn_id is None or self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Redraw applies only to the active enemy.")
        if not self.turn_in_progress:
            raise BattleSessionError("Press Draw before using Redraw.")

        self._discard_current_draw(entity)
        result = self._draw_cards_for_turn(entity)
        self._set_visible_draw(entity, list(result.drawn))

        guard_added = self._apply_draw_guard(entity, result.drawn)
        if result.drawn:
            drawn_text = ", ".join(self.card_to_effect_text(card_id) for card_id in result.drawn)
            suffix = f" (+{guard_added} guard)" if guard_added else ""
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
        entity = self._require_selected_enemy()
        if self.active_turn_id is None or self.active_turn_id != entity.instance_id:
            raise BattleSessionError("End turn applies only to the active enemy.")
        if not self.turn_in_progress:
            raise BattleSessionError("Press Draw first (or use Enemy turn without draw).")

        end_turn(entity)
        self.active_turn_id = None
        self.turn_in_progress = False
        self.movement_state = None
        self._add_log(f"Ended turn: {entity.name}")
        self.autosave()

    def start_encounter(self) -> None:
        if self.active_turn_id is not None:
            raise BattleSessionError("Encounter already has an active turn.")

        for instance_id in self.order:
            entity = self.state.enemies.get(instance_id)
            if not entity or not self._can_take_turn(entity):
                continue

            self.selected_id = entity.instance_id
            self.active_turn_id = entity.instance_id
            self.turn_in_progress = False
            if not self.is_player(entity):
                self._start_turn(entity)
            else:
                self._set_visible_draw(entity, [])
            self._reset_movement_state(entity.instance_id)
            self._add_log(f"Active turn: {entity.name}")
            self.autosave()
            return

        raise BattleSessionError("No units can start encounter.")

    def next_turn(self) -> None:
        current_turn_id = self.active_turn_id if self.active_turn_id in self.order else self.selected_id

        if self.active_turn_id is not None:
            active_enemy = self.state.enemies.get(self.active_turn_id)
            if active_enemy and not self.is_player(active_enemy):
                end_turn(active_enemy)
                self._add_log(f"Ended turn: {active_enemy.name}")
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
                if not self.is_player(entity):
                    self._start_turn(entity)
                self._reset_movement_state(entity.instance_id)
                self._add_log(f"Active turn: {entity.name}")
        self.autosave()

    def start_new_round(self) -> None:
        self.pending_new_round = False
        self.round += 1
        self._add_log(f"Round {self.round} begins")
        for instance_id in self.order:
            entity = self.state.enemies.get(instance_id)
            if entity and self._can_take_turn(entity):
                self.selected_id = entity.instance_id
                self.active_turn_id = entity.instance_id
                self.turn_in_progress = False
                if not self.is_player(entity):
                    self._start_turn(entity)
                self._reset_movement_state(entity.instance_id)
                self._add_log(f"Active turn: {entity.name}")
                break
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
            f"{log.damage_to_hp} to Toughness, Toughness {log.toughness_before}->{log.toughness_after}"
        )
        if status_parts:
            message += f" [{', '.join(status_parts)}]"
        self._add_log(message)
        self.autosave()

    def apply_heal_to_selected(self, *, toughness: int, armor: int, magic_armor: int, guard: int) -> None:
        entity = self._require_selected_enemy()
        log = apply_heal(
            entity,
            toughness=max(0, int(toughness)),
            armor=max(0, int(armor)),
            magic_armor=max(0, int(magic_armor)),
            guard=max(0, int(guard)),
        )
        self._add_log(
            f"Heal on {entity.name}: Toughness {log.toughness_before}->{log.toughness_after}, "
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
        path = (self.context.manual_dir / filename).resolve()
        manual_root = self.context.manual_dir.resolve()
        if not path.is_relative_to(manual_root):
            raise BattleSessionError("Invalid save path")
        payload = load_save_payload(path)
        if not payload:
            raise BattleSessionError("Could not load save")
        self.load_from_payload(payload, load_undo_stack=False)
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

                is_diagonal = dx != 0 and dy != 0
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

    def _draw_cards_for_turn(self, entity: EnemyInstance):
        draws = entity.power_base
        if entity.toughness_current <= 0:
            draws = 0
        if "paralyzed" in entity.statuses:
            draws -= 1
        if draws < 0:
            draws = 0
        return draw_cards(entity, draws, rnd=self._rng)

    def _apply_draw_guard(self, entity: EnemyInstance, card_ids: list[str]) -> int:
        guard_added = 0
        for card_id in card_ids:
            card = self.context.card_index.get(card_id)
            if not card:
                continue
            for effect in card.effects:
                if effect.type == "guard":
                    apply_heal(entity, guard=int(effect.amount))
                    guard_added += int(effect.amount)
        return guard_added

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
        start_log = start_turn(entity)
        self._set_visible_draw(entity, [])
        if start_log.dot_damage:
            self._add_log(f"{entity.name} takes {start_log.dot_damage} DOT")

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
        blocking_only: bool = False,
    ) -> Optional[EnemyInstance]:
        for entity in self.state.enemies.values():
            if entity.instance_id == exclude_id:
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
        return (not BattleSession.is_player(entity)) and int(getattr(entity, "toughness_current", 0)) <= 0

    def _can_take_turn(self, entity: EnemyInstance) -> bool:
        return not self.is_down(entity)
