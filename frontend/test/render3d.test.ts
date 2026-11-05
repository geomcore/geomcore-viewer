import { describe, expect, it } from "vitest";
import { viewBox } from "../src/geom/bounds";
import { evalSurface } from "../src/geom/surfaces";
import type { Geom } from "../src/geom/types";
import type { Frame } from "../src/geom/vec";
import type { SceneObject } from "../src/protocol";
import {
  Context3D,
  ISOLINES,
  SURFACE_ALPHA_WITH_CURVES,
  WIRE_ISOLINES,
  hasCurves,
  isolineCounts,
  objectDraw3D,
  screenPx,
  surfaceAlpha,
} from "../src/view3d/render";

const world: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const obj = (id: string, geom: Geom, extra: Partial<SceneObject> = {}): SceneObject => ({ id, geom, ...extra });
const cylinder = obj("Y", { type: "cylinder", frame: world, r: 2, window: { v: [-1, 4] } });
const circle = obj("C", { type: "circle", frame: world, r: 1 });

function ctx(objects: SceneObject[]): Context3D {
  const byId = new Map(objects.map((o) => [o.id, o.geom]));
  return { box: viewBox(objects.map((o) => o.geom)), lookup: (id) => byId.get(id), withCurves: hasCurves(objects) };
}

describe("surface opacity", () => {
  it("defaults to 0.45 when the scene has a curve, polyline or pcurve, else to 1", () => {
    expect(hasCurves([cylinder])).toBe(false);
    expect(hasCurves([cylinder, circle])).toBe(true);
    expect(hasCurves([obj("L", { type: "polyline", points: [[0, 0, 0], [1, 0, 0]] })])).toBe(true);
    expect(hasCurves([obj("q", { type: "pcurve", surface: "Y", curve: { type: "polyline", points: [[0, 0, 0], [1, 0, 0]] } })])).toBe(true);
    expect(hasCurves([obj("P", { type: "point", p: [0, 0, 0] })])).toBe(false);
    expect(surfaceAlpha(cylinder, false)).toBe(1);
    expect(surfaceAlpha(cylinder, true)).toBe(SURFACE_ALPHA_WITH_CURVES);
  });

  it("lets an explicit style.opacity win, clamped to [0, 1]", () => {
    expect(surfaceAlpha({ ...cylinder, style: { opacity: 0.8 } }, true)).toBe(0.8);
    expect(surfaceAlpha({ ...cylinder, style: { opacity: 3 } }, true)).toBe(1);
    expect(surfaceAlpha({ ...cylinder, style: { opacity: 0 } }, false)).toBe(0);
  });

  it("applies to the surface's mesh", () => {
    expect(objectDraw3D(cylinder, ctx([cylinder, circle])).surface?.alpha).toBe(SURFACE_ALPHA_WITH_CURVES);
    expect(objectDraw3D(cylinder, ctx([cylinder])).surface?.alpha).toBe(1);
  });
});

describe("isolines and wire", () => {
  it("reads [nu, nv], true, or wire's default", () => {
    expect(isolineCounts(undefined)).toBeNull();
    expect(isolineCounts({ isolines: [4, 2] })).toEqual([4, 2]);
    expect(isolineCounts({ isolines: true })).toEqual(ISOLINES);
    expect(isolineCounts({ wire: true })).toEqual(WIRE_ISOLINES);
    expect(isolineCounts({ isolines: [4, 2], wire: true })).toEqual([4, 2]);
    expect(isolineCounts({ isolines: [1.5, 2] })).toBeNull();
    expect(isolineCounts({ isolines: false })).toBeNull();
  });

  it("draws nu + nv isolines on the surface, keeping the fill", () => {
    const d = objectDraw3D({ ...cylinder, extras: { isolines: [4, 2] } }, ctx([cylinder]));
    expect(d.surface).not.toBeNull();
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0].paths).toHaveLength(6);
    expect(d.lines[0].px).toBe(1);
    const [u0, u1] = [0, 2 * Math.PI];
    const first = d.lines[0].paths[0][0]; // the first constant-u line, at the middle of the first of 4 cells, from v = -1
    const want = evalSurface(cylinder.geom as never, u0 + (u1 - u0) / 8, -1);
    first.forEach((x, i) => expect(x).toBeCloseTo(want[i], 12));
  });

  it("draws a wireframe as lines only: its isolines and the window's edges", () => {
    const d = objectDraw3D({ ...cylinder, extras: { wire: true } }, ctx([cylinder]));
    expect(d.surface).toBeNull();
    const paths = d.lines.flatMap((l) => l.paths);
    expect(paths).toHaveLength(WIRE_ISOLINES[0] + WIRE_ISOLINES[1] + 4);
  });
});

