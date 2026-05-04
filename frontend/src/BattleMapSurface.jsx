import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAP_DRAG_THRESHOLD,
  MAP_GRID_GAP,
  MAP_VIEWPORT_PADDING,
  MAP_ZOOM,
  cellBounds,
  cellToWorld,
  centerCameraOnExtents,
  centerCameraOnCell,
  clampCamera,
  clampCellSize,
  clientPointToCell,
  mapContentSize,
  mapStep,
  visibleCellRange,
  sameCell,
  zoomCameraAt,
} from "./mapGeometry.js";

const VIEWPORT_FALLBACK = { left: 0, top: 0, width: 800, height: 500 };
const UNIT_DOUBLE_CLICK_MS = 320;
const DUNGEON_CHUNK_SIZE = 32;
const WALL_EDGE_VERTICAL = "vertical";
const WALL_EDGE_HORIZONTAL = "horizontal";

function pointerTypeOf(event) {
  return event.pointerType || event.nativeEvent?.pointerType || "mouse";
}

function pointerIdOf(event) {
  return event.pointerId ?? event.nativeEvent?.pointerId ?? 1;
}

function pointerButtonOf(event) {
  const button = event.button ?? event.nativeEvent?.button;
  if (Number.isInteger(button) && button >= 0) {
    return button;
  }
  const buttons = event.buttons ?? event.nativeEvent?.buttons;
  if (buttons === 4) {
    return 1;
  }
  return 0;
}

function pointerPointOf(event) {
  return {
    x: event.clientX ?? event.nativeEvent?.clientX ?? 0,
    y: event.clientY ?? event.nativeEvent?.clientY ?? 0,
  };
}

function viewportMetricsOf(element) {
  const rect = element?.getBoundingClientRect?.() || VIEWPORT_FALLBACK;

  return {
    left: Number.isFinite(rect.left) ? rect.left : VIEWPORT_FALLBACK.left,
    top: Number.isFinite(rect.top) ? rect.top : VIEWPORT_FALLBACK.top,
    width: rect.width || element?.clientWidth || VIEWPORT_FALLBACK.width,
    height: rect.height || element?.clientHeight || VIEWPORT_FALLBACK.height,
  };
}

function getEntityInitial(entity) {
  return (entity?.name || "?").trim().charAt(0).toUpperCase() || "?";
}

function hasGridPosition(entity, room, dungeon = null) {
  if (dungeon?.tiles) {
    return Number.isInteger(entity?.grid_x) && Number.isInteger(entity?.grid_y);
  }
  return (
    Number.isInteger(entity?.grid_x) &&
    Number.isInteger(entity?.grid_y) &&
    entity.grid_x >= 0 &&
    entity.grid_y >= 0 &&
    entity.grid_x < room.columns &&
    entity.grid_y < room.rows
  );
}

function positionKey(x, y) {
  return `${x}:${y}`;
}

function dungeonTileKey(x, y) {
  return `${x},${y}`;
}

function edgeKey(edge) {
  return `${edge.x},${edge.y},${edge.side}`;
}

function isBlockingEntity(entity) {
  return !entity?.is_down;
}

function getEntitiesAtPosition(entitiesByPosition, cell) {
  if (!cell) {
    return [];
  }
  return entitiesByPosition.get(positionKey(cell.x, cell.y)) || [];
}

function getBlockingEntity(entities) {
  return entities.find(isBlockingEntity) || null;
}

function getTopSelectableEntity(entities) {
  return getBlockingEntity(entities) || entities[0] || null;
}

function isAdditiveSelect(event) {
  return Boolean(event.shiftKey || event.nativeEvent?.shiftKey);
}

function isSubtractiveSelect(event) {
  return Boolean(event.ctrlKey || event.metaKey || event.nativeEvent?.ctrlKey || event.nativeEvent?.metaKey);
}

function entityIdsInRect(entities, firstCell, secondCell) {
  if (!firstCell || !secondCell) {
    return [];
  }
  const minX = Math.min(firstCell.x, secondCell.x);
  const maxX = Math.max(firstCell.x, secondCell.x);
  const minY = Math.min(firstCell.y, secondCell.y);
  const maxY = Math.max(firstCell.y, secondCell.y);
  return entities
    .filter((entity) => entity.grid_x >= minX && entity.grid_x <= maxX && entity.grid_y >= minY && entity.grid_y <= maxY)
    .map((entity) => entity.instance_id);
}

function percent(current, max) {
  if (!max) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((current / max) * 100)));
}

function healthColor(value) {
  if (value > 55) {
    return 0x7db97f;
  }
  if (value > 25) {
    return 0xd8b66a;
  }
  return 0xd16a57;
}

function clearLayer(layer) {
  const children = layer.removeChildren();
  children.forEach((child) => child.destroy({ children: true }));
}

function chunkCoord(value) {
  return Math.floor(value / DUNGEON_CHUNK_SIZE);
}

function chunkKeyForCell(x, y) {
  return `${chunkCoord(x)},${chunkCoord(y)}`;
}

function chunkKeysForRange(range) {
  const keys = [];
  const minChunkX = chunkCoord(range.minX);
  const maxChunkX = chunkCoord(range.maxX);
  const minChunkY = chunkCoord(range.minY);
  const maxChunkY = chunkCoord(range.maxY);
  for (let cy = minChunkY; cy <= maxChunkY; cy += 1) {
    for (let cx = minChunkX; cx <= maxChunkX; cx += 1) {
      keys.push(`${cx},${cy}`);
    }
  }
  return keys;
}

function isCellInRange(x, y, range) {
  return x >= range.minX && x <= range.maxX && y >= range.minY && y <= range.maxY;
}

function calculateDungeonFitExtents(dungeon, roomIds) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function includeCell(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  for (const room of dungeon?.rooms || []) {
    if (!roomIds.has(room.room_id)) {
      continue;
    }
    for (const cell of room.cells || []) {
      includeCell(Number(cell[0]), Number(cell[1]));
    }
  }

  Object.entries(dungeon?.linkedDoors || {}).forEach(([key, linkedRoomIds]) => {
    if (!Array.isArray(linkedRoomIds) || !linkedRoomIds.some((roomId) => roomIds.has(roomId))) {
      return;
    }
    const parts = key.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const side = parts[2];
    includeCell(x, y);
    if (side === "e") includeCell(x + 1, y);
    else if (side === "s") includeCell(x, y + 1);
  });

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function getDungeonFitRoomIds(dungeon) {
  const visibleRoomIds = new Set(dungeon?.visibleRoomIds || []);
  if (!visibleRoomIds.size) {
    return new Set();
  }

  const pcRoomIds = new Set((dungeon?.currentPcRoomIds || []).filter((roomId) => visibleRoomIds.has(roomId)));
  if (!pcRoomIds.size) {
    return visibleRoomIds;
  }

  const fitRoomIds = new Set(pcRoomIds);
  Object.values(dungeon?.linkedDoors || {}).forEach((linkedRoomIds) => {
    if (!Array.isArray(linkedRoomIds) || !linkedRoomIds.some((roomId) => pcRoomIds.has(roomId))) {
      return;
    }
    linkedRoomIds.forEach((roomId) => {
      if (visibleRoomIds.has(roomId)) {
        fitRoomIds.add(roomId);
      }
    });
  });
  return fitRoomIds;
}

function getDungeonFitExtents(dungeon) {
  const fitRoomIds = getDungeonFitRoomIds(dungeon);
  if (!fitRoomIds.size) {
    return null;
  }
  return calculateDungeonFitExtents(dungeon, fitRoomIds);
}

function buildDungeonRenderIndex(dungeon) {
  const tileChunks = new Map();
  const roomCellToRoom = new Map();
  const roomCellChunks = new Map();
  const wallChunks = buildWallRenderIndex(dungeon?.walls);

  for (const [key, tile] of Object.entries(dungeon?.tiles || {})) {
    const [x, y] = key.split(",").map(Number);
    const chunkKey = chunkKeyForCell(x, y);
    const entry = { key, x, y, tile };
    const current = tileChunks.get(chunkKey) || [];
    current.push(entry);
    tileChunks.set(chunkKey, current);
  }

  for (const room of dungeon?.rooms || []) {
    for (const cell of room.cells || []) {
      const x = Number(cell[0]);
      const y = Number(cell[1]);
      const key = `${x},${y}`;
      roomCellToRoom.set(key, room);
      const chunkKey = chunkKeyForCell(x, y);
      const current = roomCellChunks.get(chunkKey) || [];
      current.push({ x, y, room });
      roomCellChunks.set(chunkKey, current);
    }
  }

  return { tileChunks, roomCellToRoom, roomCellChunks, wallChunks };
}

function drawGrid(graphics, room, cellSize, { unbounded = false, camera = { x: 0, y: 0 }, viewport = VIEWPORT_FALLBACK } = {}) {
  if (unbounded) {
    const range = visibleCellRange(camera, viewport, cellSize);
    const step = cellSize + 2;
    const left = range.worldLeft - step;
    const top = range.worldTop - step;
    const width = range.worldRight - range.worldLeft + step * 2;
    const height = range.worldBottom - range.worldTop + step * 2;

    graphics.clear();
    graphics.rect(left, top, width, height).fill({ color: 0x070503, alpha: 0.9 });
    for (let x = range.minX; x <= range.maxX + 1; x += 1) {
      const lineX = 10 + x * step - (x > 0 ? 1 : 0);
      graphics.moveTo(lineX, top);
      graphics.lineTo(lineX, top + height);
    }
    for (let y = range.minY; y <= range.maxY + 1; y += 1) {
      const lineY = 10 + y * step - (y > 0 ? 1 : 0);
      graphics.moveTo(left, lineY);
      graphics.lineTo(left + width, lineY);
    }
    graphics.stroke({ color: 0x513a23, alpha: 0.52, width: 1 });
    return;
  }

  const contentSize = mapContentSize(room, cellSize);
  const gridWidth = contentSize.width - 20;
  const gridHeight = contentSize.height - 20;
  const step = cellSize + 2;

  graphics.clear();
  graphics.rect(0, 0, contentSize.width, contentSize.height).fill({ color: 0x070503, alpha: 0.9 });
  graphics.rect(10, 10, gridWidth, gridHeight).fill({ color: 0x1a130c, alpha: 0.86 });

  for (let x = 0; x <= room.columns; x += 1) {
    const lineX = 10 + x * step - (x > 0 ? 1 : 0);
    graphics.moveTo(lineX, 10);
    graphics.lineTo(lineX, 10 + gridHeight);
  }
  for (let y = 0; y <= room.rows; y += 1) {
    const lineY = 10 + y * step - (y > 0 ? 1 : 0);
    graphics.moveTo(10, lineY);
    graphics.lineTo(10 + gridWidth, lineY);
  }
  graphics.stroke({ color: 0x513a23, alpha: 0.62, width: 1 });
}

function roomIdAt(roomCellToRoom, x, y) {
  return roomCellToRoom.get(`${x},${y}`)?.room_id || null;
}

function drawDungeonTiles(graphics, dungeon, renderIndex, range, cellSize, isGmMode, highlightedRoomId = null) {
  graphics.clear();
  if (!dungeon) return;

  const revealedSet = new Set(dungeon.visibleRoomIds || []);
  const roomCellToRoom = renderIndex?.roomCellToRoom || new Map();

  for (const chunkKey of chunkKeysForRange(range)) {
    const entries = renderIndex?.tileChunks?.get(chunkKey) || [];
    for (const { key, x, y, tile } of entries) {
      if (!isCellInRange(x, y, range)) continue;
      if (tile.tile_type !== "floor") continue; // skip legacy door tiles and unknown types
      const bounds = cellBounds(x, y, cellSize);
      const room_ = roomCellToRoom.get(key);

      const revealed = room_ ? revealedSet.has(room_.room_id) : true;
      const showInNormalMode = revealed || isGmMode;
      if (!showInNormalMode) continue;

      const dimAlpha = !revealed && isGmMode ? 0.55 : 1;
      graphics
        .rect(bounds.x + 1, bounds.y + 1, bounds.width - 2, bounds.height - 2)
        .fill({ color: 0x2d1f12, alpha: 0.82 * dimAlpha });
    }
  }

  // In GM mode: grey overlay for hidden rooms (distinct from void)
  if (isGmMode) {
    for (const chunkKey of chunkKeysForRange(range)) {
      const entries = renderIndex?.roomCellChunks?.get(chunkKey) || [];
      for (const { x, y, room } of entries) {
        if (!isCellInRange(x, y, range) || revealedSet.has(room.room_id)) continue;
        const tileKey = `${x},${y}`;
        if (!dungeon.tiles?.[tileKey]) continue;
        const bounds = cellBounds(x, y, cellSize);
        graphics.rect(bounds.x, bounds.y, bounds.width, bounds.height).fill({ color: 0x9fb0b8, alpha: 0.28 });
      }
    }
  }

  // Highlighted room border
  if (highlightedRoomId) {
    for (const chunkKey of chunkKeysForRange(range)) {
      const entries = renderIndex?.roomCellChunks?.get(chunkKey) || [];
      for (const { x, y, room } of entries) {
        if (!isCellInRange(x, y, range) || room.room_id !== highlightedRoomId) continue;
        const bounds = cellBounds(x, y, cellSize);
        graphics
          .rect(bounds.x, bounds.y, bounds.width, bounds.height)
          .stroke({ color: 0xd8b66a, alpha: 0.9, width: 2 });
      }
    }
  }
}

function drawDungeonIssues(graphics, dungeon, range, cellSize) {
  graphics.clear();
  if (!dungeon) return;

  for (const issue of dungeon.issues || []) {
    if (issue.x == null || issue.y == null) continue;
    if (!isCellInRange(issue.x, issue.y, range)) continue;
    const bounds = cellBounds(issue.x, issue.y, cellSize);
    const issueDoorType = issue.issue_type === "unlinkedDoor" || issue.issue_type === "ambiguousDoor";
    const color = issueDoorType ? 0xf0b040 : 0xf04040;
    graphics
      .rect(bounds.x + 1, bounds.y + 1, bounds.width - 2, bounds.height - 2)
      .stroke({ color, alpha: 0.85, width: 2 });
  }
}

function drawDungeonPreview(graphics, previewCells, cellSize) {
  graphics.clear();
  if (!previewCells?.size) return;

  for (const cell of previewCells.values()) {
    const bounds = cellBounds(cell.x, cell.y, cellSize);
    if (cell.tileType === "void") {
      graphics
        .rect(bounds.x + 1, bounds.y + 1, bounds.width - 2, bounds.height - 2)
        .fill({ color: 0x0b0704, alpha: 0.94 })
        .stroke({ color: 0x82d9df, alpha: 0.26, width: 1 });
      continue;
    }

    graphics
      .rect(bounds.x + 1, bounds.y + 1, bounds.width - 2, bounds.height - 2)
      .fill({ color: 0x4a311c, alpha: 0.96 })
      .stroke({ color: 0xd8b66a, alpha: 0.35, width: 1 });
  }
}

function heapPush(heap, item) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareQueueItems(heap[parent], item) <= 0) {
      break;
    }
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = item;
}

