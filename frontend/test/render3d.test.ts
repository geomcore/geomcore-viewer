import { describe, expect, it } from "vitest";
import { viewBox } from "../src/geom/bounds";
import { evalSurface } from "../src/geom/surfaces";
import type { Geom } from "../src/geom/types";
import type { Frame } from "../src/geom/vec";
import type { SceneObject } from "../src/protocol";
import {
  Context3D,
  EDGE_PX,
  HIDDEN_ALPHA,
  HIDDEN_PX,
  ISOLINES,
  SILHOUETTE_PX,
  SURFACE_ALPHA_WITH_CURVES,
  WIRE_ISOLINES,
  hasCurves,
  hiddenMode,
  hiddenTwin,
  isolineCounts,
  objectDraw3D,
  sceneOccludes,
  screenPx,
  silhouetteLines,
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

describe("hidden lines and silhouettes", () => {
  const torus = obj("T", { type: "torus", frame: world, R: 3, r: 1 });

  it("reads the hidden mode, ignoring anything else", () => {
    expect(hiddenMode(undefined)).toBeNull();
    expect(hiddenMode({ hidden: "dashed" })).toBe("dashed");
    expect(hiddenMode({ hidden: "hide" })).toBe("hide");
    expect(hiddenMode({ hidden: "other" })).toBeNull();
    expect(hiddenMode({ hidden: true })).toBeNull();
  });

  it("gives a hidden surface an occluder: its own tessellation, never drawn", () => {
    const d = objectDraw3D({ ...cylinder, extras: { hidden: "dashed" } }, ctx([cylinder]));
    expect(d.occluder?.mode).toBe("dashed");
    expect(d.occluder?.mesh).toEqual(d.surface?.mesh);
    const wire = objectDraw3D({ ...torus, extras: { wire: true, hidden: "hide" } }, ctx([torus]));
    expect(wire.surface).toBeNull();
    expect(wire.occluder?.mode).toBe("hide");
    expect(wire.occluder!.mesh.indices.length).toBeGreaterThan(0);
  });

  it("adds nothing without the extras, for an unknown mode, or on a mesh", () => {
    expect(objectDraw3D(cylinder, ctx([cylinder])).occluder).toBeNull();
    expect(objectDraw3D(cylinder, ctx([cylinder])).silhouette).toBeNull();
    expect(objectDraw3D({ ...cylinder, extras: { hidden: "other", silhouette: 1 } }, ctx([cylinder])).occluder).toBeNull();
    expect(objectDraw3D({ ...cylinder, extras: { silhouette: "yes" } }, ctx([cylinder])).silhouette).toBeNull();
    const mesh = obj("M", { type: "mesh", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], indices: [0, 1, 2] }, { extras: { hidden: "dashed", silhouette: true } });
    const d = objectDraw3D(mesh, ctx([mesh]));
    expect(d.occluder).toBeNull();
    expect(d.silhouette).toBeNull();
  });

  it("knows when a scene occludes", () => {
    expect(sceneOccludes([cylinder, circle])).toBe(false);
    expect(sceneOccludes([{ ...cylinder, extras: { hidden: "hide" } }])).toBe(true);
    expect(sceneOccludes([{ ...circle, extras: { hidden: "dashed" } }])).toBe(false); // curves don't occlude
  });

  it("twins a line with its dashed, thinner, fainter hidden part", () => {
    const solid = objectDraw3D(circle, ctx([circle])).lines[0];
    expect(solid.dashed).toBe(false);
    const twin = hiddenTwin(solid, ctx([circle]).box);
    expect(twin.paths.length).toBeGreaterThan(20);
    expect(twin.px).toBeCloseTo(solid.px * HIDDEN_PX, 12);
    expect(twin.alpha).toBeCloseTo(solid.alpha * HIDDEN_ALPHA, 12);
    const dashed = objectDraw3D({ ...circle, style: { dashed: true } }, ctx([circle])).lines[0];
    expect(dashed.dashed).toBe(true);
    expect(hiddenTwin(dashed, ctx([circle]).box).paths).toEqual(dashed.paths); // already cut
  });

  it("contours a silhouette in the surface's colour, a little heavier than its isolines", () => {
    const sphere = obj("S", { type: "sphere", frame: world, r: 2 }, { style: { color: "#123456" }, extras: { silhouette: true } });
    const d = objectDraw3D(sphere, ctx([sphere]));
    expect(d.silhouette).not.toBeNull();
    const part = silhouetteLines(d.silhouette!, { eye: [10, 0, 0], forward: [-1, 0, 0], ortho: false }, ctx([sphere]).box)!;
    expect(part.color).toBe("#123456");
    expect(part.px).toBe(EDGE_PX * SILHOUETTE_PX);
    expect(part.paths).toHaveLength(1);
    for (const p of part.paths[0]) expect(p[0]).toBeCloseTo(0.4, 5);
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

  it("draws a box as its twelve edges, pickable", () => {
    const box = obj("B", { type: "box", min: [0, 0, 0], max: [1, 2, 3] });
    const d = objectDraw3D(box, ctx([box]));
    expect(d.surface).toBeNull();
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0].paths).toHaveLength(12);
    expect(d.pick.polylines).toHaveLength(12);
    expect(d.pick.polylines.every((p) => p.ts === null)).toBe(true);
  });

  it("draws an exact B-spline surface and lifts a pcurve onto it", () => {
    const patch = obj("S", { type: "bspline_surface", u_degree: 1, v_degree: 1, nu: 2, nv: 2,
      poles: [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 1]],
      u_knots: [0, 1], u_multiplicities: [2, 2], v_knots: [0, 1], v_multiplicities: [2, 2],
      u_periodic: false, v_periodic: false });
    const d = objectDraw3D(patch, ctx([patch]));
    expect(d.surface).not.toBeNull();
    expect(d.surface!.mesh.positions.length).toBeGreaterThan(0);
    // The corner (1, 1) evaluates to the last pole.
    const n = d.surface!.mesh.positions.length;
    expect(d.surface!.mesh.positions.slice(n - 3)).toEqual([1, 1, 1]);
    const curve = obj("C", { type: "bspline_curve", degree: 1, poles: [[0, 0, 0], [2, 0, 0]],
      knots: [0, 1], multiplicities: [2, 2], periodic: false });
    const c = objectDraw3D(curve, ctx([curve]));
    expect(c.lines[0].paths[0][0]).toEqual([0, 0, 0]);
    const diag = obj("diag", { type: "pcurve", surface: "S",
      curve: { type: "line", o: [0, 0, 0], d: [1, 1, 0] } });
    const lifted = objectDraw3D(diag, ctx([patch, diag]));
    expect(lifted.lines[0].paths[0][0]).toEqual([0, 0, 0]);
    const last = lifted.lines[0].paths[0].at(-1)!;
    expect(last[0]).toBeCloseTo(1, 9);
    expect(last[1]).toBeCloseTo(1, 9);
    expect(last[2]).toBeCloseTo(1, 9);
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
