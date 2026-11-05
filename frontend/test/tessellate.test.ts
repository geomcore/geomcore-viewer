import { describe, expect, it } from "vitest";
import { segmentDistance } from "../src/geom/sample";
import { arcSegments, arrowPolylines, curvePieces, isoLines, surfaceGrid, tessellateSurface, windowEdges } from "../src/geom/tessellate";
import { evalSurface } from "../src/geom/surfaces";
import { evalCurve } from "../src/geom/curves";
import { halfSize, sameBox, sceneBounds, viewBox } from "../src/geom/bounds";
import { inPlaneZ0 } from "../src/geom/planar";
import type { Geom } from "../src/geom/types";
import { Frame, Vec3 } from "../src/geom/vec";

const world: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const tilted: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] };

describe("curvePieces", () => {
  it("draws a closed circle once round, from t = 0 to 2π, within the tolerance", () => {
    const g = { type: "circle", frame: world, r: 2 } as const;
    const [piece, ...rest] = curvePieces(g, viewBox([]));
    expect(rest).toEqual([]);
    expect(piece.ts[0]).toBe(0);
    expect(piece.ts[piece.ts.length - 1]).toBeCloseTo(2 * Math.PI, 12);
    const tol = 5e-4 * 5; // WORLD_TOL × the half-size of the ±5 box
    for (let i = 0; i + 1 < piece.pts.length; i++) {
      const p = evalCurve(g, (piece.ts[i] + piece.ts[i + 1]) / 2);
      expect(segmentDistance(p, piece.pts[i], piece.pts[i + 1])).toBeLessThanOrEqual(tol + 1e-12);
    }
  });

  it("runs an infinite line from face to face of the view box", () => {
    const [piece] = curvePieces({ type: "line", o: [0, 0, 0], d: [1, 0, 0] }, viewBox([]));
    expect(piece.pts[0][0]).toBeCloseTo(-5, 9);
    expect(piece.pts[piece.pts.length - 1][0]).toBeCloseTo(5, 9);
  });

  it("gives nothing for a line outside the box", () => {
    expect(curvePieces({ type: "line", o: [0, 0, 9], d: [1, 0, 0] }, viewBox([]))).toEqual([]);
  });
});

describe("arcSegments", () => {
  it("keeps the sagitta of every chord within the tolerance", () => {
    const n = arcSegments(2 * Math.PI, 3, 1e-3);
    expect(3 * (1 - Math.cos(Math.PI / n))).toBeLessThanOrEqual(1e-3);
    expect(3 * (1 - Math.cos(Math.PI / (n - 1)))).toBeGreaterThan(1e-3);
  });

  it("keeps at least 16 segments a turn, at most 256, and handles a zero radius", () => {
    expect(arcSegments(2 * Math.PI, 1e-6, 1e-3)).toBe(16);
    expect(arcSegments(Math.PI, 1e-6, 1e-3)).toBe(8);
    expect(arcSegments(2 * Math.PI, 1e6, 1e-3)).toBe(256);
    expect(arcSegments(2 * Math.PI, 0, 1e-3)).toBe(16);
  });
});

