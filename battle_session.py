from __future__ import annotations

from collections import Counter
import copy
from dataclasses import dataclass, field, replace
from datetime import datetime
import heapq
import json
from pathlib import Path
import random
import re
import threading
import uuid
from typing import Iterable, Optional

from engine.combat import WOUND_CARD_ID, AttackMod, apply_attack, apply_heal
from engine.character_builder import (
    CUSTOM_ART_ROOT,
    CharacterBuilderError,
    SUPPORTED_ART_EXTENSIONS,
    build_character_profile,
    build_character_art_options,
    card_from_payload,
    card_library_from_profile,
    catalog_payload,
    character_summary,
    deck_from_profile,
    load_character_catalog,
    resolve_character_art,
    slugify,
)
from engine.creature_workbook_save import (
    BACKUP_DIR_NAME,
    CreatureWorkbookSaveError,
    save_creature_overrides_to_workbook,
)
from engine.dungeon import analyze as dungeon_analyze
from engine.dungeon import canonical_edge_key, migrate_to_dungeon, normalize_side
from engine.excel_creatures import load_creatures_from_workbook, serialize_creature_action_card
from engine.loader import load_decks
from engine.loot import roll_loot
from engine.models import Card, Deck, Effect, EnemyTemplate, LootEntry
from engine.runtime import BattleState, draw_additional_cards, draw_cards, end_turn, spawn_enemy, start_turn
from engine.runtime_models import DeckState, DungeonState, DungeonWall, EnemyInstance, GrappleInstance, Tile
from persistence import (
    enemy_to_dict,
    grapple_to_dict,
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
PLACEHOLDER_PC_MELEE_WEAPON = {
    "name": "Sword",
    "kind": "martial_melee",
    "baseDamage": 2,
    "reach": 1,
}
UNPREVENTABLE_ATTACK_MODS: tuple[AttackMod, ...] = ("pierce", "magic_pierce")
SUPPORTED_QUICK_ATTACK_MODIFIERS: dict[str, AttackMod] = {
    "ranged": "ranged",
    "stab": "stab",
    "pierce": "pierce",
    "magic_pierce": "magic_pierce",
    "overwhelm": "overwhelm",
    "shatter": "shatter",
    "paralyse": "paralyse",
    "paralyze": "paralyse",
}


class BattleSessionError(ValueError):
    pass


def empty_loot_payload() -> dict:
    return {"currency": {}, "resources": {}, "other": []}


def normalize_loot_payload(raw: object) -> dict:
    if not isinstance(raw, dict):
        return empty_loot_payload()
    currency = raw.get("currency") if isinstance(raw.get("currency"), dict) else {}
    resources = raw.get("resources") if isinstance(raw.get("resources"), dict) else {}
    other = raw.get("other") if isinstance(raw.get("other"), list) else []
    return {
        "currency": dict(currency),
        "resources": dict(resources),
        "other": list(other),
    }


def merge_loot_payload(target: dict, source: dict) -> dict:
    merged = normalize_loot_payload(target)
    incoming = normalize_loot_payload(source)
    for group in ("currency", "resources"):
        for key, amount in incoming[group].items():
            try:
                value = int(amount)
            except (TypeError, ValueError):
                value = 0
            merged[group][key] = int(merged[group].get(key, 0) or 0) + value
    merged["other"].extend(incoming["other"])
    return merged


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
    physical_cards: bool = False,
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
        physical_cards=bool(physical_cards),
        physical_wounds=0,
        melee_weapon=dict(PLACEHOLDER_PC_MELEE_WEAPON),
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
    grapple_effects: tuple[Effect, ...] = ()
    charge_effects: tuple[Effect, ...] = ()
    prone_effects: tuple[Effect, ...] = ()
    conditional_attack_effects: tuple[Effect, ...] = ()


@dataclass(frozen=True)
class DrawResolution:
    card_ids: tuple[str, ...]
    guard_added: int = 0
    extra_drawn: int = 0
    reshuffle_pending: bool = False


@dataclass(frozen=True)
class PlayerDrawResolution:
    card_ids: tuple[str, ...]
    extra_drawn: int = 0
    instructions: tuple[str, ...] = ()
    reshuffle_pending: bool = False


@dataclass(frozen=True)
class MovementRoute:
    cost: int
    diagonal_steps: int
    steps: tuple[dict, ...]


@dataclass
class BattleSessionContext:
    root: Path
    saves_dir: Optional[Path] = None
    decks_dir: Optional[Path] = None
    player_decks_dir: Optional[Path] = None
    enemies_dir: Optional[Path] = None
    creatures_workbook: Optional[Path] = None
    character_catalog_path: Optional[Path] = None
    images_dir: Optional[Path] = None
    save_version: int = 3

    def __post_init__(self) -> None:
        self.root = Path(self.root)
        self.decks_dir = Path(self.decks_dir) if self.decks_dir else (self.root / "data" / "decks")
        self.creatures_workbook = (
            Path(self.creatures_workbook)
            if self.creatures_workbook
            else (self.root / "data" / "denizens_creature_database.xlsx")
        )
        self.player_decks_dir = (
            Path(self.player_decks_dir)
            if self.player_decks_dir
            else (self.root / "data" / "player_decks")
        )
        self.character_catalog_path = (
            Path(self.character_catalog_path)
            if self.character_catalog_path
            else (self.root / "data" / "character_builder_catalog.json")
        )
        self.enemies_dir = Path(self.enemies_dir) if self.enemies_dir else (self.root / "data" / "enemies")
        self.images_dir = Path(self.images_dir) if self.images_dir else (self.root / "images")
        self.saves_dir = Path(self.saves_dir) if self.saves_dir else (self.root / "saves")
        self.manual_dir = self.saves_dir / "manual"
        self.character_dir = self.saves_dir / "characters"
        self.creature_workbook_backup_dir = self.saves_dir / BACKUP_DIR_NAME
        self._creature_workbook_lock = threading.Lock()

        self.saves_dir.mkdir(parents=True, exist_ok=True)
        self.manual_dir.mkdir(parents=True, exist_ok=True)
        self.character_dir.mkdir(parents=True, exist_ok=True)

        self.decks = load_decks(self.decks_dir)
        self.player_decks = load_decks(self.player_decks_dir) if self.player_decks_dir.exists() else {}
        self.character_catalog = load_character_catalog(self.character_catalog_path)
        self.enemy_templates = {}
        self.card_index = {}
        self.reload_creature_templates()
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
            if template.action_deck:
                for card in template.action_deck.cards:
                    index[card.id] = card
            for special in template.specials:
                index[special.id] = special
        return index

    def current_path(self, sid: str) -> Path:
        return self.saves_dir / f"_current_{sid}.json"

    def character_art_options(self) -> list[dict]:
        return build_character_art_options(self.character_catalog, self.images_dir)

    def character_catalog_payload(self) -> dict:
        return catalog_payload(self.character_catalog, self.character_art_options())

    def list_character_profiles(self) -> list[dict]:
        profiles: list[dict] = []
        for path in sorted(self.character_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            payload = load_save_payload(path)
            if isinstance(payload, dict):
                profiles.append(character_summary(payload))
        return profiles

    def create_character_profile(self, request: dict) -> dict:
        base_name = slugify(str(request.get("name") or "character"))
        for index in range(1000):
            suffix = now_stamp() if index == 0 else f"{now_stamp()}_{index + 1}"
            character_id = f"{base_name}_{suffix}"
            path = self._character_profile_path(character_id)
            if not path.exists():
                break
        else:
            raise BattleSessionError("Could not create a unique character id")
        try:
            profile = build_character_profile(
                self.character_catalog,
                request,
                character_id=character_id,
                images_dir=self.images_dir,
                character_art_options=self.character_art_options(),
            )
        except CharacterBuilderError as exc:
            raise BattleSessionError(str(exc)) from exc
        save_current(path, profile)
        return {"character": character_summary(profile)}

    def save_character_art_upload(self, filename: str, content: bytes) -> dict:
        source_name = Path(filename or "character_art.png")
        ext = source_name.suffix.lower()
        if ext not in SUPPORTED_ART_EXTENSIONS:
            raise BattleSessionError("Character art must be a PNG, JPG, JPEG, or WEBP image")
        if len(content) > 8 * 1024 * 1024:
            raise BattleSessionError("Character art uploads must be 8 MB or smaller")
        if not content:
            raise BattleSessionError("Character art upload is empty")

        custom_dir = (self.images_dir / CUSTOM_ART_ROOT).resolve()
        images_root = self.images_dir.resolve()
        if not custom_dir.is_relative_to(images_root):
            raise BattleSessionError("Invalid custom art directory")
        custom_dir.mkdir(parents=True, exist_ok=True)

        base = slugify(source_name.stem, fallback="custom_art")
        for index in range(1000):
            suffix = now_stamp() if index == 0 else f"{now_stamp()}_{index + 1}"
            target = custom_dir / f"{base}_{suffix}{ext}"
            if not target.exists():
                break
        else:
            raise BattleSessionError("Could not create a unique character art filename")

        target.write_bytes(content)
        image_path = target.relative_to(self.images_dir).as_posix()
        try:
            art = resolve_character_art(
                {"source": "upload", "imagePath": image_path, "label": source_name.stem},
                images_dir=self.images_dir,
                character_art_options=self.character_art_options(),
            )
        except CharacterBuilderError as exc:
            raise BattleSessionError(str(exc)) from exc
        return {"art": art}

    def load_character_profile(self, character_id: str) -> dict:
        path = self._character_profile_path(character_id)
        payload = load_save_payload(path)
        if not isinstance(payload, dict):
            raise BattleSessionError("Character profile not found")
        return payload

    def delete_character_profile(self, character_id: str) -> dict:
        path = self._character_profile_path(character_id)
        if not path.exists():
            raise BattleSessionError("Character profile not found")
        path.unlink()
        return {"characters": self.list_character_profiles()}

    def _character_profile_path(self, character_id: str) -> Path:
        safe_id = slugify(character_id, fallback="")
        if not safe_id or safe_id != str(character_id or "").strip():
            raise BattleSessionError("Invalid character id")
        path = (self.character_dir / f"{safe_id}.json").resolve()
        character_root = self.character_dir.resolve()
        if not path.is_relative_to(character_root) or path.parent != character_root:
            raise BattleSessionError("Invalid character path")
        return path

    def reload_creature_templates(self) -> None:
        self.enemy_templates = load_creatures_from_workbook(self.creatures_workbook, images_dir=self.images_dir)
        if self.enemies_dir.exists():
            legacy_loot = self._load_legacy_loot_tables()
            for template_id, template in list(self.enemy_templates.items()):
                loot = legacy_loot.get(template_id)
                if loot and not getattr(template, "loot", ()):
                    self.enemy_templates[template_id] = replace(template, loot=loot)
        self.card_index = self._build_card_index()

    def _load_legacy_loot_tables(self) -> dict[str, tuple[LootEntry, ...]]:
        loot_by_id: dict[str, tuple[LootEntry, ...]] = {}
        for path in sorted(self.enemies_dir.rglob("*.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            template_id = str(raw.get("id") or "").strip()
            raw_loot = raw.get("loot") or []
            if not template_id or not isinstance(raw_loot, list):
                continue
            loot: list[LootEntry] = []
            for entry in raw_loot:
                if not isinstance(entry, dict) or not entry.get("type"):
                    continue
                loot.append(
                    LootEntry(
                        type=str(entry["type"]),
                        kind=entry.get("kind"),
                        min=entry.get("min"),
                        max=entry.get("max"),
                        text=entry.get("text"),
                    )
                )
            if loot:
                loot_table = tuple(loot)
                loot_by_id[template_id] = loot_table
                loot_by_id[template_id.upper()] = loot_table
                if not template_id.upper().startswith("C_"):
                    loot_by_id[f"C_{template_id.upper()}"] = loot_table
        return loot_by_id

    def save_creature_template_overrides(self, template_id: str, overrides: dict) -> dict:
        if template_id not in self.enemy_templates:
            raise BattleSessionError(f"Unknown template '{template_id}'")
        with self._creature_workbook_lock:
            try:
                save_result = save_creature_overrides_to_workbook(
                    workbook_path=self.creatures_workbook,
                    template_id=template_id,
                    overrides=overrides,
                    backup_dir=self.creature_workbook_backup_dir,
                )
                self.reload_creature_templates()
            except CreatureWorkbookSaveError as exc:
                raise BattleSessionError(str(exc)) from exc
        return {
            "metadata": self.metadata(),
            "backupFilename": save_result["backupFilename"],
            "backupPath": save_result["backupPath"],
            "updatedColumns": save_result["updatedColumns"],
        }

    def metadata(self) -> dict:
        templates = [
            {
                "id": template_id,
                "name": template.name,
                "imageUrl": self.template_image_url(template),
                "category": getattr(template, "category", "Uncategorized"),
                "part": getattr(template, "part", None),
                "section": getattr(template, "section", None),
                "threatTier": getattr(template, "threat_tier", None),
                "threatLevel": getattr(template, "threat_level", None),
                "shortFlavour": getattr(template, "short_flavour", None),
                "loreNote": getattr(template, "lore_note", None),
                "gmNote": getattr(template, "gm_note", None),
                "mechanicsNote": getattr(template, "mechanics_note", None),
                "traits": getattr(template, "traits", None),
                "size": getattr(template, "size", None),
                "skills": dict(getattr(template, "skills", {}) or {}),
                "actions": dict(getattr(template, "actions", {}) or {}),
                "simStats": self._template_sim_stats(template),
                "simActions": [
                    serialize_creature_action_card(card)
                    for card in (template.action_deck.cards if template.action_deck else tuple())
                ],
                "playtestStatus": getattr(template, "playtest_status", None),
                "spawnable": bool(getattr(template, "spawnable", True)),
                "spawnBlockers": list(getattr(template, "spawn_blockers", ()) or ()),
                "imagePath": getattr(template, "image", None),
                "imageMissing": bool(getattr(template, "image_missing", False)),
            }
            for template_id, template in sorted(self.enemy_templates.items(), key=lambda item: item[1].name.lower())
        ]
        decks = [{"id": deck_id, "name": deck.name} for deck_id, deck in sorted(self.decks.items(), key=lambda item: item[1].name.lower())]
        player_decks = [
            {"id": deck_id, "name": deck.name}
            for deck_id, deck in sorted(self.player_decks.items(), key=lambda item: item[1].name.lower())
        ]
        return {"enemyTemplates": templates, "decks": decks, "playerDecks": player_decks}

    def _template_sim_stats(self, template: EnemyTemplate) -> dict:
        def range_payload(value) -> dict:
            return {
                "min": int(value.min),
                "max": int(value.max),
                "value": int(value.min) if int(value.min) == int(value.max) else None,
            }

        return {
            "toughness": range_payload(template.hp),
            "armor": range_payload(template.armor),
            "magicArmor": range_payload(template.magicArmor),
            "baseGuard": range_payload(template.baseGuard),
            "draw": int(template.draws),
            "movement": int(template.movement),
            "initiativeModifier": int(template.initiative_modifier),
            "threatLevel": getattr(template, "threat_level", None),
        }

    def template_image_url(self, template: EnemyTemplate) -> str:
        image = (getattr(template, "image", None) or "").replace("\\", "/").lstrip("/")
        if image.startswith("images/"):
            image = image[len("images/"):]
        if image == "bandid.png":
            image = "Outlaws/bandit.png"
        if not image or not (self.images_dir / image).exists():
            image = self._derived_image_path(template) or "anonymous.png"
        return f"/images/{image}"

    def _derived_image_path(self, template: EnemyTemplate) -> str | None:
        part = getattr(template, "part", None) or ""
        section = getattr(template, "section", None) or ""
        creature_id = getattr(template, "id", None) or ""
        if not part or not section or not creature_id:
            return None
        safe = lambda s: re.sub(r"[^\w]", "_", s).strip("_")
        derived = f"{safe(part)}/{safe(section)}/{creature_id}.png"
        return derived if (self.images_dir / derived).exists() else None

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
    pending_search: Optional[dict] = None
    pending_opportunity: Optional[dict] = None
    active_save_filename: Optional[str] = None
    turn_skip_notice: list = field(default_factory=list)
    undo_stack: list[dict] = field(default_factory=list)
    redo_stack: list[dict] = field(default_factory=list)
    _rng: random.Random = field(default_factory=random.Random, repr=False)

    def load_from_payload(self, payload: dict, *, load_undo_stack: bool = True) -> None:
        self.state.enemies.clear()
        self.state.grapples.clear()
        self.order = []
        self.selected_id = None
        self.active_turn_id = None
        self.turn_in_progress = False
        self.room_columns = ROOM_DEFAULT_COLUMNS
        self.room_rows = ROOM_DEFAULT_ROWS
        self.round = 1
        self.combat_log = []
        self.movement_state = None
        self.pending_opportunity = None
        self.undo_stack = []
        self.redo_stack = []
        position_payload_present = any(
            "grid_x" in enemy_raw or "grid_y" in enemy_raw for enemy_raw in payload.get("enemies", []) or []
        )
        legacy_player_weapon_missing = {
            str(enemy_raw.get("instance_id") or "")
            for enemy_raw in payload.get("enemies", []) or []
            if enemy_raw.get("template_id") == "player" and "melee_weapon" not in enemy_raw
        }

        (
            loaded_order,
            loaded_selected,
            loaded_active,
            loaded_tip,
            loaded_room,
            loaded_movement_state,
            enemies,
            grapples,
            loaded_round,
            loaded_log,
            loaded_dungeon,
        ) = restore_state_from_payload(payload)
        self.room_columns = int(loaded_room.get("columns", ROOM_DEFAULT_COLUMNS) or ROOM_DEFAULT_COLUMNS)
        self.room_rows = int(loaded_room.get("rows", ROOM_DEFAULT_ROWS) or ROOM_DEFAULT_ROWS)

        for enemy in enemies:
            enemy.rolled_loot = normalize_loot_payload(getattr(enemy, "rolled_loot", None))
            enemy.inventory = normalize_loot_payload(getattr(enemy, "inventory", None))
            raw_loot_taken_by = getattr(enemy, "loot_taken_by", None)
            loot_taken_by = str(raw_loot_taken_by).strip() if raw_loot_taken_by is not None else ""
            enemy.loot_taken_by = loot_taken_by if loot_taken_by and loot_taken_by.lower() not in {"none", "null"} else None
            if self.is_player(enemy):
                if enemy.instance_id in legacy_player_weapon_missing:
                    enemy.melee_weapon = dict(PLACEHOLDER_PC_MELEE_WEAPON)
                self._migrate_player_deck_state(enemy)
            else:
                self._migrate_template_deck_state(enemy)
            self.state.add_enemy(enemy)
        self.state.grapples = {grapple.id: grapple for grapple in grapples}

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
        ps_raw = payload.get("pending_search")
        self.pending_search = dict(ps_raw) if isinstance(ps_raw, dict) else None
        po_raw = payload.get("pending_opportunity")
        self.pending_opportunity = copy.deepcopy(po_raw) if isinstance(po_raw, dict) else None
        active_save = payload.get("active_save_filename")
        self.active_save_filename = str(active_save) if active_save else None
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
        self._cleanup_grapples(add_log=False)

    def _build_payload(self, *, include_undo_stack: bool = True) -> dict:
        payload = make_save_payload(
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
            grapples=list(self.state.grapples.values()),
            dungeon=self.dungeon,
            undo_stack=self.undo_stack if include_undo_stack else None,
            redo_stack=self.redo_stack if include_undo_stack else None,
        )
        if self.pending_search is not None:
            payload["pending_search"] = dict(self.pending_search)
        if self.pending_opportunity is not None:
            payload["pending_opportunity"] = copy.deepcopy(self.pending_opportunity)
        payload["active_save_filename"] = self.active_save_filename
        return payload

    def undo_payload(self) -> dict:
        payload = self._build_payload(include_undo_stack=False)
        payload.pop("saved_at", None)
        return payload

    def remember_undo_state(self, payload: dict) -> None:
        self.undo_stack.append(copy.deepcopy(payload))
        if len(self.undo_stack) > UNDO_LIMIT:
            self.undo_stack = self.undo_stack[-UNDO_LIMIT:]
        self.redo_stack = []

    def autosave(self) -> None:
        save_current(self.context.current_path(self.sid), self._build_payload())

    def snapshot(self) -> dict:
        self._ensure_selected()
        self._cleanup_grapples(add_log=False)
        has_live_ordered_enemy = any(
            entity and not self.is_player(entity) and not self.is_down(entity)
            for entity in (self.state.enemies.get(instance_id) for instance_id in self.order)
        )
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
            "hasLiveOrderedEnemy": has_live_ordered_enemy,
            "initiativeRolledRound": self.initiative_rolled_round,
            "initiativeTargetRound": initiative_target_round,
            "canRollInitiative": not self.encounter_started or self.pending_new_round,
            "turnSkipNotice": list(self.turn_skip_notice) if self.turn_skip_notice else None,
            "selectedId": self.selected_id,
            "activeTurnId": self.active_turn_id,
            "turnInProgress": self.turn_in_progress,
            "movementState": self._movement_state_snapshot(),
            "pendingOpportunity": self._pending_opportunity_snapshot(),
            "room": {"columns": self.room_columns, "rows": self.room_rows},
            "order": list(self.order),
            "grapples": [self._grapple_payload(grapple) for grapple in sorted(self.state.grapples.values(), key=lambda g: g.created_order)],
            "enemies": [self._serialize_enemy(instance_id) for instance_id in self._ordered_enemy_ids()],
            "combatLog": list(self.combat_log),
            "canUndo": bool(self.undo_stack),
            "undoDepth": len(self.undo_stack),
            "canRedo": bool(self.redo_stack),
            "redoDepth": len(self.redo_stack),
            "dungeon": self._dungeon_snapshot(),
            "activeSave": self.active_save_snapshot(),
            "pendingSearch": {
                "entityId": self.pending_search["entity_id"],
                "roomId": self.pending_search["room_id"],
                "kind": self.pending_search.get("kind", "search"),
                "edgeKey": self.pending_search.get("edge_key"),
                "hasFate": self.pending_search["has_fate"],
                "successCount": self.pending_search["success_count"],
                "fateCount": self.pending_search["fate_count"],
            } if self.pending_search is not None else None,
        }

    def list_manual_saves(self) -> list[dict]:
        entries: list[dict] = []
        for path in sorted(self.context.manual_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            entries.append(self._manual_save_entry(path))
        return entries

    def active_save_snapshot(self) -> Optional[dict]:
        if not self.active_save_filename:
            return None
        try:
            path = self._manual_save_path(self.active_save_filename)
        except BattleSessionError:
            return None
        if not path.exists() or not path.is_file():
            return None
        return self._manual_save_entry(path)

    def _manual_save_entry(self, path: Path, payload: Optional[dict] = None) -> dict:
        payload = payload if payload is not None else (load_save_payload(path) or {})
        metadata = payload.get("save_slot", {}) if isinstance(payload, dict) else {}
        if not isinstance(metadata, dict):
            metadata = {}
        saved_at = payload.get("saved_at") if isinstance(payload, dict) else None
        created_at = metadata.get("createdAt") or metadata.get("created_at") or saved_at
        updated_at = metadata.get("updatedAt") or metadata.get("updated_at") or saved_at
        name = str(metadata.get("name") or path.stem)
        return {
            "filename": path.name,
            "name": name,
            "label": name,
            "createdAt": created_at,
            "updatedAt": updated_at,
            "savedAt": updated_at,
            "active": path.name == self.active_save_filename,
        }

    def delete_manual(self, filename: str) -> None:
        path = self._manual_save_path(filename)
        if not path.exists() or not path.is_file():
            raise BattleSessionError("Save not found")
        path.unlink()
        backup = path.with_suffix(path.suffix + ".bak")
        if backup.exists() and backup.is_file():
            backup.unlink()
        if self.active_save_filename == filename:
            self.active_save_filename = None
            self.autosave()

    def select(self, instance_id: str) -> None:
        if instance_id not in self.state.enemies:
            raise BattleSessionError(f"Entity '{instance_id}' does not exist")
        self.selected_id = instance_id
        self.autosave()

    def add_enemy_from_template(self, template_id: str) -> None:
        if template_id not in self.context.enemy_templates:
            raise BattleSessionError(f"Unknown template '{template_id}'")
        template = self.context.enemy_templates[template_id]
        if not getattr(template, "spawnable", True):
            blockers = ", ".join(getattr(template, "spawn_blockers", ()) or ("incomplete creature row",))
            raise BattleSessionError(f"Template '{template.name}' is not spawnable: {blockers}")
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
        player_deck_id: str = PLAYER_DECK_ID,
        physical_cards: bool = False,
    ) -> None:
        deck_id = player_deck_id or PLAYER_DECK_ID
        player_deck = self.context.player_decks.get(deck_id)
        if player_deck is None:
            raise BattleSessionError(f"Player deck '{deck_id}' is not loaded")
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
            physical_cards=physical_cards,
            rnd=self._rng,
        )
        self.state.add_enemy(instance)
        self._auto_place_entity(instance)
        self.order.append(instance.instance_id)
        self.selected_id = instance.instance_id
        self._add_log(f"Added player: {instance.name}")
        self.autosave()

    def add_player_from_character(self, character_id: str, *, physical_cards: bool = False) -> None:
        profile = self.context.load_character_profile(character_id)
        deck = deck_from_profile(profile)
        choices = profile.get("choices") or {}
        stats = choices.get("stats") or {}
        try:
            art = resolve_character_art(
                profile.get("art"),
                images_dir=self.context.images_dir,
                character_art_options=self.context.character_art_options(),
            )
        except CharacterBuilderError:
            art = {"imagePath": "anonymous.png", "imageUrl": "/images/anonymous.png", "label": "Anonymous", "source": "anonymous"}
        instance = spawn_player(
            str(profile.get("name") or "Player"),
            toughness=max(0, int(stats.get("toughness", HUMAN_FIGHTER_DEFAULTS["toughness"]) or 0)),
            armor=max(0, int(stats.get("armor", HUMAN_FIGHTER_DEFAULTS["armor"]) or 0)),
            magic_armor=max(0, int(stats.get("magicArmor", HUMAN_FIGHTER_DEFAULTS["magic_armor"]) or 0)),
            power=max(0, int(stats.get("power", HUMAN_FIGHTER_DEFAULTS["power"]) or 0)),
            movement=max(0, int(stats.get("movement", HUMAN_FIGHTER_DEFAULTS["movement"]) or 0)),
            base_guard=max(0, int(stats.get("baseGuard", HUMAN_FIGHTER_DEFAULTS["base_guard"]) or 0)),
            initiative_modifier=max(0, int(stats.get("initiativeModifier", HUMAN_FIGHTER_DEFAULTS["initiative_modifier"]) or 0)),
            player_deck=deck,
            physical_cards=physical_cards,
            rnd=self._rng,
        )
        instance.image = art.get("imagePath") or "anonymous.png"
        instance.character_profile = {
            "id": profile.get("id"),
            "name": profile.get("name"),
            "className": profile.get("className"),
            "ancestryName": profile.get("ancestryName"),
            "energyTypes": list(choices.get("energyTypes") or []),
            "mainArt": choices.get("mainArt"),
            "art": dict(art),
            "gearPreset": dict(profile.get("gearPreset") or {}),
        }
        instance.card_library = card_library_from_profile(profile)
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
        if self.pending_opportunity and (
            self.pending_opportunity.get("mover_id") == instance_id
            or instance_id in set(self.pending_opportunity.get("attacker_ids", []) or [])
        ):
            self.pending_opportunity = None
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
            key: {
                "wall_type": w.wall_type,
                "door_open": w.door_open,
                "secret_dc": getattr(w, "secret_dc", 2),
                "secret_discovered": getattr(w, "secret_discovered", False),
            }
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
            "searchedRoomIds": list(getattr(ds, "searched_room_ids", [])),
            "secretSuspects": list(getattr(ds, "secret_suspects", [])),
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

    def edit_dungeon_walls(self, wall_type: str, edges: list[dict], *, secret_dc: int = 2) -> None:
        if wall_type not in ("wall", "door", "secret_door", "erase"):
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
            elif wall_type == "secret_door":
                self.dungeon.walls[key] = DungeonWall(wall_type="secret_door", door_open=False, secret_dc=secret_dc)
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
        if wall is None or wall.wall_type not in ("door", "secret_door"):
            raise BattleSessionError(f"No door at edge {key!r}")
        if wall.wall_type == "secret_door" and not getattr(wall, "secret_discovered", False):
            raise BattleSessionError(f"Secret door at {key!r} has not been discovered yet")

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

    def _combat_is_running(self) -> bool:
        return bool(self.encounter_started or self.active_turn_id is not None or self.turn_in_progress or self.pending_new_round)

    def _visible_room_ids_for_loot(self) -> set[str]:
        if self.dungeon is None:
            return set()
        if not getattr(self.dungeon, "fog_of_war_enabled", True):
            return {room.room_id for room in self.dungeon.rooms}
        visible = set(getattr(self.dungeon, "revealed_room_ids", []) or [])
        for entity in self.state.enemies.values():
            if self.is_player(entity) and entity.room_id:
                visible.add(entity.room_id)
        return visible

    def _entity_is_visible_for_loot(self, entity: EnemyInstance) -> bool:
        if self.dungeon is None:
            return True
        return bool(entity.room_id and entity.room_id in self._visible_room_ids_for_loot())

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

    def _reveal_linked_room(self, edge_key: str, from_room_id: str) -> None:
        """Reveal the room on the other side of edge_key relative to from_room_id."""
        link = self.dungeon.linked_doors.get(edge_key)
        if not link or len(link) != 2:
            return
        other_room_id = link[1] if link[0] == from_room_id else link[0]
        if other_room_id not in self.dungeon.revealed_room_ids:
            self.dungeon.revealed_room_ids.append(other_room_id)
        if self.encounter_started:
            enemies_there = [
                e for e in self.state.enemies.values()
                if e.room_id == other_room_id and not self.is_player(e) and not self.is_down(e)
            ]
            if enemies_there and other_room_id not in self.dungeon.pending_encounter_room_ids:
                self.dungeon.pending_encounter_room_ids.append(other_room_id)

    def gm_reveal_secret_door(self, x: int, y: int, side: str) -> None:
        if self.dungeon is None:
            raise BattleSessionError("No dungeon loaded")
        try:
            key = normalize_side(x, y, side)
        except ValueError as exc:
            raise BattleSessionError(str(exc)) from exc
        wall = self.dungeon.walls.get(key)
        if wall is None or wall.wall_type != "secret_door":
            raise BattleSessionError(f"No secret door at edge {key!r}")
        wall.secret_discovered = True
        self.dungeon.render_version += 1
        self._add_log("GM revealed a secret door.")
        self.autosave()

    def gm_set_secret_door_dc(self, x: int, y: int, side: str, dc: int) -> None:
        if self.dungeon is None:
            raise BattleSessionError("No dungeon loaded")
        try:
            key = normalize_side(x, y, side)
        except ValueError as exc:
            raise BattleSessionError(str(exc)) from exc
        wall = self.dungeon.walls.get(key)
        if wall is None or wall.wall_type != "secret_door":
            raise BattleSessionError(f"No secret door at edge {key!r}")
        wall.secret_dc = max(0, int(dc))
        self._add_log(f"GM set secret door DC to {wall.secret_dc}.")
        self.autosave()

    def _secret_door_candidates_in_room(self, room_id: str) -> list[dict]:
        """Return hidden secret doors in room_id."""
        room = next((r for r in self.dungeon.rooms if r.room_id == room_id), None)
        if room is None:
            return []
        candidates = []
        for key, wall in self.dungeon.walls.items():
            if wall.wall_type != "secret_door" or getattr(wall, "secret_discovered", False):
                continue
            link = self.dungeon.linked_doors.get(key)
            if not link or room_id not in link:
                continue
            room_side_cell = self._room_side_cell_for_edge(key, room_id)
            if room_side_cell is None:
                continue
            candidates.append({
                "edge_key": key,
                "dc": max(0, int(getattr(wall, "secret_dc", 2) or 0)),
                "room_side_cell": room_side_cell,
            })
        return candidates

    def _edge_cells(self, edge_key: str) -> Optional[tuple[tuple[int, int], tuple[int, int]]]:
        try:
            kx_raw, ky_raw, side = edge_key.split(",", 2)
            kx = int(kx_raw)
            ky = int(ky_raw)
        except (AttributeError, TypeError, ValueError):
            return None
        if side == "e":
            return (kx, ky), (kx + 1, ky)
        if side == "s":
            return (kx, ky), (kx, ky + 1)
        return None

    def _room_cells(self, room_id: str) -> set[tuple[int, int]]:
        room = next((r for r in self.dungeon.rooms if r.room_id == room_id), None) if self.dungeon else None
        if room is None:
            return set()
        return {(int(c[0]), int(c[1])) for c in room.cells if len(c) >= 2}

    def _room_side_cell_for_edge(self, edge_key: str, room_id: str) -> Optional[tuple[int, int]]:
        cells = self._edge_cells(edge_key)
        if cells is None:
            return None
        cell_a, cell_b = cells
        room_cells = self._room_cells(room_id)
        if cell_a in room_cells:
            return cell_a
        if cell_b in room_cells:
            return cell_b
        return None

    def _pick_false_suspect_edge(self, room_id: str) -> Optional[str]:
        """Pick a random room perimeter edge suitable for a false suspect marker.

        Prefers edges where the far side is in an unrevealed (or no) room so
        the deception cannot trivially be seen through by the players.
        """
        room = next((r for r in self.dungeon.rooms if r.room_id == room_id), None)
        if room is None:
            return None
        room_cells = {tuple(c) for c in room.cells}

        # Map every cell to its room_id across the whole dungeon
        cell_to_room: dict[tuple[int, int], str] = {}
        for r in self.dungeon.rooms:
            for c in r.cells:
                cell_to_room[tuple(c)] = r.room_id
        revealed_set = set(getattr(self.dungeon, "revealed_room_ids", []))

        existing_suspect_edges = {s["edge_key"] for s in self.dungeon.secret_suspects}
        preferred: set[str] = set()
        fallback: set[str] = set()
        for x, y in room_cells:
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if (nx, ny) not in room_cells:
                    edge = canonical_edge_key(x, y, nx, ny)
                    wall = self.dungeon.walls.get(edge)
                    if wall is not None and wall.wall_type in ("door", "secret_door"):
                        continue
                    if edge in existing_suspect_edges:
                        continue
                    far_room = cell_to_room.get((nx, ny))
                    if far_room is None or far_room not in revealed_set:
                        preferred.add(edge)
                    else:
                        fallback.add(edge)
        candidates = preferred if preferred else fallback
        if not candidates:
            return None
        return self._rng.choice(sorted(candidates))

    def _search_position_candidates(
        self,
        room_id: str,
        anchor: tuple[int, int],
        assigned_positions: set[tuple[int, int]],
        blocked_positions: set[tuple[int, int]],
    ) -> list[tuple[int, int]]:
        room_cells = self._room_cells(room_id)
        if not room_cells:
            return []

        def sort_key(cell: tuple[int, int]) -> tuple[int, int, int, int]:
            dx = abs(cell[0] - anchor[0])
            dy = abs(cell[1] - anchor[1])
            return (max(dx, dy), dx + dy, cell[1], cell[0])

        candidates = sorted(room_cells, key=sort_key)
        return [
            cell for cell in candidates
            if cell not in assigned_positions
            and cell not in blocked_positions
            and self._position_is_walkable(cell[0], cell[1])
        ]

    def _place_search_entity_near_anchor(
        self,
        entity: EnemyInstance,
        room_id: str,
        anchor: tuple[int, int],
        assigned_positions: set[tuple[int, int]],
        blocked_positions: set[tuple[int, int]],
    ) -> Optional[tuple[int, int]]:
        for candidate in self._search_position_candidates(room_id, anchor, assigned_positions, blocked_positions):
            return candidate
        if self._has_position(entity):
            current = (int(entity.grid_x), int(entity.grid_y))
            assigned_positions.add(current)
        return None

    def _apply_room_search_positioning(
        self,
        entity: EnemyInstance,
        room_id: str,
        edge_keys: list[str],
        party_walk: bool,
    ) -> list[str]:
        if not self.dungeon or not edge_keys:
            return []

        anchors = [
            room_side_cell
            for edge_key in edge_keys
            if (room_side_cell := self._room_side_cell_for_edge(edge_key, room_id)) is not None
        ]
        if not anchors:
            return []

        if party_walk:
            party = self._party_walk_party(entity)
        elif not self.is_down(entity) and self._has_position(entity) and self._position_is_walkable(entity.grid_x, entity.grid_y):
            party = [entity]
        else:
            party = []
        if not party:
            return []

        moving_ids = {member.instance_id for member in party}
        blocked_positions = {
            (int(other.grid_x), int(other.grid_y))
            for other in self.state.enemies.values()
            if other.instance_id not in moving_ids
            and self._blocks_position(other)
            and self._has_position(other)
        }
        assigned_positions: set[tuple[int, int]] = set()
        placements: list[tuple[EnemyInstance, int, int]] = []

        for index, member in enumerate(party):
            anchor = anchors[index] if party_walk and index < len(anchors) else anchors[0]
            chosen = self._place_search_entity_near_anchor(member, room_id, anchor, assigned_positions, blocked_positions)
            if chosen is None:
                continue
            assigned_positions.add(chosen)
            placements.append((member, chosen[0], chosen[1]))

        moved_ids: list[str] = []
        for member, target_x, target_y in placements:
            current = (int(member.grid_x), int(member.grid_y)) if self._has_position(member) else (None, None)
            if current != (target_x, target_y):
                moved_ids.append(member.instance_id)
            self._set_position(member, target_x, target_y)
        if moved_ids:
            self._add_log(
                f"Search positioning moved {len(moved_ids)} PC{'s' if len(moved_ids) != 1 else ''}."
            )
        unplaced_count = len(party) - len(placements)
        if unplaced_count:
            self._add_log(f"Search positioning left {unplaced_count} PC{'s' if unplaced_count != 1 else ''} in place.")
        return moved_ids

    def _combat_flow_active(self) -> bool:
        return bool(
            self.encounter_started
            or self.active_turn_id is not None
            or self.turn_in_progress
            or self.pending_new_round
        )

    def start_room_search(self) -> dict:
        entity = self._require_selected_entity()
        if not self.is_player(entity):
            raise BattleSessionError("Search is only available for player characters.")
        if entity.grid_x is None or entity.grid_y is None:
            raise BattleSessionError("Selected player is not on the map.")
        if self.dungeon is None:
            raise BattleSessionError("No dungeon loaded.")
        if self._combat_flow_active():
            raise BattleSessionError("Search Room is only available outside combat.")
        if self.pending_opportunity is not None:
            raise BattleSessionError("Resolve the pending opportunity attack before searching.")
        if self.dungeon.pending_encounter_room_ids:
            raise BattleSessionError("Resolve the pending encounter before searching.")
        if self.pending_search is not None:
            raise BattleSessionError("A search is already in progress. Resolve it first.")
        room_id = entity.room_id
        if room_id is None:
            raise BattleSessionError("Player is not in a room.")
        if room_id in getattr(self.dungeon, "searched_room_ids", []):
            raise BattleSessionError("This room has already been searched.")

        self.dungeon.searched_room_ids.append(room_id)

        result = self._draw_additional_for_player(entity, 3)
        drawn = list(result.drawn)
        self._append_visible_draw_group(entity, drawn)

        summary = self._player_draw_summary(drawn)
        drawn_text = ", ".join(self.card_to_effect_text(cid) for cid in drawn)
        self._add_log(f"{entity.name} searches the room: {drawn_text}")

        self.pending_search = {
            "kind": "search",
            "entity_id": entity.instance_id,
            "room_id": room_id,
            "drawn_card_ids": drawn,
            "success_count": summary["outcomes"]["success"],
            "fate_count": summary["outcomes"]["fate"],
            "has_fate": summary["outcomes"]["fate"] > 0,
        }
        self.autosave()
        return {
            "searchStarted": {
                "drawnCardIds": drawn,
                "summary": summary,
                "hasFate": summary["outcomes"]["fate"] > 0,
            }
        }

    def resolve_room_search(self, use_willpower: bool, party_walk: bool = False) -> dict:
        if self.pending_search is None:
            raise BattleSessionError("No pending search to resolve.")
        ps = self.pending_search
        entity = self.state.enemies.get(ps["entity_id"])
        if entity is None:
            self.pending_search = None
            raise BattleSessionError("Search entity no longer exists.")

        score = ps["success_count"] + (ps["fate_count"] if use_willpower else 0)
        room_id = ps["room_id"]
        party_walk = bool(party_walk)

        candidates = self._secret_door_candidates_in_room(room_id)
        candidates.sort(key=lambda c: c["edge_key"])

        outcome = "nothing"
        edge_keys: list[str] = []

        if score > 0 and candidates:
            discovered_edges = [
                target["edge_key"]
                for target in candidates
                if score >= int(target["dc"])
            ]
            if discovered_edges:
                discovered_set = set(discovered_edges)
                for discovered_edge in discovered_edges:
                    wall = self.dungeon.walls.get(discovered_edge)
                    if wall:
                        wall.secret_discovered = True
                self.dungeon.secret_suspects = [
                    s for s in self.dungeon.secret_suspects if s["edge_key"] not in discovered_set
                ]
                edge_keys.extend(discovered_edges)
                outcome = "discovered"
                if len(discovered_edges) == 1:
                    self._add_log(f"{entity.name} discovers a secret door!")
                else:
                    self._add_log(f"{entity.name} discovers {len(discovered_edges)} secret doors!")
            else:
                true_suspects = [
                    target["edge_key"]
                    for target in candidates
                    if score == int(target["dc"]) - 1
                ]
                if true_suspects:
                    true_edge = true_suspects[0]
                    already = any(s["edge_key"] == true_edge for s in self.dungeon.secret_suspects)
                    if not already:
                        self.dungeon.secret_suspects.append({
                            "room_id": room_id,
                            "edge_key": true_edge,
                            "kind": "secret",
                            "exhausted": False,
                            "false_dc": 0,
                        })
                    edge_keys.append(true_edge)
                    outcome = "true_suspect"
                    self._add_log(f"{entity.name} senses something suspicious.")

        false_prob = max(0.0, (3 - score) / 6) if score < 3 else 0.0
        if outcome != "discovered" and false_prob > 0 and self._rng.random() < false_prob:
            false_edge = self._pick_false_suspect_edge(room_id)
            if false_edge:
                false_dc = self._rng.randint(1, 3)
                self.dungeon.secret_suspects.append({
                    "room_id": room_id,
                    "edge_key": false_edge,
                    "kind": "false",
                    "exhausted": False,
                    "false_dc": false_dc,
                })
                self._add_log(f"{entity.name} thinks something might be hidden here.")
                edge_keys.append(false_edge)
                if outcome == "nothing":
                    outcome = "false_suspect"

        if outcome == "nothing":
            self._add_log(f"{entity.name} searches but finds nothing.")

        moved_ids = self._apply_room_search_positioning(entity, room_id, edge_keys, party_walk)
        self.pending_search = None
        self.dungeon.render_version += 1
        self.autosave()
        return {
            "searchResolved": {
                "outcome": outcome,
                "edgeKey": edge_keys[0] if edge_keys else None,
                "edgeKeys": list(edge_keys),
                "movedEntityIds": moved_ids,
                "partyWalk": party_walk,
                "useWillpower": use_willpower,
            }
        }

    def interact_suspect(self, edge_key: str) -> dict:
        entity = self._require_selected_entity()
        if not self.is_player(entity):
            raise BattleSessionError("Suspect interaction is only available for player characters.")
        if entity.grid_x is None or entity.grid_y is None:
            raise BattleSessionError("Selected player is not on the map.")
        if self.dungeon is None:
            raise BattleSessionError("No dungeon loaded.")
        combat_active = self._combat_flow_active()
        if combat_active and self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Another unit has the active turn. End that turn first.")
        if self.pending_opportunity is not None:
            raise BattleSessionError("Resolve the pending opportunity attack before investigating.")
        if self.dungeon.pending_encounter_room_ids:
            raise BattleSessionError("Resolve the pending encounter before investigating.")
        if self.pending_search is not None:
            raise BattleSessionError("A search is already in progress. Resolve it first.")

        suspect = next((s for s in self.dungeon.secret_suspects if s["edge_key"] == edge_key), None)
        if suspect is None:
            raise BattleSessionError(f"No suspect marker at edge {edge_key!r}")
        if suspect.get("exhausted", False):
            raise BattleSessionError("This suspect marker is exhausted.")

        # Determine room-side cell for distance check
        parts = edge_key.split(",")
        kx, ky, ks = int(parts[0]), int(parts[1]), parts[2]
        cell_a = (kx, ky)
        cell_b = (kx + 1, ky) if ks == "e" else (kx, ky + 1)
        room = next((r for r in self.dungeon.rooms if r.room_id == suspect.get("room_id")), None)
        room_cells = {tuple(c) for c in room.cells} if room else set()
        if cell_a in room_cells:
            room_side_cell = cell_a
        elif cell_b in room_cells:
            room_side_cell = cell_b
        else:
            room_side_cell = cell_a
        dist = max(abs(entity.grid_x - room_side_cell[0]), abs(entity.grid_y - room_side_cell[1]))
        if dist > 1:
            raise BattleSessionError("Selected player is not within 5ft of the suspect marker.")

        if combat_active:
            self._charge_action(entity)

        result = self._draw_additional_for_player(entity, 3)
        drawn = list(result.drawn)
        self._append_visible_draw_group(entity, drawn)
        summary = self._player_draw_summary(drawn)

        if suspect["kind"] == "secret":
            wall = self.dungeon.walls.get(edge_key)
            dc = max(0, (getattr(wall, "secret_dc", 2) if wall else 2) - 1)
        else:
            dc = suspect.get("false_dc", 1)

        drawn_text = ", ".join(self.card_to_effect_text(cid) for cid in drawn)

        self._add_log(f"{entity.name} investigates a suspect marker: {drawn_text}")
        self.pending_search = {
            "kind": "suspect",
            "entity_id": entity.instance_id,
            "room_id": suspect.get("room_id"),
            "edge_key": edge_key,
            "suspect_kind": suspect.get("kind", "false"),
            "dc": dc,
            "drawn_card_ids": drawn,
            "success_count": summary["outcomes"]["success"],
            "fate_count": summary["outcomes"]["fate"],
            "has_fate": summary["outcomes"]["fate"] > 0,
        }
        self.autosave()
        return {
            "suspectInteractionStarted": {
                "edgeKey": edge_key,
                "kind": suspect["kind"],
                "dc": dc,
                "drawnCardIds": drawn,
                "summary": summary,
                "hasFate": summary["outcomes"]["fate"] > 0,
            }
        }

    def resolve_suspect_interaction(self, use_willpower: bool) -> dict:
        if self.pending_search is None or self.pending_search.get("kind") != "suspect":
            raise BattleSessionError("No pending suspect interaction to resolve.")
        ps = self.pending_search
        entity = self.state.enemies.get(ps["entity_id"])
        if entity is None:
            self.pending_search = None
            raise BattleSessionError("Suspect interaction entity no longer exists.")

        edge_key = ps["edge_key"]
        suspect_kind = ps.get("suspect_kind", "false")
        dc = int(ps.get("dc", 1))
        score = ps["success_count"] + (ps["fate_count"] if use_willpower else 0)
        suspect = next((s for s in self.dungeon.secret_suspects if s["edge_key"] == edge_key), None)
        drawn = list(ps.get("drawn_card_ids", []))
        summary = self._player_draw_summary(drawn)
        drawn_text = ", ".join(self.card_to_effect_text(cid) for cid in drawn)

        if score > 0 and score >= dc:
            if suspect_kind == "secret":
                wall = self.dungeon.walls.get(edge_key)
                if wall:
                    wall.secret_discovered = True
                self.dungeon.secret_suspects = [
                    s for s in self.dungeon.secret_suspects if s["edge_key"] != edge_key
                ]
                self._add_log(f"{entity.name} discovers a secret door! ({drawn_text})")
                outcome = "discovered"
            else:
                self.dungeon.secret_suspects = [
                    s for s in self.dungeon.secret_suspects if s["edge_key"] != edge_key
                ]
                self._add_log(f"{entity.name} investigates - nothing here. ({drawn_text})")
                outcome = "cleared"
        else:
            if suspect is not None:
                suspect["exhausted"] = True
            self._add_log(f"{entity.name} investigates but finds nothing conclusive. ({drawn_text})")
            outcome = "exhausted"

        self.pending_search = None
        self.dungeon.render_version += 1
        self.autosave()
        return {
            "suspectInteraction": {
                "edgeKey": edge_key,
                "kind": suspect_kind,
                "outcome": outcome,
                "score": score,
                "dc": dc,
                "drawnCardIds": drawn,
                "summary": summary,
                "useWillpower": use_willpower,
            }
        }

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
        if wall.wall_type == "wall":
            return True
        if wall.wall_type == "door":
            return not wall.door_open
        if wall.wall_type == "secret_door":
            # Hidden secret doors block like walls; discovered ones behave like doors.
            return not (getattr(wall, "secret_discovered", False) and wall.door_open)
        return False

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

    def party_walk(self, leader_id: str, x: int, y: int) -> dict:
        has_live_ordered_enemy = any(
            (entity := self.state.enemies.get(instance_id)) is not None
            and not self.is_player(entity)
            and not self.is_down(entity)
            for instance_id in self.order
        )
        if (
            self.active_turn_id is not None
            or self.turn_in_progress
            or (self.encounter_started and has_live_ordered_enemy)
            or (self.pending_new_round and has_live_ordered_enemy)
        ):
            raise BattleSessionError("Party Walk is only available outside active combat turns.")
        if self.pending_opportunity is not None:
            raise BattleSessionError("Resolve the pending opportunity attack before using Party Walk.")
        if self.dungeon and self.dungeon.pending_encounter_room_ids:
            raise BattleSessionError("Resolve the pending encounter before using Party Walk.")

        leader = self.state.enemies.get(str(leader_id or ""))
        if not leader:
            raise BattleSessionError(f"Entity '{leader_id}' does not exist")
        if not self.is_player(leader):
            raise BattleSessionError("Party Walk needs a player character as leader.")
        if self.is_down(leader):
            raise BattleSessionError("Down player characters cannot lead Party Walk.")
        if not self._has_position(leader) or not self._position_is_walkable(leader.grid_x, leader.grid_y):
            raise BattleSessionError(f"{leader.name} must be on the battle map to lead Party Walk.")

        x = int(x)
        y = int(y)
        if not self._position_in_bounds(x, y):
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is outside the battle map")
        if not self._position_is_walkable(x, y):
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is not walkable")

        party = self._party_walk_party(leader)
        party_ids = {entity.instance_id for entity in party}
        for entity in party:
            if self._grapples_for_target(entity.instance_id):
                raise BattleSessionError(f"{entity.name} is Grappled and cannot use Party Walk.")

        occupying = self._entity_at_position(x, y, exclude_ids=party_ids, blocking_only=True)
        if occupying:
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is occupied by {occupying.name}")

        route = self._movement_route(leader, x, y, diagonal_steps_used=0, max_cost=None)
        if route is None:
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is not reachable")

        route_steps, stopped_for_encounter, revealed_rooms, pending_rooms = self._party_walk_route_plan(
            leader,
            list(route.steps),
        )
        route_positions = [(int(leader.grid_x), int(leader.grid_y))]
        route_positions.extend((int(step["x"]), int(step["y"])) for step in route_steps)
        actual_x, actual_y = route_positions[-1]
        allowed_revealed = set(getattr(self.dungeon, "revealed_room_ids", []) if self.dungeon else [])
        allowed_revealed.update(revealed_rooms)
        placements = self._party_walk_placements(
            leader,
            party,
            actual_x,
            actual_y,
            route_positions,
            allowed_revealed,
        )

        if self.dungeon:
            for room_id in revealed_rooms:
                if room_id not in self.dungeon.revealed_room_ids:
                    self.dungeon.revealed_room_ids.append(room_id)
            for room_id in pending_rooms:
                if room_id not in self.dungeon.pending_encounter_room_ids:
                    self.dungeon.pending_encounter_room_ids.append(room_id)
            if revealed_rooms or pending_rooms:
                self.dungeon.render_version += 1

        for entity, target_x, target_y in placements:
            self._set_position(entity, target_x, target_y)

        self.selected_id = leader.instance_id
        moved_ids = [entity.instance_id for entity, _target_x, _target_y in placements]
        if stopped_for_encounter:
            self._add_log(
                f"Party walk stopped: encounter discovered after {leader.name} led "
                f"{len(moved_ids)} PC{'s' if len(moved_ids) != 1 else ''} to ({actual_x + 1}, {actual_y + 1})."
            )
        else:
            self._add_log(
                f"Party walk: {leader.name} led {len(moved_ids)} PC{'s' if len(moved_ids) != 1 else ''} "
                f"to ({actual_x + 1}, {actual_y + 1})."
            )
        self.autosave()
        return {
            "partyWalk": {
                "leaderId": leader.instance_id,
                "movedEntityIds": moved_ids,
                "destination": {"x": x, "y": y},
                "actualDestination": {"x": actual_x, "y": actual_y},
                "stoppedForEncounter": stopped_for_encounter,
                "revealedRoomIds": list(revealed_rooms),
                "pendingEncounterRoomIds": list(pending_rooms),
            }
        }

    def _party_walk_party(self, leader: EnemyInstance) -> list[EnemyInstance]:
        members: list[EnemyInstance] = [leader]
        for instance_id in self._ordered_enemy_ids():
            entity = self.state.enemies.get(instance_id)
            if (
                entity
                and entity.instance_id != leader.instance_id
                and self.is_player(entity)
                and not self.is_down(entity)
                and self._has_position(entity)
                and self._position_is_walkable(entity.grid_x, entity.grid_y)
            ):
                members.append(entity)
        return members

    def _party_walk_route_plan(
        self,
        leader: EnemyInstance,
        route_steps: list[dict],
    ) -> tuple[list[dict], bool, list[str], list[str]]:
        if not self.dungeon:
            return route_steps, False, [], []

        revealed_seen = set(getattr(self.dungeon, "revealed_room_ids", []))
        pending_seen = set(getattr(self.dungeon, "pending_encounter_room_ids", []))
        revealed_rooms: list[str] = []
        pending_rooms: list[str] = []

        def reveal_room(room_id: Optional[str]) -> bool:
            if not room_id:
                return False
            if room_id not in revealed_seen:
                revealed_seen.add(room_id)
                revealed_rooms.append(room_id)
            if self._party_walk_room_has_enemies(room_id):
                if room_id not in pending_seen:
                    pending_seen.add(room_id)
                    pending_rooms.append(room_id)
                return True
            return False

        start_room_id = self._room_id_for_position(leader.grid_x, leader.grid_y)
        if reveal_room(start_room_id):
            return [], True, revealed_rooms, pending_rooms

        accepted_steps: list[dict] = []
        for step in route_steps:
            accepted_steps.append(step)
            room_id = self._room_id_for_position(step["x"], step["y"])
            if room_id and room_id != start_room_id and reveal_room(room_id):
                return accepted_steps, True, revealed_rooms, pending_rooms
            if room_id and room_id not in revealed_seen:
                reveal_room(room_id)

        return accepted_steps, False, revealed_rooms, pending_rooms

    def _party_walk_room_has_enemies(self, room_id: str) -> bool:
        for entity in self.state.enemies.values():
            if self.is_player(entity) or self.is_down(entity) or not self._has_position(entity):
                continue
            if self._room_id_for_position(entity.grid_x, entity.grid_y) == room_id:
                return True
        return False

    def _party_walk_placements(
        self,
        leader: EnemyInstance,
        party: list[EnemyInstance],
        leader_x: int,
        leader_y: int,
        route_positions: list[tuple[int, int]],
        allowed_revealed_room_ids: set[str],
    ) -> list[tuple[EnemyInstance, int, int]]:
        party_ids = {entity.instance_id for entity in party}
        blocked_positions = {
            (int(entity.grid_x), int(entity.grid_y))
            for entity in self.state.enemies.values()
            if entity.instance_id not in party_ids
            and self._blocks_position(entity)
            and self._has_position(entity)
        }
        placements: list[tuple[EnemyInstance, int, int]] = [(leader, leader_x, leader_y)]
        assigned_positions: set[tuple[int, int]] = {(leader_x, leader_y)}
        facing = self._party_walk_facing(route_positions)
        preferred_cells = self._party_walk_preferred_cells(leader_x, leader_y, facing)
        breadcrumb_cells = list(reversed(route_positions[:-1]))
        fallback_cells = self._party_walk_fallback_cells(leader_x, leader_y, facing)

        for follower in party[1:]:
            chosen: Optional[tuple[int, int]] = None
            seen: set[tuple[int, int]] = set()
            for candidate in [*preferred_cells, *breadcrumb_cells, *fallback_cells]:
                if candidate in seen:
                    continue
                seen.add(candidate)
                if not self._party_walk_cell_is_valid(
                    candidate,
                    assigned_positions,
                    blocked_positions,
                    allowed_revealed_room_ids,
                ):
                    continue
                if self._movement_route(follower, candidate[0], candidate[1], diagonal_steps_used=0, max_cost=None) is None:
                    continue
                chosen = candidate
                break
            if chosen is None:
                raise BattleSessionError(f"No valid Party Walk formation cell found for {follower.name}.")
            assigned_positions.add(chosen)
            placements.append((follower, chosen[0], chosen[1]))

        return placements

    @staticmethod
    def _party_walk_facing(route_positions: list[tuple[int, int]]) -> tuple[int, int]:
        if len(route_positions) < 2:
            return (0, 1)
        previous_x, previous_y = route_positions[-2]
        current_x, current_y = route_positions[-1]
        dx = (current_x > previous_x) - (current_x < previous_x)
        dy = (current_y > previous_y) - (current_y < previous_y)
        return (dx, dy) if dx or dy else (0, 1)

    def _party_walk_preferred_cells(self, leader_x: int, leader_y: int, facing: tuple[int, int]) -> list[tuple[int, int]]:
        dx, dy = facing
        behind = (-dx, -dy) if dx or dy else (0, 1)
        left = (-dy, dx)
        right = (dy, -dx)
        offsets = [
            behind,
            (behind[0] + left[0], behind[1] + left[1]),
            (behind[0] + right[0], behind[1] + right[1]),
            left,
            right,
            (behind[0] * 2, behind[1] * 2),
            (behind[0] * 2 + left[0], behind[1] * 2 + left[1]),
            (behind[0] * 2 + right[0], behind[1] * 2 + right[1]),
        ]
        result: list[tuple[int, int]] = []
        seen: set[tuple[int, int]] = set()
        for ox, oy in offsets:
            if ox == 0 and oy == 0:
                continue
            cell = (leader_x + ox, leader_y + oy)
            if cell not in seen:
                seen.add(cell)
                result.append(cell)
        return result

    def _party_walk_fallback_cells(self, leader_x: int, leader_y: int, facing: tuple[int, int]) -> list[tuple[int, int]]:
        dx, dy = facing
        behind = (-dx, -dy) if dx or dy else (0, 1)
        side = (-dy, dx)
        candidates: list[tuple[int, int]] = []
        if self._uses_sparse_dungeon_grid() and self.dungeon:
            for key in self.dungeon.tiles.keys():
                try:
                    x_raw, y_raw = key.split(",", 1)
                    candidates.append((int(x_raw), int(y_raw)))
                except (TypeError, ValueError):
                    continue
        else:
            candidates = [
                (x, y)
                for y in range(self.room_rows)
                for x in range(self.room_columns)
            ]

        def sort_key(cell: tuple[int, int]) -> tuple[int, int, int, int]:
            rel_x = cell[0] - leader_x
            rel_y = cell[1] - leader_y
            chebyshev = max(abs(rel_x), abs(rel_y))
            manhattan = abs(rel_x) + abs(rel_y)
            behind_score = rel_x * behind[0] + rel_y * behind[1]
            side_score = abs(rel_x * side[0] + rel_y * side[1])
            return (chebyshev, -behind_score, side_score, manhattan)

        return sorted(candidates, key=sort_key)

    def _party_walk_cell_is_valid(
        self,
        cell: tuple[int, int],
        assigned_positions: set[tuple[int, int]],
        blocked_positions: set[tuple[int, int]],
        allowed_revealed_room_ids: set[str],
    ) -> bool:
        x, y = cell
        if cell in assigned_positions or cell in blocked_positions:
            return False
        if not self._position_in_bounds(x, y) or not self._position_is_walkable(x, y):
            return False
        if self.dungeon and self.dungeon.fog_of_war_enabled:
            room_id = self._room_id_for_position(x, y)
            if room_id and room_id not in allowed_revealed_room_ids:
                return False
        return True

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

    def move_entity_with_movement(self, instance_id: str, x: int, y: int, *, dash: bool = False) -> Optional[dict]:
        if self.pending_opportunity is not None:
            raise BattleSessionError("Resolve the pending opportunity attack before moving again.")
        entity = self.state.enemies.get(instance_id)
        if not entity:
            raise BattleSessionError(f"Entity '{instance_id}' does not exist")
        if self.active_turn_id != instance_id:
            raise BattleSessionError("Only the active unit can use Move.")
        if not self._has_position(entity) or not self._position_is_walkable(entity.grid_x, entity.grid_y):
            raise BattleSessionError(f"{entity.name} must be on the battle map to move")
        if self._grapples_for_target(entity.instance_id):
            raise BattleSessionError(f"{entity.name} is Grappled and cannot move.")

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
        if movement_state.get("movement_stopped", False):
            raise BattleSessionError(f"{entity.name}'s movement has been stopped for this turn.")
        movement_used = int(movement_state["movement_used"])
        diagonal_steps_used = int(movement_state["diagonal_steps_used"])
        base_movement = self.effective_movement(entity)
        max_movement = base_movement * 2 if movement_state["dash_used"] else base_movement
        route = self._movement_route(
            entity,
            x,
            y,
            diagonal_steps_used=diagonal_steps_used,
            max_cost=max(base_movement * 2 - movement_used, 0),
        )
        if route is None:
            raise BattleSessionError(f"Position ({x + 1}, {y + 1}) is not reachable")

        move_cost, diagonal_steps = route.cost, route.diagonal_steps
        next_movement_used = movement_used + move_cost
        needs_dash = next_movement_used > base_movement and not movement_state["dash_used"]
        if needs_dash and not dash:
            raise BattleSessionError("This movement requires a Dash action.")
        if needs_dash:
            max_movement = base_movement * 2
        if next_movement_used > max_movement:
            raise BattleSessionError(f"{entity.name} does not have enough movement remaining")

        self.selected_id = instance_id
        result = self._advance_movement_route(
            entity,
            list(route.steps),
            base_movement=base_movement,
            dash_requested=bool(dash),
            full_move_cost=move_cost,
        )
        self.autosave()
        return result

    def _advance_movement_route(
        self,
        entity: EnemyInstance,
        steps: list[dict],
        *,
        base_movement: int,
        dash_requested: bool,
        full_move_cost: int,
        ignored_attacker_ids: Optional[set[str]] = None,
    ) -> dict:
        movement_state = self._movement_state_for_active()
        start_used = int(movement_state["movement_used"])
        ignored = set(ignored_attacker_ids or set())
        wound_events: list[dict] = []
        opportunity_events: list[dict] = []
        total_steps = len(steps)

        for step_index, step in enumerate(steps):
            from_x, from_y = int(entity.grid_x), int(entity.grid_y)
            to_x, to_y = int(step["x"]), int(step["y"])
            attackers = self._opportunity_attackers_for_step(
                entity,
                from_x,
                from_y,
                to_x,
                to_y,
                ignored,
            )

            npc_attackers = [attacker for attacker in attackers if not self.is_player(attacker)]
            npc_step_events: list[dict] = []
            npc_stopped = False
            for attacker in npc_attackers:
                result = self._resolve_npc_opportunity_attack(attacker, entity)
                wound_events.extend(result.get("woundEvents", []))
                if result.get("opportunityEvent"):
                    npc_step_events.append(result["opportunityEvent"])
                    opportunity_events.append(result["opportunityEvent"])
                npc_stopped = bool(npc_stopped or result.get("stopped"))
            if len(npc_step_events) > 1:
                names = ", ".join(str(event.get("attackerName") or "Enemy") for event in npc_step_events)
                self._add_log(f"{entity.name} provokes {len(npc_step_events)} enemy opportunity attacks: {names}.")
            if npc_stopped:
                self._stop_active_movement()
                self._add_log(f"{entity.name}'s movement is stopped by an opportunity attack.")
                return self._opportunity_result_payload(
                    wound_events,
                    notice=self._opportunity_events_notice(npc_step_events),
                    opportunity_events=opportunity_events,
                )

            pc_attackers = [attacker for attacker in attackers if self.is_player(attacker)]
            if pc_attackers:
                self._set_pending_opportunity(
                    mover=entity,
                    attackers=pc_attackers,
                    route_steps=steps[step_index:],
                    ignored_attacker_ids=ignored,
                    base_movement=base_movement,
                    dash_requested=dash_requested,
                )
                attacker = pc_attackers[0]
                self._add_log(f"{entity.name} provokes an opportunity attack from {attacker.name}.")
                return self._opportunity_result_payload(
                    wound_events,
                    notice=f"{entity.name} provokes an opportunity attack from {attacker.name}.",
                    opportunity_events=opportunity_events,
                )

            self._apply_movement_step(entity, step, base_movement=base_movement)

        used_now = int(movement_state["movement_used"]) - start_used
        dash_suffix = " using Dash" if used_now and int(movement_state["movement_used"]) > base_movement and dash_requested else ""
        if steps:
            self._add_log(
                f"Moved {entity.name} to ({int(entity.grid_x) + 1}, {int(entity.grid_y) + 1}) "
                f"for {used_now if used_now else full_move_cost} movement{dash_suffix}"
            )
            self._after_entity_position_changed(entity)
        elif total_steps == 0:
            self._after_entity_position_changed(entity)
        return self._opportunity_result_payload(
            wound_events,
            notice=self._opportunity_events_notice(opportunity_events),
            opportunity_events=opportunity_events,
        )

    def _apply_movement_step(self, entity: EnemyInstance, step: dict, *, base_movement: int) -> None:
        movement_state = self._movement_state_for_active()
        self._set_position(entity, int(step["x"]), int(step["y"]))
        movement_state["movement_used"] = int(movement_state["movement_used"]) + int(step.get("cost", 0) or 0)
        if bool(step.get("diagonal", False)):
            movement_state["diagonal_steps_used"] = int(movement_state["diagonal_steps_used"]) + 1
        movement_state["dash_used"] = bool(movement_state.get("dash_used", False) or int(movement_state["movement_used"]) > base_movement)
        self._after_entity_position_changed(entity)

    def _after_entity_position_changed(self, entity: EnemyInstance) -> None:
        if not (self.is_player(entity) and self.dungeon and self.encounter_started):
            return
        _cell_to_room = {
            f"{c[0]},{c[1]}": r.room_id
            for r in self.dungeon.rooms for c in r.cells
        }
        new_rid = _cell_to_room.get(f"{entity.grid_x},{entity.grid_y}")
        entity.room_id = new_rid
        if new_rid and new_rid not in self.dungeon.revealed_room_ids:
            self.dungeon.revealed_room_ids.append(new_rid)
            enemies_there = [
                e for e in self.state.enemies.values()
                if e.room_id == new_rid and not self.is_player(e) and not self.is_down(e)
            ]
            if enemies_there and new_rid not in self.dungeon.pending_encounter_room_ids:
                self.dungeon.pending_encounter_room_ids.append(new_rid)

    def _opportunity_attackers_for_step(
        self,
        mover: EnemyInstance,
        from_x: int,
        from_y: int,
        to_x: int,
        to_y: int,
        ignored_attacker_ids: set[str],
    ) -> list[EnemyInstance]:
        if self._movement_state_for_active().get("disengaged", False):
            return []
        attackers: list[EnemyInstance] = []
        for instance_id in self._ordered_enemy_ids():
            attacker = self.state.enemies.get(instance_id)
            if not attacker or attacker.instance_id == mover.instance_id:
                continue
            if attacker.instance_id in ignored_attacker_ids:
                continue
            if self.is_player(attacker) == self.is_player(mover):
                continue
            if self.is_down(attacker) or self.is_down(mover):
                continue
            if not self._has_position(attacker):
                continue
            if int(getattr(attacker, "opportunity_attack_used_round", 0) or 0) == int(self.round):
                continue
            reach = self._opportunity_reach(attacker)
            old_distance = self._grid_distance(int(attacker.grid_x), int(attacker.grid_y), from_x, from_y)
            new_distance = self._grid_distance(int(attacker.grid_x), int(attacker.grid_y), to_x, to_y)
            if (
                old_distance <= reach
                and new_distance > old_distance
                and self._opportunity_threatens_position(attacker, from_x, from_y, reach)
            ):
                attackers.append(attacker)
        return attackers

    @staticmethod
    def _grid_distance(ax: int, ay: int, bx: int, by: int) -> int:
        return max(abs(ax - bx), abs(ay - by))

    def _opportunity_threatens_position(self, attacker: EnemyInstance, x: int, y: int, reach: int) -> bool:
        if not self._has_position(attacker):
            return False
        reach = max(0, int(reach))
        attacker_x = int(attacker.grid_x)
        attacker_y = int(attacker.grid_y)
        target = (int(x), int(y))
        if self._grid_distance(attacker_x, attacker_y, target[0], target[1]) > reach:
            return False
        if not self.dungeon:
            return True
        if not self._position_is_walkable(target[0], target[1]):
            return False

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
        frontier: list[tuple[int, int, int]] = [(attacker_x, attacker_y, 0)]
        seen: set[tuple[int, int]] = {(attacker_x, attacker_y)}
        while frontier:
            current_x, current_y, distance = frontier.pop(0)
            if (current_x, current_y) == target:
                return True
            if distance >= reach:
                continue
            for dx, dy in directions:
                next_x = current_x + dx
                next_y = current_y + dy
                next_cell = (next_x, next_y)
                if next_cell in seen:
                    continue
                if not self._position_in_bounds(next_x, next_y) or not self._position_is_walkable(next_x, next_y):
                    continue
                if dx != 0 and dy != 0:
                    if self._diagonal_touches_any_wall(current_x, current_y, next_x, next_y):
                        continue
                elif self._wall_blocks_orthogonal(current_x, current_y, next_x, next_y):
                    continue
                if self._grid_distance(next_x, next_y, target[0], target[1]) > reach - distance - 1:
                    continue
                seen.add(next_cell)
                frontier.append((next_x, next_y, distance + 1))
        return False

    def _opportunity_reach(self, entity: EnemyInstance) -> int:
        if self.is_player(entity):
            weapon = self._eligible_martial_melee_weapon(entity)
            return max(1, int((weapon or {}).get("reach", 1) or 1))
        return 1

    def _opportunity_base_damage(self, entity: EnemyInstance) -> int:
        if self.is_player(entity):
            weapon = self._eligible_martial_melee_weapon(entity)
            return max(1, int((weapon or {}).get("baseDamage", 1) or 1))
        return 1

    def _pc_opportunity_hit_draw_count(self, attacker: EnemyInstance, target: EnemyInstance) -> int:
        count = 3
        if self._status_present(getattr(target, "statuses", {}) or {}, "prone"):
            count += 1
        return max(1, count)

    def _eligible_martial_melee_weapon(self, entity: EnemyInstance) -> Optional[dict]:
        weapon = dict(getattr(entity, "melee_weapon", {}) or {})
        kind = str(weapon.get("kind", "")).strip().lower()
        if "martial" in kind and "melee" in kind:
            return weapon
        return None

    def _set_pending_opportunity(
        self,
        *,
        mover: EnemyInstance,
        attackers: list[EnemyInstance],
        route_steps: list[dict],
        ignored_attacker_ids: set[str],
        base_movement: int,
        dash_requested: bool,
    ) -> None:
        self.pending_opportunity = {
            "mover_id": mover.instance_id,
            "attacker_ids": [attacker.instance_id for attacker in attackers],
            "attacker_index": 0,
            "route_steps": [dict(step) for step in route_steps],
            "ignored_attacker_ids": list(ignored_attacker_ids),
            "base_movement": max(0, int(base_movement)),
            "dash_requested": bool(dash_requested),
            "phase": "choose",
            "drawn_card_ids": [],
            "success_count": None,
            "fate_count": None,
            "use_willpower": None,
        }

    def _pending_current_attacker(self) -> Optional[EnemyInstance]:
        if not self.pending_opportunity:
            return None
        attacker_ids = list(self.pending_opportunity.get("attacker_ids", []))
        index = int(self.pending_opportunity.get("attacker_index", 0) or 0)
        if index < 0 or index >= len(attacker_ids):
            return None
        return self.state.enemies.get(attacker_ids[index])

    def _pending_mover(self) -> Optional[EnemyInstance]:
        if not self.pending_opportunity:
            return None
        return self.state.enemies.get(str(self.pending_opportunity.get("mover_id") or ""))

    def _opportunity_result_payload(
        self,
        wound_events: list[dict],
        *,
        notice: Optional[str] = None,
        opportunity_events: Optional[list[dict]] = None,
    ) -> dict:
        payload: dict = {}
        if wound_events:
            payload["woundEvents"] = wound_events
        if opportunity_events:
            payload["opportunityEvents"] = [dict(event) for event in opportunity_events]
        if self.pending_opportunity is not None:
            payload["pendingOpportunity"] = self._pending_opportunity_snapshot()
        if notice:
            payload["opportunityNotice"] = notice
        return payload

    @staticmethod
    def _opportunity_events_notice(events: list[dict]) -> Optional[str]:
        count = len(events)
        if count <= 0:
            return None
        stopped = any(bool(event.get("stopped")) for event in events)
        suffix = " Movement is stopped." if stopped else ""
        if count == 1:
            event = events[0]
            return f"Opportunity Attack: {event.get('attackerName', 'Enemy')} attacks {event.get('targetName', 'target')}.{suffix}"
        return f"Opportunity Attacks: {count} enemies attack.{suffix}"

    def _pending_opportunity_snapshot(self) -> Optional[dict]:
        if not self.pending_opportunity:
            return None
        attacker = self._pending_current_attacker()
        mover = self._pending_mover()
        if attacker is None or mover is None:
            return None
        drawn = list(self.pending_opportunity.get("drawn_card_ids", []) or [])
        success_count = self.pending_opportunity.get("success_count")
        fate_count = self.pending_opportunity.get("fate_count")
        return {
            "phase": self.pending_opportunity.get("phase", "choose"),
            "attackerId": attacker.instance_id,
            "attackerName": attacker.name,
            "targetId": mover.instance_id,
            "targetName": mover.name,
            "attackerIsPlayer": self.is_player(attacker),
            "targetIsPlayer": self.is_player(mover),
            "attackerPhysicalCards": self._uses_physical_cards(attacker),
            "baseDamage": self._opportunity_base_damage(attacker),
            "reach": self._opportunity_reach(attacker),
            "hitDrawCount": self._pc_opportunity_hit_draw_count(attacker, mover),
            "drawnCardIds": drawn,
            "drawnText": [self.card_to_effect_text(card_id) for card_id in drawn],
            "summary": self._player_draw_summary(drawn) if drawn else None,
            "successCount": success_count,
            "fateCount": fate_count,
            "useWillpower": self.pending_opportunity.get("use_willpower"),
        }

    def _resolve_npc_opportunity_attack(self, attacker: EnemyInstance, target: EnemyInstance) -> dict:
        attacker.opportunity_attack_used_round = int(self.round)
        card_id, reshuffled = self._draw_enemy_opportunity_card(attacker)
        if not card_id:
            notice = f"Opportunity Attack: {attacker.name} has no card to draw."
            self._add_log(notice)
            return {
                "stopped": False,
                "notice": notice,
                "opportunityEvent": {
                    "attackerId": attacker.instance_id,
                    "attackerName": attacker.name,
                    "targetId": target.instance_id,
                    "targetName": target.name,
                    "cardId": None,
                    "cardText": "No card drawn",
                    "damage": 0,
                    "damageToToughness": 0,
                    "special": False,
                    "unpreventable": False,
                    "stopped": False,
                    "reshuffled": bool(reshuffled),
                },
            }

        card_text = self.card_to_effect_text(card_id)
        base_damage, attack_modifiers = self._first_regular_attack_effect(card_id)
        prone_adjustment = self._prone_npc_attack_damage_adjustment(target, attack_modifiers)
        damage = max(0, base_damage + prone_adjustment)
        is_special = self._is_enemy_special_card(attacker, card_id)
        wound_events: list[dict] = []
        damage_to_toughness = 0
        if damage > 0:
            log, events = self._apply_opportunity_damage(
                attacker,
                target,
                damage,
                unpreventable=is_special,
                source="Opportunity Attack",
            )
            wound_events.extend(events)
            damage_to_toughness = log.damage_to_hp

        suffix = " (reshuffled first)" if reshuffled else ""
        damage_text = f"{damage_to_toughness} to Toughness" if damage > 0 else "no regular attack damage"
        prone_text = ""
        if prone_adjustment > 0:
            prone_text = f", prone melee advantage changes Attack {base_damage} to Attack {damage}"
        elif prone_adjustment < 0:
            prone_text = f", prone ranged disadvantage changes Attack {base_damage} to Attack {damage}"
        special_text = ", special stops movement" if is_special else ""
        self._add_log(
            f"Opportunity Attack by {attacker.name} on {target.name}: {card_text}{suffix}; "
            f"{damage_text}{prone_text}{special_text}."
        )
        notice = f"Opportunity Attack: {attacker.name} attacks {target.name} with {card_text}."
        if is_special:
            notice += " Movement is stopped."
        return {
            "stopped": is_special,
            "woundEvents": wound_events,
            "notice": notice,
            "opportunityEvent": {
                "attackerId": attacker.instance_id,
                "attackerName": attacker.name,
                "targetId": target.instance_id,
                "targetName": target.name,
                "cardId": card_id,
                "cardText": card_text,
                "baseDamage": base_damage,
                "proneAdjustment": prone_adjustment,
                "damage": damage,
                "damageToToughness": damage_to_toughness,
                "special": bool(is_special),
                "unpreventable": bool(is_special),
                "stopped": bool(is_special),
                "reshuffled": bool(reshuffled),
            },
        }

    def _draw_enemy_opportunity_card(self, entity: EnemyInstance) -> tuple[Optional[str], bool]:
        deck_state = entity.deck_state
        reshuffled = False
        if not deck_state.draw_pile and deck_state.discard_pile:
            deck_state.draw_pile = list(deck_state.discard_pile)
            deck_state.discard_pile.clear()
            self._rng.shuffle(deck_state.draw_pile)
            reshuffled = True
        if not deck_state.draw_pile:
            return None, reshuffled
        card_id = deck_state.draw_pile.pop(0)
        deck_state.discard_pile.append(card_id)
        return card_id, reshuffled

    def _draw_player_opportunity_hit_cards(self, entity: EnemyInstance, count: int) -> tuple[list[str], bool]:
        deck_state = entity.deck_state
        drawn: list[str] = []
        reshuffled = False
        for _ in range(max(0, int(count))):
            if not deck_state.draw_pile and deck_state.discard_pile:
                deck_state.draw_pile = list(deck_state.discard_pile)
                deck_state.discard_pile.clear()
                self._rng.shuffle(deck_state.draw_pile)
                reshuffled = True
            if not deck_state.draw_pile:
                break
            drawn.append(deck_state.draw_pile.pop(0))
        if drawn:
            deck_state.discard_pile.extend(drawn)
        return drawn, reshuffled

    def _first_regular_attack_effect(self, card_id: str) -> tuple[int, tuple[str, ...]]:
        card = self.context.card_index.get(card_id)
        if not card:
            return 0, tuple()
        for effect in card.effects:
            if effect.type == "attack":
                return max(0, int(effect.amount)), tuple(str(modifier) for modifier in getattr(effect, "modifiers", ()) or ())
        return 0, tuple()

    def _first_regular_attack_damage(self, card_id: str) -> int:
        damage, _ = self._first_regular_attack_effect(card_id)
        return damage

    def _is_enemy_special_card(self, entity: EnemyInstance, card_id: str) -> bool:
        card = self.context.card_index.get(card_id)
        if card and str(getattr(card, "action_result", "") or "").strip().upper() == "S":
            return True
        template = self.context.enemy_templates.get(getattr(entity, "template_id", ""))
        if not template:
            return False
        return card_id in {special.id for special in getattr(template, "specials", ())}

    def _apply_opportunity_damage(
        self,
        attacker: EnemyInstance,
        target: EnemyInstance,
        damage: int,
        *,
        unpreventable: bool,
        source: str,
    ) -> tuple["CombatLog", list[dict]]:
        log = apply_attack(
            target,
            max(0, int(damage)),
            mods=list(UNPREVENTABLE_ATTACK_MODS) if unpreventable else [],
            reset_toughness_on_deplete=self.is_player(target),
            add_wound_cards=not self._uses_physical_cards(target),
        )
        if log.wounds_added and self._uses_physical_cards(target):
            self._add_physical_wounds(target, log.wounds_added)
        for line in self._damage_grapples_held_by(target, log.damage_to_hp):
            self._add_log(line)
        for line in self._cleanup_grapples(add_log=False):
            self._add_log(line)
        wound_events: list[dict] = []
        if log.wounds_added:
            wound_events.append(
                {
                    "instanceId": target.instance_id,
                    "name": target.name,
                    "wounds": log.wounds_added,
                    "toughnessAfter": target.toughness_current,
                    "toughnessMax": target.toughness_max,
                }
            )
        return log, wound_events

    def resolve_opportunity_attack(
        self,
        *,
        action: str,
        use_willpower: Optional[bool] = None,
        manual_successes: Optional[int] = None,
        manual_fate: Optional[int] = None,
    ) -> dict:
        if not self.pending_opportunity:
            raise BattleSessionError("No pending opportunity attack.")
        action = str(action or "").strip().lower()
        if action not in {"attack", "skip"}:
            raise BattleSessionError("Opportunity action must be attack or skip.")

        attacker = self._pending_current_attacker()
        mover = self._pending_mover()
        if attacker is None or mover is None:
            self.pending_opportunity = None
            raise BattleSessionError("Pending opportunity attack is no longer valid.")
        if not self.is_player(attacker):
            self.pending_opportunity = None
            raise BattleSessionError("Pending opportunity attacker is not a player character.")

        if action == "skip":
            self._add_log(f"{attacker.name} skips the opportunity attack on {mover.name}.")
            result = self._continue_pending_opportunity(
                ignored_attacker_id=attacker.instance_id,
                notice=f"{attacker.name} skips the opportunity attack.",
            )
            self.autosave()
            return result

        success_count, fate_count, drawn = self._resolve_pc_opportunity_hit_draw(
            attacker,
            mover,
            manual_successes=manual_successes,
            manual_fate=manual_fate,
        )
        self.pending_opportunity["success_count"] = success_count
        self.pending_opportunity["fate_count"] = fate_count
        if drawn:
            self.pending_opportunity["drawn_card_ids"] = list(drawn)

        if use_willpower is None:
            if fate_count > 0:
                self.pending_opportunity["phase"] = "willpower"
                self._add_log(
                    f"{attacker.name} draws fate on an opportunity attack against {mover.name}; waiting for willpower choice."
                )
                notice = f"{attacker.name} drew {fate_count} fate. Choose whether to spend willpower."
            else:
                self.pending_opportunity["phase"] = "confirm"
                self._add_log(
                    f"{attacker.name} resolves an opportunity hit draw against {mover.name}; waiting for confirmation."
                )
                notice = f"{attacker.name} drew no fate. Confirm the opportunity attack result."
            self.autosave()
            return {
                "pendingOpportunity": self._pending_opportunity_snapshot(),
                "opportunityNotice": notice,
            }

        score = success_count + (fate_count if use_willpower else 0)
        self.pending_opportunity["use_willpower"] = bool(use_willpower)
        self.pending_opportunity["phase"] = "resolved"
        attacker.opportunity_attack_used_round = int(self.round)

        base_damage = self._opportunity_base_damage(attacker)
        wound_events: list[dict] = []
        notice = ""
        if score <= 0:
            self._add_log(f"Opportunity Attack by {attacker.name} on {mover.name}: miss.")
            notice = f"Opportunity Attack: {attacker.name} misses {mover.name}."
            result = self._continue_pending_opportunity(notice=notice)
            self.autosave()
            return result

        if score == 1:
            log, wound_events = self._apply_opportunity_damage(
                attacker,
                mover,
                base_damage,
                unpreventable=False,
                source="Opportunity Attack",
            )
            self._add_log(
                f"Opportunity Attack by {attacker.name} on {mover.name}: hit for {base_damage}; "
                f"{log.damage_to_hp} to Toughness."
            )
            notice = f"Opportunity Attack: {attacker.name} hits {mover.name} for {base_damage}."
            result = self._continue_pending_opportunity(wound_events=wound_events, notice=notice)
            self.autosave()
            return result

        damage = base_damage * 2 if score >= 3 else base_damage
        self._apply_opportunity_stop_position(mover, attacker)
        self._stop_active_movement()
        log, wound_events = self._apply_opportunity_damage(
            attacker,
            mover,
            damage,
            unpreventable=True,
            source="Opportunity Attack",
        )
        crit_text = " critical" if score >= 3 else ""
        self._add_log(
            f"Opportunity Attack by {attacker.name} on {mover.name}:{crit_text} precise hit; "
            f"{damage} unpreventable, movement stops."
        )
        self.pending_opportunity = None
        notice = (
            f"Opportunity Attack: {attacker.name} stops {mover.name} and deals "
            f"{damage} unpreventable damage."
        )
        self.autosave()
        return self._opportunity_result_payload(wound_events, notice=notice)

    def _apply_opportunity_stop_position(self, mover: EnemyInstance, attacker: EnemyInstance) -> None:
        if not self.pending_opportunity:
            return
        route_steps = [dict(step) for step in self.pending_opportunity.get("route_steps", []) or []]
        if not route_steps:
            return
        base_movement = int(self.pending_opportunity.get("base_movement", self.effective_movement(mover)) or 0)
        reach = self._opportunity_reach(attacker)
        for step in route_steps:
            stop_x, stop_y = int(step["x"]), int(step["y"])
            if not self._opportunity_threatens_position(attacker, stop_x, stop_y, reach):
                break
            self._apply_movement_step(mover, step, base_movement=base_movement)

    def _stop_active_movement(self) -> None:
        movement_state = self._movement_state_for_active()
        movement_state["movement_stopped"] = True

    def _resolve_pc_opportunity_hit_draw(
        self,
        attacker: EnemyInstance,
        mover: EnemyInstance,
        *,
        manual_successes: Optional[int],
        manual_fate: Optional[int],
    ) -> tuple[int, int, list[str]]:
        if self._uses_physical_cards(attacker):
            if self.pending_opportunity and self.pending_opportunity.get("success_count") is not None:
                return (
                    max(0, int(self.pending_opportunity.get("success_count") or 0)),
                    max(0, int(self.pending_opportunity.get("fate_count") or 0)),
                    [],
                )
            if manual_successes is None:
                raise BattleSessionError("Physical-card opportunity attacks need manual successes.")
            return max(0, int(manual_successes)), max(0, int(manual_fate or 0)), []

        drawn = list(self.pending_opportunity.get("drawn_card_ids") or []) if self.pending_opportunity else []
        if not drawn:
            draw_count = self._pc_opportunity_hit_draw_count(attacker, mover)
            drawn, reshuffled = self._draw_player_opportunity_hit_cards(attacker, draw_count)
            drawn_text = ", ".join(self.card_to_effect_text(card_id) for card_id in drawn) or "no cards"
            suffix = " (reshuffled first)" if reshuffled else ""
            self._add_log(f"{attacker.name} draws {draw_count} opportunity hit cards: {drawn_text}{suffix}")
        summary = self._player_draw_summary(drawn)
        return (
            max(0, int(summary["outcomes"].get("success", 0))),
            max(0, int(summary["outcomes"].get("fate", 0))),
            drawn,
        )

    def _continue_pending_opportunity(
        self,
        *,
        ignored_attacker_id: Optional[str] = None,
        wound_events: Optional[list[dict]] = None,
        notice: Optional[str] = None,
    ) -> dict:
        if not self.pending_opportunity:
            return self._opportunity_result_payload(wound_events or [], notice=notice)
        mover = self._pending_mover()
        if mover is None:
            self.pending_opportunity = None
            return self._opportunity_result_payload(wound_events or [], notice=notice)

        ignored = set(self.pending_opportunity.get("ignored_attacker_ids", []) or [])
        if ignored_attacker_id:
            ignored.add(ignored_attacker_id)

        attacker_ids = list(self.pending_opportunity.get("attacker_ids", []) or [])
        next_index = int(self.pending_opportunity.get("attacker_index", 0) or 0) + 1
        while next_index < len(attacker_ids):
            next_attacker = self.state.enemies.get(attacker_ids[next_index])
            if next_attacker and next_attacker.instance_id not in ignored and not self.is_down(next_attacker):
                self.pending_opportunity.update(
                    {
                        "attacker_index": next_index,
                        "ignored_attacker_ids": list(ignored),
                        "phase": "choose",
                        "drawn_card_ids": [],
                        "success_count": None,
                        "fate_count": None,
                        "use_willpower": None,
                    }
                )
                return self._opportunity_result_payload(
                    wound_events or [],
                    notice=notice or f"{mover.name} also provokes an opportunity attack from {next_attacker.name}.",
                )
            next_index += 1

        route_steps = [dict(step) for step in self.pending_opportunity.get("route_steps", []) or []]
        base_movement = int(self.pending_opportunity.get("base_movement", self.effective_movement(mover)) or 0)
        dash_requested = bool(self.pending_opportunity.get("dash_requested", False))
        full_move_cost = sum(int(step.get("cost", 0) or 0) for step in route_steps)
        self.pending_opportunity = None
        result = self._advance_movement_route(
            mover,
            route_steps,
            base_movement=base_movement,
            dash_requested=dash_requested,
            full_move_cost=full_move_cost,
            ignored_attacker_ids=ignored,
        )
        combined_events = list(wound_events or [])
        combined_events.extend(result.get("woundEvents", []))
        if combined_events:
            result["woundEvents"] = combined_events
        if notice and not result.get("opportunityNotice"):
            result["opportunityNotice"] = notice
        return result

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
            if draw_resolution.reshuffle_pending:
                suffix_parts.append("reshuffle pending")
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
            if draw_resolution.reshuffle_pending:
                suffix_parts.append("reshuffle pending")
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
        self.pending_opportunity = None
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
            self.pending_opportunity = None

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
        self.pending_opportunity = None
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

    def end_combat(self) -> None:
        if not self.encounter_started and self.active_turn_id is None and not self.pending_new_round:
            raise BattleSessionError("No active combat to end.")
        self.encounter_started = False
        self.active_turn_id = None
        self.turn_in_progress = False
        self.pending_new_round = False
        self.initiative_rolled_round = None
        self.movement_state = None
        self.pending_opportunity = None
        self.turn_skip_notice = []
        self.round = 1
        self._add_log("Combat ended.")
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

    def _grapples_for_target(self, target_id: str) -> list[GrappleInstance]:
        return sorted(
            [
                grapple
                for grapple in self.state.grapples.values()
                if grapple.target_id == target_id and grapple.toughness_current > 0
            ],
            key=lambda grapple: (grapple.toughness_current, grapple.created_order),
        )

    def _grapples_by_grappler(self, grappler_id: str) -> list[GrappleInstance]:
        return sorted(
            [
                grapple
                for grapple in self.state.grapples.values()
                if grapple.grappler_id == grappler_id and grapple.toughness_current > 0
            ],
            key=lambda grapple: grapple.created_order,
        )

    def _preferred_grapple_for_target(self, target_id: str) -> Optional[GrappleInstance]:
        grapples = self._grapples_for_target(target_id)
        return grapples[0] if grapples else None

    def _next_grapple_order(self) -> int:
        return 1 + max((grapple.created_order for grapple in self.state.grapples.values()), default=0)

    def _entity_name(self, instance_id: str) -> str:
        entity = self.state.enemies.get(instance_id)
        return entity.name if entity else instance_id

    def _grapple_payload(self, grapple: GrappleInstance) -> dict:
        payload = grapple_to_dict(grapple)
        payload.update(
            {
                "id": grapple.id,
                "grapplerId": grapple.grappler_id,
                "targetId": grapple.target_id,
                "grapplerName": self._entity_name(grapple.grappler_id),
                "targetName": self._entity_name(grapple.target_id),
                "toughnessCurrent": int(grapple.toughness_current),
                "toughnessMax": int(grapple.toughness_max),
                "createdOrder": int(grapple.created_order),
                "label": f"Grapple T {grapple.toughness_current}/{grapple.toughness_max}",
            }
        )
        return payload

    def _cleanup_grapples(self, *, add_log: bool = True) -> list[str]:
        lines: list[str] = []
        for grapple_id, grapple in list(self.state.grapples.items()):
            grappler = self.state.enemies.get(grapple.grappler_id)
            target = self.state.enemies.get(grapple.target_id)
            reason = ""
            if grapple.toughness_current <= 0:
                reason = "Toughness reaches 0"
            elif grappler is None or self.is_down(grappler):
                reason = "grappler is down"
            elif target is None or self.is_down(target):
                reason = "target is down"
            if not reason:
                continue
            self.state.grapples.pop(grapple_id, None)
            line = f"Grapple between {self._entity_name(grapple.grappler_id)} and {self._entity_name(grapple.target_id)} ends ({reason})."
            lines.append(line)
            if add_log:
                self._add_log(line)
        return lines

    def _apply_grapple(self, grappler: EnemyInstance, target: EnemyInstance, amount: int) -> str:
        amount = max(0, int(amount))
        if amount <= 0:
            return ""
        for grapple in self._grapples_for_target(target.instance_id):
            if grapple.grappler_id == grappler.instance_id:
                before_current = grapple.toughness_current
                before_max = grapple.toughness_max
                grapple.toughness_current += amount
                grapple.toughness_max += amount
                return (
                    f"{grappler.name}'s Grapple on {target.name} increases by {amount}: "
                    f"T {before_current}/{before_max}->{grapple.toughness_current}/{grapple.toughness_max}."
                )
        grapple = GrappleInstance(
            id=f"grapple-{uuid_short()}",
            grappler_id=grappler.instance_id,
            target_id=target.instance_id,
            toughness_current=amount,
            toughness_max=amount,
            created_order=self._next_grapple_order(),
        )
        self.state.grapples[grapple.id] = grapple
        return f"{target.name} is Grappled by {grappler.name} (T {amount}/{amount})."

    def _apply_charge(self, grappler: EnemyInstance, target: EnemyInstance, amount: int) -> list[str]:
        lines: list[str] = [f"{grappler.name} charges {target.name}."]
        grapple_line = self._apply_grapple(grappler, target, amount)
        if grapple_line:
            lines.append(grapple_line)
        prone_line = self._apply_prone(target)
        if prone_line:
            lines.append(prone_line)
        return lines

    @staticmethod
    def _apply_prone(target: EnemyInstance) -> str:
        if BattleSession._status_present(getattr(target, "statuses", {}) or {}, "prone"):
            return f"{target.name} is already Prone."
        target.statuses["prone"] = {"stacks": 1}
        return f"{target.name} is Prone."

    def _clear_prone_if_free(self, entity: EnemyInstance) -> None:
        if not self._status_present(getattr(entity, "statuses", {}) or {}, "prone"):
            return
        if self._grapples_for_target(entity.instance_id):
            return
        entity.statuses.pop("prone", None)
        self._add_log(f"{entity.name} stands up from Prone.")

    @staticmethod
    def _attack_is_ranged(modifiers: Iterable[str]) -> bool:
        return any(str(modifier).strip().lower() == "ranged" for modifier in modifiers or ())

    def _prone_npc_attack_damage_adjustment(self, target: EnemyInstance, modifiers: Iterable[str]) -> int:
        if not self._status_present(getattr(target, "statuses", {}) or {}, "prone"):
            return 0
        return -2 if self._attack_is_ranged(modifiers) else 2

    def _damage_grapple(self, grapple: GrappleInstance, damage: int, *, source: str) -> tuple[int, list[str]]:
        damage = max(0, int(damage))
        before = grapple.toughness_current
        dealt = min(before, damage)
        grapple.toughness_current = max(0, before - damage)
        lines = [
            (
                f"{source} damages Grapple on {self._entity_name(grapple.target_id)}: "
                f"{damage} in, T {before}->{grapple.toughness_current}."
            )
        ]
        lines.extend(self._cleanup_grapples(add_log=False))
        return dealt, lines

    def _damage_grapples_held_by(self, grappler: EnemyInstance, damage: int) -> list[str]:
        if damage <= 0:
            return []
        lines: list[str] = []
        for grapple in list(self._grapples_by_grappler(grappler.instance_id)):
            before = grapple.toughness_current
            grapple.toughness_current = max(0, before - int(damage))
            lines.append(
                f"Damage to {grappler.name} also reduces Grapple on {self._entity_name(grapple.target_id)}: "
                f"T {before}->{grapple.toughness_current}."
            )
        lines.extend(self._cleanup_grapples(add_log=False))
        return lines

    def _effective_attack_damage(self, attacker: Optional[EnemyInstance], damage: int, *, target_is_grapple: bool) -> int:
        damage = max(0, int(damage))
        if attacker is not None and not target_is_grapple and self._grapples_for_target(attacker.instance_id):
            return damage // 2
        return damage

    def apply_attack_to_selected(
        self,
        *,
        damage: int,
        modifiers: list[AttackMod],
        add_burn: bool,
        add_poison: bool,
        add_slow: bool,
        add_paralyze: bool,
        target_mode: str = "creature",
        grapple_id: Optional[str] = None,
    ) -> Optional[dict]:
        entity = self._require_selected_entity()
        if target_mode == "grapple":
            grapple = self.state.grapples.get(grapple_id or "") or self._preferred_grapple_for_target(entity.instance_id)
            if grapple is None or grapple.target_id != entity.instance_id:
                raise BattleSessionError("Selected entity has no targetable Grapple.")
            dealt, lines = self._damage_grapple(grapple, max(0, int(damage)), source="Manual attack")
            for line in lines:
                self._add_log(line)
            self.autosave()
            return {
                "grappleEvents": [
                    {
                        "grappleId": grapple.id,
                        "damage": dealt,
                        "toughnessAfter": max(0, grapple.toughness_current),
                    }
                ]
            }

        effective_mods = list(modifiers)
        if add_paralyze and "paralyse" not in effective_mods:
            effective_mods.append("paralyse")

        log = apply_attack(
            entity,
            max(0, int(damage)),
            mods=effective_mods,
            reset_toughness_on_deplete=self.is_player(entity),
            add_wound_cards=not self._uses_physical_cards(entity),
        )
        if log.wounds_added and self._uses_physical_cards(entity):
            self._add_physical_wounds(entity, log.wounds_added)
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
        for line in self._damage_grapples_held_by(entity, log.damage_to_hp):
            self._add_log(line)
        for line in self._cleanup_grapples(add_log=False):
            self._add_log(line)
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

        target: Optional[EnemyInstance] = None
        active_grapple = self._preferred_grapple_for_target(attacker.instance_id)
        if active_grapple is None:
            target = self._require_selected_entity()
            if target.instance_id == attacker.instance_id:
                raise BattleSessionError("Select a target other than the active NPC.")
            if self.is_down(target):
                raise BattleSessionError("Quick Attack target is down.")

        steps = self._quick_attack_steps_for(attacker)
        if not steps:
            raise BattleSessionError("Current draw has no attack effects.")

        wound_total = 0
        first_toughness_before = target.toughness_current if target is not None else active_grapple.toughness_current
        damage_to_toughness = 0
        labels: list[str] = []
        resolved_attacks: list[dict] = []
        unsupported: list[str] = []
        manual_effects: list[str] = []
        target_name = target.name if target is not None else f"Grapple on {attacker.name}"
        target_id = target.instance_id if target is not None else active_grapple.id

        for step in steps:
            grapple_target = self._preferred_grapple_for_target(attacker.instance_id)
            if grapple_target is not None:
                label = self._quick_attack_label(step)
                labels.append(label)
                attack_payload = self._quick_attack_payload(step)
                attack_payload["label"] = label
                resolved_attacks.append(attack_payload)
                dealt, lines = self._damage_grapple(grapple_target, int(step.damage), source=f"{attacker.name}'s {label}")
                damage_to_toughness += dealt
                for line in lines:
                    self._add_log(line)
                target_name = f"Grapple on {attacker.name}"
                target_id = grapple_target.id
            elif target is not None:
                selected_damage = self._conditional_attack_amount_for_target(target, step.damage, step.conditional_attack_effects)
                if selected_damage != step.damage:
                    self._add_log(
                        f"{target.name} meets a conditional attack clause; {attacker.name}'s attack damage changes "
                        f"from {step.damage} to {selected_damage}."
                    )
                prone_adjustment = self._prone_npc_attack_damage_adjustment(target, step.modifiers)
                adjusted_damage = max(0, selected_damage + prone_adjustment)
                if prone_adjustment > 0:
                    self._add_log(
                        f"{target.name} is Prone; {attacker.name}'s melee attack damage increases "
                        f"from {selected_damage} to {adjusted_damage}."
                    )
                elif prone_adjustment < 0:
                    self._add_log(
                        f"{target.name} is Prone; {attacker.name}'s ranged attack damage decreases "
                        f"from {selected_damage} to {adjusted_damage}."
                    )
                label = self._quick_attack_label(step, damage=adjusted_damage)
                labels.append(label)
                attack_payload = self._quick_attack_payload(step)
                attack_payload["damage"] = adjusted_damage
                attack_payload["selectedDamage"] = selected_damage
                attack_payload["proneAdjustment"] = prone_adjustment
                attack_payload["label"] = label
                resolved_attacks.append(attack_payload)
                effective_damage = self._effective_attack_damage(attacker, adjusted_damage, target_is_grapple=False)
                log = apply_attack(
                    target,
                    effective_damage,
                    mods=list(step.modifiers),
                    reset_toughness_on_deplete=self.is_player(target),
                    add_wound_cards=not self._uses_physical_cards(target),
                )
                if log.wounds_added and self._uses_physical_cards(target):
                    self._add_physical_wounds(target, log.wounds_added)
                wound_total += log.wounds_added
                damage_to_toughness += log.damage_to_hp
                for line in self._damage_grapples_held_by(target, log.damage_to_hp):
                    self._add_log(line)
                for grapple_effect in step.grapple_effects:
                    if "on_damage" in grapple_effect.modifiers and log.damage_to_hp <= 0:
                        continue
                    grapple_line = self._apply_grapple(attacker, target, grapple_effect.amount)
                    if grapple_line:
                        self._add_log(grapple_line)
                for charge_effect in step.charge_effects:
                    if "on_damage" in charge_effect.modifiers and log.damage_to_hp <= 0:
                        continue
                    for line in self._apply_charge(attacker, target, charge_effect.amount):
                        self._add_log(line)
                for prone_effect in step.prone_effects:
                    if "on_damage" in prone_effect.modifiers and log.damage_to_hp <= 0:
                        continue
                    self._add_log(self._apply_prone(target))
                for line in self._cleanup_grapples(add_log=False):
                    self._add_log(line)
            unsupported.extend(step.unsupported_modifiers)
            manual_effects.extend(step.manual_effects)

        manual_items = self._unique_preserve_order([*unsupported, *manual_effects])
        attacks_text = ", ".join(labels)
        message = (
            f"Quick Attack by {attacker.name} on {target_name}: {attacks_text}; "
            f"{damage_to_toughness} to Toughness"
        )
        if target is not None:
            message += f", Toughness {first_toughness_before}->{target.toughness_current}"
        if wound_total:
            message += f", {wound_total} wound{'s' if wound_total != 1 else ''} added"
        if manual_items:
            message += f"; handle manually: {', '.join(manual_items)}"
        attacker.quick_attack_used = True
        self._add_log(message)
        self.autosave()

        notice = f"Quick Attack: {attacker.name} attacks {target_name} with {attacks_text}."
        if manual_items:
            notice += f" Handle manually: {', '.join(manual_items)}."

        result = {
            "quickAttack": {
                "attackerId": attacker.instance_id,
                "attackerName": attacker.name,
                "targetId": target_id,
                "targetType": "unit" if target is not None else "grapple",
                "targetName": target_name,
                "attacks": resolved_attacks,
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

    def apply_heal_to_selected(
        self,
        *,
        toughness: int,
        armor: int,
        magic_armor: int,
        guard: int,
        temporary_toughness: int = 0,
    ) -> None:
        entity = self._require_selected_entity()
        temporary_toughness = max(0, int(temporary_toughness))
        if temporary_toughness and not self.is_player(entity):
            raise BattleSessionError("Temporary toughness is only available for player characters.")
        log = apply_heal(
            entity,
            toughness=max(0, int(toughness)),
            armor=max(0, int(armor)),
            magic_armor=max(0, int(magic_armor)),
            guard=max(0, int(guard)),
            toughness_cap=entity.toughness_max,
            allow_temporary_armor=True,
        )
        temp_text = ""
        if temporary_toughness:
            before_temp = entity.toughness_current
            entity.toughness_current += temporary_toughness
            temp_text = f", Temp toughness {before_temp}->{entity.toughness_current}"
        self._add_log(
            f"Heal on {entity.name}: Toughness {log.toughness_before}->{log.toughness_after}, "
            f"Armor {log.armor_before}->{log.armor_after}, "
            f"Magic {log.magic_armor_before}->{log.magic_armor_after}, "
            f"Guard {log.guard_before}->{log.guard_after}"
            f"{temp_text}"
        )
        self.autosave()

    def discard_player_wound(self, instance_id: str) -> None:
        entity = self._require_player_by_id(instance_id)
        if self._uses_physical_cards(entity):
            raise BattleSessionError("Physical-card players do not track wound locations.")
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
        if self._uses_physical_cards(entity):
            current = max(0, int(getattr(entity, "physical_wounds", 0) or 0))
            if current <= 0:
                raise BattleSessionError(f"{entity.name} has no wounds to remove.")
            entity.physical_wounds = current - 1
            entity.is_ko = False
            self._add_log(f"{entity.name} removes a physical wound ({current}->{entity.physical_wounds}).")
            self.autosave()
            return
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

    def adjust_physical_wounds(self, instance_id: str, *, delta: int) -> None:
        entity = self._require_player_by_id(instance_id)
        if not self._uses_physical_cards(entity):
            raise BattleSessionError("Wound total adjustment is only available for physical-card players.")
        current = max(0, int(getattr(entity, "physical_wounds", 0) or 0))
        next_total = current + int(delta)
        if next_total < 0:
            raise BattleSessionError(f"{entity.name} cannot have negative wounds.")
        entity.physical_wounds = next_total
        entity.is_ko = False
        self._add_log(f"{entity.name} physical wounds adjusted: {current}->{next_total}.")
        self.autosave()

    def _reset_player_deck_for_digital_cards(self, entity: EnemyInstance, *, wounds: int) -> None:
        deck_id = getattr(entity, "core_deck_id", None) or PLAYER_DECK_ID
        player_deck = self.context.player_decks.get(deck_id)
        if player_deck is None:
            raise BattleSessionError(f"Player deck '{deck_id}' is not loaded.")
        card_ids = build_core_deck_ids(player_deck, rnd=self._rng)
        card_ids.extend([WOUND_CARD_ID] * max(0, int(wounds)))
        self._rng.shuffle(card_ids)
        entity.deck_state = DeckState(draw_pile=card_ids, discard_pile=[], hand=[])
        entity.pending_reshuffle = False
        entity.power_draw_used = False
        entity.quick_attack_used = False
        entity.is_ko = False
        self._set_visible_draw(entity, [])

    def set_player_card_mode(self, instance_id: str, *, physical_cards: bool, deck_reset: bool = False) -> None:
        entity = self._require_player_by_id(instance_id)
        target_mode = bool(physical_cards)
        if target_mode == self._uses_physical_cards(entity):
            return

        if target_mode:
            converted_wounds = self._remove_digital_wounds(entity)
            entity.physical_wounds = max(0, int(getattr(entity, "physical_wounds", 0) or 0)) + converted_wounds
            entity.physical_cards = True
            entity.is_ko = False
            self._add_log(
                f"{entity.name} switches to physical cards"
                + (f" ({converted_wounds} wound{'s' if converted_wounds != 1 else ''} converted)." if converted_wounds else ".")
            )
        else:
            physical_wounds = max(0, int(getattr(entity, "physical_wounds", 0) or 0))
            if physical_wounds and not deck_reset:
                raise BattleSessionError(
                    "Switching from physical to digital cards with wounds requires a deck reset confirmation."
                )
            if deck_reset:
                self._reset_player_deck_for_digital_cards(entity, wounds=physical_wounds)
                entity.physical_wounds = 0
            entity.physical_cards = False
            self._add_log(
                f"{entity.name} switches to digital cards"
                + (f" with a deck reset ({physical_wounds} wound{'s' if physical_wounds != 1 else ''} shuffled in)." if deck_reset else ".")
            )
        self.autosave()

    def _charge_action(self, entity: EnemyInstance) -> None:
        entity.actions_used = getattr(entity, "actions_used", 0) + 1

    def prepare_pc(self) -> None:
        entity = self._require_selected_entity()
        if not self.is_player(entity):
            raise BattleSessionError("Prepare is only available for player characters.")
        entity.draw_bonus_next_turn = min(3, int(getattr(entity, "draw_bonus_next_turn", 0) or 0) + 1)
        self._charge_action(entity)
        self._add_log(f"{entity.name} prepares (+1 draw bonus next turn, total: {entity.draw_bonus_next_turn})")
        self.autosave()

    def strengthen_pc(self, x: int) -> None:
        entity = self._require_selected_entity()
        if not self.is_player(entity):
            raise BattleSessionError("Strengthen is only available for player characters.")
        x = max(1, int(x))
        entity.toughness_current = entity.toughness_current + x
        overflow = max(0, entity.toughness_current - entity.toughness_max)
        self._charge_action(entity)
        self._add_log(
            f"{entity.name} strengthened: +{x} toughness "
            f"({entity.toughness_current}/{entity.toughness_max})"
            + (f", {overflow} temporary" if overflow else "")
        )
        self.autosave()

    def guard_pc(self, x: int) -> None:
        entity = self._require_selected_entity()
        if not self.is_player(entity):
            raise BattleSessionError("Guard is only available for player characters.")
        x = max(1, int(x))
        entity.guard_current = max(0, int(getattr(entity, "guard_current", 0) or 0)) + x
        self._charge_action(entity)
        self._add_log(f"{entity.name} guards: +{x} guard.")
        self.autosave()

    def hitdraw_pc(self) -> dict:
        entity = self._require_selected_entity()
        if not self._can_take_turn(entity):
            raise BattleSessionError("Down units cannot take a turn.")
        if not self.is_player(entity):
            raise BattleSessionError("Hitdraw is only available for player characters.")
        if self._uses_physical_cards(entity):
            raise BattleSessionError("Physical-card players draw their hit cards outside the app.")
        if self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Hitdraw applies only to the active player.")
        if not getattr(entity, "power_draw_used", False):
            raise BattleSessionError("Use Draw of Power before Hitdraw.")

        drawn, reshuffled = self._draw_player_opportunity_hit_cards(entity, 3)
        summary = self._player_draw_summary(drawn)
        drawn_text = [self._player_hit_draw_label(card_id) for card_id in drawn]
        drawn_cards = [self._player_hit_draw_card_payload(card_id) for card_id in drawn]
        outcomes = summary["outcomes"]
        self._charge_action(entity)
        self._add_log(
            f"{entity.name} hits draw: {', '.join(drawn_text) or 'no cards'} "
            f"(success {outcomes['success']}, fate {outcomes['fate']}, fail {outcomes['fail']})"
        )
        self.autosave()
        return {
            "hitDraw": {
                "entityId": entity.instance_id,
                "entityName": entity.name,
                "drawnCardIds": drawn,
                "drawnText": drawn_text,
                "drawnCards": drawn_cards,
                "summary": summary,
                "reshuffled": bool(reshuffled),
            }
        }

    def shed_wound(self) -> None:
        entity = self._require_selected_entity()
        if not self.is_player(entity):
            raise BattleSessionError("Shed is only available for player characters.")
        if self._uses_physical_cards(entity):
            raise BattleSessionError("Physical-card players do not track wounds in hand.")
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
        if self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Disengage is only available for the active unit.")
        if self.is_down(entity):
            raise BattleSessionError("Down units cannot disengage.")
        if self.is_player(entity):
            self._charge_action(entity)
        movement_state = self._movement_state_for_active()
        movement_state["disengaged"] = True
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
        target.draw_bonus_next_turn = min(3, int(getattr(target, "draw_bonus_next_turn", 0) or 0) + 2)
        self._charge_action(helper)
        self._add_log(f"{helper.name} helps {target.name} (+2 draw bonus next turn).")
        self.autosave()

    def roll_loot_for_selected(self) -> None:
        entity = self._require_selected_enemy()
        self._inspect_loot_for_enemy(entity)

    def roll_loot_for_entity(self, instance_id: str) -> None:
        self.inspect_loot_for_entity(instance_id)

    def inspect_loot_for_entity(self, instance_id: str) -> None:
        entity = self.state.enemies.get(instance_id)
        if not entity:
            raise BattleSessionError(f"Entity '{instance_id}' does not exist")
        if self.is_player(entity):
            raise BattleSessionError("This action is not available for player cards")
        self.selected_id = instance_id
        self._inspect_loot_for_enemy(entity)

    def inspect_all_visible_loot(self) -> None:
        if self._combat_is_running():
            raise BattleSessionError("Inspect all loot is only available out of combat.")
        inspected = 0
        for entity in self.state.enemies.values():
            if (
                not self.is_player(entity)
                and self.is_down(entity)
                and not getattr(entity, "loot_rolled", False)
                and self._has_template_loot(entity)
                and self._entity_is_visible_for_loot(entity)
            ):
                self._inspect_loot_for_enemy(entity, autosave=False, add_log=False)
                inspected += 1
        if inspected:
            self._add_log(f"Inspected loot on {inspected} down enem{'y' if inspected == 1 else 'ies'}.")
        self.autosave()

    def take_loot_for_player(self, enemy_id: str, player_id: str) -> None:
        enemy = self.state.enemies.get(enemy_id)
        if not enemy:
            raise BattleSessionError(f"Entity '{enemy_id}' does not exist")
        if self.is_player(enemy):
            raise BattleSessionError("Player characters cannot be looted.")
        player = self.state.enemies.get(player_id)
        if not player:
            raise BattleSessionError(f"Entity '{player_id}' does not exist")
        if not self.is_player(player):
            raise BattleSessionError("Loot can only be taken by player characters.")
        if self.is_down(player):
            raise BattleSessionError("Down player characters cannot take loot.")
        if not self.is_down(enemy):
            raise BattleSessionError("Only down enemies can be looted.")
        if not getattr(enemy, "loot_rolled", False):
            raise BattleSessionError("Inspect loot before taking it.")
        if getattr(enemy, "loot_taken_by", None):
            raise BattleSessionError(f"Loot has already been taken from {enemy.name}.")
        if player.grid_x is None or player.grid_y is None or enemy.grid_x is None or enemy.grid_y is None:
            raise BattleSessionError("Both the player and enemy must be on the map to take loot.")
        distance = max(abs(player.grid_x - enemy.grid_x), abs(player.grid_y - enemy.grid_y))
        if distance > 1:
            raise BattleSessionError(f"{player.name} is not within 5ft of {enemy.name}.")

        if self._combat_is_running():
            if self.active_turn_id != player.instance_id:
                raise BattleSessionError("In combat, only the active player can take loot.")
            self._charge_action(player)

        player.inventory = merge_loot_payload(getattr(player, "inventory", None), getattr(enemy, "rolled_loot", None))
        enemy.loot_taken_by = player.instance_id
        self.selected_id = player.instance_id
        self._add_log(f"{player.name} takes loot from {enemy.name}.")
        self.autosave()

    def _inspect_loot_for_enemy(self, entity: EnemyInstance, *, autosave: bool = True, add_log: bool = True) -> None:
        if not self.is_down(entity):
            raise BattleSessionError("Only down enemies can be looted.")
        if getattr(entity, "loot_rolled", False):
            if autosave:
                self.autosave()
            return
        if entity.template_id == "custom":
            raise BattleSessionError("Custom enemies have no template loot.")
        template = self.context.enemy_templates.get(entity.template_id)
        if not template:
            raise BattleSessionError(f"Missing template for '{entity.name}'")
        if not getattr(template, "loot", ()):
            raise BattleSessionError(f"{template.name} has no loot table.")
        loot_result = roll_loot(template, rnd=self._rng)
        entity.rolled_loot = {
            "currency": dict(loot_result.currency),
            "resources": dict(loot_result.resources),
            "other": list(loot_result.other),
        }
        entity.loot_rolled = True
        if add_log:
            self._add_log(f"Loot inspected for {entity.name}")
        if autosave:
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
        # Shuffle player draw piles so re-draws produce fresh randomness.
        # Redo still restores the exact snapshot (same drawn cards).
        for entity in self.state.enemies.values():
            if self.is_player(entity) and entity.deck_state.draw_pile:
                self._rng.shuffle(entity.deck_state.draw_pile)
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
        display_name = str(name or "").strip() or "Session save"
        filename = self._new_manual_save_filename(display_name)
        path = self.context.manual_dir / filename
        self.active_save_filename = filename
        payload = self._build_payload(include_undo_stack=False)
        saved_at = payload.get("saved_at")
        payload["save_slot"] = {
            "filename": filename,
            "name": display_name,
            "createdAt": saved_at,
            "updatedAt": saved_at,
        }
        save_current(path, payload)
        self._add_log(f"Session save created: {display_name}")
        self.autosave()
        return {"save": self._manual_save_entry(path, payload)}

    def overwrite_manual(self, filename: str) -> dict:
        path = self._manual_save_path(filename)
        if not path.exists() or not path.is_file():
            raise BattleSessionError("Save not found")
        previous_payload = load_save_payload(path) or {}
        previous_entry = self._manual_save_entry(path, previous_payload)
        self.active_save_filename = filename
        payload = self._build_payload(include_undo_stack=False)
        saved_at = payload.get("saved_at")
        payload["save_slot"] = {
            "filename": filename,
            "name": previous_entry["name"],
            "createdAt": previous_entry.get("createdAt") or saved_at,
            "updatedAt": saved_at,
        }
        save_current(path, payload)
        self._add_log(f"Session save updated: {previous_entry['name']}")
        self.autosave()
        return {"save": self._manual_save_entry(path, payload)}

    def load_manual(self, filename: str) -> None:
        path = self._manual_save_path(filename)
        payload = load_save_payload(path)
        if not payload:
            raise BattleSessionError("Could not load save")
        self.load_from_payload(payload, load_undo_stack=False)
        self.active_save_filename = filename
        entry = self._manual_save_entry(path, payload)
        self._add_log(f"Loaded session save: {entry['name']}")
        self.autosave()

    def _new_manual_save_filename(self, name: str) -> str:
        base = safe_filename(name)
        stamp = now_stamp()
        filename = f"{base}_{stamp}.json"
        if not (self.context.manual_dir / filename).exists():
            return filename
        for suffix in range(2, 1000):
            candidate = f"{base}_{stamp}_{suffix}.json"
            if not (self.context.manual_dir / candidate).exists():
                return candidate
        raise BattleSessionError("Could not create a unique save filename")

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
                image = self.context._derived_image_path(template) if template else None
                image = image or "anonymous.png"

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
                "disengaged": False,
                "movement_stopped": False,
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
            "disengaged": bool(movement_state.get("disengaged", False)),
            "movement_stopped": bool(movement_state.get("movement_stopped", False)),
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
        movement_stopped = bool(movement_state.get("movement_stopped", False))
        return {
            "entityId": movement_state["entity_id"],
            "movementUsed": movement_state["movement_used"],
            "diagonalStepsUsed": movement_state["diagonal_steps_used"],
            "dashUsed": movement_state["dash_used"],
            "disengaged": bool(movement_state.get("disengaged", False)),
            "movementStopped": movement_stopped,
            "baseMovement": base_movement,
            "maxMovement": max_movement,
            "remainingMovement": 0 if movement_stopped else max(0, max_movement - movement_state["movement_used"]),
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
        route = self._movement_route(
            entity,
            target_x,
            target_y,
            diagonal_steps_used=diagonal_steps_used,
            max_cost=max_cost,
        )
        return (route.cost, route.diagonal_steps) if route is not None else None

    def _movement_route(
        self,
        entity: EnemyInstance,
        target_x: int,
        target_y: int,
        *,
        diagonal_steps_used: int,
        max_cost: Optional[int] = None,
    ) -> Optional[MovementRoute]:
        start = (int(entity.grid_x), int(entity.grid_y))
        target = (int(target_x), int(target_y))
        if start == target:
            return MovementRoute(cost=0, diagonal_steps=0, steps=())

        occupied = self._occupied_positions(exclude_id=entity.instance_id, passthrough_entity=entity)
        start_parity = int(diagonal_steps_used) % 2
        counter = 0
        queue: list[tuple[int, int, int, int, int, int, int, tuple[dict, ...]]] = [
            (0, 0, counter, 0, start[0], start[1], start_parity, ())
        ]
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
            cost, _neg_diagonal_steps, _counter, diagonal_steps, x, y, parity, path = heapq.heappop(queue)
            if best.get((x, y, parity)) != (cost, diagonal_steps):
                continue
            if (x, y) == target:
                return MovementRoute(cost=cost, diagonal_steps=diagonal_steps, steps=path)

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
                counter += 1
                next_path = (
                    *path,
                    {
                        "x": next_x,
                        "y": next_y,
                        "cost": step_cost,
                        "diagonal": bool(is_diagonal),
                    },
                )
                heapq.heappush(
                    queue,
                    (next_cost, -next_diagonal_steps, counter, next_diagonal_steps, next_x, next_y, next_parity, next_path),
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
        card = self._card_for_id(card_id)
        if not card:
            return card_id
        if card.action_text:
            return card.action_text
        if self._has_player_card_metadata(card):
            return self._player_card_text(card)
        parts: list[str] = []
        for effect in card.effects:
            if effect.type == "attack":
                if effect.modifiers:
                    modifiers = ", ".join(self._format_attack_modifier(modifier) for modifier in effect.modifiers)
                    parts.append(f"Attack {effect.amount} ({modifiers})")
                else:
                    parts.append(f"Attack {effect.amount}")
            elif effect.type == "grapple":
                suffix = " (on damage)" if "on_damage" in getattr(effect, "modifiers", ()) else ""
                parts.append(f"Grapple {effect.amount}{suffix}")
            elif effect.type == "charge":
                suffix = " (on damage)" if "on_damage" in getattr(effect, "modifiers", ()) else ""
                parts.append(f"Charge {effect.amount}{suffix}")
            elif effect.type == "prone":
                suffix = " (on damage)" if "on_damage" in getattr(effect, "modifiers", ()) else ""
                parts.append(f"Prone{suffix}")
            elif effect.type == "conditional_attack":
                conditions = ", ".join(
                    self._format_condition_modifier(modifier)
                    for modifier in getattr(effect, "modifiers", ())
                    if modifier.startswith("if_target_")
                )
                parts.append(
                    f"If target {conditions}: Attack {effect.amount} instead"
                    if conditions
                    else f"Conditional Attack {effect.amount}"
                )
            elif effect.type == "guard":
                parts.append(f"Guard {effect.amount}")
            elif effect.type == "draw":
                parts.append(f"Draw {effect.amount}")
            elif effect.type == "disengage":
                parts.append(f"Disengage {effect.amount}")
            else:
                parts.append(effect.type)
        return " + ".join(parts) if parts else (card.title or card_id)

    def _card_for_id(self, card_id: str) -> Optional[Card]:
        indexed = self.context.card_index.get(card_id)
        if indexed:
            return indexed
        for entity in self.state.enemies.values():
            card_payload = dict(getattr(entity, "card_library", {}) or {}).get(card_id)
            if isinstance(card_payload, dict):
                try:
                    return card_from_payload(card_payload)
                except (KeyError, TypeError, ValueError):
                    continue
        return self._legacy_player_card(card_id)

    @staticmethod
    def _legacy_player_card(card_id: str) -> Optional[Card]:
        raw = str(card_id or "").strip()
        match = re.match(
            r"^(?P<prefix>h[fwd])_(?P<energy>master|martial|elemental|light|void)_(?P<amount>\d+)_(?P<outcome>success|fate|fail)(?P<reshuffle>_reshuffle)?$",
            raw,
        )
        if not match:
            match = re.match(
                r"^(?P<prefix>h[fwd])_(?P<energy>master|martial|elemental|light|void)_(?P<outcome>success|fate|fail)(?P<reshuffle>_reshuffle)?$",
                raw,
            )
        if not match:
            return None
        energy_key = match.group("energy")
        outcome = match.group("outcome")
        amount = int(match.groupdict().get("amount") or (0 if energy_key == "void" else 1))
        energy_type = {
            "master": "Master",
            "martial": "Martial",
            "elemental": "Elemental",
            "light": "Light",
            "void": "Void",
        }[energy_key]
        title = (
            f"{energy_type} - {outcome}"
            if energy_type == "Void" and amount == 0
            else f"{energy_type} energy {amount} - {outcome}"
        )
        reshuffle = bool(match.group("reshuffle"))
        if reshuffle:
            title = f"{title} (reshuffle)"
        return Card(
            id=raw,
            title=title,
            effects=(),
            energy_type=energy_type,
            energy_amount=amount,
            outcome=outcome,
            reshuffle=reshuffle,
        )

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
            card = self._card_for_id(card_id)
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

    def _player_hit_draw_label(self, card_id: str) -> str:
        if card_id == WOUND_CARD_ID:
            return "Fail"
        card = self._card_for_id(card_id)
        outcome = (card.outcome if card else "").strip().lower()
        if outcome == "success":
            return "Success"
        if outcome == "fate":
            return "Fate"
        return "Fail"

    def _player_hit_draw_detail(self, card_id: str) -> str:
        if card_id == WOUND_CARD_ID:
            return "Wound"
        card = self._card_for_id(card_id)
        if not card:
            return card_id
        energy_type = (card.energy_type or "").strip()
        energy_amount = max(0, int(card.energy_amount or 0))
        if energy_type.lower() in {"class", "ancestry"}:
            title = (card.title or energy_type).split(" - ", 1)[0].strip()
            return f"{energy_type}: {title}" if title and title.lower() != energy_type.lower() else energy_type
        if energy_type:
            return f"{energy_type} {energy_amount} energy" if energy_amount > 0 else energy_type
        return card.title or card.id

    def _player_hit_draw_card_payload(self, card_id: str) -> dict:
        return {
            "label": self._player_hit_draw_label(card_id),
            "detail": self._player_hit_draw_detail(card_id),
        }

    def _quick_attack_steps_for(self, entity: EnemyInstance) -> list[QuickAttackStep]:
        steps: list[QuickAttackStep] = []
        for card_id in list(entity.deck_state.hand):
            card = self._card_for_id(card_id)
            if not card:
                continue
            manual_effects = tuple(
                self._effect_label(effect)
                for effect in card.effects
                if effect.type not in {"attack", "guard", "draw", "grapple", "charge", "prone", "conditional_attack"}
            )
            grapple_effects = tuple(effect for effect in card.effects if effect.type == "grapple")
            charge_effects = tuple(effect for effect in card.effects if effect.type == "charge")
            prone_effects = tuple(effect for effect in card.effects if effect.type == "prone")
            conditional_attack_effects = tuple(effect for effect in card.effects if effect.type == "conditional_attack")
            for effect in card.effects:
                if effect.type != "attack":
                    continue
                modifiers: list[AttackMod] = []
                unsupported: list[str] = []
                for modifier in effect.modifiers:
                    normalized = self._normalize_quick_attack_modifier(str(modifier))
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
                        manual_effects=tuple([*manual_effects, *getattr(card, "manual_notes", ())]),
                        grapple_effects=grapple_effects,
                        charge_effects=charge_effects,
                        prone_effects=prone_effects,
                        conditional_attack_effects=conditional_attack_effects,
                    )
                )
        return steps

    def _conditional_attack_amount_for_target(
        self,
        target: EnemyInstance,
        base_damage: int,
        effects: tuple[Effect, ...],
    ) -> int:
        amount = int(base_damage)
        for effect in effects:
            if "replace_attack" not in effect.modifiers:
                continue
            if self._target_matches_conditional_attack(target, effect.modifiers):
                amount = int(effect.amount)
        return amount

    def _target_matches_conditional_attack(self, target: EnemyInstance, modifiers: tuple[str, ...]) -> bool:
        modifier_set = set(modifiers or ())
        statuses = getattr(target, "statuses", {}) or {}
        checks: list[bool] = []
        if "if_target_grappled" in modifier_set:
            checks.append(bool(self._grapples_for_target(target.instance_id) or self._status_present(statuses, "grappled")))
        if "if_target_prone" in modifier_set:
            checks.append(self._status_present(statuses, "prone"))
        if "if_target_poisoned" in modifier_set:
            checks.append(self._status_present(statuses, "poison", "poisoned"))
        if "if_target_burning" in modifier_set:
            checks.append(self._status_present(statuses, "burn", "burning", "burned"))
        if "if_target_slowed" in modifier_set:
            checks.append(self._status_present(statuses, "slow", "slowed"))
        if "if_target_paralyzed" in modifier_set:
            checks.append(self._status_present(statuses, "paralyzed", "paralysed", "paralyze", "paralyse"))
        if "if_target_stunned" in modifier_set:
            checks.append(self._status_present(statuses, "stun", "stunned"))
        if not checks:
            return False
        return all(checks) if "condition_all" in modifier_set else any(checks)

    @staticmethod
    def _status_present(statuses: dict, *keys: str) -> bool:
        normalized = {str(key).strip().lower() for key in statuses.keys()}
        return any(key in normalized for key in keys)

    @staticmethod
    def _normalize_quick_attack_modifier(modifier: str) -> Optional[AttackMod]:
        lowered = modifier.strip().lower()
        pierce_match = re.match(r"^pierce[:\s]+(\d+)$", lowered)
        if pierce_match:
            amount = max(0, int(pierce_match.group(1)))
            return f"pierce:{amount}" if amount > 0 else None
        sunder_match = re.match(r"^sunder(?:[:\s]+(\d+))?$", lowered)
        if sunder_match:
            amount = max(0, int(sunder_match.group(1) or "1"))
            return f"sunder:{amount}" if amount > 0 else None
        return SUPPORTED_QUICK_ATTACK_MODIFIERS.get(lowered)

    def _quick_attack_payload(self, step: QuickAttackStep) -> dict:
        return {
            "cardId": step.card_id,
            "cardTitle": step.card_title,
            "damage": step.damage,
            "modifiers": list(step.modifiers),
            "unsupportedModifiers": list(step.unsupported_modifiers),
            "manualEffects": list(step.manual_effects),
            "grappleEffects": [
                {
                    "type": effect.type,
                    "amount": int(effect.amount),
                    "modifiers": list(effect.modifiers),
                }
                for effect in step.grapple_effects
            ],
            "chargeEffects": [
                {
                    "type": effect.type,
                    "amount": int(effect.amount),
                    "modifiers": list(effect.modifiers),
                }
                for effect in step.charge_effects
            ],
            "proneEffects": [
                {
                    "type": effect.type,
                    "amount": int(effect.amount),
                    "modifiers": list(effect.modifiers),
                }
                for effect in step.prone_effects
            ],
            "conditionalAttacks": [
                {
                    "type": effect.type,
                    "amount": int(effect.amount),
                    "modifiers": list(effect.modifiers),
                }
                for effect in step.conditional_attack_effects
            ],
            "label": self._quick_attack_label(step),
        }

    def _quick_attack_label(self, step: QuickAttackStep, *, damage: Optional[int] = None) -> str:
        amount = step.damage if damage is None else int(damage)
        visible_modifiers = tuple(modifier for modifier in step.modifiers if str(modifier).strip().lower() != "ranged")
        if visible_modifiers:
            return f"Attack {amount} ({', '.join(self._format_attack_modifier(modifier) for modifier in visible_modifiers)})"
        return f"Attack {amount}"

    @staticmethod
    def _format_attack_modifier(modifier: str) -> str:
        text = str(modifier)
        if text.startswith("pierce:"):
            return f"pierce {text.split(':', 1)[1]}"
        if text.startswith("sunder:"):
            return f"sunder {text.split(':', 1)[1]}"
        return text

    @staticmethod
    def _effect_label(effect) -> str:
        amount = int(getattr(effect, "amount", 0) or 0)
        if getattr(effect, "type", "") == "grapple":
            suffix = " (on damage)" if "on_damage" in getattr(effect, "modifiers", ()) else ""
            return f"Grapple {amount}{suffix}" if amount > 0 else "Grapple"
        if getattr(effect, "type", "") == "charge":
            suffix = " (on damage)" if "on_damage" in getattr(effect, "modifiers", ()) else ""
            return f"Charge {amount}{suffix}" if amount > 0 else "Charge"
        if getattr(effect, "type", "") == "prone":
            suffix = " (on damage)" if "on_damage" in getattr(effect, "modifiers", ()) else ""
            return f"Prone{suffix}"
        if getattr(effect, "type", "") == "conditional_attack":
            conditions = ", ".join(BattleSession._format_condition_modifier(modifier) for modifier in getattr(effect, "modifiers", ()) if modifier.startswith("if_target_"))
            return f"If target {conditions}: Attack {amount} instead" if conditions else f"Conditional Attack {amount}"
        return f"{effect.type} {amount}" if amount > 0 else str(effect.type)

    @staticmethod
    def _format_condition_modifier(modifier: str) -> str:
        return modifier.removeprefix("if_target_").replace("_", " ")

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

    def _uses_physical_cards(self, entity: EnemyInstance) -> bool:
        return self.is_player(entity) and bool(getattr(entity, "physical_cards", False))

    def _remove_digital_wounds(self, entity: EnemyInstance) -> int:
        deck_state = entity.deck_state
        removed = 0
        for zone_name in ("hand", "discard_pile", "draw_pile"):
            cards = list(getattr(deck_state, zone_name))
            kept = [card_id for card_id in cards if card_id != WOUND_CARD_ID]
            removed += len(cards) - len(kept)
            setattr(deck_state, zone_name, kept)
        return removed

    def _add_physical_wounds(self, entity: EnemyInstance, wounds: int) -> None:
        if wounds <= 0:
            return
        entity.physical_wounds = max(0, int(getattr(entity, "physical_wounds", 0) or 0)) + int(wounds)
        entity.is_ko = False

    def _player_wound_counts(self, entity: EnemyInstance) -> dict[str, int]:
        if self._uses_physical_cards(entity):
            return {
                "hand": 0,
                "discard": 0,
                "draw_pile": 0,
                "total": max(0, int(getattr(entity, "physical_wounds", 0) or 0)),
            }
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
        if self._uses_physical_cards(entity):
            entity.is_ko = False
        elif self.is_player(entity) and self._player_wound_counts(entity)["hand"] == 0:
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
        if self._uses_physical_cards(entity):
            raise BattleSessionError("Physical-card players draw their cards outside the app.")
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
        if self._uses_physical_cards(entity):
            raise BattleSessionError("Physical-card players draw their cards outside the app.")
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
        if self._uses_physical_cards(entity):
            raise BattleSessionError("Physical-card players draw their cards outside the app.")
        if self.active_turn_id is not None and self.active_turn_id != entity.instance_id:
            raise BattleSessionError("Another unit has the active turn. End that turn first.")
        count = max(1, int(count))

        if self.active_turn_id is None:
            self.active_turn_id = entity.instance_id
            self._start_turn(entity)
            self._reset_movement_state(entity.instance_id)

        self._charge_action(entity)
        result = self._draw_additional_for_player(entity, count)
        self.turn_in_progress = True
        entity.quick_attack_used = False

        resolved = list(result.drawn)
        instructions: list[str] = []
        for card_id in resolved:
            card = self._card_for_id(card_id)
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

    def _draw_additional_for_player(self, entity: EnemyInstance, n: int) -> "DrawResult":
        """Draw n extra cards; wounds drawn by a player go straight to discard (not kept in hand)."""
        result = draw_additional_cards(entity, n, rnd=self._rng)
        if self.is_player(entity):
            for card_id in result.drawn:
                if card_id == WOUND_CARD_ID:
                    entity.deck_state.hand.remove(WOUND_CARD_ID)
                    entity.deck_state.discard_pile.append(WOUND_CARD_ID)
        return result

    def _resolve_player_draw_effects(self, entity: EnemyInstance, card_ids: list[str]) -> PlayerDrawResolution:
        resolved: list[str] = list(card_ids)
        pending: list[str] = list(card_ids)
        extra_drawn = 0
        instructions: list[str] = []
        reshuffle_pending = False
        while pending:
            card_id = pending.pop(0)
            card = self._card_for_id(card_id)
            if not card:
                continue
            if card.reshuffle:
                entity.pending_reshuffle = True
                reshuffle_pending = True
            instruction = (card.instruction or "").strip()
            if instruction and instruction not in instructions:
                instructions.append(instruction)
            if card.extra_draw:
                result = self._draw_additional_for_player(entity, max(0, int(card.extra_draw)))
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
        reshuffle_pending = False
        while pending:
            card_id = pending.pop(0)
            card = self.context.card_index.get(card_id)
            if not card:
                continue
            if card.reshuffle:
                entity.pending_reshuffle = True
                reshuffle_pending = True
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
                elif effect.type == "disengage":
                    if self.active_turn_id == entity.instance_id:
                        self._movement_state_for_active()["disengaged"] = True
        return DrawResolution(
            card_ids=tuple(resolved),
            guard_added=guard_added,
            extra_drawn=extra_drawn,
            reshuffle_pending=reshuffle_pending,
        )

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

    def _start_player_draw_bonus_window(self, entity: EnemyInstance) -> None:
        next_turn_bonus = max(0, int(getattr(entity, "draw_bonus_next_turn", 0) or 0))
        if next_turn_bonus:
            entity.draw_bonus_pending = min(3, int(getattr(entity, "draw_bonus_pending", 0) or 0) + next_turn_bonus)
            entity.draw_bonus_next_turn = 0
            self._add_log(f"{entity.name} has +{next_turn_bonus} draw bonus available this turn.")

        # Strengthen overflow is temporary toughness only; it no longer grants draw.
        if entity.toughness_current > entity.toughness_max:
            entity.toughness_current = entity.toughness_max
            self._add_log(f"{entity.name} temporary toughness expired.")

    def _start_turn(self, entity: EnemyInstance) -> None:
        if self.is_player(entity) and not self._uses_physical_cards(entity):
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
        self._clear_prone_if_free(entity)
        if self.is_player(entity):
            self._start_player_draw_bonus_window(entity)
            if self._uses_physical_cards(entity):
                entity.is_ko = False
        if start_log.dot_damage:
            self._add_log(f"{entity.name} takes {start_log.dot_damage} DOT")
        if entity.armor_current > entity.armor_max:
            previous = entity.armor_current
            entity.armor_current = entity.armor_max
            self._add_log(f"{entity.name} temporary armor expires: {previous}->{entity.armor_current}.")

    def _finish_turn(self, entity: EnemyInstance) -> None:
        if self.is_player(entity):
            self._finish_player_turn(entity)
        else:
            end_turn(entity)
            if getattr(entity, "pending_reshuffle", False):
                self._reshuffle_enemy_deck_at_end(entity)
        self._add_log(f"Ended turn: {entity.name}")

    def _finish_player_turn(self, entity: EnemyInstance) -> None:
        unused_bonus = max(0, int(getattr(entity, "draw_bonus_pending", 0) or 0))
        if unused_bonus:
            entity.draw_bonus_pending = 0
            self._add_log(f"{entity.name}'s unused draw bonus expires.")
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

    def _reshuffle_enemy_deck_at_end(self, entity: EnemyInstance) -> None:
        deck_state = entity.deck_state
        cards = list(deck_state.draw_pile) + list(deck_state.discard_pile) + list(deck_state.hand)
        deck_state.draw_pile = cards
        deck_state.discard_pile.clear()
        deck_state.hand.clear()
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

    def _occupied_positions(
        self,
        *,
        exclude_id: Optional[str] = None,
        passthrough_entity: Optional["EnemyInstance"] = None,
    ) -> set[tuple[int, int]]:
        positions: set[tuple[int, int]] = set()
        for entity in self.state.enemies.values():
            if entity.instance_id == exclude_id:
                continue
            if not self._blocks_position(entity):
                continue
            # Same-faction units are passable during movement (can't stop on them, but can pass through)
            if passthrough_entity is not None and self.is_player(entity) == self.is_player(passthrough_entity):
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
        grappled_by = [self._grapple_payload(grapple) for grapple in self._grapples_for_target(instance_id)]
        grappling = [self._grapple_payload(grapple) for grapple in self._grapples_by_grappler(instance_id)]
        derived_statuses = dict(getattr(entity, "statuses", {}) or {})
        if grappled_by:
            derived_statuses["grappled"] = {"stacks": len(grappled_by)}
        if grappling:
            derived_statuses["grappling"] = {"stacks": len(grappling)}
        draw_groups = [
            {
                "label": f"Draw {index + 1}",
                "items": [self.card_to_effect_text(card_id) for card_id in group],
                "summary": self._player_draw_summary(group) if self.is_player(entity) else None,
            }
            for index, group in enumerate(self.visible_draw_groups_for(entity))
        ]
        loot_taken_by = getattr(entity, "loot_taken_by", None)
        loot_state = (
            "taken" if loot_taken_by
            else "inspected" if getattr(entity, "loot_rolled", False)
            else "uninspected" if self._has_template_loot(entity)
            else "none"
        )
        loot_taker = self.state.enemies.get(loot_taken_by) if loot_taken_by else None
        payload = enemy_to_dict(entity)
        payload.update(
            {
                "image_url": self.image_url_for(entity),
                "is_player": self.is_player(entity),
                "is_down": self.is_down(entity),
                "is_ko": bool(getattr(entity, "is_ko", False)) if self.is_player(entity) else False,
                "has_loot": self._has_template_loot(entity),
                "loot_state": loot_state,
                "loot_taken_by_name": loot_taker.name if loot_taker else None,
                "inventory": normalize_loot_payload(getattr(entity, "inventory", None)),
                "rolled_loot": normalize_loot_payload(getattr(entity, "rolled_loot", None)),
                "template_info": self._template_info_for(entity),
                "quick_attack_used": bool(getattr(entity, "quick_attack_used", False)),
                "effective_movement": self.effective_movement(entity),
                "statuses": derived_statuses,
                "status_text": self.format_statuses(derived_statuses),
                "grappled_by": grappled_by,
                "grappling": grappling,
                "current_draw_groups": draw_groups,
                "current_draw_text": [self.card_to_effect_text(card_id) for card_id in self.visible_draw_for(entity)],
                "current_draw_summary": (
                    self._player_draw_summary(self.visible_draw_for(entity))
                    if self.is_player(entity)
                    else None
                ),
                "pending_reshuffle": bool(getattr(entity, "pending_reshuffle", False)),
                "draw_bonus_pending": int(getattr(entity, "draw_bonus_pending", 0)),
                "draw_bonus_next_turn": int(getattr(entity, "draw_bonus_next_turn", 0)),
                "actions_used": int(getattr(entity, "actions_used", 0)),
                "physical_cards": bool(getattr(entity, "physical_cards", False)) if self.is_player(entity) else False,
                "physical_wounds": max(0, int(getattr(entity, "physical_wounds", 0) or 0)) if self.is_player(entity) else 0,
                "opportunity_attack_used_round": int(getattr(entity, "opportunity_attack_used_round", 0) or 0),
                "melee_weapon": dict(getattr(entity, "melee_weapon", {}) or {}) if self.is_player(entity) else None,
                "opportunity_base_damage": self._opportunity_base_damage(entity) if self.is_player(entity) else 1,
                "opportunity_reach": self._opportunity_reach(entity),
                "wounds_in_hand": 0 if self._uses_physical_cards(entity) else entity.deck_state.hand.count(WOUND_CARD_ID) if self.is_player(entity) else 0,
                "power_draw_used": bool(getattr(entity, "power_draw_used", False)),
                "wound_counts": self._player_wound_counts(entity) if self.is_player(entity) else None,
                "power_draw_cards": self._power_draw_cards_payload(entity) if self.is_player(entity) else None,
                "current_draw_attacks": [
                    self._quick_attack_payload(step)
                    for step in self._quick_attack_steps_for(entity)
                ],
            }
        )
        return payload

    def _has_template_loot(self, entity: EnemyInstance) -> bool:
        if self.is_player(entity) or getattr(entity, "template_id", "") in {"custom", "player"}:
            return False
        template = self.context.enemy_templates.get(getattr(entity, "template_id", ""))
        return bool(template and getattr(template, "loot", ()))

    def _template_info_for(self, entity: EnemyInstance) -> Optional[dict]:
        if self.is_player(entity):
            return None
        template = self.context.enemy_templates.get(getattr(entity, "template_id", ""))
        if not template:
            return None
        return {
            "part": getattr(template, "part", None),
            "section": getattr(template, "section", None),
            "threatTier": getattr(template, "threat_tier", None),
            "threatLevel": getattr(template, "threat_level", None),
            "shortFlavour": getattr(template, "short_flavour", None),
            "loreNote": getattr(template, "lore_note", None),
            "gmNote": getattr(template, "gm_note", None),
            "mechanicsNote": getattr(template, "mechanics_note", None),
            "traits": getattr(template, "traits", None),
            "size": getattr(template, "size", None),
            "skills": dict(getattr(template, "skills", {}) or {}),
            "actions": dict(getattr(template, "actions", {}) or {}),
            "playtestStatus": getattr(template, "playtest_status", None),
        }

    def _power_draw_cards_payload(self, entity: EnemyInstance) -> list:
        dop_group: list[str] = []
        draw_groups = getattr(entity, "draw_groups", [])
        if getattr(entity, "power_draw_used", False) and draw_groups:
            dop_group = list(draw_groups[0]) if isinstance(draw_groups[0], list) else []
        result = []
        for card_id in dop_group:
            if card_id == WOUND_CARD_ID:
                result.append({"energy_type": "", "energy_amount": 0, "outcome": "fail", "title": "Wound"})
            else:
                card = self._card_for_id(card_id)
                if card:
                    result.append({
                        "energy_type": card.energy_type or "",
                        "energy_amount": int(card.energy_amount or 0),
                        "outcome": card.outcome or "",
                        "title": self._player_card_text(card),
                    })
        return result

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
        deck_id = getattr(entity, "core_deck_id", None) or PLAYER_DECK_ID
        player_deck = self.context.player_decks.get(deck_id)
        if player_deck is None:
            return
        if getattr(entity, "core_deck_id", None) != deck_id:
            entity.core_deck_id = deck_id

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
        core_deck = template.action_deck or self.context.decks.get(template.coreDeck)
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
            if bool(getattr(entity, "physical_cards", False)):
                return False
            return bool(getattr(entity, "is_ko", False))
        return int(getattr(entity, "toughness_current", 0)) <= 0

    def _can_take_turn(self, entity: EnemyInstance) -> bool:
        return not self.is_down(entity)