function heapPop(heap) {
  if (!heap.length) {
    return null;
  }
  const root = heap[0];
  const last = heap.pop();
  if (heap.length && last) {
    let index = 0;
    while (true) {
      let child = index * 2 + 1;
      if (child >= heap.length) {
        break;
      }
      const right = child + 1;
      if (right < heap.length && compareQueueItems(heap[right], heap[child]) < 0) {
        child = right;
      }
      if (compareQueueItems(last, heap[child]) <= 0) {
        break;
      }
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
  }
  return root;
}

function compareQueueItems(first, second) {
  return first.cost - second.cost || second.diagonalSteps - first.diagonalSteps;
}

function movementStateNumber(movementState, key, fallback = 0) {
  const value = Number(movementState?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function dungeonBlocksCell(dungeon, x, y) {
  if (!dungeon || !dungeon.tiles) return false;
  return !dungeon.tiles[dungeonTileKey(x, y)]; // void/unknown blocks
}

function isDungeonCellVisibleToPlayers(dungeon, renderIndex, x, y) {
  if (!dungeon?.tiles) return true;
  const key = dungeonTileKey(x, y);
  if (!dungeon.tiles[key]) return false;
  const visibleRoomIds = new Set(dungeon.visibleRoomIds || []);
  const room = renderIndex?.roomCellToRoom?.get(key);
  if (room) return visibleRoomIds.has(room.room_id);
  return true; // unanalyzed floor: always show
}

function canonicalEdgeKey(ax, ay, bx, by) {
  if (bx === ax + 1) return `${ax},${ay},e`;
  if (bx === ax - 1) return `${bx},${ay},e`;
  if (by === ay + 1) return `${ax},${ay},s`;
  if (by === ay - 1) return `${ax},${by},s`;
  throw new Error(`Cells ${ax},${ay} and ${bx},${by} are not adjacent`);
}

function edgeHasAnyWall(dungeon, ax, ay, bx, by) {
  return !!dungeon?.walls?.[canonicalEdgeKey(ax, ay, bx, by)];
}

function wallBlocksOrthogonal(dungeon, ax, ay, bx, by) {
  const wall = dungeon?.walls?.[canonicalEdgeKey(ax, ay, bx, by)];
  if (!wall) return false;
  if (wall.wall_type === "wall") return true;
  if (wall.wall_type === "door") return !wall.door_open;
  if (wall.wall_type === "secret_door") return !(wall.secret_discovered && wall.door_open);
  return false;
}

function diagonalTouchesAnyWall(dungeon, ax, ay, bx, by) {
  return (
    edgeHasAnyWall(dungeon, ax, ay, bx, ay) ||
    edgeHasAnyWall(dungeon, ax, ay, ax, by) ||
    edgeHasAnyWall(dungeon, bx, by, ax, by) ||
    edgeHasAnyWall(dungeon, bx, by, bx, ay)
  );
}

function wallStrokeWidths(cellSize) {
  const outer = Math.max(7, Math.min(14, Math.round(cellSize * 0.12)));
  return {
    outer,
    inner: Math.max(3, Math.min(6, Math.round(outer * 0.46))),
    doorFrame: Math.max(4, Math.min(8, Math.round(cellSize * 0.07))),
  };
}

function wallEdgeOrientation(edge) {
  return edge?.side === "e" ? WALL_EDGE_VERTICAL : WALL_EDGE_HORIZONTAL;
}

function wallEdgeLine(edge) {
  return edge?.side === "e" ? edge.x : edge.y;
}

function snapToNearestEdge(worldX, worldY, cellSize, lock = null) {
  const step = mapStep(cellSize);
  const gridX = worldX - MAP_VIEWPORT_PADDING;
  const gridY = worldY - MAP_VIEWPORT_PADDING;
  const cx = Math.floor(gridX / step);
  const cy = Math.floor(gridY / step);
  const offsetX = gridX - cx * step;
  const offsetY = gridY - cy * step;
  const dE = Math.abs(cellSize - offsetX);
  const dW = Math.abs(offsetX);
  const dS = Math.abs(cellSize - offsetY);
  const dN = Math.abs(offsetY);
  const lockedLine = Number.isInteger(lock?.line) ? lock.line : null;
  if (lock?.orientation === WALL_EDGE_VERTICAL) {
    const x = lockedLine ?? (dE <= dW ? cx : cx - 1);
    return { x, y: cy, side: "e" };
  }
  if (lock?.orientation === WALL_EDGE_HORIZONTAL) {
    const y = lockedLine ?? (dS <= dN ? cy : cy - 1);
    return { x: cx, y, side: "s" };
  }
  const min = Math.min(dE, dW, dS, dN);
  if (min === dE) return { x: cx, y: cy, side: "e" };
  if (min === dW) return { x: cx - 1, y: cy, side: "e" };
  if (min === dS) return { x: cx, y: cy, side: "s" };
  return { x: cx, y: cy - 1, side: "s" };
}

function wallStrokeSegmentEdges(previous, edge) {
  if (!previous || previous.side !== edge.side) {
    return [edge];
  }
  if (edge.side === "e" && previous.x === edge.x) {
    const direction = previous.y <= edge.y ? 1 : -1;
    const edges = [];
    for (let y = previous.y; ; y += direction) {
      edges.push({ x: edge.x, y, side: "e" });
      if (y === edge.y) break;
    }
    return edges;
  }
  if (edge.side === "s" && previous.y === edge.y) {
    const direction = previous.x <= edge.x ? 1 : -1;
    const edges = [];
    for (let x = previous.x; ; x += direction) {
      edges.push({ x, y: edge.y, side: "s" });
      if (x === edge.x) break;
    }
    return edges;
  }
  return [edge];
}

function buildWallRenderIndex(walls) {
  const chunks = new Map();
  for (const [key, wall] of Object.entries(walls || {})) {
    const parts = key.split(",");
    const x = parseInt(parts[0], 10);
    const y = parseInt(parts[1], 10);
    const side = parts[2];
    const chunkKey = chunkKeyForCell(x, y);
    const current = chunks.get(chunkKey) || [];
    current.push({ key, x, y, side, wall });
    chunks.set(chunkKey, current);
  }
  return chunks;
}

function drawEdgeWall(graphics, wall, x1, y1, x2, y2, side, cellSize, isGmMode = false) {
  const widths = wallStrokeWidths(cellSize);
  if (wall.wall_type === "secret_door") {
    const discovered = wall.secret_discovered;
    if (isGmMode) {
      if (discovered) {
        // Discovered secret door in GM mode: draw as door with purple tint overlay
        // fall through to door drawing below by reassigning locally
      } else {
        // Hidden secret door in GM mode: dashed purple line
        const len = side === "e" ? y2 - y1 : x2 - x1;
        const dashLen = Math.max(3, Math.round(len * 0.25));
        const gap = Math.max(2, Math.round(len * 0.15));
        let pos = 0;
        let drawing = true;
        while (pos < len) {
          const end = Math.min(pos + (drawing ? dashLen : gap), len);
          if (drawing) {
            if (side === "e") graphics.moveTo(x1, y1 + pos).lineTo(x1, y1 + end).stroke({ color: 0x8844cc, alpha: 0.9, width: widths.outer });
            else graphics.moveTo(x1 + pos, y1).lineTo(x1 + end, y1).stroke({ color: 0x8844cc, alpha: 0.9, width: widths.outer });
          }
          pos = end;
          drawing = !drawing;
        }
        return;
      }
    } else if (!discovered) {
      // Hidden secret door for players: render as regular wall
      graphics.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: 0x140904, width: widths.outer });
      graphics.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: 0x8a5628, alpha: 0.9, width: widths.inner });
      return;
    }
    // Discovered secret door (any mode): render as regular door (fall through)
  }
  if (wall.wall_type === "wall") {
    graphics.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: 0x140904, width: widths.outer });
    graphics.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: 0x8a5628, alpha: 0.9, width: widths.inner });
    return;
  }
  // Door
  const isEast = side === "e";
  const totalLen = isEast ? y2 - y1 : x2 - x1;
  const gapSize = Math.max(4, Math.min(totalLen * 0.45, cellSize * 0.38));
  const halfGap = gapSize / 2;
  const midCoord = isEast ? (y1 + y2) / 2 : (x1 + x2) / 2;
  const frameColor = 0x3a2510;
  const panelColor = 0xd4a254;
  const panelDark = 0x8a5a26;
  const panelW = Math.max(widths.doorFrame, Math.round(cellSize * 0.16));

  if (isEast) {
    if (midCoord - halfGap > y1) graphics.moveTo(x1, y1).lineTo(x1, midCoord - halfGap).stroke({ color: frameColor, width: widths.doorFrame });
    if (midCoord + halfGap < y2) graphics.moveTo(x1, midCoord + halfGap).lineTo(x1, y2).stroke({ color: frameColor, width: widths.doorFrame });
    if (wall.door_open) {
      graphics.rect(x1 - panelW, y1, panelW, Math.round(gapSize)).fill({ color: panelDark });
      graphics.rect(x1 - panelW + 1, y1 + 1, Math.max(1, panelW - 2), Math.max(1, Math.round(gapSize) - 2)).fill({ color: panelColor, alpha: 0.9 });
    } else {
      graphics.rect(x1 - panelW / 2, midCoord - halfGap, panelW, gapSize).fill({ color: panelDark });
      graphics.rect(x1 - panelW / 2 + 1, midCoord - halfGap + 1, Math.max(1, panelW - 2), Math.max(1, gapSize - 2)).fill({ color: panelColor, alpha: 0.9 });
    }
  } else {
    if (midCoord - halfGap > x1) graphics.moveTo(x1, y1).lineTo(midCoord - halfGap, y1).stroke({ color: frameColor, width: widths.doorFrame });
    if (midCoord + halfGap < x2) graphics.moveTo(midCoord + halfGap, y1).lineTo(x2, y1).stroke({ color: frameColor, width: widths.doorFrame });
    if (wall.door_open) {
      graphics.rect(x1, y1 - panelW, Math.round(gapSize), panelW).fill({ color: panelDark });
      graphics.rect(x1 + 1, y1 - panelW + 1, Math.max(1, Math.round(gapSize) - 2), Math.max(1, panelW - 2)).fill({ color: panelColor, alpha: 0.9 });
    } else {
      graphics.rect(midCoord - halfGap, y1 - panelW / 2, gapSize, panelW).fill({ color: panelDark });
      graphics.rect(midCoord - halfGap + 1, y1 - panelW / 2 + 1, Math.max(1, gapSize - 2), Math.max(1, panelW - 2)).fill({ color: panelColor, alpha: 0.9 });
    }
  }
}

