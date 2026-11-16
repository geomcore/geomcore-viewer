import { describe, expect, it } from "vitest";
import type { Geom } from "../src/geom/types";
import type { Frame, Vec2, Vec3 } from "../src/geom/vec";
import type { SceneObject } from "../src/protocol";
import { uvAt } from "../src/geom/pcurve";
import { Hit3D, Project, describeHit3D, pickProjected, surfaceUv } from "../src/view3d/pick";
import type { Pickable3D } from "../src/view3d/render";

const world: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
/** Looking down z, 10 px per unit, origin at (100, 100); points above z = 5 are "behind the camera". */
const project: Project = (p: Vec3): Vec2 | null => (p[2] > 5 ? null : [100 + 10 * p[0], 100 - 10 * p[1]]);
const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));

describe("pickProjected", () => {
  it("maps a hit on a projected curve back to the world point and the curve parameter", () => {
    const line: Pickable3D = { id: "L", polylines: [{ pts: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], ts: [0, 10, 20] }], dots: [] };
    const hit = pickProjected([line], project, 115, 103)!;
    expect(hit.id).toBe("L");
    expect(hit.dist).toBeCloseTo(3, 9);
    close(hit.at, [1.5, 0, 0]);
    expect(hit.t).toBeCloseTo(15, 9);
  });

  it("splits a polyline where it passes behind the camera, and still maps hits on the far run", () => {
    const arc: Pickable3D = { id: "A", polylines: [{ pts: [[0, 0, 0], [1, 0, 9], [2, 0, 0], [3, 0, 0]], ts: [0, 1, 2, 3] }], dots: [] };
    expect(pickProjected([arc], project, 105, 100)).toBeNull(); // the segments through the hidden point are gone
    const hit = pickProjected([arc], project, 125, 101)!;
    close(hit.at, [2.5, 0, 0]);
    expect(hit.t).toBeCloseTo(2.5, 9);
  });

  it("gives a polyline's hit no parameter, and a dot its index and position", () => {
    const poly: Pickable3D = { id: "Q", polylines: [{ pts: [[0, 2, 0], [2, 2, 0]], ts: null }], dots: [] };
    const cloud: Pickable3D = { id: "S", polylines: [], dots: [[0, -2, 0], [3, -2, 1]] };
    expect(pickProjected([poly, cloud], project, 110, 81)).toMatchObject({ id: "Q", t: null, index: null });
    expect(pickProjected([poly, cloud], project, 129, 121)).toMatchObject({ id: "S", index: 1, at: [3, -2, 1], t: null });
  });

  it("finds nothing beyond the radius", () => {
    const line: Pickable3D = { id: "L", polylines: [{ pts: [[0, 0, 0], [1, 0, 0]], ts: [0, 1] }], dots: [] };
    expect(pickProjected([line], project, 105, 120)).toBeNull();
  });
});

describe("surface and (u, v) helpers", () => {
  it("maps normalized texture coordinates through the grid's window", () => {
    const grid = { u: [0, 2 * Math.PI] as [number, number], v: [-1, 4] as [number, number], nu: 8, nv: 1, assumed: false };
    close(surfaceUv(grid, [0.25, 0.5]), [Math.PI / 2, 1.5]);
  });

  it("evaluates a (u, v) line, circle or polyline at t", () => {
    close(uvAt({ type: "line", o: [0, 1.5, 0], d: [1, 0, 0] }, 2), [2, 1.5]);
    close(uvAt({ type: "circle", frame: world, r: 2 }, Math.PI / 2), [0, 2]);
    close(uvAt({ type: "polyline", points: [[0, 0, 0], [1, 0, 0], [1, 2, 0]] }, 1.25), [1, 0.5]);
  });
});

describe("describeHit3D", () => {
  const cylinder: Geom = { type: "cylinder", frame: world, r: 2, window: { v: [-1, 4] } };
  const lookup = (id: string) => (id === "Y" ? cylinder : undefined);
  const hit = (extra: Partial<Hit3D>): Hit3D => ({ id: "x", dist: 0, at: [0, 0, 0], t: null, index: null, uv: null, ...extra });

  it("shows a pcurve's t, its (u, v) and the point S(u, v)", () => {
    const ring: SceneObject = { id: "ring", geom: { type: "pcurve", surface: "Y", curve: { type: "line", o: [0, 1.5, 0], d: [1, 0, 0] } } };
    expect(describeHit3D(ring, hit({ t: Math.PI / 2 }), lookup)).toEqual(["ring · pcurve", "t = 1.5708", "u = 1.5708 · v = 1.5", "(0, 2, 1.5)"]);
  });

  it("shows a surface's (u, v) and the exact point there", () => {
    const y: SceneObject = { id: "Y", label: "Y", geom: cylinder, meta: { params: [1, 2] } };
    expect(describeHit3D(y, hit({ uv: [0, 0.5] }), lookup)).toEqual(["Y · cylinder", "u = 0 · v = 0.5", "(2, 0, 0.5)", "params (1, 2)"]);
  });

  it("shows a curve's t and a point's coordinates", () => {
    const c: SceneObject = { id: "C", geom: { type: "circle", frame: world, r: 1 } };
    expect(describeHit3D(c, hit({ t: Math.PI }), lookup)).toEqual(["C · circle", "t = 3.1416", "(-1, 0, 0)"]);
    const p: SceneObject = { id: "P", geom: { type: "point", p: [1, 2, 3] } };
    expect(describeHit3D(p, hit({ index: 0 }), lookup)).toEqual(["P · point", "(1, 2, 3)"]);
  });
});
