from __future__ import annotations

import uuid
from typing import Optional

from engine.runtime_models import DungeonIssue, DungeonRoom, DungeonState, DungeonWall, EnemyInstance, Tile


def _tile_key(x: int, y: int) -> str:
    return f"{x},{y}"


def _parse_key(key: str) -> tuple[int, int]:
    x, y = key.split(",")
    return int(x), int(y)


def _short_id() -> str:
    return uuid.uuid4().hex[:8]


# ---------------------------------------------------------------------------
# Canonical edge helpers (public for reuse in battle_session.py)
# ---------------------------------------------------------------------------

def canonical_edge_key(ax: int, ay: int, bx: int, by: int) -> str:
    """Return the canonical edge key between two adjacent cells."""
    if bx == ax + 1: return f"{ax},{ay},e"
    if bx == ax - 1: return f"{bx},{ay},e"
    if by == ay + 1: return f"{ax},{ay},s"
    if by == ay - 1: return f"{ax},{by},s"
    raise ValueError(f"Cells ({ax}, {ay}) and ({bx}, {by}) are not adjacent")


def normalize_side(x: int, y: int, side: str) -> str:
    """Normalize an (x, y, side) triple to a canonical edge key."""
    s = side.lower()
    if s == 'e': return f"{x},{y},e"
    if s == 'w': return f"{x - 1},{y},e"
    if s == 's': return f"{x},{y},s"
    if s == 'n': return f"{x},{y - 1},s"
    raise ValueError(f"Unknown side: {side!r}")


# ---------------------------------------------------------------------------
# Connected-component analysis
# ---------------------------------------------------------------------------

def _connected_components(
    tiles: dict[str, Tile],
    walls: dict[str, DungeonWall],
) -> list[frozenset[tuple[int, int]]]:
    """Return list of room components (floor tiles only) via cardinal flood-fill.

    Adjacency is blocked by any wall or door edge between two cells.
    """
    floor_cells: set[tuple[int, int]] = set()
    for key, tile in tiles.items():
        if tile.tile_type == "floor":
            x, y = key.split(",")
            floor_cells.add((int(x), int(y)))

    visited: set[tuple[int, int]] = set()
    components: list[frozenset[tuple[int, int]]] = []

    for start in floor_cells:
        if start in visited:
            continue
        component: set[tuple[int, int]] = set()
        stack = [start]
        while stack:
            cell = stack.pop()
            if cell in visited:
                continue
            visited.add(cell)
            component.add(cell)
            x, y = cell
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if (nx, ny) not in floor_cells or (nx, ny) in visited:
                    continue
                edge = canonical_edge_key(x, y, nx, ny)
                if edge in walls:
                    continue  # wall or door on this edge — not adjacent
                stack.append((nx, ny))
        components.append(frozenset(component))

    return components


# ---------------------------------------------------------------------------
# Room ID stability
# ---------------------------------------------------------------------------

def _assign_room_ids(
    components: list[frozenset[tuple[int, int]]],
    prev_rooms: list[DungeonRoom],
) -> tuple[list[DungeonRoom], list[DungeonIssue]]:
    """
    Assign room IDs to new components, maximising stability vs prev_rooms.
    Rules:
    - Each new component tries to claim the old room_id with the most overlap.
    - Merge (multiple new components want the same old id): largest wins, others get new ids.
    - Split (one old id claimed by multiple new components): largest keeps old id.
    - If old room was revealed, all split children are also revealed.
    - Conflict (two components tie in overlap for the same old id): deterministic fallback.
    """
    issues: list[DungeonIssue] = []

    # Build old room lookup
    old_by_id: dict[str, DungeonRoom] = {r.room_id: r for r in prev_rooms}
    old_cell_to_room: dict[tuple[int, int], str] = {}
    for r in prev_rooms:
        for cell in r.cells:
            old_cell_to_room[tuple(cell)] = r.room_id

    # For each new component, count overlap with each old room
    comp_best: list[Optional[str]] = []  # best old room_id candidate per component
    for comp in components:
        overlap_count: dict[str, int] = {}
        for cell in comp:
            old_id = old_cell_to_room.get(cell)
            if old_id:
                overlap_count[old_id] = overlap_count.get(old_id, 0) + 1

        if not overlap_count:
            comp_best.append(None)
            continue

        max_overlap = max(overlap_count.values())
        candidates = [rid for rid, cnt in overlap_count.items() if cnt == max_overlap]
        # deterministic: prefer alphabetically first if tie
        candidates.sort()
        comp_best.append(candidates[0])

    # Detect which old ids are claimed by multiple components (split from old perspective)
    # and which new components all want the same old id (merge from new perspective)
    old_id_to_claimants: dict[str, list[int]] = {}  # old_id → list of component indices
    for idx, best_id in enumerate(comp_best):
        if best_id is not None:
            old_id_to_claimants.setdefault(best_id, []).append(idx)

    # Resolve conflicts: for each old id claimed by multiple components, largest component wins
    assigned_ids: list[Optional[str]] = list(comp_best)
    for old_id, claimant_idxs in old_id_to_claimants.items():
        if len(claimant_idxs) == 1:
            continue
        # Multiple components want this old id — largest (by cell count) wins
        claimant_idxs.sort(key=lambda i: (-len(components[i]), min(components[i])))
        winner = claimant_idxs[0]
        for loser in claimant_idxs[1:]:
            assigned_ids[loser] = None  # will get a new id

    # Check for genuine tie (two components same size, same old id) — emit conflict issue
    for old_id, claimant_idxs in old_id_to_claimants.items():
        if len(claimant_idxs) > 1:
            sizes = [len(components[i]) for i in claimant_idxs]
            if sizes[0] == sizes[1]:
                sample_cell = next(iter(components[claimant_idxs[0]]))
                issues.append(DungeonIssue(
                    issue_type="roomIdentityConflict",
                    x=sample_cell[0],
                    y=sample_cell[1],
                    detail=f"Room identity for '{old_id}' was ambiguous; deterministic fallback applied.",
                ))

    # Build final rooms
    used_ids: set[str] = set()
    new_rooms: list[DungeonRoom] = []

    for idx, comp in enumerate(components):
        old_id = assigned_ids[idx]
        if old_id and old_id not in used_ids:
            room_id = old_id
            used_ids.add(room_id)
        else:
            room_id = _short_id()

        cells = sorted(list(comp))
        new_rooms.append(DungeonRoom(room_id=room_id, cells=cells))

    return new_rooms, issues


