import { halfSize } from "./bounds";
import { clipCurveBox } from "./clip";
import { evalCurve } from "./curves";
import { Sampled, sampleAdaptive } from "./sample";
import { evalSurface, surfaceWindow } from "./surfaces";
import type { CurveGeom, Range, SurfaceGeom } from "./types";
import { Box, Vec3, add, cross, norm, scale, sub } from "./vec";

/** Chord tolerance of the 3D view, as a fraction of the view box's half-size (≈ 0.1 px when the scene fills the pane). */
export const WORLD_TOL = 1.25e-4;
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
    case "bspline_surface":
      nu = bsplineSegments(g.u_knots, u);
      nv = bsplineSegments(g.v_knots, v);
      break;
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

/** Segments along a B-spline direction: eight per knot span in the window, within reason. */
function bsplineSegments(knots: number[], w: Range): number {
  const spans = knots.filter((k) => k > w[0] && k < w[1]).length + 1;
  return Math.min(MAX_SEGMENTS, Math.max(16, 8 * spans));
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

/** An axis-aligned box's twelve edges, as two-point paths (either corner may be the smaller one). */
export function boxEdges(a: Vec3, b: Vec3): Vec3[][] {
  const lo: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const hi: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  const c = (x: number, y: number, z: number): Vec3 => [x ? hi[0] : lo[0], y ? hi[1] : lo[1], z ? hi[2] : lo[2]];
  const corners = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  return edges.map(([i, j]) => [corners[i], corners[j]]);
}
