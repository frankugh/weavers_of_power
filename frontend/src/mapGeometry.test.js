import { describe, expect, it } from "vitest";
import {
  MAP_ZOOM,
  cellToWorld,
  centerCameraOnCell,
  clampCamera,
  clientPointToCell,
  mapContentSize,
  worldToCell,
  zoomCameraAt,
} from "./mapGeometry.js";

describe("map geometry", () => {
  it("calculates map size and cell centers from room dimensions", () => {
    expect(mapContentSize({ columns: 10, rows: 7 })).toEqual({ width: 478, height: 340 });
    expect(cellToWorld(0, 0)).toEqual({ x: 32, y: 32 });
    expect(cellToWorld(4, 3)).toEqual({ x: 216, y: 170 });
  });

  it("maps world points to cells and rejects gaps or out-of-bounds points", () => {
    const room = { columns: 10, rows: 7 };

    expect(worldToCell(32, 32, room)).toEqual({ x: 0, y: 0 });
    expect(worldToCell(216, 170, room)).toEqual({ x: 4, y: 3 });
    expect(worldToCell(55, 32, room)).toBeNull();
    expect(worldToCell(500, 32, room)).toBeNull();
  });

  it("maps client points through the current camera", () => {
    const room = { columns: 10, rows: 7 };
    const camera = { x: 120, y: 80 };

    expect(clientPointToCell({ x: 152, y: 112 }, { left: 0, top: 0 }, camera, room)).toEqual({ x: 0, y: 0 });
    expect(clientPointToCell({ x: 120, y: 80 }, { left: 0, top: 0 }, camera, room)).toBeNull();
  });

  it("clamps camera position and centers maps smaller than the viewport", () => {
    expect(clampCamera({ x: -1000, y: 40 }, { width: 800, height: 500 }, { columns: 10, rows: 7 })).toEqual({
      x: 161,
      y: 80,
    });
    expect(clampCamera({ x: -1000, y: 40 }, { width: 500, height: 400 }, { columns: 24, rows: 18 })).toEqual({
      x: -622,
      y: 0,
    });
  });

  it("keeps the zoom anchor stable while clamping to legal zoom sizes", () => {
    const zoomed = zoomCameraAt(
      { x: 0, y: 0 },
      { width: 500, height: 400 },
      { columns: 24, rows: 18 },
      MAP_ZOOM.defaultSize,
      MAP_ZOOM.defaultSize + MAP_ZOOM.step,
      { x: 100, y: 80 },
    );

    expect(zoomed.cellSize).toBe(48);
    expect(zoomed.camera.x).toBeCloseTo(-7.83, 1);
    expect(zoomed.camera.y).toBeCloseTo(-6.09, 1);
  });

  it("centers a selected cell in the viewport when possible", () => {
    expect(centerCameraOnCell({ x: 12, y: 9 }, { width: 500, height: 400 }, { columns: 24, rows: 18 })).toEqual({
      x: -334,
      y: -246,
    });
    expect(centerCameraOnCell({ x: 99, y: 9 }, { width: 500, height: 400 }, { columns: 24, rows: 18 })).toBeNull();
  });
});