describe("surfaceGrid", () => {
  it("gives straight directions one segment and curved ones a curvature-based count", () => {
    expect(surfaceGrid({ type: "plane", frame: world, window: { u: [-1, 1], v: [-2, 2] } }, 5, 1e-3)).toEqual({
      u: [-1, 1], v: [-2, 2], nu: 1, nv: 1, assumed: false,
    });
    const cyl = surfaceGrid({ type: "cylinder", frame: world, r: 2, window: { v: [-1, 1] } }, 5, 1e-3);
    expect(cyl).toMatchObject({ nu: arcSegments(2 * Math.PI, 2, 1e-3), nv: 1 });
    const cone = surfaceGrid({ type: "cone", frame: world, semi_angle: Math.PI / 6, ref_radius: 1, window: { v: [-1, 4] } }, 5, 1e-3);
    expect(cone.nu).toBe(arcSegments(2 * Math.PI, 3, 1e-3)); // the widest ring, at v = 4
    const torus = surfaceGrid({ type: "torus", frame: world, R: 3, r: 1 }, 5, 1e-3);
    expect(torus).toMatchObject({ nu: arcSegments(2 * Math.PI, 4, 1e-3), nv: arcSegments(2 * Math.PI, 1, 1e-3) });
    expect(surfaceGrid({ type: "plane", frame: world }, 5, 1e-3)).toMatchObject({ u: [-5, 5], assumed: true });
  });

  it("follows an extrusion's profile and a revolution's arm", () => {
    const profile = { type: "polyline" as const, points: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]] as Vec3[] };
    expect(surfaceGrid({ type: "extrusion", profile, direction: [0, 1, 0], window: { u: [0, 3], v: [0, 1] } }, 5, 1e-3))
      .toMatchObject({ nu: 3, nv: 1 });
    const extrusionOfCircle = surfaceGrid(
      { type: "extrusion", profile: { type: "circle", frame: world, r: 2 }, direction: [0, 0, 1], window: { v: [0, 1] } },
      5, 1e-3);
    expect(extrusionOfCircle).toMatchObject({ nu: arcSegments(2 * Math.PI, 2, 1e-3), nv: 1 });
    const revolution = surfaceGrid(
      { type: "revolution", profile: { type: "line", o: [1, 0, 0], d: [0, 0, 1] }, origin: [0, 0, 0], direction: [0, 0, 1], window: { v: [0, 2] } },
      5, 1e-3);
    expect(revolution).toMatchObject({ nu: arcSegments(2 * Math.PI, 1, 1e-3), nv: 1 });
  });
});

describe("tessellateSurface", () => {
  it("builds an (nu+1)×(nv+1) grid of triangles with normalized (u, v) per vertex", () => {
    const g = { type: "sphere", frame: world, r: 1 } as const;
    const mesh = tessellateSurface(g, { u: [0, 2 * Math.PI], v: [-Math.PI / 2, Math.PI / 2], nu: 4, nv: 2, assumed: false });
    expect(mesh.positions).toHaveLength(5 * 3 * 3);
    expect(mesh.uvs).toHaveLength(5 * 3 * 2);
    expect(mesh.indices).toHaveLength(4 * 2 * 6);
    expect(mesh.uvs.slice(0, 2)).toEqual([0, 0]);
    expect(mesh.uvs.slice(-2)).toEqual([1, 1]);
    expect(mesh.positions.slice(3 * 7, 3 * 8)).toEqual(evalSurface(g, Math.PI, 0)); // vertex (i = 2, j = 1)
  });

  it("stays within the tolerance of a sphere along its widest grid row", () => {
    const g = { type: "sphere", frame: world, r: 3 } as const;
    const grid = surfaceGrid(g, 5, 1e-3);
    const mesh = tessellateSurface(g, grid);
    const j = Math.floor(grid.nv / 2); // the row next to the equator
    const v = -Math.PI / 2 + (Math.PI * j) / grid.nv;
    for (let i = 0; i < grid.nu; i++) {
      const a = mesh.positions.slice(3 * (j * (grid.nu + 1) + i), 3 * (j * (grid.nu + 1) + i) + 3) as Vec3;
      const b = mesh.positions.slice(3 * (j * (grid.nu + 1) + i + 1), 3 * (j * (grid.nu + 1) + i + 1) + 3) as Vec3;
      const mid = evalSurface(g, ((i + 0.5) / grid.nu) * 2 * Math.PI, v);
      expect(segmentDistance(mid, a, b)).toBeLessThanOrEqual(1e-3 + 1e-12);
    }
  });
});

