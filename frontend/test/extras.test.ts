import { describe, expect, it } from "vitest";
import { evalCurve } from "../src/geom/curves";
import { Extras, LineGeom, curveExtras, dataExtras } from "../src/geom/extras";
import type { CurveGeom } from "../src/geom/types";
import type { Frame, Vec3 } from "../src/geom/vec";

const ALL = { foci: true, center: true, axes: true, asymptotes: true, directrix: true, vertex: true };
const world: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
function turned(angle: number, o: Vec3 = [1.5, -0.7, 0]): Frame {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { o, x: [c, s, 0], y: [-s, c, 0], z: [0, 0, 1] };
}

const dist = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
/** Distance from p to an infinite line. */
function lineDist(p: Vec3, l: LineGeom): number {
  const w = [p[0] - l.o[0], p[1] - l.o[1]];
  return Math.abs(w[0] * l.d[1] - w[1] * l.d[0]) / Math.hypot(l.d[0], l.d[1]);
}
const named = (e: Extras, name: string): Vec3 => {
  const found = e.points.find((p) => p.name === name);
  if (!found) throw new Error(`no extra point ${name}`);
  return found.p;
};
const params = [-2.5, -1, -0.3, 0.4, 1.2, 2.9];

describe("curveExtras", () => {
  it("puts an ellipse's foci where the focal distances sum to the major axis", () => {
    for (const [g, major] of [
      [{ type: "ellipse", frame: turned(0.6), a: 3, b: 2 }, 6],
      [{ type: "ellipse", frame: turned(-1.2), a: 1, b: 2.5 }, 5], // b > a: foci on the y axis
    ] as [CurveGeom, number][]) {
      const e = curveExtras(g, { foci: true });
      for (const t of params) {
        const p = evalCurve(g, t);
        expect(dist(p, named(e, "F₁")) + dist(p, named(e, "F₂"))).toBeCloseTo(major, 9);
      }
    }
  });

  it("keeps the eccentricity ratio for an ellipse's directrices", () => {
    const g: CurveGeom = { type: "ellipse", frame: turned(0.3), a: 4, b: 3 };
    const e = curveExtras(g, { foci: true, directrix: true });
    const ecc = Math.sqrt(16 - 9) / 4;
    expect(e.lines).toHaveLength(2);
    for (const t of params) {
      const p = evalCurve(g, t);
      expect(dist(p, named(e, "F₁")) / lineDist(p, e.lines[0])).toBeCloseTo(ecc, 9);
    }
  });

  it("puts a parabola's focus and directrix at equal distances from every point", () => {
    for (const f of [0.5, -0.5]) {
      const g: CurveGeom = { type: "parabola", frame: turned(2.1), f };
      const e = curveExtras(g, { foci: true, directrix: true });
      for (const t of params) {
        const p = evalCurve(g, t);
        expect(dist(p, named(e, "F"))).toBeCloseTo(lineDist(p, e.lines[0]), 9);
      }
    }
  });

  it("gives a hyperbola its foci, asymptotes and directrix", () => {
    const g: CurveGeom = { type: "hyperbola", frame: turned(-0.8), a: 1.5, b: 0.8 };
    const e = curveExtras(g, { foci: true, asymptotes: true, directrix: true });
    const c = Math.hypot(1.5, 0.8);
    for (const t of params) {
      const p = evalCurve(g, t);
      expect(Math.abs(dist(p, named(e, "F₁")) - dist(p, named(e, "F₂")))).toBeCloseTo(3, 9);
      expect(dist(p, named(e, "F₁")) / lineDist(p, e.lines[2])).toBeCloseTo(c / 1.5, 9);
    }
    const far = evalCurve(g, 8);
    expect(Math.min(lineDist(far, e.lines[0]), lineDist(far, e.lines[1]))).toBeLessThan(1e-3);
  });

  it("marks a circle's center and an ellipse's vertices", () => {
    const circle = curveExtras({ type: "circle", frame: turned(0.4), r: 2 }, { center: true });
    expect(circle.points).toEqual([{ p: [1.5, -0.7, 0], name: "O" }]);
    const ellipse = curveExtras({ type: "ellipse", frame: world, a: 3, b: 2 }, { vertex: true, axes: true });
    expect(ellipse.points.map((p) => p.p)).toEqual([[3, 0, 0], [-3, 0, 0], [0, 2, 0], [0, -2, 0]]);
    expect(ellipse.lines).toHaveLength(2);
  });

  it("gives nothing for a line, a false value or an unknown key", () => {
    expect(curveExtras({ type: "line", o: [0, 0, 0], d: [1, 0, 0] }, ALL)).toEqual({ lines: [], points: [] });
    const g: CurveGeom = { type: "ellipse", frame: world, a: 3, b: 2 };
    expect(curveExtras(g, { foci: false, isolines: [4, 4], asymptotes: true })).toEqual({ lines: [], points: [] });
  });
});

describe("dataExtras", () => {
  it("draws a control polygon and its poles", () => {
    const e = dataExtras({ poles: [[0, 0, 0], [1, 2], [3, 0, 0]] });
    expect(e.paths).toEqual([[[0, 0, 0], [1, 2, 0], [3, 0, 0]]]);
    expect(e.points.map((p) => p.p)).toEqual([[0, 0, 0], [1, 2, 0], [3, 0, 0]]);
    expect(e.points.every((p) => p.name === "")).toBe(true);
  });

  it("draws knot points, comb teeth with their envelope, and normal segments", () => {
    const e = dataExtras({
      knots: [[0.5, 0, 0]],
      comb: { scale: 0.5, teeth: [[[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 2, 0]], [[2, 0, 0], [2, 0, 0]]] },
      normals: [[[0, 0, 0], [0, 0, 1]]],
    });
    // two non-degenerate teeth, their envelope, and the normal segment
    expect(e.paths).toEqual([
      [[0, 0, 0], [0, 1, 0]],
      [[1, 0, 0], [1, 2, 0]],
      [[0, 1, 0], [1, 2, 0]],
      [[0, 0, 0], [0, 0, 1]],
    ]);
    expect(e.points.map((p) => p.p)).toEqual([[0.5, 0, 0]]);
  });

  it("ignores missing and malformed data", () => {
    expect(dataExtras({ foci: true })).toEqual({ lines: [], points: [], paths: [] });
    expect(dataExtras({ poles: "nope", knots: [["a"]], comb: { teeth: [[[0, 0], [1]]] }, normals: [null] }))
      .toEqual({ lines: [], points: [], paths: [] });
  });
});
