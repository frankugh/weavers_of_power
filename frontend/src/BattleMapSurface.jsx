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

function drawMoveHighlights(graphics, room, cellSize, moveMode, selectedEntity, busy, hoverCell, occupiedByPosition) {
  graphics.clear();

  if (!moveMode || !selectedEntity || busy) {
    return;
  }

  const contentSize = mapContentSize(room, cellSize);
  graphics
    .rect(10, 10, contentSize.width - 20, contentSize.height - 20)
    .fill({ color: 0x7db97f, alpha: 0.045 })
    .stroke({ color: 0x7db97f, alpha: 0.38, width: 2 });

  if (hoverCell && !occupiedByPosition.has(positionKey(hoverCell.x, hoverCell.y))) {
    const bounds = cellBounds(hoverCell.x, hoverCell.y, cellSize);
    graphics
      .rect(bounds.x, bounds.y, bounds.width, bounds.height)
      .fill({ color: 0x7db97f, alpha: 0.18 })
      .stroke({ color: 0x7db97f, alpha: 0.76, width: 2 });
  }
}

function drawUnit(PIXI, layer, entity, entityState, cellSize, texture) {
  const center = cellToWorld(entity.grid_x, entity.grid_y, cellSize);
  const token = new PIXI.Container();
  const radius = Math.max(10, Math.min(26, cellSize / 2 - 5));
  const hpValue = entity.is_player ? 100 : percent(entity.hp_current, entity.hp_max);
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

function renderPixiScene(renderer, state) {
  if (!renderer) {
    return;
  }

  const { PIXI, app, world, layers, textures } = renderer;
  const { room, placedEntities, selectedId, activeTurnId, moveMode, selectedEntity, busy, hoverCell, occupiedByPosition, cellSize, camera } = state;

  world.position.set(camera.x, camera.y);
  drawGrid(layers.terrain, room, cellSize);
  drawMoveHighlights(layers.highlights, room, cellSize, moveMode, selectedEntity, busy, hoverCell, occupiedByPosition);
  clearLayer(layers.units);

  placedEntities.forEach((entity) => {
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
  moveMode,
  busy,
  onSelect,
  onMoveToCell,
}) {
  const surfaceRef = useRef(null);
  const rendererRef = useRef(null);
  const panRef = useRef(null);
  const pinchRef = useRef(null);
  const pointersRef = useRef(new Map());
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
  const occupiedByPosition = useMemo(
    () => new Map(placedEntities.map((entity) => [positionKey(entity.grid_x, entity.grid_y), entity])),
    [placedEntities],
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
      moveMode,
      selectedEntity,
      busy,
      hoverCell,
      occupiedByPosition,
      cellSize,
      camera,
    });
  }, [pixiReady, textureVersion, room, placedEntities, selectedId, activeTurnId, moveMode, selectedEntity, busy, hoverCell, occupiedByPosition, cellSize, camera]);

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
    const occupied = cell ? occupiedByPosition.has(positionKey(cell.x, cell.y)) : false;
    const isMiddleMouse = pointerType !== "touch" && pointerButton === 1;
    const isLeftMouse = pointerType !== "touch" && pointerButton === 0;
    const canStartPan = isMiddleMouse || ((isLeftMouse || pointerType === "touch") && !occupied);

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
    const pan = panRef.current;
    const wasDragging = pan?.pointerId === pointerId && pan.dragging;
    const wasPinching = Boolean(pinchRef.current);
    const clickCell = !wasDragging && !wasPinching && pan?.button !== 1 ? cellFromPointer(event) : null;

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

    const occupant = occupiedByPosition.get(positionKey(clickCell.x, clickCell.y));
    if (occupant) {
      onSelect(occupant.instance_id);
      return;
    }
    if (moveMode && selectedEntity && !busy) {
      onMoveToCell(clickCell.x, clickCell.y);
    }
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
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
      />
    </div>
  );
}

export default BattleMapSurface;
