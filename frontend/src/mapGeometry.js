export const MAP_ZOOM = {
  min: 24,
  max: 172,
  step: 4,
  defaultSize: 72,
};

export const MAP_DRAG_THRESHOLD = 4;
export const MAP_GRID_GAP = 2;
export const MAP_VIEWPORT_PADDING = 10;
export const DEFAULT_MAP_VIEWPORT = { width: 800, height: 500 };

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clampCellSize(cellSize) {
  return clamp(Math.round(numberOr(cellSize, MAP_ZOOM.defaultSize) / MAP_ZOOM.step) * MAP_ZOOM.step, MAP_ZOOM.min, MAP_ZOOM.max);
}

export function normalizeViewportSize(viewport) {
  return {
    width: Math.max(1, numberOr(viewport?.width, DEFAULT_MAP_VIEWPORT.width)),
    height: Math.max(1, numberOr(viewport?.height, DEFAULT_MAP_VIEWPORT.height)),
  };
}

export function mapStep(cellSize = MAP_ZOOM.defaultSize, gap = MAP_GRID_GAP) {
  return cellSize + gap;
}

export function mapContentSize(room, cellSize = MAP_ZOOM.defaultSize, gap = MAP_GRID_GAP, padding = MAP_VIEWPORT_PADDING) {
  const columns = Math.max(0, Number(room?.columns) || 0);
  const rows = Math.max(0, Number(room?.rows) || 0);

  return {
    width: padding * 2 + columns * cellSize + Math.max(0, columns - 1) * gap,
    height: padding * 2 + rows * cellSize + Math.max(0, rows - 1) * gap,
  };
}

export function isCellInsideRoom(cell, room) {
  return (
    Number.isInteger(cell?.x) &&
    Number.isInteger(cell?.y) &&
    cell.x >= 0 &&
    cell.y >= 0 &&
    cell.x < room.columns &&
    cell.y < room.rows
  );
}

export function cellToWorld(x, y, cellSize = MAP_ZOOM.defaultSize, gap = MAP_GRID_GAP, padding = MAP_VIEWPORT_PADDING) {
  const step = mapStep(cellSize, gap);

  return {
    x: padding + x * step + cellSize / 2,
    y: padding + y * step + cellSize / 2,
  };
}

export function cellBounds(x, y, cellSize = MAP_ZOOM.defaultSize, gap = MAP_GRID_GAP, padding = MAP_VIEWPORT_PADDING) {
  const step = mapStep(cellSize, gap);

  return {
    x: padding + x * step,
    y: padding + y * step,
    width: cellSize,
    height: cellSize,
  };
}

export function worldToCell(
  worldX,
  worldY,
  room,
  cellSize = MAP_ZOOM.defaultSize,
  gap = MAP_GRID_GAP,
  padding = MAP_VIEWPORT_PADDING,
  options = {},
) {
  const step = mapStep(cellSize, gap);
  const gridX = worldX - padding;
  const gridY = worldY - padding;
  const x = Math.floor(gridX / step);
  const y = Math.floor(gridY / step);
  const offsetX = gridX - x * step;
  const offsetY = gridY - y * step;
  const cell = { x, y };

  const unbounded = Boolean(options.unbounded);
  if (offsetX < 0 || offsetY < 0 || offsetX > cellSize || offsetY > cellSize || (!unbounded && !isCellInsideRoom(cell, room))) {
    return null;
  }

  return cell;
}

export function clientPointToCell(point, viewportRect, camera, room, cellSize = MAP_ZOOM.defaultSize, options = {}) {
  const rectLeft = numberOr(viewportRect?.left, 0);
  const rectTop = numberOr(viewportRect?.top, 0);
  const worldX = numberOr(point?.x, 0) - rectLeft - numberOr(camera?.x, 0);
  const worldY = numberOr(point?.y, 0) - rectTop - numberOr(camera?.y, 0);

  return worldToCell(worldX, worldY, room, cellSize, MAP_GRID_GAP, MAP_VIEWPORT_PADDING, options);
}