# ---------------------------------------------------------------------------
# Door wall linking
# ---------------------------------------------------------------------------

def _link_door_walls(
    walls: dict[str, DungeonWall],
    rooms: list[DungeonRoom],
) -> tuple[dict[str, list[str]], list[DungeonIssue]]:
    """
    For each door-type wall edge, determine which two rooms it connects.
    Edge key "x,y,e" connects cells (x,y) and (x+1,y).
    Edge key "x,y,s" connects cells (x,y) and (x,y+1).
    Returns linked_doors dict (edge_key → [room_id_a, room_id_b]) and issues.
    """
    cell_to_room: dict[tuple[int, int], str] = {}
    for room in rooms:
        for cell in room.cells:
            cell_to_room[tuple(cell)] = room.room_id

    linked_doors: dict[str, list[str]] = {}
    issues: list[DungeonIssue] = []

    for key, wall in walls.items():
        if wall.wall_type != "door":
            continue
        parts = key.split(",")
        x, y, side = int(parts[0]), int(parts[1]), parts[2]

        if side == 'e':
            cell_a, cell_b = (x, y), (x + 1, y)
        else:  # 's'
            cell_a, cell_b = (x, y), (x, y + 1)

        ra = cell_to_room.get(cell_a)
        rb = cell_to_room.get(cell_b)

        if ra and rb and ra != rb:
            linked_doors[key] = [ra, rb]
        else:
            issues.append(DungeonIssue(
                issue_type="unlinkedDoor",
                x=x, y=y, side=side,
                detail="Door edge has no valid room pair.",
            ))

    return linked_doors, issues


# ---------------------------------------------------------------------------
# Unit room assignment
# ---------------------------------------------------------------------------

def _assign_unit_rooms(
    entities: list[EnemyInstance],
    tiles: dict[str, Tile],
    rooms: list[DungeonRoom],
) -> list[DungeonIssue]:
    """Update room_id on each entity; emit unitOffGrid issue when tile is absent."""
    cell_to_room: dict[tuple[int, int], str] = {}
    for room in rooms:
        for cell in room.cells:
            cell_to_room[tuple(cell)] = room.room_id

    issues: list[DungeonIssue] = []
    for entity in entities:
        if entity.grid_x is None or entity.grid_y is None:
            entity.room_id = None
            continue
        key = _tile_key(entity.grid_x, entity.grid_y)
        tile = tiles.get(key)
        if tile is None:
            # unit is on a void cell
            entity.room_id = None
            entity.grid_x = None
            entity.grid_y = None
            issues.append(DungeonIssue(
                issue_type="unitOffGrid",
                unit_id=entity.instance_id,
                detail=f"{entity.name} is on a void tile and has been unplaced.",
            ))
        else:
            entity.room_id = cell_to_room.get((entity.grid_x, entity.grid_y))

    return issues


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def analyze(
    dungeon: DungeonState,
    entities: list[EnemyInstance],
) -> None:
    """
    Run full dungeon analysis in-place on `dungeon`:
    - Recompute rooms (connected components of floor tiles, split by wall/door edges).
    - Assign stable room IDs.
    - Link door edges to room pairs.
    - Assign unit room_ids; unplace units on void tiles.
    - Populate dungeon.issues.
    - Increment analysis_version.

    This is NOT called automatically by tile/wall edits — the client must call
    the /analyze endpoint after editing to refresh rooms and linkedDoors.
    """
    tiles = dungeon.tiles
    walls = dungeon.walls

    # 1. Connected components → rooms with stable IDs
    components = _connected_components(tiles, walls)
    new_rooms, id_issues = _assign_room_ids(components, dungeon.rooms)

    # 2. Door wall linking
    linked_doors, door_issues = _link_door_walls(walls, new_rooms)

    # 3. Unit room assignment
    unit_issues = _assign_unit_rooms(entities, tiles, new_rooms)

    # Commit results
    dungeon.rooms = new_rooms
    dungeon.linked_doors = linked_doors
    dungeon.issues = id_issues + door_issues + unit_issues
    dungeon.analysis_version += 1
    dungeon.render_version += 1


def migrate_to_dungeon(
    columns: int,
    rows: int,
    entities: list[EnemyInstance],
) -> DungeonState:
    """
    Build a fresh DungeonState from a legacy single-room session.
    All cells within the room bounds become floor tiles.
    Analysis runs immediately to produce one fully-revealed room.
    """
    tiles: dict[str, Tile] = {}
    for x in range(columns):
        for y in range(rows):
            tiles[_tile_key(x, y)] = Tile(tile_type="floor")

    dungeon = DungeonState(tiles=tiles)
    analyze(dungeon, entities)
    return dungeon
