import { describe, expect, it } from "vitest";
import { VersionError, parseDoc, parseObject } from "../src/protocol";

const frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

describe("parseObject", () => {
  it("accepts a valid analytic object and pads 2D vectors", () => {
    const r = parseObject({ id: "L", label: "L", geom: { type: "line", o: [0, 1], d: [1, 0] } });
    expect(r).toEqual({ object: { id: "L", label: "L", geom: { type: "line", o: [0, 1, 0], d: [1, 0, 0] } } });
  });

  it("accepts a box and pads 2D corners", () => {
    const r = parseObject({ id: "B", geom: { type: "box", min: [0, 0], max: [1, 2, 3] } });
    expect(r).toEqual({ object: { id: "B", geom: { type: "box", min: [0, 0, 0], max: [1, 2, 3] } } });
  });

  it("accepts exact B-splines", () => {
    const curve = parseObject({
      id: "C",
      geom: { type: "bspline_curve", degree: 3, poles: [[0, 0, 0], [1, 2, 0], [3, 2, 1], [4, 0, 0]],
              knots: [0, 1], multiplicities: [4, 4], periodic: false, range: [0, 0.5] },
    });
    expect("object" in curve && curve.object.geom).toEqual({
      type: "bspline_curve", degree: 3, poles: [[0, 0, 0], [1, 2, 0], [3, 2, 1], [4, 0, 0]],
      knots: [0, 1], multiplicities: [4, 4], periodic: false, range: [0, 0.5],
    });
    const surface = parseObject({
      id: "S",
      geom: { type: "bspline_surface", u_degree: 1, v_degree: 1, nu: 2, nv: 2,
              poles: [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 1]],
              u_knots: [0, 1], u_multiplicities: [2, 2], v_knots: [0, 1], v_multiplicities: [2, 2],
              u_periodic: false, v_periodic: false },
    });
    expect("object" in surface).toBe(true);
  });

  it.each([
    [{ geom: { type: "point", p: [0, 0, 0] } }, "?", "missing string id"],
    [{ id: "a", geom: { type: "foo" } }, "a", 'unknown type "foo"'],
    [{ id: "a", geom: { type: "circle", frame, r: -1 } }, "a", "circle.r must be positive"],
    [{ id: "a", geom: { type: "parabola", frame, f: 0 } }, "a", "parabola.f must be non-zero"],
    [{ id: "a", geom: { type: "ellipse", frame, a: 1 } }, "a", "ellipse.b is missing or malformed"],
    [{ id: "a", geom: { type: "mesh", vertices: [[0, 0, 0]], indices: [0, 0] } }, "a", "mesh.indices must be triangles indexing vertices"],
    [{ id: "a", geom: { type: "line", o: [0, 0, 0], d: [1, 0, 0], range: [1] } }, "a", "line.range must be [t0, t1]"],
    [{ id: "a", geom: { type: "point", p: [0, NaN, 0] } }, "a", "point.p is missing or malformed"],
    [{ id: "a", geom: { type: "line", o: [0, 0, 0], d: [0, 0, 0] } }, "a", "line.d must be non-zero"],
    [{ id: "a", geom: { type: "plane", frame, window: { u: [1] } } }, "a", "plane.window must be {u?: [a, b], v?: [a, b]}"],
    [{ id: "a", geom: { type: "polyline", points: [] } }, "a", "polyline.points needs at least 2 points"],
    [{ id: "a", geom: { type: "polyline", points: [[0, 0, 0]] } }, "a", "polyline.points needs at least 2 points"],
    [{ id: "a", geom: { type: "points", positions: [] } }, "a", "points.positions must not be empty"],
    [{ id: "a", geom: { type: "mesh", vertices: [[0, 0, 0]], indices: [] } }, "a", "mesh.indices must be a non-empty multiple of 3"],
    [{ id: "a", geom: { type: "box", min: [0, 0, 0] } }, "a", "box.max is missing or malformed"],
    [{ id: "a", geom: { type: "bspline_curve", degree: 0, poles: [[0, 0, 0], [1, 0, 0]], knots: [0, 1], multiplicities: [2, 2], periodic: false } }, "a", "bspline_curve.degree must be an integer of at least 1"],
    [{ id: "a", geom: { type: "bspline_curve", degree: 1, poles: [[0, 0, 0], [1, 0, 0]], knots: [0, 1], multiplicities: [2, 1], periodic: false } }, "a", "bspline_curve holds 2 poles but its knots describe 1"],
    [{ id: "a", geom: { type: "bspline_curve", degree: 1, poles: [[0, 0, 0], [1, 0, 0]], weights: [1], knots: [0, 1], multiplicities: [2, 2], periodic: false } }, "a", "bspline_curve.weights must hold one weight per pole"],
    [{ id: "a", geom: { type: "bspline_curve", degree: 1, poles: [[0, 0, 0], [1, 0, 0]], weights: [1, 0], knots: [0, 1], multiplicities: [2, 2], periodic: false } }, "a", "bspline_curve.weights must be positive"],
    [{ id: "a", geom: { type: "bspline_surface", u_degree: 1, v_degree: 1, nu: 1, nv: 2, poles: [[0, 0, 0], [0, 1, 0]], u_knots: [0, 1], u_multiplicities: [2, 2], v_knots: [0, 1], v_multiplicities: [2, 2], u_periodic: false, v_periodic: false } }, "a", "bspline_surface.u needs at least 2 poles"],
    [{ id: "a", geom: { type: "constructor" } }, "a", 'unknown type "constructor"'],
    [{ id: "a", geom: { type: "pcurve", curve: { type: "line", o: [0, 0], d: [1, 0] } } }, "a", "pcurve.surface must be an object id"],
    [{ id: "a", geom: { type: "pcurve", surface: "Y", curve: { type: "ellipse", frame, a: 2, b: 1 } } }, "a", "pcurve.curve must be a line, circle or polyline"],
    [{ id: "a", geom: { type: "pcurve", surface: "Y" } }, "a", "pcurve.curve must be a line, circle or polyline"],
    [{ id: "a", geom: { type: "pcurve", surface: "Y", curve: { type: "circle", frame, r: 0 } } }, "a", "pcurve.circle.r must be positive"],
    [{ id: "a", geom: { type: "pcurve", surface: "Y", curve: { type: "line", o: [0, 0, 1], d: [1, 0, 0] } } }, "a", "pcurve.curve must lie in z = 0 (x is u, y is v)"],
  ])("rejects %j", (raw, id, message) => {
    expect(parseObject(raw)).toEqual({ problem: { id, message } });
  });
});