describe("objectDraw3D", () => {
  it("draws a curve inside the view box with its parameters for picking, labelled 30 % along", () => {
    const d = objectDraw3D(circle, ctx([circle]));
    expect(d.lines[0].px).toBe(3);
    expect(d.pick.polylines[0].ts![0]).toBe(0);
    const pts = d.lines[0].paths[0];
    expect(d.texts).toEqual([{ key: "c:C", id: "C", text: "C", at: pts[Math.floor((pts.length - 1) * 0.3)], color: null, kind: "curve" }]);
  });

  it("dashes a dashed curve in world units", () => {
    const d = objectDraw3D({ ...circle, style: { dashed: true } }, ctx([circle]));
    expect(d.lines[0].paths.length).toBeGreaterThan(20);
    expect(d.pick.polylines).toHaveLength(1); // hover still follows the whole curve
  });

  it("lifts a pcurve onto its surface, and draws nothing while the surface is missing", () => {
    const ring = obj("ring", { type: "pcurve", surface: "Y", curve: { type: "line", o: [0, 1.5, 0], d: [1, 0, 0] } });
    const d = objectDraw3D(ring, ctx([cylinder, ring]));
    for (const p of d.lines[0].paths[0]) {
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(2, 9);
      expect(p[2]).toBeCloseTo(1.5, 12);
    }
    expect(d.texts[0].key).toBe("c:ring");
    const lost = objectDraw3D(ring, ctx([ring]));
    expect(lost.lines).toEqual([]);
    expect(lost.texts).toEqual([]);
  });

  it("gives a point a marker, a dot to pick and a coordinate label", () => {
    const d = objectDraw3D(obj("P", { type: "point", p: [1, 2, 3] }), ctx([]));
    expect(d.markers).toEqual([{ id: "P", at: [[1, 2, 3]], color: "#3a7cc2", px: 4.5, alpha: 1, extra: false }]);
    expect(d.pick.dots).toEqual([[1, 2, 3]]);
    expect(d.texts[0].text).toBe("P (1, 2, 3)");
  });

  it("labels a tangent hit with its name, the tangency and its coordinates", () => {
    const hit = obj("P·hit1", { type: "point", p: [0, -2, 0] }, { meta: { tag: "hit", tangent: true } });
    expect(objectDraw3D(hit, ctx([])).texts[0].text).toBe("P·hit1 tangent (0, -2)");
  });

  it("draws client-computed extras as extra lines and dots", () => {
    const b = obj("B", { type: "polyline", points: [[0, 0, 0], [1, 0, 0]] }, {
      extras: { poles: [[0, 0, 0], [1, 1, 0]], knots: [[0.5, 0, 0]], normals: [[[0, 0, 0], [0, 0, 1]]] },
    });
    const d = objectDraw3D(b, ctx([b]));
    const extra = d.lines.filter((l) => l.extra);
    expect(extra).toHaveLength(1);
    expect(extra[0].paths.length).toBeGreaterThan(2); // dashed control polygon and normal segment
    expect(extra[0].paths.flat().some((p) => p[1] === 1)).toBe(true); // the bend of the control polygon
    expect(d.markers.filter((m) => m.extra).flatMap((m) => m.at)).toEqual([[0, 0, 0], [1, 1, 0], [0.5, 0, 0]]);
    expect(d.texts.filter((t) => t.kind === "extra")).toEqual([]); // pole/knot dots stay unlabelled
  });

  it("colours a point cloud and a mesh by their scalars", () => {
    const cloud = obj("C", { type: "points", positions: [[0, 0, 0], [1, 0, 0]], values: [0, 1], colormap: "turbo" });
    const [marker] = objectDraw3D(cloud, ctx([cloud])).markers;
    expect(marker.colors).toHaveLength(2);
    expect(marker.colors![0]).not.toBe(marker.colors![1]);

    const mesh = obj("M", {
      type: "mesh", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], indices: [0, 1, 2], values: [1, 2, 3],
    });
    const { surface } = objectDraw3D(mesh, ctx([mesh]));
    expect(surface!.colors).toHaveLength(3 * 4); // RGBA per vertex
    expect(surface!.colors!.filter((_, i) => i % 4 === 3)).toEqual([1, 1, 1]);
  });

  it("does not label a result operand", () => {
    const operand = obj("P·second", { type: "sphere", frame: world, r: 1 }, { meta: { operand: true } });
    expect(objectDraw3D(operand, ctx([operand])).texts).toEqual([]);
  });

  it("draws curve extras dashed and lighter-weight, with named markers", () => {
    const e = obj("E", { type: "ellipse", frame: world, a: 3, b: 2 }, { extras: { foci: true, axes: true } });
    const d = objectDraw3D(e, ctx([e]));
    const extra = d.lines.find((l) => l.extra)!;
    expect(extra.px).toBe(1.5);
    expect(extra.paths.length).toBeGreaterThan(2);
    expect(d.markers[0].extra).toBe(true);
    expect(d.texts.filter((t) => t.kind === "extra").map((t) => t.text)).toEqual(["F₁", "F₂"]);
  });

  it("labels a surface at the middle of its window", () => {
    const d = objectDraw3D(cylinder, ctx([cylinder]));
    const want = evalSurface(cylinder.geom as never, Math.PI, 1.5);
    d.texts[0].at.forEach((x, i) => expect(x).toBeCloseTo(want[i], 12));
  });
});

describe("screenPx", () => {
  it("scales for presentation and adds the highlight", () => {
    expect(screenPx(3, 1, false)).toBe(3);
    expect(screenPx(3, 1.5, false)).toBe(4.5);
    expect(screenPx(3, 1.5, true)).toBe(6);
  });
});
