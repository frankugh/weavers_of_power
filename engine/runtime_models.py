from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Tile:
    tile_type: str          # "floor"
    door_open: bool = False


@dataclass
class DungeonWall:
    wall_type: str          # "wall" | "door"
    door_open: bool = False


@dataclass
class DungeonRoom:
    room_id: str
    cells: list = field(default_factory=list)   # list of [x, y]


@dataclass
class DungeonIssue:
    issue_type: str         # "unlinkedDoor" | "unitOffGrid" | "roomIdentityConflict"
    x: Optional[int] = None
    y: Optional[int] = None
    side: Optional[str] = None   # "e" or "s" — for edge-related issues
    unit_id: Optional[str] = None
    detail: str = ""


@dataclass
class DungeonState:
    tiles: dict = field(default_factory=dict)                       # "x,y" → Tile
    walls: dict = field(default_factory=dict)                       # "x,y,e"|"x,y,s" → DungeonWall
    rooms: list = field(default_factory=list)                       # list of DungeonRoom
    revealed_room_ids: list = field(default_factory=list)           # str room_ids
    pending_encounter_room_ids: list = field(default_factory=list)  # str room_ids
    issues: list = field(default_factory=list)                      # list of DungeonIssue
    fog_of_war_enabled: bool = True
    analysis_version: int = 0
    render_version: int = 0
    # linked_doors is derived by analysis and persisted to avoid re-analyzing on every request.
    linked_doors: dict = field(default_factory=dict)                # "x,y,e"|"x,y,s" → [room_id_a, room_id_b]


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

    toughness_current: int
    toughness_max: int

    armor_current: int
    armor_max: int

    magic_armor_current: int
    magic_armor_max: int

    guard_base: int = 0
    guard_current: int = 0


    power_base: int = 1
    movement: int = 0
    core_deck_id: Optional[str] = None

    initiative_modifier: int = 2
    initiative_roll: Optional[int] = None
    initiative_total: Optional[int] = None
    initiative_mode: str = "normal"

    rolled_loot: dict = field(default_factory=dict)  # later typener; nu simpel
    loot_rolled: bool = False

    deck_state: DeckState = field(default_factory=DeckState)
    quick_attack_used: bool = False

    statuses: dict[str, dict] = field(default_factory=dict)

    grid_x: Optional[int] = None
    grid_y: Optional[int] = None
    room_id: Optional[str] = None
