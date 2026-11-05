import { halfSize } from "./bounds";
import { clipCurveBox } from "./clip";
import { evalCurve } from "./curves";
import { Sampled, sampleAdaptive } from "./sample";
import { evalProfile, evalSurface, surfaceWindow } from "./surfaces";
import type { CurveGeom, ProfileCurve, Range, SurfaceGeom } from "./types";
import { Box, Vec3, add, cross, norm, scale, sub } from "./vec";

/** Chord tolerance of the 3D view, as a fraction of the view box's half-size (≈ 0.4 px when the scene fills the pane). */
export const WORLD_TOL = 5e-4;
/** Most segments along one parameter direction of a surface. */
export const MAX_SEGMENTS = 256;
/** Fewest segments per full turn of a curved direction, however coarse the tolerance. */
export const MIN_PER_TURN = 16;

const TAU = 2 * Math.PI;

/** The curve's pieces inside `box` (spec §5.3: the view box is the scene's ×1.5), clipped in closed form and sampled to `tol`. */
export function curvePieces(g: CurveGeom, box: Box, tol = WORLD_TOL * halfSize(box)): Sampled<Vec3>[] {
  return clipCurveBox(g, box).map(([a, b]) => sampleAdaptive((t) => evalCurve(g, t), a, b, tol));
}

/** Segments for an arc of `span` radians on a circle of `radius`, each chord's sagitta ≤ `tol`. */
export function arcSegments(span: number, radius: number, tol: number): number {
  const step = 2 * Math.acos(Math.max(-1, 1 - tol / radius));
  const turns = Math.abs(span) / TAU;
  return Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(Math.abs(span) / step), Math.ceil(turns * MIN_PER_TURN)));
}

/** A surface's parameter window and how finely it is cut (spec §5.3: curvature-based density). */
export interface SurfaceGrid {
  u: Range;
  v: Range;
  nu: number;
  nv: number;
  /** True when an infinite direction had no window and fell back to ±fallbackHalf. */
  assumed: boolean;
}

/**
 * Segments along a profile's parameter: a polyline's index space needs one per segment, a line
 * one, conics enough for their arc, the unbounded conics a fixed density.
 */
function profileSegments(profile: ProfileCurve, span: number, tol: number): number {
  switch (profile.type) {
    case "line":
      return 1;
    case "circle":
      return arcSegments(span, profile.r, tol);
    case "ellipse":
      return arcSegments(span, Math.max(profile.a, profile.b), tol);
    case "polyline":
      return Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(Math.abs(span))));
    default:
      return Math.min(MAX_SEGMENTS, Math.max(MIN_PER_TURN, Math.ceil(Math.abs(span) * 8)));
  }
}

/** Greatest distance of the profile from the revolution axis over the v window, for the u density. */
function revolutionRadius(g: Extract<SurfaceGeom, { type: "revolution" }>, v: Range): number {
  const [dx, dy, dz] = g.direction;
  const n = Math.hypot(dx, dy, dz);
  if (n === 0) return 0;
  const [x, y, z] = [dx / n, dy / n, dz / n];
  let max = 0;
  for (let i = 0; i <= 16; i++) {
    const p = evalProfile(g.profile, v[0] + ((v[1] - v[0]) * i) / 16);
    const [wx, wy, wz] = [p[0] - g.origin[0], p[1] - g.origin[1], p[2] - g.origin[2]];
    const along = x * wx + y * wy + z * wz;
    max = Math.max(max, Math.hypot(wx - along * x, wy - along * y, wz - along * z));
  }
  return max;
}

/**
 * The window to draw (explicit, natural, else ±fallbackHalf) and the segments per direction:
 * a straight direction (plane u and v, cylinder and cone v) needs one, a curved one as many
 * as keep the chord within `tol` of its widest circle.
 */
