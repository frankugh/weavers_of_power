import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAP_DRAG_THRESHOLD,
  MAP_ZOOM,
  cellBounds,
  cellToWorld,
  centerCameraOnCell,
  clampCamera,
  clientPointToCell,
  mapContentSize,
  sameCell,
  zoomCameraAt,
} from "./mapGeometry.js";

const VIEWPORT_FALLBACK = { left: 0, top: 0, width: 800, height: 500 };
const UNIT_DOUBLE_CLICK_MS = 320;

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

function hasGridPosition(entity, room) {
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

function drawGrid(graphics, room, cellSize) {
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

function getReachableMovementCells(room, selectedEntity, movementState, blockingByPosition) {
  const reachable = new Map();
  if (!hasGridPosition(selectedEntity, room)) {
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
      if (nextX < 0 || nextY < 0 || nextX >= room.columns || nextY >= room.rows) {
        continue;
      }
      if (blockingByPosition.has(positionKey(nextX, nextY))) {
        continue;
      }

      const isDiagonal = dx !== 0 && dy !== 0;
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
      const cellKey = positionKey(nextX, nextY);
      const currentCell = reachable.get(cellKey);
      const kind = dashUsed || totalCost > baseMovement ? "dash" : "normal";
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

function drawMoveHighlights(graphics, room, cellSize, mapMode, selectedEntity, busy, hoverCell, blockingByPosition, reachableCells) {
  graphics.clear();

  if (mapMode === "idle" || !selectedEntity || busy) {
    return;
  }

  const contentSize = mapContentSize(room, cellSize);
  if (mapMode === "reposition") {
    graphics
      .rect(10, 10, contentSize.width - 20, contentSize.height - 20)
      .fill({ color: 0x82d9df, alpha: 0.035 })
      .stroke({ color: 0x82d9df, alpha: 0.32, width: 2 });
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
    mapMode === "reposition" && hoverCell && !blockingByPosition.has(positionKey(hoverCell.x, hoverCell.y));
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

function renderPixiScene(renderer, state) {
  if (!renderer) {
    return;
  }

  const { PIXI, app, world, layers, textures } = renderer;
  const {
    room,
    placedEntities,
    selectedId,
    activeTurnId,
    mapMode,
    selectedEntity,
    busy,
    hoverCell,
    blockingByPosition,
    reachableCells,
    cellSize,
    camera,
  } = state;

  world.position.set(camera.x, camera.y);
  drawGrid(layers.terrain, room, cellSize);
  drawMoveHighlights(
    layers.highlights,
    room,
    cellSize,
    mapMode,
    selectedEntity,
    busy,
    hoverCell,
    blockingByPosition,
    reachableCells,
  );
  clearLayer(layers.units);

  [...placedEntities]
    .sort((first, second) => Number(second.is_down) - Number(first.is_down))
    .forEach((entity) => {
      drawUnit(
        PIXI,
        layers.units,
        entity,
        {
          isSelected: entity.instance_id === selectedId,
          isActive: entity.instance_id === activeTurnId,
        },
        cellSize,
        entity.image_url ? textures.get(entity.image_url) : null,
      );
    });

  app.render();
}

function BattleMapSurface({
  room,
  entities,
  selectedId,
  activeTurnId,
  selectedEntity,
  mapMode = "idle",
  movementState = null,
  drawPulse,
  busy,
  onSelect,
  onMoveToCell,
  onUnitContextMenu,
  onUnitDoubleClick,
}) {
  const surfaceRef = useRef(null);
  const rendererRef = useRef(null);
  const panRef = useRef(null);
  const pinchRef = useRef(null);
  const pointersRef = useRef(new Map());
  const lastUnitClickRef = useRef(null);
  const cellSizeRef = useRef(MAP_ZOOM.defaultSize);
  const cameraRef = useRef({ x: 0, y: 0 });
  const viewportRef = useRef(VIEWPORT_FALLBACK);

  const [cellSize, setCellSize] = useState(MAP_ZOOM.defaultSize);
  const [camera, setCamera] = useState(() => clampCamera({ x: 0, y: 0 }, VIEWPORT_FALLBACK, room, MAP_ZOOM.defaultSize));
  const [hoverCell, setHoverCell] = useState(null);
  const [isPanning, setIsPanning] = useState(false);
  const [pixiReady, setPixiReady] = useState(false);
  const [textureVersion, setTextureVersion] = useState(0);

  const placedEntities = useMemo(() => entities.filter((entity) => hasGridPosition(entity, room)), [entities, room.columns, room.rows]);
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
  const reachableCells = useMemo(
    () =>
      mapMode === "move"
        ? getReachableMovementCells(room, selectedEntity, movementState, blockingByPosition)
        : new Map(),
    [room, selectedEntity, movementState, blockingByPosition, mapMode],
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
      setCamera((current) => clampCamera(current, metrics, room, cellSizeRef.current));
    }

    updateViewport();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateViewport);
      observer.observe(surface);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, [room]);

  useEffect(() => {
    setCamera((current) => clampCamera(current, viewportRef.current, room, cellSizeRef.current));
  }, [room.columns, room.rows]);

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
          highlights: new PIXI.Graphics(),
          units: new PIXI.Container(),
          effects: new PIXI.Container(),
        };

        world.addChild(layers.terrain, layers.highlights, layers.units, layers.effects);
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
    renderPixiScene(rendererRef.current, {
      room,
      placedEntities,
      selectedId,
      activeTurnId,
      mapMode,
      selectedEntity,
      busy,
      hoverCell,
      blockingByPosition,
      reachableCells,
      cellSize,
      camera,
    });
  }, [
    pixiReady,
    textureVersion,
    room,
    placedEntities,
    selectedId,
    activeTurnId,
    mapMode,
    selectedEntity,
    busy,
    hoverCell,
    blockingByPosition,
    reachableCells,
    cellSize,
    camera,
  ]);

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

    ring.position.set(center.x, center.y);
    renderer.layers.effects.addChild(ring);

    function destroyRing() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      renderer.app.ticker.remove(tick);
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
    renderer.app.ticker.add(tick);
    tick();

    return destroyRing;
  }, [drawPulse?.entityId, drawPulse?.key, pixiReady, placedEntities, cellSize]);

  function cellFromPointer(event) {
    const surface = surfaceRef.current;
    const metrics = viewportMetricsOf(surface);
    viewportRef.current = metrics;
    return clientPointToCell(pointerPointOf(event), metrics, cameraRef.current, room, cellSizeRef.current);
  }

  function updateHoverCell(event) {
    const nextCell = cellFromPointer(event);
    setHoverCell((current) => (sameCell(current, nextCell) ? current : nextCell));
  }

  function applyCamera(nextCamera) {
    setCamera(clampCamera(nextCamera, viewportRef.current, room, cellSizeRef.current));
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
    const blocking = cell ? blockingByPosition.has(positionKey(cell.x, cell.y)) : false;
    const isMiddleMouse = pointerType !== "touch" && pointerButton === 1;
    const isLeftMouse = pointerType !== "touch" && pointerButton === 0;
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
      );

      event.preventDefault();
      viewportRef.current = metrics;
      cellSizeRef.current = nextZoom.cellSize;
      cameraRef.current = nextZoom.camera;
      setCellSize(nextZoom.cellSize);
      setCamera(nextZoom.camera);
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
    const selectedOccupant = selectedEntity
      ? cellEntities.find((entity) => entity.instance_id === selectedEntity.instance_id)
      : null;
    const blockingOccupant = getBlockingEntity(cellEntities);
    const occupant = getTopSelectableEntity(cellEntities);

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

      if (isDoubleClick && onUnitDoubleClick?.(occupant.instance_id)) {
        return;
      }
    } else {
      lastUnitClickRef.current = null;
    }

    if (selectedOccupant) {
      onSelect(selectedOccupant.instance_id);
      return;
    }
    if (mapMode === "reposition" && selectedEntity && !busy && !blockingOccupant) {
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
    const nextZoom = zoomCameraAt(cameraRef.current, metrics, room, cellSizeRef.current, cellSizeRef.current - MAP_ZOOM.step);
    cellSizeRef.current = nextZoom.cellSize;
    cameraRef.current = nextZoom.camera;
    setCellSize(nextZoom.cellSize);
    setCamera(nextZoom.camera);
  }

  function handleZoomIn() {
    const metrics = viewportMetricsOf(surfaceRef.current);
    viewportRef.current = metrics;
    const nextZoom = zoomCameraAt(cameraRef.current, metrics, room, cellSizeRef.current, cellSizeRef.current + MAP_ZOOM.step);
    cellSizeRef.current = nextZoom.cellSize;
    cameraRef.current = nextZoom.camera;
    setCellSize(nextZoom.cellSize);
    setCamera(nextZoom.camera);
  }

  function handleZoomReset() {
    const metrics = viewportMetricsOf(surfaceRef.current);
    viewportRef.current = metrics;
    const nextZoom = zoomCameraAt(cameraRef.current, metrics, room, cellSizeRef.current, MAP_ZOOM.defaultSize);
    cellSizeRef.current = nextZoom.cellSize;
    cameraRef.current = nextZoom.camera;
    setCellSize(nextZoom.cellSize);
    setCamera(nextZoom.camera);
  }

  function handleCenterSelected() {
    if (!hasGridPosition(selectedEntity, room)) {
      return;
    }
    const metrics = viewportMetricsOf(surfaceRef.current);
    viewportRef.current = metrics;
    const nextCamera = centerCameraOnCell({ x: selectedEntity.grid_x, y: selectedEntity.grid_y }, metrics, room, cellSizeRef.current);
    if (nextCamera) {
      cameraRef.current = nextCamera;
      setCamera(nextCamera);
    }
  }

  const zoomPercent = Math.round((cellSize / MAP_ZOOM.defaultSize) * 100);
  const reachableNormalCount = countReachableByKind(reachableCells, "normal");
  const reachableDashCount = countReachableByKind(reachableCells, "dash");

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
      </div>
      <div
        ref={surfaceRef}
        className={`battle-map-surface ${isPanning ? "battle-map-surface-panning" : ""}`.trim()}
        role="region"
        aria-label="Battle map viewport"
        data-cell-size={cellSize}
        data-camera-x={camera.x}
        data-camera-y={camera.y}
        data-pixi-ready={pixiReady ? "true" : "false"}
        data-map-mode={mapMode}
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
