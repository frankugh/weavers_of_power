from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


def empty_loot() -> dict:
    return {"currency": {}, "resources": {}, "other": []}


# How many grid cells (per side) a creature of a given size occupies.
# Tiny/Small/Medium share a single cell; Large+ scale up to a square block.
SIZE_FOOTPRINT: dict[str, int] = {
    "tiny": 1,
    "small": 1,
    "medium": 1,
    "large": 2,
    "huge": 3,
    "gargantuan": 4,
}


def footprint_for_size(size: Optional[str]) -> int:
    """Return the side length (in cells) of a creature's square footprint."""
    if not size:
        return 1
    return SIZE_FOOTPRINT.get(str(size).strip().lower(), 1)


def footprint_cells(grid_x: Optional[int], grid_y: Optional[int], size: Optional[str]) -> list[tuple[int, int]]:
    """All grid cells occupied by a creature anchored at (grid_x, grid_y).

    The anchor is the top-left cell of the footprint. Returns an empty list
    when the creature is not placed on the grid.
    """
    if grid_x is None or grid_y is None:
        return []
    side = footprint_for_size(size)
    ox, oy = int(grid_x), int(grid_y)
    return [(ox + dx, oy + dy) for dy in range(side) for dx in range(side)]


@dataclass
class Tile:
    tile_type: str          # "floor"
    door_open: bool = False


@dataclass
class DungeonWall:
    wall_type: str          # "wall" | "door" | "secret_door"
    door_open: bool = False
    secret_dc: int = 2
    secret_discovered: bool = False


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
    searched_room_ids: list = field(default_factory=list)           # room_ids already searched by party
    secret_suspects: list = field(default_factory=list)             # list of suspect dicts
    player_spawn: Optional[dict] = None                             # {"x": int, "y": int} player spawn-area cell
    info_markers: list = field(default_factory=list)                 # map flavour marker definitions
    info_marker_states: dict = field(default_factory=dict)           # runtime state by marker id
    search_check: dict = field(default_factory=dict)                 # default room-search check config


@dataclass
class DeckState:
    draw_pile: list[str] = field(default_factory=list)     # card_ids in shuffle order
    discard_pile: list[str] = field(default_factory=list)
    hand: list[str] = field(default_factory=list)          # cards drawn this turn (ids)


@dataclass
class GrappleInstance:
    id: str
    grappler_id: str
    target_id: str
    toughness_current: int
    toughness_max: int
    created_order: int


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

    rolled_loot: dict = field(default_factory=empty_loot)  # later typener; nu simpel
    loot_rolled: bool = False
    loot_taken_by: Optional[str] = None
    inventory: dict = field(default_factory=empty_loot)

    deck_state: DeckState = field(default_factory=DeckState)
    quick_attack_used: bool = False
    draw_groups: list[list[str]] = field(default_factory=list)
    pending_reshuffle: bool = False
    draw_bonus_pending: int = 0
    draw_bonus_next_turn: int = 0
    actions_used: int = 0
    power_draw_used: bool = False
    is_ko: bool = False
    physical_cards: bool = False
    physical_wounds: int = 0
    opportunity_attack_used_round: int = 0
    melee_weapon: dict = field(default_factory=dict)
    character_profile: dict = field(default_factory=dict)
    card_library: dict = field(default_factory=dict)
    abilities: dict[str, int] = field(default_factory=dict)
    specializations: list[dict] = field(default_factory=list)

    statuses: dict[str, dict] = field(default_factory=dict)

    grid_x: Optional[int] = None
    grid_y: Optional[int] = None
    room_id: Optional[str] = None

    # Creature size (e.g. "Large"), drives the multi-cell grid footprint.
    size: Optional[str] = None

    def footprint(self) -> int:
        return footprint_for_size(self.size)

    def occupied_cells(self) -> list[tuple[int, int]]:
        return footprint_cells(self.grid_x, self.grid_y, self.size)