export function clampCamera(camera, viewport, room, cellSize = MAP_ZOOM.defaultSize, options = {}) {
  const viewportSize = normalizeViewportSize(viewport);
  if (options.unbounded) {
    return {
      x: numberOr(camera?.x, 0),
      y: numberOr(camera?.y, 0),
    };
  }
  const contentSize = mapContentSize(room, cellSize);

  function clampAxis(value, viewportLength, contentLength) {
    if (contentLength <= viewportLength) {
      return (viewportLength - contentLength) / 2;
    }
    return clamp(numberOr(value, 0), viewportLength - contentLength, 0);
  }

  return {
    x: clampAxis(camera?.x, viewportSize.width, contentSize.width),
    y: clampAxis(camera?.y, viewportSize.height, contentSize.height),
  };
}

export function zoomCameraAt(camera, viewport, room, oldCellSize, nextCellSize, anchor, options = {}) {
  const viewportSize = normalizeViewportSize(viewport);
  const clampedNextSize = clampCellSize(nextCellSize);
  const oldStep = mapStep(oldCellSize);
  const nextStep = mapStep(clampedNextSize);
  const anchorX = numberOr(anchor?.x, viewportSize.width / 2);
  const anchorY = numberOr(anchor?.y, viewportSize.height / 2);
  const gridUnitX = (anchorX - numberOr(camera?.x, 0) - MAP_VIEWPORT_PADDING) / oldStep;
  const gridUnitY = (anchorY - numberOr(camera?.y, 0) - MAP_VIEWPORT_PADDING) / oldStep;
  const nextCamera = {
    x: anchorX - (MAP_VIEWPORT_PADDING + gridUnitX * nextStep),
    y: anchorY - (MAP_VIEWPORT_PADDING + gridUnitY * nextStep),
  };

  return {
    cellSize: clampedNextSize,
    camera: clampCamera(nextCamera, viewportSize, room, clampedNextSize, options),
  };
}

export function centerCameraOnCell(cell, viewport, room, cellSize = MAP_ZOOM.defaultSize, options = {}) {
  const viewportSize = normalizeViewportSize(viewport);
  if (!options.unbounded && !isCellInsideRoom(cell, room)) {
    return null;
  }

  const center = cellToWorld(cell.x, cell.y, cellSize);

  return clampCamera(
    {
      x: viewportSize.width / 2 - center.x,
      y: viewportSize.height / 2 - center.y,
    },
    viewportSize,
    room,
    cellSize,
    options,
  );
}

export function visibleCellRange(camera, viewport, cellSize = MAP_ZOOM.defaultSize, gap = MAP_GRID_GAP, padding = MAP_VIEWPORT_PADDING) {
  const viewportSize = normalizeViewportSize(viewport);
  const step = mapStep(cellSize, gap);
  const worldLeft = -numberOr(camera?.x, 0);
  const worldTop = -numberOr(camera?.y, 0);
  const worldRight = worldLeft + viewportSize.width;
  const worldBottom = worldTop + viewportSize.height;

  return {
    minX: Math.floor((worldLeft - padding) / step) - 1,
    maxX: Math.floor((worldRight - padding) / step) + 1,
    minY: Math.floor((worldTop - padding) / step) - 1,
    maxY: Math.floor((worldBottom - padding) / step) + 1,
    worldLeft,
    worldTop,
    worldRight,
    worldBottom,
  };
}

export function centerCameraOnExtents(extents, viewport, cellSize = MAP_ZOOM.defaultSize, options = {}) {
  if (!extents || Number(extents.width) <= 0 || Number(extents.height) <= 0) {
    return centerCameraOnCell({ x: 0, y: 0 }, viewport, { columns: 1, rows: 1 }, cellSize, { ...options, unbounded: true });
  }
  const centerCell = {
    x: (Number(extents.minX) + Number(extents.maxX)) / 2,
    y: (Number(extents.minY) + Number(extents.maxY)) / 2,
  };
  return centerCameraOnCell(centerCell, viewport, { columns: 1, rows: 1 }, cellSize, { ...options, unbounded: true });
}

export function sameCell(first, second) {
  return first?.x === second?.x && first?.y === second?.y;
}