describe("isoLines and windowEdges", () => {
  const sphere = { type: "sphere", frame: world, r: 2 } as const;
  const grid = surfaceGrid(sphere, 5, 1e-3);

  it("draws nu lines of constant u and nv of constant v, centred in their cells", () => {
    const lines = isoLines(sphere, grid, 4, 2);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toHaveLength(grid.nv + 1);
    for (const p of lines[0].slice(1, -1)) expect(Math.atan2(p[1], p[0])).toBeCloseTo(Math.PI / 4, 9);
    expect(lines[4]).toHaveLength(grid.nu + 1);
    for (const p of lines[4]) expect(p[2]).toBeCloseTo(2 * Math.sin(-Math.PI / 4), 9); // v = −π/4
  });

  it("outlines the window and leaves out edges that collapse to a pole", () => {
    expect(windowEdges(sphere, grid)).toHaveLength(2); // the seam at u = 0 and u = 2π; the poles are points
    expect(windowEdges({ type: "plane", frame: world, window: { u: [0, 1], v: [0, 1] } }, surfaceGrid({ type: "plane", frame: world, window: { u: [0, 1], v: [0, 1] } }, 5, 1e-3))).toEqual([
      [[0, 0, 0], [0, 1, 0]],
      [[1, 0, 0], [1, 1, 0]],
      [[0, 0, 0], [1, 0, 0]],
      [[0, 1, 0], [1, 1, 0]],
    ]);
  });
});

describe("arrowPolylines", () => {
  it("draws a shaft from at to at+vec plus two head strokes", () => {
    const lines = arrowPolylines([0, 0, 0], [0, 0, 2]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([[0, 0, 0], [0, 0, 2]]);
    for (const head of lines.slice(1)) expect(head[0]).toEqual([0, 0, 2]);
  });
});

describe("bounds", () => {
  it("covers finite geometry and only the origin of infinite curves", () => {
    const geoms: Geom[] = [
      { type: "circle", frame: { ...world, o: [1, 0, 0] }, r: 2 },
      { type: "point", p: [0, 4, 0] },
      { type: "line", o: [0, 0, -1], d: [1, 0, 0] },
      { type: "note", text: "hi" },
    ];
    expect(sceneBounds(geoms)).toEqual({ min: [-1, -2, -2], max: [3, 4, 2] });
    expect(sceneBounds([{ type: "note", text: "x" }])).toBeNull();
  });

  it("includes the drawn extent of explicitly ranged infinite curves", () => {
    expect(sceneBounds([{ type: "line", o: [0, 0, 0], d: [1, 0, 0], range: [0, 100] }])).toEqual({
      min: [0, 0, 0],
      max: [100, 0, 0],
    });
    const parabola: Geom = { type: "parabola", frame: world, f: 0.25, range: [-2, 2] };
    expect(sceneBounds([parabola])).toEqual({ min: [0, -2, 0], max: [4, 2, 0] });
    expect(sceneBounds([{ type: "line", o: [0, 0, 0], d: [1, 0, 0], range: [50, 100] }])).toEqual({
      min: [50, 0, 0],
      max: [100, 0, 0],
    });
    const away: Geom = { type: "parabola", frame: world, f: 0.25, range: [1, 2] };
    expect(sceneBounds([away])).toEqual({ min: [1, 1, 0], max: [4, 2, 0] });
  });

  it("grows the scene box ×1.5 into a cube, or falls back to ±5", () => {
    expect(viewBox([])).toEqual({ min: [-5, -5, -5], max: [5, 5, 5] });
    const box = viewBox([{ type: "point", p: [0, 0, 0] }, { type: "point", p: [2, 0, 0] }]);
    expect(box).toEqual({ min: [-0.5, -1.5, -1.5], max: [2.5, 1.5, 1.5] });
    expect(halfSize(box)).toBe(1.5);
    expect(sameBox(box, viewBox([{ type: "point", p: [2, 0, 0] }, { type: "point", p: [0, 0, 0] }]))).toBe(true);
  });
});

describe("inPlaneZ0", () => {
  it.each<[Geom, boolean]>([
    [{ type: "circle", frame: world, r: 1 }, true],
    [{ type: "circle", frame: tilted, r: 1 }, false],
    [{ type: "line", o: [0, 0, 0], d: [1, 1, 0] }, true],
    [{ type: "line", o: [0, 0, 0], d: [0, 0, 1] }, false],
    [{ type: "point", p: [1, 2, 0] }, true],
    [{ type: "polyline", points: [[0, 0, 0], [1, 0, 1e-3]] }, false],
    [{ type: "plane", frame: world }, false],
  ])("%j → %s", (g, want) => {
    expect(inPlaneZ0(g)).toBe(want);
  });
});
