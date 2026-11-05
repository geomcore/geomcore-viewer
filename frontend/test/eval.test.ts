import { describe, expect, it } from "vitest";
import curves from "./fixtures/curves_analytic.json";
import surfaces from "./fixtures/surfaces_analytic.json";
import { evalCurve } from "../src/geom/curves";
import { evalSurface, surfaceWindow } from "../src/geom/surfaces";
import type { CurveGeom, SurfaceGeom } from "../src/geom/types";
import { Frame, Vec3, norm, sub } from "../src/geom/vec";

type FxFrame = { origin: Vec3; x_dir: Vec3; y_dir: Vec3; z_dir: Vec3 };
type CurveSample = { u: number; point: Vec3 };
type SurfaceSample = { u: number; v: number; point: Vec3 };
const frame = (f: FxFrame): Frame => ({ o: f.origin, x: f.x_dir, y: f.y_dir, z: f.z_dir });

function expectClose(got: Vec3, want: Vec3): void {
  expect(norm(sub(got, want))).toBeLessThanOrEqual(1e-9 * Math.max(1, norm(want)));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const curveCases: [string, CurveGeom, CurveSample[]][] = [
  ...curves.lines.map((c: any): [string, CurveGeom, CurveSample[]] => ["line", { type: "line", o: c.origin, d: c.direction }, c.samples]),
  ...curves.circles.map((c: any): [string, CurveGeom, CurveSample[]] => ["circle", { type: "circle", frame: frame(c.frame), r: c.radius }, c.samples]),
  ...curves.ellipses.map((c: any): [string, CurveGeom, CurveSample[]] => ["ellipse", { type: "ellipse", frame: frame(c.frame), a: c.major_radius, b: c.minor_radius }, c.samples]),
  ...curves.parabolas.map((c: any): [string, CurveGeom, CurveSample[]] => ["parabola", { type: "parabola", frame: frame(c.frame), f: c.focal }, c.samples]),
  ...curves.hyperbolas.map((c: any): [string, CurveGeom, CurveSample[]] => ["hyperbola", { type: "hyperbola", frame: frame(c.frame), a: c.major_radius, b: c.minor_radius }, c.samples]),
];

const surfaceCases: [string, SurfaceGeom, SurfaceSample[]][] = [
  ...surfaces.planes.map((c: any): [string, SurfaceGeom, SurfaceSample[]] => ["plane", { type: "plane", frame: frame(c.frame) }, c.samples]),
  ...surfaces.cylinders.map((c: any): [string, SurfaceGeom, SurfaceSample[]] => ["cylinder", { type: "cylinder", frame: frame(c.frame), r: c.radius }, c.samples]),
  ...surfaces.cones.map((c: any): [string, SurfaceGeom, SurfaceSample[]] => ["cone", { type: "cone", frame: frame(c.frame), semi_angle: c.semi_angle, ref_radius: c.ref_radius }, c.samples]),
  ...surfaces.spheres.map((c: any): [string, SurfaceGeom, SurfaceSample[]] => ["sphere", { type: "sphere", frame: frame(c.frame), r: c.radius }, c.samples]),
  ...surfaces.tori.map((c: any): [string, SurfaceGeom, SurfaceSample[]] => ["torus", { type: "torus", frame: frame(c.frame), R: c.major_radius, r: c.minor_radius }, c.samples]),
];
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("evalCurve matches geomcore goldens", () => {
  it.each(curveCases)("%s", (_name, g, samples) => {
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) expectClose(evalCurve(g, s.u), s.point);
  });
});

describe("evalSurface matches geomcore goldens", () => {
  it.each(surfaceCases)("%s", (_name, g, samples) => {
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) expectClose(evalSurface(g, s.u, s.v), s.point);
  });
});

const world: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

describe("profile surfaces", () => {
  it("extrudes its profile along the direction", () => {
    const g: SurfaceGeom = { type: "extrusion", profile: { type: "line", o: [1, 0, 0], d: [0, 0, 1] }, direction: [0, 1, 0] };
    expect(evalSurface(g, 1.5, 0.25)).toEqual([1, 0.25, 1.5]);
    const circle: CurveGeom = { type: "circle", frame: world, r: 2 };
    const cylinder = evalSurface({ type: "extrusion", profile: circle, direction: [0, 0, 1] }, Math.PI / 2, 3);
    expectClose(cylinder, [0, 2, 3]);
  });

  it("revolves its profile about the axis with u as the angle", () => {
    const profile: CurveGeom = { type: "line", o: [1, 0, 2], d: [0, 0, 1] };
    const g: SurfaceGeom = { type: "revolution", profile, origin: [0, 0, 0], direction: [0, 0, 1] };
    expectClose(evalSurface(g, Math.PI / 2, 0), [0, 1, 2]);
    expectClose(evalSurface(g, Math.PI, 1), [-1, 0, 3]);
  });

  it("evaluates a polyline profile by point index, as a pcurve does", () => {
    const profile = { type: "polyline" as const, points: [[0, 0, 0], [2, 0, 0], [2, 3, 0]] as Vec3[] };
    expect(evalSurface({ type: "extrusion", profile, direction: [0, 0, 1] }, 1.5, 4)).toEqual([2, 1.5, 4]);
  });

  it("windows a revolution over a full turn and its profile's own range", () => {
    const circle: CurveGeom = { type: "circle", frame: world, r: 1 };
    expect(surfaceWindow({ type: "revolution", profile: circle, origin: [0, 0, 0], direction: [0, 0, 1] }, 5)).toEqual({
      u: [0, 2 * Math.PI], v: [0, 2 * Math.PI], assumed: false,
    });
    expect(surfaceWindow({ type: "extrusion", profile: { type: "line", o: [1, 0, 0], d: [0, 0, 1] }, direction: [0, 1, 0] }, 5)).toEqual({
      u: [-5, 5], v: [-5, 5], assumed: true,
    });
  });
});


describe("surfaceWindow", () => {
  it("fills full periods and flags assumed infinite directions", () => {
    expect(surfaceWindow({ type: "sphere", frame: world, r: 1 }, 5)).toEqual({ u: [0, 2 * Math.PI], v: [-Math.PI / 2, Math.PI / 2], assumed: false });
    expect(surfaceWindow({ type: "plane", frame: world }, 5)).toEqual({ u: [-5, 5], v: [-5, 5], assumed: true });
    expect(surfaceWindow({ type: "cylinder", frame: world, r: 1, window: { v: [0, 2] } }, 5)).toEqual({ u: [0, 2 * Math.PI], v: [0, 2], assumed: false });
  });
});
