import { describe, expect, it } from "vitest";
import type { Vec2 } from "../src/geom/vec";
import type { SceneObject } from "../src/protocol";
import { PALETTES, mixHex } from "../src/ui/theme";
import { Camera2D } from "../src/view2d/camera";
import { DrawOptions, EXTRA_MIX, buildDrawList, describeHit } from "../src/view2d/render";

const frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const obj = (id: string, geom: unknown, extra: Partial<SceneObject> = {}) => ({ id, geom, ...extra }) as SceneObject;
const cam: Camera2D = { cx: 0, cy: 0, scale: 100, width: 800, height: 600 };
const opts = (extra: Partial<DrawOptions> = {}): DrawOptions => ({
  visible: () => true,
  palette: PALETTES.light,
  widthScale: 1,
  highlight: null,
  selected: null,
  ...extra,
});
const diagonal = obj("L", { type: "line", o: [0.3, -0.2, 0], d: [1, 0.7, 0] });

/** True when the polyline enters from beyond one edge of the pane and leaves beyond another. */
function crossesPane(pts: Vec2[], c: Camera2D): boolean {
  const outside = (p: Vec2) => p[0] < 0 || p[0] > c.width || p[1] < 0 || p[1] > c.height;
  return pts.length >= 2 && outside(pts[0]) && outside(pts[pts.length - 1]);
}