function drawSecretSuspects(PIXI, container, dungeon, renderIndex, range, cellSize, isGmMode = false) {
  while (container.children.length > 0) container.removeChildAt(0);
  if (!dungeon?.secretSuspects?.length) return;
  const step = mapStep(cellSize);
  const padding = MAP_VIEWPORT_PADDING;
  const halfGap = Math.floor(MAP_GRID_GAP / 2);
  const revealedSet = new Set(dungeon.visibleRoomIds || []);
  const roomCellToRoom = renderIndex?.roomCellToRoom || new Map();

  for (const suspect of dungeon.secretSuspects) {
    const parts = suspect.edge_key?.split(",");
    if (!parts || parts.length !== 3) continue;
    const x = parseInt(parts[0], 10);
    const y = parseInt(parts[1], 10);
    const side = parts[2];
    if (!isCellInRange(x, y, { ...range, minX: range.minX - 1, minY: range.minY - 1 })) continue;
    if (!isGmMode) {
      // Check both cells adjacent to the edge for visibility
      const nx = side === "e" ? x + 1 : x;
      const ny = side === "s" ? y + 1 : y;
      const roomCellA = roomCellToRoom.get(`${x},${y}`);
      const roomCellB = roomCellToRoom.get(`${nx},${ny}`);
      const visibleA = !roomCellA || revealedSet.has(roomCellA.room_id);
      const visibleB = !roomCellB || revealedSet.has(roomCellB.room_id);
      if (!visibleA && !visibleB) continue;
    }

    let cx, cy;
    if (side === "e") {
      cx = padding + (x + 1) * step - halfGap;
      cy = padding + y * step + cellSize / 2;
    } else {
      cx = padding + x * step + cellSize / 2;
      cy = padding + (y + 1) * step - halfGap;
    }

    const radius = Math.max(5, Math.round(cellSize * 0.18));
    const bg = new PIXI.Graphics();
    const fillColor = suspect.exhausted ? 0x666666 : 0x774499;
    bg.circle(cx, cy, radius).fill({ color: fillColor, alpha: 0.85 });
    bg.circle(cx, cy, radius).stroke({ color: 0xffffff, alpha: 0.6, width: 1 });
    container.addChild(bg);

    const label = new PIXI.Text({
      text: "?",
      style: { fill: 0xffffff, fontSize: Math.max(7, Math.round(cellSize * 0.22)), fontWeight: "700" },
      anchor: 0.5,
    });
    label.x = cx;
    label.y = cy;
    container.addChild(label);
  }
}

function drawWallEdges(graphics, dungeon, wallRenderIndex, renderIndex, range, cellSize, isGmMode) {
  graphics.clear();
  if (!dungeon?.walls) return;

  const step = mapStep(cellSize);
  const padding = MAP_VIEWPORT_PADDING;
  const halfGap = Math.floor(MAP_GRID_GAP / 2);
  const revealedSet = new Set(dungeon.visibleRoomIds || []);
  const roomCellToRoom = renderIndex?.roomCellToRoom || new Map();
  const edgeRange = {
    ...range,
    minX: range.minX - 1,
    minY: range.minY - 1,
  };

  for (const chunkKey of chunkKeysForRange(edgeRange)) {
    const entries = wallRenderIndex?.get(chunkKey) || [];
    for (const { x, y, side, wall } of entries) {
      if (!isCellInRange(x, y, edgeRange)) continue;
      if (!isGmMode) {
        const roomA = roomCellToRoom.get(`${x},${y}`);
        const visA = roomA && revealedSet.has(roomA.room_id);
        const bx = side === "e" ? x + 1 : x;
        const by = side === "s" ? y + 1 : y;
        const roomB = roomCellToRoom.get(`${bx},${by}`);
        const visB = roomB && revealedSet.has(roomB.room_id);
        if (!visA && !visB) continue;
      }
      if (side === "e") {
        const ex = padding + (x + 1) * step - halfGap;
        drawEdgeWall(graphics, wall, ex, padding + y * step, ex, padding + y * step + cellSize, "e", cellSize, isGmMode);
      } else {
        const sy = padding + (y + 1) * step - halfGap;
        drawEdgeWall(graphics, wall, padding + x * step, sy, padding + x * step + cellSize, sy, "s", cellSize, isGmMode);
      }
    }
  }
}

function drawWallEdgePreview(graphics, edges, wallPalette, cellSize) {
  graphics.clear();
  if (!edges?.length) return;
  const step = mapStep(cellSize);
  const padding = MAP_VIEWPORT_PADDING;
  const halfGap = Math.floor(MAP_GRID_GAP / 2);
  const color = wallPalette === "erase" ? 0xff5555 : wallPalette === "door" ? 0xe8c070 : wallPalette === "secret_door" ? 0xaa66ff : 0x9ab0c0;
  const widths = wallStrokeWidths(cellSize);
  const lineWidth = wallPalette === "door" ? widths.doorFrame : widths.outer;

  for (const { x, y, side } of edges) {
    if (side === "e") {
      const ex = padding + (x + 1) * step - halfGap;
      graphics.moveTo(ex, padding + y * step).lineTo(ex, padding + y * step + cellSize).stroke({ color, alpha: 0.7, width: lineWidth });
    } else {
      const sy = padding + (y + 1) * step - halfGap;
      graphics.moveTo(padding + x * step, sy).lineTo(padding + x * step + cellSize, sy).stroke({ color, alpha: 0.7, width: lineWidth });
    }
  }
}

