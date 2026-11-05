import { describe, expect, it } from "vitest";
import { Viewpoint, silhouette } from "../src/geom/silhouette";
import { surfaceGrid } from "../src/geom/tessellate";
import type { SurfaceGeom } from "../src/geom/types";
import { Frame, Vec3, norm, sub } from "../src/geom/vec";

const world: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const TOL = 1e-6;
const persp = (eye: Vec3): Viewpoint => ({ eye, forward: [0, 0, 0], ortho: false });
const contour = (g: SurfaceGeom, view: Viewpoint) => silhouette(g, surfaceGrid(g, 5, 1e-3), view, TOL);
const closed = (line: Vec3[]) => norm(sub(line[0], line[line.length - 1])) < 1e-6;
const length = (line: Vec3[]) => line.slice(1).reduce((s, p, i) => s + norm(sub(p, line[i])), 0);

describe("silhouette", () => {
  const sphere: SurfaceGeom = { type: "sphere", frame: world, r: 2 };

  it("of a sphere seen from (d, 0, 0) is the circle at x = r²/d of radius r√(d² − r²)/d", () => {
    const d = 10;
    const lines = contour(sphere, persp([d, 0, 0]));
    expect(lines).toHaveLength(1); // one loop, joined across the u seam
    const [loop] = lines;
    expect(closed(loop)).toBe(true);
    for (const p of loop) {
      expect(norm(p)).toBeCloseTo(2, 6);
      expect(p[0]).toBeCloseTo(0.4, 6);
    }
    const rho = (2 * Math.sqrt(d * d - 4)) / d;
    expect(length(loop)).toBeCloseTo(2 * Math.PI * rho, 1);
  });

  it("follows the view direction, not the eye, in orthographic", () => {
    const lines = silhouette(sphere, surfaceGrid(sphere, 5, 1e-3), { eye: [10, 0, 0], forward: [-1, 0, 0], ortho: true }, TOL);
    expect(lines).toHaveLength(1);
    for (const p of lines[0]) expect(Math.abs(p[0])).toBeLessThan(1e-6);
  });

  it("of a plane seen face-on is empty", () => {
    const plane: SurfaceGeom = { type: "plane", frame: world, window: { u: [-1, 1], v: [-1, 1] } };
    expect(contour(plane, persp([0, 0, 10]))).toEqual([]);
  });

  it("of a cylinder is two generators", () => {
    const cylinder: SurfaceGeom = { type: "cylinder", frame: world, r: 1, window: { v: [-1, 1] } };
    const lines = contour(cylinder, persp([10, 0, 0]));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      for (const p of line) expect(p[0]).toBeCloseTo(0.1, 6);
      expect(Math.abs(line[0][2] - line[line.length - 1][2])).toBeCloseTo(2, 6);
    }
  });

  it("of a torus seen from above is its outer and inner circles", () => {
    const torus: SurfaceGeom = { type: "torus", frame: world, R: 3, r: 1 };
    const lines = contour(torus, persp([0, 0, 20]));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(closed(line)).toBe(true);
  });
});