describe("pcurve", () => {
  it("accepts a (u, v) line, circle or polyline and pads 2D vectors", () => {
    const line = parseObject({ id: "c", geom: { type: "pcurve", surface: "Y", curve: { type: "line", o: [0, 3], d: [1, 0], range: [0, 6] } } });
    expect(line).toEqual({
      object: { id: "c", geom: { type: "pcurve", surface: "Y", curve: { type: "line", o: [0, 3, 0], d: [1, 0, 0], range: [0, 6] } } },
    });
    const circle = parseObject({ id: "d", geom: { type: "pcurve", surface: "P", curve: { type: "circle", frame, r: 1 } } });
    expect("object" in circle && circle.object.geom).toMatchObject({ type: "pcurve", curve: { type: "circle", r: 1 } });
    const poly = parseObject({ id: "e", geom: { type: "pcurve", surface: "P", curve: { type: "polyline", points: [[0, 0], [1, 2]] } } });
    expect("object" in poly && poly.object.geom).toEqual({ type: "pcurve", surface: "P", curve: { type: "polyline", points: [[0, 0, 0], [1, 2, 0]] } });
  });

  it("accepts a clockwise (u, v) circle, whose frame z is -z", () => {
    const cw = { ...frame, y: [0, -1, 0], z: [0, 0, -1] };
    expect("object" in parseObject({ id: "c", geom: { type: "pcurve", surface: "Y", curve: { type: "circle", frame: cw, r: 1 } } })).toBe(true);
  });
});

describe("parseDoc", () => {
  it("migrates v1 entities", () => {
    const { doc, problems } = parseDoc({
      version: 1,
      entities: [
        { id: "c", kind: "curve2d", name: "pc", color: "#f00", points: [[0, 0], [1, 1]] },
        { id: "s", kind: "surface", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], indices: [0, 1, 2], opacity: 0.5 },
        { id: "q", kind: "points3d", positions: [[0, 0, 0]], size: 3 },
        { id: "x", kind: "hologram" },
      ],
    });
    expect(doc.objects[0]).toEqual({ id: "c", label: "pc", style: { color: "#f00" }, geom: { type: "polyline", points: [[0, 0, 0], [1, 1, 0]] } });
    expect(doc.objects[1].style).toEqual({ opacity: 0.5 });
    expect(doc.objects[2].geom).toEqual({ type: "points", positions: [[0, 0, 0]], size: 3 });
    expect(problems).toEqual([{ id: "x", message: 'unknown type "v1:hologram"' }]);
  });

  it("reads v2 metadata and rejects other versions", () => {
    const { doc } = parseDoc({ version: 2, title: "t", run: "r", view: "2d", objects: [] });
    expect(doc).toEqual({ version: 2, title: "t", run: "r", view: "2d", objects: [] });
    expect(() => parseDoc({ version: 3, objects: [] })).toThrow(VersionError);
  });
});