function getReachableMovementCells(room, selectedEntity, movementState, blockingByPosition, dungeon, passthroughByPosition = new Map()) {
  const reachable = new Map();
  const usesDungeonGrid = Boolean(dungeon?.tiles);
  if (!hasGridPosition(selectedEntity, room, dungeon)) {
    return reachable;
  }

  const baseMovement = Math.max(
    0,
    movementStateNumber(movementState, "baseMovement", Number(selectedEntity?.effective_movement || 0)),
  );
  const movementUsed = Math.max(0, movementStateNumber(movementState, "movementUsed", 0));
  const diagonalStepsUsed = Math.max(0, movementStateNumber(movementState, "diagonalStepsUsed", 0));
  const dashUsed = Boolean(movementState?.dashUsed);
  const maxRemaining = Math.max(0, baseMovement * 2 - movementUsed);
  if (!maxRemaining) {
    return reachable;
  }

  const start = { x: selectedEntity.grid_x, y: selectedEntity.grid_y };
  const startParity = diagonalStepsUsed % 2;
  const queue = [{ cost: 0, diagonalSteps: 0, x: start.x, y: start.y, parity: startParity }];
  const best = new Map([[`${start.x}:${start.y}:${startParity}`, { cost: 0, diagonalSteps: 0 }]]);
  const directions = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];

  while (queue.length) {
    const current = heapPop(queue);
    const currentBest = best.get(`${current.x}:${current.y}:${current.parity}`);
    if (!currentBest || currentBest.cost !== current.cost || currentBest.diagonalSteps !== current.diagonalSteps) {
      continue;
    }

    for (const [dx, dy] of directions) {
      const nextX = current.x + dx;
      const nextY = current.y + dy;
      if (!usesDungeonGrid && (nextX < 0 || nextY < 0 || nextX >= room.columns || nextY >= room.rows)) {
        continue;
      }
      const nextKey = positionKey(nextX, nextY);
      const isPassthrough = passthroughByPosition.has(nextKey);
      // Friendly units (passthrough) can be traversed but not stopped on; enemies hard-block
      if (!isPassthrough && blockingByPosition.has(nextKey)) {
        continue;
      }
      if (dungeonBlocksCell(dungeon, nextX, nextY)) {
        continue;
      }

      const isDiagonal = dx !== 0 && dy !== 0;
      if (isDiagonal) {
        if (diagonalTouchesAnyWall(dungeon, current.x, current.y, nextX, nextY)) continue;
      } else if (wallBlocksOrthogonal(dungeon, current.x, current.y, nextX, nextY)) {
        continue;
      }

      const stepCost = isDiagonal ? (current.parity === 0 ? 1 : 2) : 1;
      const nextCost = current.cost + stepCost;
      if (nextCost > maxRemaining) {
        continue;
      }

      const nextParity = isDiagonal ? 1 - current.parity : current.parity;
      const nextDiagonalSteps = current.diagonalSteps + (isDiagonal ? 1 : 0);
      const key = `${nextX}:${nextY}:${nextParity}`;
      const previous = best.get(key);
      if (previous && (previous.cost < nextCost || (previous.cost === nextCost && previous.diagonalSteps >= nextDiagonalSteps))) {
        continue;
      }

      const totalCost = movementUsed + nextCost;
      const requiresDash = !dashUsed && totalCost > baseMovement;
      const cellKey = nextKey;
      const kind = dashUsed || totalCost > baseMovement ? "dash" : "normal";
      // Only mark as a valid destination if no friendly unit is standing here
      if (!isPassthrough) {
        const currentCell = reachable.get(cellKey);
        if (!currentCell || currentCell.cost > nextCost) {
          reachable.set(cellKey, {
            x: nextX,
            y: nextY,
            cost: nextCost,
            diagonalSteps: nextDiagonalSteps,
            kind,
            requiresDash,
          });
        }
      }

      best.set(key, { cost: nextCost, diagonalSteps: nextDiagonalSteps });
      heapPush(queue, { cost: nextCost, diagonalSteps: nextDiagonalSteps, x: nextX, y: nextY, parity: nextParity });
    }
  }

  reachable.delete(positionKey(start.x, start.y));
  return reachable;
}

function countReachableByKind(reachableCells, kind) {
  let count = 0;
  for (const cell of reachableCells.values()) {
    if (cell.kind === kind) {
      count += 1;
    }
  }
  return count;
}

function drawMoveHighlights(
  graphics,
  room,
  dungeon,
  renderIndex,
  cellSize,
  mapMode,
  selectedEntity,
  busy,
  hoverCell,
  blockingByPosition,
  reachableCells,
  camera,
  viewport,
) {
  graphics.clear();

  if (mapMode === "idle" || !selectedEntity || busy) {
    return;
  }

  const isRepositionMode = mapMode === "reposition" || mapMode === "gm-reposition";
  const usesDungeonGrid = Boolean(dungeon?.tiles);
  if (isRepositionMode) {
    if (usesDungeonGrid) {
      const range = visibleCellRange(camera, viewport, cellSize);
      for (const chunkKey of chunkKeysForRange(range)) {
        const entries = renderIndex?.tileChunks?.get(chunkKey) || [];
        for (const { x, y } of entries) {
          if (!isCellInRange(x, y, range) || dungeonBlocksCell(dungeon, x, y)) continue;
          if (!isDungeonCellVisibleToPlayers(dungeon, renderIndex, x, y)) continue;
          if (blockingByPosition.has(positionKey(x, y))) continue;
          const bounds = cellBounds(x, y, cellSize);
          graphics
            .rect(bounds.x, bounds.y, bounds.width, bounds.height)
            .fill({ color: 0x82d9df, alpha: 0.055 })
            .stroke({ color: 0x82d9df, alpha: 0.2, width: 1 });
        }
      }
    } else {
      const contentSize = mapContentSize(room, cellSize);
      graphics
        .rect(10, 10, contentSize.width - 20, contentSize.height - 20)
        .fill({ color: 0x82d9df, alpha: 0.035 })
        .stroke({ color: 0x82d9df, alpha: 0.32, width: 2 });
    }
  } else {
    for (const cell of reachableCells.values()) {
      const bounds = cellBounds(cell.x, cell.y, cellSize);
      const isDash = cell.kind === "dash";
      graphics
        .rect(bounds.x, bounds.y, bounds.width, bounds.height)
        .fill({ color: 0x7db97f, alpha: isDash ? 0.075 : 0.16 })
        .stroke({ color: 0x7db97f, alpha: isDash ? 0.18 : 0.34, width: 1 });
    }
  }

  const hoverKey = hoverCell ? positionKey(hoverCell.x, hoverCell.y) : "";
  const hoverInfo = reachableCells.get(hoverKey);
  const canHoverReposition =
    isRepositionMode &&
    hoverCell &&
    !blockingByPosition.has(positionKey(hoverCell.x, hoverCell.y)) &&
    (!usesDungeonGrid ||
      (!dungeonBlocksCell(dungeon, hoverCell.x, hoverCell.y) &&
        isDungeonCellVisibleToPlayers(dungeon, renderIndex, hoverCell.x, hoverCell.y)));
  if (hoverInfo || canHoverReposition) {
    const bounds = cellBounds(hoverCell.x, hoverCell.y, cellSize);
    const isDash = hoverInfo?.kind === "dash";
    graphics
      .rect(bounds.x, bounds.y, bounds.width, bounds.height)
      .fill({ color: isDash ? 0xa7d8aa : 0x7db97f, alpha: isDash ? 0.11 : 0.2 })
      .stroke({ color: isDash ? 0xa7d8aa : 0x7db97f, alpha: 0.82, width: 2 });
  }
}

