import { describe, expect, it } from "vitest";
import {
  MAP_ZOOM,
  cellToWorld,
  centerCameraOnCell,
  clampCamera,
  clampCellSize,
  clientPointToCell,
  footprintCells,
  footprintCenter,
  footprintForSize,
  mapContentSize,
  worldToCell,
  zoomCameraAt,
} from "./mapGeometry.js";

describe("map geometry", () => {
  it("calculates map size and cell centers from room dimensions", () => {
    expect(mapContentSize({ columns: 10, rows: 7 })).toEqual({ width: 758, height: 536 });
    expect(cellToWorld(0, 0)).toEqual({ x: 46, y: 46 });
    expect(cellToWorld(4, 3)).toEqual({ x: 342, y: 268 });
  });

  it("maps world points to cells and rejects gaps or out-of-bounds points", () => {
    const room = { columns: 10, rows: 7 };

    expect(worldToCell(46, 46, room)).toEqual({ x: 0, y: 0 });
    expect(worldToCell(342, 268, room)).toEqual({ x: 4, y: 3 });
    expect(worldToCell(83, 46, room)).toBeNull();
    expect(worldToCell(760, 46, room)).toBeNull();
  });

  it("maps client points through the current camera", () => {
    const room = { columns: 10, rows: 7 };
    const camera = { x: 120, y: 80 };

    expect(clientPointToCell({ x: 166, y: 126 }, { left: 0, top: 0 }, camera, room)).toEqual({ x: 0, y: 0 });
    expect(clientPointToCell({ x: 120, y: 80 }, { left: 0, top: 0 }, camera, room)).toBeNull();
  });

  it("clamps camera position and centers maps smaller than the viewport", () => {
    expect(clampCamera({ x: -1000, y: 40 }, { width: 800, height: 500 }, { columns: 10, rows: 7 })).toEqual({
      x: 21,
      y: 0,
    });
    expect(clampCamera({ x: -2000, y: 40 }, { width: 500, height: 400 }, { columns: 24, rows: 18 })).toEqual({
      x: -1294,
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

    expect(zoomed.cellSize).toBe(76);
    expect(zoomed.camera.x).toBeCloseTo(-4.86, 1);
    expect(zoomed.camera.y).toBeCloseTo(-3.78, 1);
    expect(clampCellSize(MAP_ZOOM.defaultSize * 2.4)).toBe(MAP_ZOOM.max);
  });

  it("maps creature sizes to square footprints", () => {
    expect(footprintForSize("Medium")).toBe(1);
    expect(footprintForSize("Large")).toBe(2);
    expect(footprintForSize("Huge")).toBe(3);
    expect(footprintForSize("Gargantuan")).toBe(4);
    expect(footprintForSize(undefined)).toBe(1);
    expect(footprintForSize("nonsense")).toBe(1);
  });

  it("expands a creature anchor into the cells it occupies", () => {
    expect(footprintCells(2, 2, "Medium")).toEqual([{ x: 2, y: 2 }]);
    expect(footprintCells(2, 2, "Large")).toEqual([
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 3 },
    ]);
    expect(footprintCells(null, 2, "Large")).toEqual([]);
  });

  it("centers a large footprint over the middle of its block", () => {
    const single = footprintCenter(2, 2, "Medium");
    expect({ x: single.x, y: single.y }).toEqual(cellToWorld(2, 2));
    const large = footprintCenter(2, 2, "Large");
    expect(large.side).toBe(2);
    // Anchored at cell 2, a 2x2 block spans two cells plus the gap between them.
    expect(large.span).toBe(MAP_ZOOM.defaultSize * 2 + 2);
  });

  it("centers a selected cell in the viewport when possible", () => {
    expect(centerCameraOnCell({ x: 12, y: 9 }, { width: 500, height: 400 }, { columns: 24, rows: 18 })).toEqual({
      x: -684,
      y: -512,
    });
    expect(centerCameraOnCell({ x: 99, y: 9 }, { width: 500, height: 400 }, { columns: 24, rows: 18 })).toBeNull();
  });
});