describe("buildDrawList", () => {
  it("draws an infinite line edge to edge", () => {
    const list = buildDrawList([diagonal], cam, opts());
    expect(list.strokes).toHaveLength(1);
    expect(list.strokes[0].paths).toHaveLength(1);
    expect(crossesPane(list.strokes[0].paths[0], cam)).toBe(true);
  });

  it("keeps the line edge to edge at extreme zoom", () => {
    for (const scale of [1e-6, 1e-3, 1e3, 1e8]) {
      const c = { ...cam, cx: 0.3, cy: -0.2, scale }; // centred on the line's origin, which lies on it
      const [stroke] = buildDrawList([diagonal], c, opts()).strokes;
      expect(stroke.paths, `scale ${scale}`).toHaveLength(1);
      const pts = stroke.paths[0];
      expect(crossesPane(pts, c), `scale ${scale}`).toBe(true);
      expect(pts.length).toBeLessThanOrEqual(4096);
      expect(pts.flat().every(Number.isFinite)).toBe(true);
    }
  });

  it("labels a point with its protocol coordinates", () => {
    const list = buildDrawList([obj("P₁", { type: "point", p: [1.8412, 1.62, 0] }, { label: "P₁" })], cam, opts());
    expect(list.dots).toMatchObject([{ id: "P₁", at: [584.12, 138], radius: 4.5, hollow: false }]);
    expect(list.texts).toMatchObject([{ key: "p:P₁", text: "P₁ (1.841, 1.62)", kind: "point" }]);
  });

  it("keeps a tangent hit's name next to its coordinates", () => {
    const hit = obj("P·hit1", { type: "point", p: [1.8412, 1.62, 0] }, { meta: { tag: "hit", tangent: true } });
    expect(buildDrawList([hit], cam, opts()).texts).toMatchObject([{ text: "P·hit1 tangent (1.841, 1.62)" }]);
  });

  it("colours a point cloud's dots by its scalars", () => {
    const cloud = obj("C", { type: "points", positions: [[0, 0, 0], [1, 0, 0]], values: [0, 1] });
    const dots = buildDrawList([cloud], cam, opts()).dots;
    expect(dots).toHaveLength(2);
    expect(dots[0].color).not.toBe(dots[1].color);
  });

  it("does not label a result operand, whose label stays in hover", () => {
    const operand = obj("P·first", { type: "point", p: [1, 0, 0] }, { meta: { operand: true } });
    const list = buildDrawList([operand], cam, opts());
    expect(list.texts).toEqual([]);
    expect(list.dots).toHaveLength(1); // the geometry is still drawn
  });

  it("skips hidden, non-planar and note objects", () => {
    const objects = [
      obj("hidden", { type: "point", p: [0, 0, 0] }),
      obj("lifted", { type: "point", p: [0, 0, 1] }),
      obj("sphere", { type: "sphere", frame, r: 1 }),
      obj("tall-box", { type: "box", min: [0, 0, 0], max: [1, 1, 1] }),
      obj("note", { type: "note", text: "hi" }),
    ];
    const list = buildDrawList(objects, cam, opts({ visible: (o) => o.id !== "hidden" }));
    expect(list.dots).toEqual([]);
    expect(list.strokes).toEqual([]);
    expect(list.texts).toEqual([]);
  });

  it("draws a flat box as its twelve edges", () => {
    const list = buildDrawList([obj("B", { type: "box", min: [-1, -1, 0], max: [1, 1, 0] })], cam, opts());
    expect(list.strokes).toHaveLength(1);
    expect(list.strokes[0].paths).toHaveLength(12);
    expect(list.pickables[0].polylines).toHaveLength(12);
  });

  it("draws a planar B-spline with its parameter for picking", () => {
    const c = obj("C", { type: "bspline_curve", degree: 1, poles: [[0, 0, 0], [2, 0, 0]],
      knots: [0, 1], multiplicities: [2, 2], periodic: false });
    const list = buildDrawList([c], cam, opts());
    expect(list.strokes).toHaveLength(1);
    const [line] = list.pickables[0].polylines;
    expect(line.ts).not.toBeNull();
    expect(line.ts![0]).toBe(0);
  });

  it("draws extras dashed, thinner and faded towards the background", () => {
    const e = obj("E", { type: "ellipse", frame, a: 3, b: 2 }, { style: { color: "#d1495b" }, extras: { foci: true, axes: true } });
    const list = buildDrawList([e], cam, opts());
    const extra = list.strokes.find((s) => s.extra)!;
    expect(extra.color).toBe(mixHex("#d1495b", PALETTES.light.bg, EXTRA_MIX));
    expect(extra.width).toBe(1.5);
    expect(extra.paths.length).toBeGreaterThan(20); // two axes cut into 7 px dashes
    expect(list.dots.filter((d) => d.hollow).map((d) => d.at)).toEqual([[400 + 100 * Math.sqrt(5), 300], [400 - 100 * Math.sqrt(5), 300]]);
    expect(list.texts.filter((t) => t.kind === "extra").map((t) => t.text)).toEqual(["F₁", "F₂"]);
  });

  it("draws client-computed extras (control polygon, knots, comb) in the plane view too", () => {
    const b = obj("B", { type: "polyline", points: [[0, 0, 0], [1, 0, 0]] }, {
      style: { color: "#d1495b" },
      extras: { poles: [[0, 0, 0], [0.5, 1, 0], [1, 0, 0]], knots: [[0.5, 0, 0]], comb: { teeth: [[[0.5, 0.5, 0], [0.5, 0, 0]]] } },
    });
    const list = buildDrawList([b], cam, opts());
    const extra = list.strokes.find((s) => s.extra)!;
    expect(extra.color).toBe(mixHex("#d1495b", PALETTES.light.bg, EXTRA_MIX));
    expect(extra.paths.flat().some((p) => p[1] === 300 - 100)).toBe(true); // the control polygon's apex (0.5, 1)
    expect(list.dots.filter((d) => d.hollow)).toHaveLength(4); // three poles and one knot
  });

  it("widens lines by half in presentation mode and more when highlighted", () => {
    const c = obj("C", { type: "circle", frame, r: 1 });
    expect(buildDrawList([c], cam, opts({ widthScale: 1.5 })).strokes[0].width).toBe(3.75);
    expect(buildDrawList([c], cam, opts({ widthScale: 1.5, highlight: "C" })).strokes[0].width).toBe(5.25);
  });

  it("honours the style's width, dashes and opacity", () => {
    const c = obj("C", { type: "circle", frame, r: 1 }, { style: { width: 4, dashed: true, opacity: 0.5 } });
    const [stroke] = buildDrawList([c], cam, opts()).strokes;
    expect(stroke.width).toBe(4);
    expect(stroke.alpha).toBe(0.5);
    expect(stroke.paths.length).toBeGreaterThan(40); // 628 px of circle in 12 px periods
  });

  it("puts highlighted labels first, then text, points, curves, extras", () => {
    const objects = [
      obj("C", { type: "circle", frame, r: 1 }),
      obj("P", { type: "point", p: [2, 0, 0] }),
      obj("T", { type: "text", at: [0, 2, 0], text: "hello" }),
    ];
    expect(buildDrawList(objects, cam, opts()).texts.map((t) => t.id)).toEqual(["T", "P", "C"]);
    expect(buildDrawList(objects, cam, opts({ highlight: "C" })).texts.map((t) => t.id)).toEqual(["C", "T", "P"]);
  });

  it("highlights the selected object when it is not hovered, its label first", () => {
    const objects = [
      obj("C", { type: "circle", frame, r: 1 }),
      obj("P", { type: "point", p: [2, 0, 0] }),
      obj("T", { type: "text", at: [0, 2, 0], text: "hello" }),
    ];
    const curve = buildDrawList(objects, cam, opts({ selected: "C" }));
    expect(curve.strokes[0].width).toBe(4);
    expect(curve.texts.map((t) => t.id)).toEqual(["C", "T", "P"]);
    const point = buildDrawList(objects, cam, opts({ selected: "P", highlight: "C" }));
    expect(point.strokes[0].width).toBe(4); // hovered
    expect(point.dots[0].radius).toBe(6); // selected
    expect(point.texts.map((t) => t.id)).toEqual(["C", "P", "T"]);
  });

  it("gives pickables with curve parameters", () => {
    const list = buildDrawList([obj("C", { type: "circle", frame, r: 1 })], cam, opts());
    const [line] = list.pickables[0].polylines;
    expect(line.ts).not.toBeNull();
    expect(line.ts!.length).toBe(line.pts.length);
  });
});

describe("describeHit", () => {
  it("shows a point's label, type, coordinates and params", () => {
    const p = obj("P₁", { type: "point", p: [1.84, 1.62, 0] }, { label: "P₁", meta: { params: [0.785398, 2.1] } });
    expect(describeHit(p, { id: "P₁", dist: 0, at: [0, 0], t: null, index: 0 }, cam)).toEqual([
      "P₁ · point",
      "(1.84, 1.62)",
      "params (0.7854, 2.1)",
    ]);
  });

  it("shows a curve's parameter and the point there", () => {
    const c = obj("C", { type: "circle", frame, r: 1 });
    expect(describeHit(c, { id: "C", dist: 1, at: [400, 200], t: Math.PI / 2, index: null }, cam)).toEqual([
      "C · circle",
      "t = 1.5708",
      "(0, 1)",
    ]);
  });
});