function drawUnit(PIXI, layer, entity, entityState, cellSize, texture) {
  const center = cellToWorld(entity.grid_x, entity.grid_y, cellSize);
  const token = new PIXI.Container();
  const radius = Math.max(10, cellSize / 2 - 5);
  const hpValue = entity.is_player ? 100 : percent(entity.toughness_current, entity.toughness_max);
  const statusKeys = Object.keys(entity.statuses || {});

  token.position.set(center.x, center.y);
  token.alpha = entity.is_down ? 0.46 : 1;

  const base = new PIXI.Graphics();
  const fillColor = entity.is_player ? 0x24323a : 0x0d0907;
  const lineColor = entityState.isSelected && entityState.isActive ? 0x82d9df : entityState.isSelected ? 0xd8b66a : entityState.isActive ? 0x62c9d2 : 0xddb979;

  if (entityState.isSelected || entityState.isActive) {
    base.circle(0, 0, radius + 5).stroke({
      color: entityState.isSelected && entityState.isActive ? 0x82d9df : lineColor,
      alpha: 0.55,
      width: 3,
    });
  }

  base
    .circle(0, 0, radius)
    .fill({ color: fillColor, alpha: 0.96 })
    .stroke({ color: lineColor, alpha: entityState.isSelected || entityState.isActive ? 0.9 : 0.42, width: 2 });
  token.addChild(base);

  const label = new PIXI.Text({
    text: getEntityInitial(entity),
    style: {
      fill: entity.is_player ? 0xe8f7fb : 0xf0cf85,
      fontFamily: "Inter, Segoe UI, sans-serif",
      fontSize: Math.max(12, Math.round(cellSize * 0.36)),
      fontWeight: "700",
    },
    anchor: 0.5,
  });
  token.addChild(label);

  if (texture) {
    const sprite = new PIXI.Sprite(texture);
    const mask = new PIXI.Graphics().circle(0, 0, Math.max(4, radius - 3)).fill({ color: 0xffffff });
    sprite.anchor.set(0.5);
    sprite.width = Math.max(8, radius * 1.65);
    sprite.height = Math.max(8, radius * 1.65);
    sprite.mask = mask;
    token.addChild(mask);
    token.addChild(sprite);
  }

  const typeBadge = new PIXI.Graphics();
  typeBadge
    .circle(radius - 3, -radius + 3, Math.max(4, radius * 0.22))
    .fill({ color: entity.is_player ? 0xb9dbe6 : 0xd16a57, alpha: 1 })
    .stroke({ color: 0x080604, alpha: 0.96, width: 2 });
  token.addChild(typeBadge);

  if (!entity.is_player) {
    const barWidth = Math.max(14, radius * 1.55);
    const bar = new PIXI.Graphics();
    bar.rect(-barWidth / 2, radius + 2, barWidth, 4).fill({ color: 0x080604, alpha: 0.96 });
    bar
      .rect(-barWidth / 2, radius + 2, (barWidth * hpValue) / 100, 4)
      .fill({ color: healthColor(hpValue), alpha: 1 });
    token.addChild(bar);
  }

  statusKeys.slice(0, 3).forEach((statusKey, index) => {
    const badge = new PIXI.Graphics();
    const offset = (index - Math.min(2, statusKeys.length - 1) / 2) * 10;
    badge.circle(offset, radius - 5, 5).fill({ color: 0x080604, alpha: 0.86 }).stroke({
      color: 0xddb979,
      alpha: 0.35,
      width: 1,
    });
    const statusText = new PIXI.Text({
      text: statusKey.charAt(0).toUpperCase(),
      style: { fill: 0xf0cf85, fontSize: 7, fontWeight: "700" },
      anchor: 0.5,
    });
    statusText.position.set(offset, radius - 5);
    token.addChild(badge);
    token.addChild(statusText);
  });

  layer.addChild(token);
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function renderPixi(renderer) {
  if (!renderer) {
    return;
  }
  renderer.app.render();
}

function drawStaticMapLayer(
  renderer,
  room,
  dungeon,
  renderIndex,
  mapMode,
  cellSize,
  camera,
  viewport,
  highlightedRoomId = null,
) {
  if (!renderer) {
    return;
  }
  const { layers } = renderer;
  const isGmDungeonMode = mapMode === "gm-dungeon";
  const unbounded = Boolean(dungeon?.tiles);
  const range = visibleCellRange(camera, viewport, cellSize);
  drawGrid(layers.terrain, room, cellSize, { unbounded, camera, viewport });
  drawDungeonTiles(layers.dungeonTiles, dungeon, renderIndex, range, cellSize, isGmDungeonMode, highlightedRoomId);
  drawWallEdges(layers.dungeonWalls, dungeon, renderIndex?.wallChunks, renderIndex, range, cellSize, isGmDungeonMode);
  drawSecretSuspects(renderer.PIXI, layers.secretSuspects, dungeon, renderIndex, range, cellSize, isGmDungeonMode);
  drawDungeonIssues(layers.dungeonIssues, dungeon, range, cellSize);
  renderPixi(renderer);
}

function drawDungeonPreviewLayer(renderer, previewCells, cellSize, dungeon) {
  if (!renderer) {
    return;
  }
  drawDungeonPreview(renderer.layers.dungeonPreview, previewCells, cellSize, dungeon);
  renderPixi(renderer);
}

function drawWallEdgePreviewLayer(renderer, edges, wallPalette, cellSize) {
  if (!renderer) {
    return;
  }
  drawWallEdgePreview(renderer.layers.wallPreview, edges, wallPalette, cellSize);
  renderPixi(renderer);
}

function drawHighlightsLayer(
  renderer,
  room,
  dungeon,
  renderIndex,
  cellSize,
  mapMode,
  selectedEntity,
  busy,
  hoverCell,
  blockingByPosition,
  reachableCells,
  camera,
  viewport,
) {
  if (!renderer) {
    return;
  }
  drawMoveHighlights(
    renderer.layers.highlights,
    room,
    dungeon,
    renderIndex,
    cellSize,
    mapMode,
    selectedEntity,
    busy,
    hoverCell,
    blockingByPosition,
    reachableCells,
    camera,
    viewport,
  );
  renderPixi(renderer);
}

function drawSelectionLayer(renderer, firstCell, secondCell, cellSize) {
  if (!renderer) {
    return;
  }
  const layer = renderer.layers.selection;
  layer.clear();
  if (firstCell && secondCell) {
    const minX = Math.min(firstCell.x, secondCell.x);
    const maxX = Math.max(firstCell.x, secondCell.x);
    const minY = Math.min(firstCell.y, secondCell.y);
    const maxY = Math.max(firstCell.y, secondCell.y);
    const topLeft = cellBounds(minX, minY, cellSize);
    const bottomRight = cellBounds(maxX, maxY, cellSize);
    const x = topLeft.x;
    const y = topLeft.y;
    const width = bottomRight.x + bottomRight.width - topLeft.x;
    const height = bottomRight.y + bottomRight.height - topLeft.y;
    layer
      .rect(x, y, width, height)
      .fill({ color: 0x82d9df, alpha: 0.08 })
      .stroke({ color: 0x82d9df, alpha: 0.72, width: 2 });
  }
  renderPixi(renderer);
}

function drawUnitsLayer(renderer, placedEntities, selectedId, selectedUnitIds, activeTurnId, cellSize) {
  if (!renderer) {
    return;
  }
  const { PIXI, layers, textures } = renderer;
  clearLayer(layers.units);
  const selectedSet = new Set(selectedUnitIds || []);

  [...placedEntities]
    .sort((first, second) => Number(second.is_down) - Number(first.is_down))
    .forEach((entity) => {
      drawUnit(
        PIXI,
        layers.units,
        entity,
        {
          isSelected: entity.instance_id === selectedId || selectedSet.has(entity.instance_id),
          isActive: entity.instance_id === activeTurnId,
        },
        cellSize,
        entity.image_url ? textures.get(entity.image_url) : null,
      );
    });

  renderPixi(renderer);
}

function BattleMapSurface({
  room,
  entities,
  selectedId,
  activeTurnId,
  selectedEntity,
  mapMode = "idle",
  movementState = null,
  dungeon = null,
  gmDungeonInteractionMode = "draw",
  gmDungeonPalette = "floor",
  gmDungeonTool = "brush",
  gmDungeonDrawSubmode = "terrain",
  gmDungeonWallPalette = "wall",
  selectedUnitIds = [],
  highlightedRoomId = null,
  drawPulse,
  busy,
  onSelect,
  onSelectionChange,
  onGroupMove,
  onMoveToCell,
  onTileEdit,
  onWallEdit,
  onSecretDoorClick,
  onUnitContextMenu,
  onUnitDoubleClick,
}) {
  const surfaceRef = useRef(null);
  const rendererRef = useRef(null);
  const panRef = useRef(null);
  const pinchRef = useRef(null);
  const pointersRef = useRef(new Map());
  const lastUnitClickRef = useRef(null);
  const brushStrokeRef = useRef(null); // { palette, cells: Set<"x,y"> }
  const wallStrokeRef = useRef(null);
  const selectionDragRef = useRef(null);
  const groupDragRef = useRef(null);
  const dungeonPreviewRef = useRef(new Map());
  const dungeonPreviewFrameRef = useRef(null);
  const cellSizeRef = useRef(MAP_ZOOM.defaultSize);
  const cameraRef = useRef({ x: 0, y: 0 });
  const viewportRef = useRef(VIEWPORT_FALLBACK);
  const usesDungeonGrid = Boolean(dungeon?.tiles);

  const [cellSize, setCellSize] = useState(MAP_ZOOM.defaultSize);
  const [camera, setCamera] = useState(() =>
    clampCamera({ x: 0, y: 0 }, VIEWPORT_FALLBACK, room, MAP_ZOOM.defaultSize, { unbounded: Boolean(dungeon?.tiles) }),
  );
  const [hoverCell, setHoverCell] = useState(null);
  const [isPanning, setIsPanning] = useState(false);
  const [pixiReady, setPixiReady] = useState(false);
  const [textureVersion, setTextureVersion] = useState(0);

  const dungeonRenderKey = dungeon ? `${dungeon.analysisVersion ?? 0}:${dungeon.renderVersion ?? 0}` : "none";
  const renderIndex = useMemo(() => buildDungeonRenderIndex(dungeon), [dungeonRenderKey, dungeon]);
  const placedEntities = useMemo(
    () => entities.filter((entity) => hasGridPosition(entity, room, dungeon)),
    [entities, room.columns, room.rows, dungeon],
  );
  const entitiesByPosition = useMemo(() => {
    const next = new Map();
    placedEntities.forEach((entity) => {
      const key = positionKey(entity.grid_x, entity.grid_y);
      const current = next.get(key) || [];
      next.set(key, [...current, entity]);
    });
    return next;
  }, [placedEntities]);
  const blockingByPosition = useMemo(
    () =>
      new Map(
        placedEntities
          .filter(isBlockingEntity)
          .map((entity) => [positionKey(entity.grid_x, entity.grid_y), entity]),
      ),
    [placedEntities],
  );
  // Same-faction non-down units: can be traversed during movement but cannot be stopped on
  const passthroughByPosition = useMemo(() => {
    if (!selectedEntity) return new Map();
    const selectedIsPlayer = Boolean(selectedEntity.is_player);
    return new Map(
      placedEntities
        .filter((e) => isBlockingEntity(e) && Boolean(e.is_player) === selectedIsPlayer && e.instance_id !== selectedEntity.instance_id)
        .map((e) => [positionKey(e.grid_x, e.grid_y), e]),
    );
  }, [placedEntities, selectedEntity]);
  const reachableCells = useMemo(
    () =>
      mapMode === "move"
        ? getReachableMovementCells(room, selectedEntity, movementState, blockingByPosition, dungeon, passthroughByPosition)
        : new Map(),
    [room.columns, room.rows, selectedEntity, movementState, blockingByPosition, passthroughByPosition, mapMode, dungeon],
  );

  useEffect(() => {
    cellSizeRef.current = cellSize;
  }, [cellSize]);

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) {
      return undefined;
    }

    function updateViewport() {
      const metrics = viewportMetricsOf(surface);
      viewportRef.current = metrics;
      setCamera((current) => clampCamera(current, metrics, room, cellSizeRef.current, { unbounded: usesDungeonGrid }));
    }

    updateViewport();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateViewport);
      observer.observe(surface);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, [room.columns, room.rows, usesDungeonGrid]);

  useEffect(() => {
    setCamera((current) => clampCamera(current, viewportRef.current, room, cellSizeRef.current, { unbounded: usesDungeonGrid }));
  }, [room.columns, room.rows, usesDungeonGrid]);

  useEffect(() => {
    if (import.meta.env.MODE === "test") {
      return undefined;
    }

    const surface = surfaceRef.current;
    let cancelled = false;
    let app = null;

    async function initializePixi() {
      if (!surface) {
        return;
      }

      try {
        const PIXI = await import("pixi.js");
        app = new PIXI.Application();
        await app.init({
          resizeTo: surface,
          backgroundAlpha: 0,
          antialias: true,
          autoStart: false,
          autoDensity: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          preference: "webgl",
        });

        if (cancelled) {
          app.destroy(true, { children: true });
          return;
        }

        app.canvas.className = "battle-map-canvas";
        app.canvas.setAttribute("aria-hidden", "true");
        surface.appendChild(app.canvas);

        const world = new PIXI.Container();
        const layers = {
          terrain: new PIXI.Graphics(),
          dungeonTiles: new PIXI.Graphics(),
          dungeonWalls: new PIXI.Graphics(),
          secretSuspects: new PIXI.Container(),
          dungeonIssues: new PIXI.Graphics(),
          dungeonPreview: new PIXI.Graphics(),
          wallPreview: new PIXI.Graphics(),
          selection: new PIXI.Graphics(),
          highlights: new PIXI.Graphics(),
          units: new PIXI.Container(),
          effects: new PIXI.Container(),
        };

        world.addChild(
          layers.terrain,
          layers.dungeonTiles,
          layers.dungeonWalls,
          layers.secretSuspects,
          layers.dungeonIssues,
          layers.dungeonPreview,
          layers.wallPreview,
          layers.selection,
          layers.highlights,
          layers.units,
          layers.effects,
        );
        app.stage.addChild(world);
        rendererRef.current = { PIXI, app, world, layers, textures: new Map(), failedTextures: new Set() };
        setPixiReady(true);
      } catch {
        rendererRef.current = null;
        setPixiReady(false);
      }
    }

    initializePixi();

    return () => {
      cancelled = true;
      rendererRef.current = null;
      app?.destroy(true, { children: true });
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return undefined;
    }

    let cancelled = false;
    const urls = [
      ...new Set(
        placedEntities
          .map((entity) => entity.image_url)
          .filter((imageUrl) => imageUrl && !renderer.textures.has(imageUrl) && !renderer.failedTextures.has(imageUrl)),
      ),
    ];

    urls.forEach((imageUrl) => {
      renderer.PIXI.Assets.load(imageUrl)
        .then((texture) => {
          if (cancelled || rendererRef.current !== renderer) {
            return;
          }
          renderer.textures.set(imageUrl, texture);
          setTextureVersion((current) => current + 1);
        })
        .catch(() => {
          if (cancelled || rendererRef.current !== renderer) {
            return;
          }
          renderer.failedTextures.add(imageUrl);
          setTextureVersion((current) => current + 1);
        });
    });

    return () => {
      cancelled = true;
    };
  }, [pixiReady, placedEntities]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    renderer.world.position.set(camera.x, camera.y);
    if (usesDungeonGrid) {
      drawStaticMapLayer(renderer, room, dungeon, renderIndex, mapMode, cellSize, camera, viewportRef.current, highlightedRoomId);
    }
    renderPixi(renderer);
  }, [pixiReady, camera.x, camera.y, usesDungeonGrid]);

  useEffect(() => {
    drawStaticMapLayer(
      rendererRef.current,
      room,
      dungeon,
      renderIndex,
      mapMode,
      cellSize,
      cameraRef.current,
      viewportRef.current,
      highlightedRoomId,
    );
  }, [pixiReady, room.columns, room.rows, dungeonRenderKey, mapMode, cellSize, highlightedRoomId, renderIndex]);

  useEffect(() => {
    dungeonPreviewRef.current.clear();
    drawDungeonPreviewLayer(rendererRef.current, dungeonPreviewRef.current, cellSize, dungeon);
    drawWallEdgePreviewLayer(rendererRef.current, [], gmDungeonWallPalette, cellSize);
  }, [pixiReady, dungeonRenderKey, mapMode, gmDungeonWallPalette, cellSize]);

  useEffect(() => {
    drawDungeonPreviewLayer(rendererRef.current, dungeonPreviewRef.current, cellSize, dungeon);
  }, [pixiReady, cellSize, dungeon]);

  useEffect(
    () => () => {
      if (dungeonPreviewFrameRef.current != null) {
        const cancelFrame = window.cancelAnimationFrame || window.clearTimeout;
        cancelFrame(dungeonPreviewFrameRef.current);
        dungeonPreviewFrameRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    drawHighlightsLayer(
      rendererRef.current,
      room,
      dungeon,
      renderIndex,
      cellSize,
      mapMode,
      selectedEntity,
      busy,
      hoverCell,
      blockingByPosition,
      reachableCells,
      camera,
      viewportRef.current,
    );
  }, [
    pixiReady,
    room.columns,
    room.rows,
    dungeon,
    renderIndex,
    cellSize,
    mapMode,
    selectedEntity,
    busy,
    hoverCell,
    blockingByPosition,
    reachableCells,
    camera.x,
    camera.y,
  ]);

  useEffect(() => {
    drawUnitsLayer(rendererRef.current, placedEntities, selectedId, selectedUnitIds, activeTurnId, cellSize);
  }, [pixiReady, textureVersion, placedEntities, selectedId, selectedUnitIds, activeTurnId, cellSize]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !drawPulse?.entityId || !drawPulse?.key) {
      return undefined;
    }

    const entity = placedEntities.find((placedEntity) => placedEntity.instance_id === drawPulse.entityId);
    if (!entity) {
      return undefined;
    }

    const center = cellToWorld(entity.grid_x, entity.grid_y, cellSize);
    const radius = Math.max(12, cellSize / 2 - 2);
    const ring = new renderer.PIXI.Graphics();
    let destroyed = false;
    let frameId = null;

    ring.position.set(center.x, center.y);
    renderer.layers.effects.addChild(ring);

    function destroyRing() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      if (frameId != null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      ring.parent?.removeChild(ring);
      ring.destroy();
      renderer.app.render();
    }

    function drawRing(progress) {
      const easeOut = 1 - (1 - progress) * (1 - progress);
      const alpha = Math.max(0, 0.82 * (1 - progress));
      ring.clear();
      ring.circle(0, 0, radius + easeOut * 14).stroke({
        color: 0xf0cf85,
        alpha,
        width: Math.max(1.5, 4 - progress * 2),
      });
      ring.circle(0, 0, radius + 3 + easeOut * 5).stroke({
        color: 0x82d9df,
        alpha: alpha * 0.38,
        width: 2,
      });
    }

    function tick() {
      const progress = Math.min(1, (performance.now() - startedAt) / 650);
      drawRing(progress);
      renderer.app.render();
      if (progress >= 1) {
        destroyRing();
      } else {
        frameId = window.requestAnimationFrame(tick);
      }
    }

    if (prefersReducedMotion()) {
      drawRing(0);
      renderer.app.render();
      const timeoutId = window.setTimeout(destroyRing, 350);
      return () => {
        window.clearTimeout(timeoutId);
        destroyRing();
      };
    }

    const startedAt = performance.now();
    tick();

    return destroyRing;
  }, [drawPulse?.entityId, drawPulse?.key, pixiReady, placedEntities, cellSize]);

  function cellFromPointer(event) {
    const surface = surfaceRef.current;
    const metrics = viewportMetricsOf(surface);
    viewportRef.current = metrics;
    return clientPointToCell(pointerPointOf(event), metrics, cameraRef.current, room, cellSizeRef.current, {
      unbounded: usesDungeonGrid,
    });
  }

  function updateHoverCell(event) {
    const nextCell = cellFromPointer(event);
    setHoverCell((current) => (sameCell(current, nextCell) ? current : nextCell));
  }

  function applyCamera(nextCamera) {
    setCamera(clampCamera(nextCamera, viewportRef.current, room, cellSizeRef.current, { unbounded: usesDungeonGrid }));
  }

  function renderDungeonPreviewSoon() {
    if (dungeonPreviewFrameRef.current != null) {
      return;
    }

    const requestFrame = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 0));
    dungeonPreviewFrameRef.current = requestFrame(() => {
      dungeonPreviewFrameRef.current = null;
      drawDungeonPreviewLayer(rendererRef.current, dungeonPreviewRef.current, cellSizeRef.current, dungeon);
    });
  }

  function removeDungeonPreviewCells(keys) {
    for (const key of keys) {
      dungeonPreviewRef.current.delete(key);
    }
    renderDungeonPreviewSoon();
  }

  function rectangleCells(first, second) {
    if (!first || !second) return [];
    const minX = Math.min(first.x, second.x);
    const maxX = Math.max(first.x, second.x);
    const minY = Math.min(first.y, second.y);
    const maxY = Math.max(first.y, second.y);
    const cells = [];
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        cells.push({ x, y });
      }
    }
    return cells;
  }

  function replaceStrokePreview(cells) {
    const stroke = brushStrokeRef.current;
    if (!stroke) return;
    for (const key of stroke.previewKeys || []) {
      dungeonPreviewRef.current.delete(key);
    }
    stroke.cells = new Set();
    stroke.previewKeys = new Set();
    cells.forEach((cell) => {
      const key = `${cell.x},${cell.y}`;
      stroke.cells.add(key);
      stroke.previewKeys.add(key);
      dungeonPreviewRef.current.set(key, { x: cell.x, y: cell.y, tileType: stroke.palette });
    });
    renderDungeonPreviewSoon();
  }

  function orderedSelectionIds(ids) {
    const idSet = new Set(ids);
    return [
      ...placedEntities.map((entity) => entity.instance_id).filter((instanceId) => idSet.has(instanceId)),
      ...ids.filter((instanceId) => !placedEntities.some((entity) => entity.instance_id === instanceId)),
    ];
  }

  function currentSelectionIds() {
    if ((mapMode === "gm-dungeon" && gmDungeonInteractionMode === "select") || mapMode === "gm-reposition") {
      return selectedUnitIds || [];
    }
    return selectedId ? [selectedId] : [];
  }

  function applyUnitSelection(targetId, event) {
    const current = currentSelectionIds();
    let nextIds;
    let primaryId = targetId;
    if (isSubtractiveSelect(event)) {
      nextIds = current.filter((instanceId) => instanceId !== targetId);
      primaryId = nextIds[0] || "";
    } else if (isAdditiveSelect(event)) {
      nextIds = current.includes(targetId)
        ? current.filter((instanceId) => instanceId !== targetId)
        : [...current, targetId];
      primaryId = targetId;
    } else {
      nextIds = [targetId];
    }
    onSelectionChange?.(orderedSelectionIds(nextIds), { primaryId });
  }

  function applyRectangleSelection(firstCell, secondCell, event) {
    const rectIds = entityIdsInRect(placedEntities, firstCell, secondCell);
    const current = currentSelectionIds();
    let nextIds;
    if (isSubtractiveSelect(event)) {
      const removeSet = new Set(rectIds);
      nextIds = current.filter((instanceId) => !removeSet.has(instanceId));
    } else if (isAdditiveSelect(event)) {
      nextIds = [...current, ...rectIds.filter((instanceId) => !current.includes(instanceId))];
    } else {
      nextIds = rectIds;
    }
    onSelectionChange?.(orderedSelectionIds(nextIds), { primaryId: nextIds[0] || "" });
  }

  function selectedGroupPositions() {
    const selectedSet = new Set(currentSelectionIds());
    return placedEntities
      .filter((entity) => selectedSet.has(entity.instance_id))
      .map((entity) => ({
        instanceId: entity.instance_id,
        x: entity.grid_x,
        y: entity.grid_y,
      }));
  }

  function isVisibleWalkableRepositionCell(cell) {
    if (!cell) {
      return false;
    }
    if (!usesDungeonGrid) {
      return true;
    }
    return (
      !dungeonBlocksCell(dungeon, cell.x, cell.y) &&
      isDungeonCellVisibleToPlayers(dungeon, renderIndex, cell.x, cell.y)
    );
  }

  function handleWheel(event) {
    event.preventDefault();
    const surface = surfaceRef.current;
    const metrics = viewportMetricsOf(surface);
    viewportRef.current = metrics;
    const direction = event.deltaY > 0 ? -1 : 1;
    const nextZoom = zoomCameraAt(
      cameraRef.current,
      metrics,
      room,
      cellSizeRef.current,
      cellSizeRef.current + direction * MAP_ZOOM.step,
      {
        x: event.clientX - metrics.left,
        y: event.clientY - metrics.top,
      },
      { unbounded: usesDungeonGrid },
    );

    cellSizeRef.current = nextZoom.cellSize;
    cameraRef.current = nextZoom.camera;
    setCellSize(nextZoom.cellSize);
    setCamera(nextZoom.camera);
  }

  function beginPan(event, { captureImmediately = false } = {}) {
    const pointerId = pointerIdOf(event);
    const point = pointerPointOf(event);
    panRef.current = {
      pointerId,
      button: pointerButtonOf(event),
      startX: point.x,
      startY: point.y,
      startCameraX: cameraRef.current.x,
      startCameraY: cameraRef.current.y,
      dragging: false,
      captured: false,
    };

    if (captureImmediately) {
      surfaceRef.current?.setPointerCapture?.(pointerId);
      panRef.current.captured = true;
      setIsPanning(true);
    }
  }

  function beginPinch() {
    const touches = [...pointersRef.current.values()];
    if (touches.length < 2) {
      return;
    }

    const [first, second] = touches;
    pinchRef.current = {
      startDistance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      startCellSize: cellSizeRef.current,
      startCamera: cameraRef.current,
    };
    panRef.current = null;
    for (const pointerId of pointersRef.current.keys()) {
      surfaceRef.current?.setPointerCapture?.(pointerId);
    }
    setIsPanning(true);
  }

  function paintBrushCell(cell) {
    if (!cell || !brushStrokeRef.current) return;
    const key = `${cell.x},${cell.y}`;
    if (brushStrokeRef.current.cells.has(key)) return;
    brushStrokeRef.current.cells.add(key);
    brushStrokeRef.current.previewKeys?.add(key);
    dungeonPreviewRef.current.set(key, { x: cell.x, y: cell.y, tileType: brushStrokeRef.current.palette });
    renderDungeonPreviewSoon();
  }

  function edgeFromPointer(event, stroke = null) {
    const metrics = viewportMetricsOf(surfaceRef.current);
    viewportRef.current = metrics;
    const point = pointerPointOf(event);
    const worldX = point.x - metrics.left - cameraRef.current.x;
    const worldY = point.y - metrics.top - cameraRef.current.y;
    return snapToNearestEdge(
      worldX,
      worldY,
      cellSizeRef.current,
      stroke ? { orientation: stroke.orientation, line: stroke.line } : null,
    );
  }

  function addWallStrokeEdge(edge) {
    const stroke = wallStrokeRef.current;
    if (!edge || !stroke) return;
    let changed = false;
    for (const segmentEdge of wallStrokeSegmentEdges(stroke.lastEdge, edge)) {
      const key = edgeKey(segmentEdge);
      if (stroke.edges.has(key)) {
        continue;
      }
      stroke.edges.set(key, segmentEdge);
      changed = true;
    }
    stroke.lastEdge = edge;
    if (changed) {
      drawWallEdgePreviewLayer(rendererRef.current, [...stroke.edges.values()], stroke.palette, cellSizeRef.current);
    }
  }

  async function flushWallStroke() {
    const stroke = wallStrokeRef.current;
    wallStrokeRef.current = null;
    drawWallEdgePreviewLayer(rendererRef.current, [], gmDungeonWallPalette, cellSizeRef.current);
    if (!stroke || stroke.edges.size === 0) return;
    const edges = [...stroke.edges.values()];
    if (!onWallEdit) return;
    await onWallEdit(stroke.palette, edges);
  }

  async function flushBrushStroke() {
    const stroke = brushStrokeRef.current;
    brushStrokeRef.current = null;
    if (!stroke || stroke.cells.size === 0) return;
    const keys = [...stroke.cells];
    if (!onTileEdit) {
      removeDungeonPreviewCells(keys);
      return;
    }
    const cells = keys.map((key) => key.split(",").map(Number));
    const payload = await onTileEdit(stroke.palette, cells);
    if (!payload) {
      removeDungeonPreviewCells(keys);
    }
  }

  function handlePointerDown(event) {
    const pointerType = pointerTypeOf(event);
    const pointerId = pointerIdOf(event);
    const pointerButton = pointerButtonOf(event);
    const point = pointerPointOf(event);

    if (pointerType === "touch") {
      pointersRef.current.set(pointerId, point);
      if (pointersRef.current.size === 2) {
        event.preventDefault();
        beginPinch();
        return;
      }
    }

    const cell = cellFromPointer(event);
    const isLeftMouse = pointerType !== "touch" && pointerButton === 0;
    const isMiddleMouse = pointerType !== "touch" && pointerButton === 1;
    const isGmDungeonDrawMode = mapMode === "gm-dungeon" && gmDungeonInteractionMode === "draw";
    const isGmDungeonWallDraw = isGmDungeonDrawMode && gmDungeonDrawSubmode === "walls";
    const isGmDungeonSelectMode = mapMode === "gm-dungeon" && gmDungeonInteractionMode === "select";
    const isGmDungeonDragMode = mapMode === "gm-dungeon" && gmDungeonInteractionMode === "drag";
    const canSelectSecretDoorEdge = isGmDungeonSelectMode || mapMode === "gm-reposition";
    const isMultiSelectMode = isGmDungeonSelectMode || mapMode === "gm-reposition";

    if (isGmDungeonDragMode && !busy && (isMiddleMouse || isLeftMouse || pointerType === "touch")) {
      event.preventDefault();
      beginPan(event, { captureImmediately: true });
      return;
    }

    // In GM Dungeon wall draw mode, left click starts an edge stroke.
    if (isGmDungeonWallDraw && !busy && (isLeftMouse || pointerType === "touch")) {
      event.preventDefault();
      const firstEdge = edgeFromPointer(event);
      wallStrokeRef.current = {
        pointerId,
        palette: gmDungeonWallPalette,
        edges: new Map(),
        orientation: wallEdgeOrientation(firstEdge),
        line: wallEdgeLine(firstEdge),
        lastEdge: null,
      };
      addWallStrokeEdge(firstEdge);
      surfaceRef.current?.setPointerCapture?.(pointerId);
      return;
    }

    // In GM Dungeon terrain draw mode, left click starts a brush stroke.
    if (isGmDungeonDrawMode && gmDungeonDrawSubmode === "terrain" && !busy && (isLeftMouse || pointerType === "touch") && cell) {
      event.preventDefault();
      const mode = gmDungeonTool === "rectangle" ? "rectangle" : "brush";
      brushStrokeRef.current = {
        palette: gmDungeonPalette,
        mode,
        anchor: cell,
        cells: new Set(),
        previewKeys: new Set(),
      };
      if (mode === "rectangle") {
        replaceStrokePreview([cell]);
      } else {
        paintBrushCell(cell);
      }
      surfaceRef.current?.setPointerCapture?.(pointerId);
      return;
    }

    if (canSelectSecretDoorEdge && !busy && (isLeftMouse || pointerType === "touch") && onSecretDoorClick) {
      const occupant = cell ? getTopSelectableEntity(getEntitiesAtPosition(entitiesByPosition, cell)) : null;
      if (!occupant) {
        const edge = edgeFromPointer(event);
        if (edge) {
          const ek = edgeKey(edge);
          const wall = dungeon?.walls?.[ek];
          if (wall?.wall_type === "secret_door") {
            event.preventDefault();
            onSecretDoorClick(ek);
            return;
          }
        }
      }
    }

    if (isMultiSelectMode && !busy && (isLeftMouse || pointerType === "touch") && cell) {
      const occupant = getTopSelectableEntity(getEntitiesAtPosition(entitiesByPosition, cell));
      const selectedSet = new Set(currentSelectionIds());
      if (occupant && selectedSet.has(occupant.instance_id) && !isAdditiveSelect(event) && !isSubtractiveSelect(event)) {
        groupDragRef.current = {
          pointerId,
          startX: point.x,
          startY: point.y,
          startCell: cell,
          dragging: false,
          positions: selectedGroupPositions(),
        };
        surfaceRef.current?.setPointerCapture?.(pointerId);
        return;
      }
      if (!occupant) {
        selectionDragRef.current = {
          pointerId,
          startX: point.x,
          startY: point.y,
          startCell: cell,
          currentCell: cell,
          dragging: false,
        };
        surfaceRef.current?.setPointerCapture?.(pointerId);
        return;
      }
    }

    const blocking = cell ? blockingByPosition.has(positionKey(cell.x, cell.y)) : false;
    const canStartPan = isMiddleMouse || ((isLeftMouse || pointerType === "touch") && !blocking);

    if (!canStartPan) {
      panRef.current = null;
      return;
    }

    if (isMiddleMouse) {
      event.preventDefault();
    }
    beginPan(event, { captureImmediately: isMiddleMouse });
  }

  function handlePointerMove(event) {
    const pointerType = pointerTypeOf(event);
    const pointerId = pointerIdOf(event);
    const point = pointerPointOf(event);

    if (pointerType === "touch" && pointersRef.current.has(pointerId)) {
      pointersRef.current.set(pointerId, point);
    }

    if (pinchRef.current && pointersRef.current.size >= 2) {
      const touches = [...pointersRef.current.values()];
      const [first, second] = touches;
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const scale = distance / pinchRef.current.startDistance;
      const metrics = viewportMetricsOf(surfaceRef.current);
      const nextZoom = zoomCameraAt(
        pinchRef.current.startCamera,
        metrics,
        room,
        pinchRef.current.startCellSize,
        pinchRef.current.startCellSize * scale,
        {
          x: (first.x + second.x) / 2 - metrics.left,
          y: (first.y + second.y) / 2 - metrics.top,
        },
        { unbounded: usesDungeonGrid },
      );

      event.preventDefault();
      viewportRef.current = metrics;
      cellSizeRef.current = nextZoom.cellSize;
      cameraRef.current = nextZoom.camera;
      setCellSize(nextZoom.cellSize);
      setCamera(nextZoom.camera);
      return;
    }

    const groupDrag = groupDragRef.current;
    if (groupDrag && groupDrag.pointerId === pointerId) {
      const moved = Math.hypot(point.x - groupDrag.startX, point.y - groupDrag.startY);
      if (moved >= MAP_DRAG_THRESHOLD) {
        groupDrag.dragging = true;
        setIsPanning(true);
      }
      updateHoverCell(event);
      return;
    }

    const selectionDrag = selectionDragRef.current;
    if (selectionDrag && selectionDrag.pointerId === pointerId) {
      const moved = Math.hypot(point.x - selectionDrag.startX, point.y - selectionDrag.startY);
      const cell = cellFromPointer(event);
      selectionDrag.currentCell = cell || selectionDrag.currentCell;
      if (moved >= MAP_DRAG_THRESHOLD) {
        selectionDrag.dragging = true;
        drawSelectionLayer(rendererRef.current, selectionDrag.startCell, selectionDrag.currentCell, cellSizeRef.current);
      }
      updateHoverCell(event);
      return;
    }

    if (mapMode === "gm-dungeon" && wallStrokeRef.current?.pointerId === pointerId) {
      addWallStrokeEdge(edgeFromPointer(event, wallStrokeRef.current));
      updateHoverCell(event);
      return;
    }

    // Brush drag in GM Dungeon mode
    if (mapMode === "gm-dungeon" && brushStrokeRef.current) {
      const cell = cellFromPointer(event);
      if (brushStrokeRef.current.mode === "rectangle") {
        replaceStrokePreview(rectangleCells(brushStrokeRef.current.anchor, cell));
      } else {
        paintBrushCell(cell);
      }
      updateHoverCell(event);
      return;
    }

    const pan = panRef.current;
    if (!pan || pan.pointerId !== pointerId) {
      updateHoverCell(event);
      return;
    }

    const deltaX = point.x - pan.startX;
    const deltaY = point.y - pan.startY;
    const moved = Math.hypot(deltaX, deltaY);
    if (!pan.dragging && moved < MAP_DRAG_THRESHOLD) {
      updateHoverCell(event);
      return;
    }

    event.preventDefault();
    if (!pan.captured) {
      surfaceRef.current?.setPointerCapture?.(pointerId);
      pan.captured = true;
    }
    pan.dragging = true;
    setIsPanning(true);
    applyCamera({ x: pan.startCameraX + deltaX, y: pan.startCameraY + deltaY });
  }

  function finishPointer(event) {
    const pointerType = pointerTypeOf(event);
    const pointerId = pointerIdOf(event);
    const pointerButton = pointerButtonOf(event);

    if (mapMode === "gm-dungeon" && wallStrokeRef.current?.pointerId === pointerId) {
      flushWallStroke();
      surfaceRef.current?.releasePointerCapture?.(pointerId);
      return;
    }

    // Flush brush stroke in GM Dungeon mode
    if (mapMode === "gm-dungeon" && brushStrokeRef.current) {
      flushBrushStroke();
      surfaceRef.current?.releasePointerCapture?.(pointerId);
      return;
    }

    const groupDrag = groupDragRef.current;
    if (groupDrag && groupDrag.pointerId === pointerId) {
      groupDragRef.current = null;
      setIsPanning(false);
      surfaceRef.current?.releasePointerCapture?.(pointerId);
      if (groupDrag.dragging) {
        const targetCell = cellFromPointer(event);
        if (targetCell) {
          const deltaX = targetCell.x - groupDrag.startCell.x;
          const deltaY = targetCell.y - groupDrag.startCell.y;
          if ((deltaX !== 0 || deltaY !== 0) && groupDrag.positions.length) {
            const placements = groupDrag.positions.map((position) => ({
              instanceId: position.instanceId,
              x: position.x + deltaX,
              y: position.y + deltaY,
            }));
            if (mapMode !== "gm-reposition" || placements.every((placement) => isVisibleWalkableRepositionCell(placement))) {
              onGroupMove?.(placements);
            }
          }
        }
      }
      return;
    }

    const selectionDrag = selectionDragRef.current;
    if (selectionDrag && selectionDrag.pointerId === pointerId) {
      selectionDragRef.current = null;
      surfaceRef.current?.releasePointerCapture?.(pointerId);
      drawSelectionLayer(rendererRef.current, null, null, cellSizeRef.current);
      if (selectionDrag.dragging) {
        applyRectangleSelection(selectionDrag.startCell, selectionDrag.currentCell, event);
        return;
      } else if (mapMode === "gm-dungeon" && gmDungeonInteractionMode === "select") {
        onSelectionChange?.([], { primaryId: "" });
        return;
      }
    }

    const pan = panRef.current;
    const wasDragging = pan?.pointerId === pointerId && pan.dragging;
    const wasPinching = Boolean(pinchRef.current);
    const canClick = pointerType === "touch" || pointerButton === 0;
    const clickCell = canClick && !wasDragging && !wasPinching && pan?.button !== 1 ? cellFromPointer(event) : null;

    if (pointerType === "touch") {
      pointersRef.current.delete(pointerId);
      if (pointersRef.current.size < 2) {
        pinchRef.current = null;
      }
    }

    if (pan?.pointerId === pointerId) {
      panRef.current = null;
    }
    if (!panRef.current && !pinchRef.current) {
      setIsPanning(false);
    }
    surfaceRef.current?.releasePointerCapture?.(pointerId);

    if (!clickCell) {
      return;
    }

    const cellEntities = getEntitiesAtPosition(entitiesByPosition, clickCell);
    const currentSelection = currentSelectionIds();
    const selectedSet = new Set(currentSelection);
    const selectedOccupant = selectedSet.size
      ? cellEntities.find((entity) => selectedSet.has(entity.instance_id))
      : null;
    const blockingOccupant = getBlockingEntity(cellEntities);
    const occupant = getTopSelectableEntity(cellEntities);
    const isGmDungeonSelectMode = mapMode === "gm-dungeon" && gmDungeonInteractionMode === "select";
    const canSelectSecretDoorEdge = isGmDungeonSelectMode || mapMode === "gm-reposition";
    const isMultiSelectMode = isGmDungeonSelectMode || mapMode === "gm-reposition";

    if (canSelectSecretDoorEdge && !occupant && onSecretDoorClick) {
      const edge = edgeFromPointer(event);
      if (edge) {
        const ek = edgeKey(edge);
        const wall = dungeon?.walls?.[ek];
        if (wall?.wall_type === "secret_door") {
          onSecretDoorClick(ek);
          return;
        }
      }
    }

    if (occupant) {
      const now = Date.now();
      const previousClick = lastUnitClickRef.current;
      const isDoubleClick =
        previousClick &&
        previousClick.entityId === occupant.instance_id &&
        previousClick.x === clickCell.x &&
        previousClick.y === clickCell.y &&
        now - previousClick.time <= UNIT_DOUBLE_CLICK_MS;

      lastUnitClickRef.current = isDoubleClick
        ? null
        : {
            entityId: occupant.instance_id,
            x: clickCell.x,
            y: clickCell.y,
            time: now,
          };

      if (!isMultiSelectMode && isDoubleClick && onUnitDoubleClick?.(occupant.instance_id)) {
        return;
      }
    } else {
      lastUnitClickRef.current = null;
    }

    if (isMultiSelectMode && occupant) {
      applyUnitSelection(occupant.instance_id, event);
      return;
    }

    if (selectedOccupant) {
      onSelect(selectedOccupant.instance_id);
      return;
    }
    const canSingleReposition =
      mapMode !== "gm-reposition" ||
      (currentSelection.length === 1 && currentSelection[0] === selectedEntity?.instance_id);
    if (
      (mapMode === "reposition" || mapMode === "gm-reposition") &&
      selectedEntity &&
      !busy &&
      !blockingOccupant &&
      canSingleReposition &&
      isVisibleWalkableRepositionCell(clickCell)
    ) {
      onMoveToCell(clickCell.x, clickCell.y, { mode: "reposition" });
      return;
    }

    const reachableTarget = reachableCells.get(positionKey(clickCell.x, clickCell.y));
    if (mapMode === "move" && selectedEntity && !busy && reachableTarget && !blockingOccupant) {
      onMoveToCell(clickCell.x, clickCell.y, {
        mode: "move",
        cost: reachableTarget.cost,
        requiresDash: reachableTarget.requiresDash,
      });
      return;
    }

    if (occupant) {
      onSelect(occupant.instance_id);
    }
  }

  function handleContextMenu(event) {
    event.preventDefault();
    const clickCell = cellFromPointer(event);
    const occupant = getTopSelectableEntity(getEntitiesAtPosition(entitiesByPosition, clickCell));
    if (!occupant) {
      return;
    }

    onUnitContextMenu?.({
      instanceId: occupant.instance_id,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  function handleZoomOut() {
    const metrics = viewportMetricsOf(surfaceRef.current);
    viewportRef.current = metrics;
    const nextZoom = zoomCameraAt(
      cameraRef.current,
      metrics,
      room,
      cellSizeRef.current,
      cellSizeRef.current - MAP_ZOOM.step,
      undefined,
      { unbounded: usesDungeonGrid },
    );
    cellSizeRef.current = nextZoom.cellSize;
    cameraRef.current = nextZoom.camera;
    setCellSize(nextZoom.cellSize);
    setCamera(nextZoom.camera);
  }

  function handleZoomIn() {
    const metrics = viewportMetricsOf(surfaceRef.current);
    viewportRef.current = metrics;
    const nextZoom = zoomCameraAt(
      cameraRef.current,
      metrics,
      room,
      cellSizeRef.current,
      cellSizeRef.current + MAP_ZOOM.step,
      undefined,
      { unbounded: usesDungeonGrid },
    );
    cellSizeRef.current = nextZoom.cellSize;
    cameraRef.current = nextZoom.camera;
    setCellSize(nextZoom.cellSize);
    setCamera(nextZoom.camera);
  }

  function handleZoomReset() {
    const metrics = viewportMetricsOf(surfaceRef.current);
    viewportRef.current = metrics;
    const nextZoom = zoomCameraAt(
      cameraRef.current,
      metrics,
      room,
      cellSizeRef.current,
      MAP_ZOOM.defaultSize,
      undefined,
      { unbounded: usesDungeonGrid },
    );
    cellSizeRef.current = nextZoom.cellSize;
    cameraRef.current = nextZoom.camera;
    setCellSize(nextZoom.cellSize);
    setCamera(nextZoom.camera);
  }

  function handleCenterSelected() {
    if (!hasGridPosition(selectedEntity, room, dungeon)) {
      return;
    }
    const metrics = viewportMetricsOf(surfaceRef.current);
    viewportRef.current = metrics;
    const nextCamera = centerCameraOnCell({ x: selectedEntity.grid_x, y: selectedEntity.grid_y }, metrics, room, cellSizeRef.current, {
      unbounded: usesDungeonGrid,
    });
    if (nextCamera) {
      cameraRef.current = nextCamera;
      setCamera(nextCamera);
    }
  }

  function handleFitDungeon() {
    const metrics = viewportMetricsOf(surfaceRef.current);
    viewportRef.current = metrics;
    const extents = getDungeonFitExtents(dungeon);
    let nextCellSize = cellSizeRef.current;
    if (extents && Number(extents.width) > 0 && Number(extents.height) > 0) {
      const widthCells = Number(extents.width);
      const heightCells = Number(extents.height);
      const fitWidth = Math.floor((metrics.width - 34 - Math.max(0, widthCells - 1) * 2) / widthCells);
      const fitHeight = Math.floor((metrics.height - 34 - Math.max(0, heightCells - 1) * 2) / heightCells);
      nextCellSize = clampCellSize(Math.min(MAP_ZOOM.defaultSize, fitWidth, fitHeight));
    }
    const nextCamera = centerCameraOnExtents(extents, metrics, nextCellSize, { unbounded: true });
    cellSizeRef.current = nextCellSize;
    cameraRef.current = nextCamera;
    setCellSize(nextCellSize);
    setCamera(nextCamera);
  }

  const zoomPercent = Math.round((cellSize / MAP_ZOOM.defaultSize) * 100);
  const reachableNormalCount = countReachableByKind(reachableCells, "normal");
  const reachableDashCount = countReachableByKind(reachableCells, "dash");
  const surfaceClassName = `battle-map-surface ${isPanning ? "battle-map-surface-panning" : ""}`.trim();

  return (
    <div className="map-viewport-shell">
      <div className="map-viewport-controls" aria-label="Map viewport controls">
        <button type="button" className="map-control-button" aria-label="Zoom out battle map" onClick={handleZoomOut}>
          -
        </button>
        <button type="button" className="map-control-button map-control-reset" aria-label="Reset battle map zoom" onClick={handleZoomReset}>
          {zoomPercent}%
        </button>
        <button type="button" className="map-control-button" aria-label="Zoom in battle map" onClick={handleZoomIn}>
          +
        </button>
        <button type="button" className="map-control-button map-control-center" aria-label="Center selected unit" onClick={handleCenterSelected}>
          Center
        </button>
        {usesDungeonGrid ? (
          <button type="button" className="map-control-button map-control-center" aria-label="Fit dungeon map" onClick={handleFitDungeon}>
            Fit
          </button>
        ) : null}
      </div>
      <div
        ref={surfaceRef}
        className={surfaceClassName}
        role="region"
        aria-label="Battle map viewport"
        data-cell-size={cellSize}
        data-camera-x={camera.x}
        data-camera-y={camera.y}
        data-pixi-ready={pixiReady ? "true" : "false"}
        data-map-mode={mapMode}
        data-gm-interaction-mode={mapMode === "gm-dungeon" ? gmDungeonInteractionMode : mapMode === "gm-reposition" ? "select" : ""}
        data-selected-unit-ids={(selectedUnitIds || []).join(",")}
        data-reachable-normal={reachableNormalCount}
        data-reachable-dash={reachableDashCount}
        data-draw-pulse-entity-id={drawPulse?.entityId || ""}
        data-draw-pulse-key={drawPulse?.key || ""}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onContextMenu={handleContextMenu}
      />
    </div>
  );
}

export default BattleMapSurface;
