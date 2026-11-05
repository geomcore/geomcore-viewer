import { evalCurve } from "./curves";
import type { ProfileCurve, Range, SurfaceGeom } from "./types";
import { Vec3, inFrame } from "./vec";

const TAU = 2 * Math.PI;

/** Where parameter `t` falls along a polyline profile, in point index (segment i is [i, i + 1]). */
function polylineIndex(profile: Extract<ProfileCurve, { type: "polyline" }>, t: number): number {
  if (!profile.range) return t;
  const [t0, t1] = profile.range;
  return ((t - t0) / (t1 - t0)) * (profile.points.length - 1);
}

/** A profile curve's point at parameter `t`; a polyline's points are spaced evenly over its `range`. */
export function evalProfile(profile: ProfileCurve, t: number): Vec3 {
  if (profile.type !== "polyline") return evalCurve(profile, t);
  const index = polylineIndex(profile, t);
  const i = Math.max(0, Math.min(Math.floor(index), profile.points.length - 2));
  const [a, b] = [profile.points[i], profile.points[i + 1]];
  const s = index - i;
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

/** Rotate `p` about the axis through `o` along `d` by `angle` (Rodrigues' formula). */
function rotateAbout(p: Vec3, o: Vec3, d: Vec3, angle: number): Vec3 {
  const n = Math.hypot(d[0], d[1], d[2]);
  if (n === 0) return p;
  const [x, y, z] = [d[0] / n, d[1] / n, d[2] / n];
  const [px, py, pz] = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = (x * px + y * py + z * pz) * (1 - c);
  return [
    o[0] + px * c + (y * pz - z * py) * s + x * k,
    o[1] + py * c + (z * px - x * pz) * s + y * k,
    o[2] + pz * c + (x * py - y * px) * s + z * k,
  ];
}

/** Point at `(u, v)` — formulas identical to geomcore (protocol/SCENE.md). */
export function evalSurface(g: SurfaceGeom, u: number, v: number): Vec3 {
  switch (g.type) {
    case "plane":
      return inFrame(g.frame, u, v);
    case "cylinder":
      return inFrame(g.frame, g.r * Math.cos(u), g.r * Math.sin(u), v);
    case "cone": {
      const radius = g.ref_radius + v * Math.sin(g.semi_angle);
      return inFrame(g.frame, radius * Math.cos(u), radius * Math.sin(u), v * Math.cos(g.semi_angle));
    }
    case "sphere": {
      const rc = g.r * Math.cos(v);
      return inFrame(g.frame, rc * Math.cos(u), rc * Math.sin(u), g.r * Math.sin(v));
    }
    case "torus": {
      const rho = g.R + g.r * Math.cos(v);
      return inFrame(g.frame, rho * Math.cos(u), rho * Math.sin(u), g.r * Math.sin(v));
    }
    case "extrusion": {
      const p = evalProfile(g.profile, u);
      return [p[0] + v * g.direction[0], p[1] + v * g.direction[1], p[2] + v * g.direction[2]];
    }
    case "revolution":  // u is the angle, v the profile's parameter (geomcore's convention)
      return rotateAbout(evalProfile(g.profile, v), g.origin, g.direction, u);
  }
}

/** A profile's own parameter window when it is finite: a full turn for a conic, a polyline's range. */
function profileWindow(profile: ProfileCurve): Range | null {
  if (profile.type === "polyline") return profile.range ?? [0, profile.points.length - 1];
  if (profile.type === "circle" || profile.type === "ellipse") return [0, TAU];
  return null;
}

/** A profile's period when its parameter wraps, else null. */
function profilePeriod(profile: ProfileCurve): number | null {
  return profile.type === "circle" || profile.type === "ellipse" ? TAU : null;
}

/** Full periods of closed parameter directions; null where the surface is infinite. */
export function naturalWindow(g: SurfaceGeom): { u: Range | null; v: Range | null } {
  switch (g.type) {
    case "plane":
      return { u: null, v: null };
    case "cylinder":
    case "cone":
      return { u: [0, TAU], v: null };
    case "sphere":
      return { u: [0, TAU], v: [-Math.PI / 2, Math.PI / 2] };
    case "torus":
      return { u: [0, TAU], v: [0, TAU] };
    case "extrusion":
      return { u: profileWindow(g.profile), v: null };
    case "revolution":
      return { u: [0, TAU], v: profileWindow(g.profile) };
  }
}

/** The period of each parameter direction that wraps around (2π), null for one that does not. */
export function periods(g: SurfaceGeom): { u: number | null; v: number | null } {
  switch (g.type) {
    case "plane":
      return { u: null, v: null };
    case "cylinder":
    case "cone":
    case "sphere":
      return { u: TAU, v: null };
    case "torus":
      return { u: TAU, v: TAU };
    case "extrusion":
      return { u: profilePeriod(g.profile), v: null };
    case "revolution":
      return { u: TAU, v: profilePeriod(g.profile) };
  }
}

/** Window to tessellate: explicit, else natural, else ±fallbackHalf (`assumed` = a fallback was used). */
export function surfaceWindow(g: SurfaceGeom, fallbackHalf: number): { u: Range; v: Range; assumed: boolean } {
  const natural = naturalWindow(g);
  const fallback = (direction: "u" | "v"): Range => {
    const half = parameterHalfRange(g, direction, fallbackHalf);
    return [-half, half];
  };
  const u = g.window?.u ?? natural.u;
  const v = g.window?.v ?? natural.v;
  return { u: u ?? fallback("u"), v: v ?? fallback("v"), assumed: u === null || v === null };
}

/**
 * Half-range of parameter that keeps an infinite direction within about `extent` of its origin.
 * The parameter is a length for a plane, a cylinder or a cone; a swept profile's or sweep's is
 * not, so it is scaled (a hyperbola grows like exp(t)). Mirrors `_parameter_half_range` in adapt.py.
 */
export function parameterHalfRange(g: SurfaceGeom, direction: "u" | "v", extent: number): number {
  if (g.type === "extrusion" && direction === "v") return extent / Math.max(Math.hypot(...g.direction), 1e-300);
  const sweepsProfile = (g.type === "extrusion" && direction === "u") || (g.type === "revolution" && direction === "v");
  if (!sweepsProfile) return extent;
  const profile = g.profile;
  switch (profile.type) {
    case "line":
      return extent / Math.max(Math.hypot(...profile.d), 1e-300);
    case "parabola": // y = t, x = t² / 4f
      return Math.min(extent, 2 * Math.sqrt(Math.abs(profile.f) * extent));
    case "hyperbola": // (a cosh t, b sinh t)
      return Math.asinh(extent / Math.max(profile.a, profile.b));
    default:
      return extent;
  }
}