export function surfaceGrid(g: SurfaceGeom, fallbackHalf: number, tol: number): SurfaceGrid {
  const { u, v, assumed } = surfaceWindow(g, fallbackHalf);
  const du = u[1] - u[0];
  const dv = v[1] - v[0];
  let nu = 1;
  let nv = 1;
  switch (g.type) {
    case "cylinder":
      nu = arcSegments(du, g.r, tol);
      break;
    case "cone": {
      const ring = (t: number) => Math.abs(g.ref_radius + t * Math.sin(g.semi_angle));
      nu = arcSegments(du, Math.max(ring(v[0]), ring(v[1])), tol);
      break;
    }
    case "sphere":
      nu = arcSegments(du, g.r, tol);
      nv = arcSegments(dv, g.r, tol);
      break;
    case "torus":
      nu = arcSegments(du, g.R + g.r, tol);
      nv = arcSegments(dv, g.r, tol);
      break;
    case "extrusion":
      nu = profileSegments(g.profile, du, tol);
      break;
    case "revolution": {
      nu = arcSegments(du, revolutionRadius(g, v), tol);
      nv = profileSegments(g.profile, dv, tol);
      break;
    }
  }
  return { u, v, nu, nv, assumed };
}

export interface TriMesh {
  positions: number[];
  indices: number[];
  /** Each vertex's (u, v), normalized to [0, 1] across the window (picking interpolates them). */
  uvs: number[];
}

const at = (r: Range, s: number): number => r[0] + (r[1] - r[0]) * s;

/** Grid triangulation of the surface: (nu + 1) × (nv + 1) vertices, row by row in v. */
export function tessellateSurface(g: SurfaceGeom, grid: SurfaceGrid): TriMesh {
  const { nu, nv } = grid;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      positions.push(...evalSurface(g, at(grid.u, i / nu), at(grid.v, j / nv)));
      uvs.push(i / nu, j / nv);
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const c = a + nu + 1;
      indices.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  return { positions, indices, uvs };
}

/** Curve of constant u (sampled at the grid's v steps), or of constant v. */
function isoU(g: SurfaceGeom, grid: SurfaceGrid, u: number): Vec3[] {
  return Array.from({ length: grid.nv + 1 }, (_, j) => evalSurface(g, u, at(grid.v, j / grid.nv)));
}
function isoV(g: SurfaceGeom, grid: SurfaceGrid, v: number): Vec3[] {
  return Array.from({ length: grid.nu + 1 }, (_, i) => evalSurface(g, at(grid.u, i / grid.nu), v));
}

/** `isolines: [nu, nv]` (spec §4.2): nu curves of constant u, then nv of constant v, each in the middle of its cell. */
export function isoLines(g: SurfaceGeom, grid: SurfaceGrid, nu: number, nv: number): Vec3[][] {
  const us = Array.from({ length: nu }, (_, i) => at(grid.u, (i + 0.5) / nu));
  const vs = Array.from({ length: nv }, (_, j) => at(grid.v, (j + 0.5) / nv));
  return [...us.map((u) => isoU(g, grid, u)), ...vs.map((v) => isoV(g, grid, v))];
}

/** The window's four edges (u = u0, u1, then v = v0, v1), leaving out edges that collapse to a point (a sphere's poles). */
export function windowEdges(g: SurfaceGeom, grid: SurfaceGrid): Vec3[][] {
  const edges = [isoU(g, grid, grid.u[0]), isoU(g, grid, grid.u[1]), isoV(g, grid, grid.v[0]), isoV(g, grid, grid.v[1])];
  return edges.filter((line) => line.some((p) => norm(sub(p, line[0])) > 1e-12 * Math.max(1, norm(line[0]))));
}

/** Shaft plus two head strokes (15 % of the length), in a plane containing the arrow. */
export function arrowPolylines(at: Vec3, vec: Vec3): Vec3[][] {
  const tip = add(at, vec);
  const length = norm(vec);
  if (length === 0) return [[at, tip]];
  const dir = scale(vec, 1 / length);
  const helper: Vec3 = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const side = cross(dir, helper);
  const sideUnit = scale(side, (0.08 * length) / norm(side));
  const back = sub(tip, scale(dir, 0.15 * length));
  return [[at, tip], [tip, add(back, sideUnit)], [tip, sub(back, sideUnit)]];
}
