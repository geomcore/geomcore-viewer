import { evalSurface } from "./surfaces";
import type { SurfaceGrid } from "./tessellate";
import type { SurfaceGeom } from "./types";
import { Vec3, cross, dot, norm, scale, sub } from "./vec";

/** Where the camera is and where it looks: an orthographic silhouette depends on the direction only. */
export interface Viewpoint {
  eye: Vec3;
  forward: Vec3;
  ortho: boolean;
}

/** Most cells along one direction of the grid the silhouette is contoured on. */
export const SILHOUETTE_MAX = 96;
const SILHOUETTE_MIN = 8;
/** Steps of the false-position refinement of one crossing. */
const MAX_STEPS = 40;

type Uv = [number, number];

/**
 * The surface's silhouette from `view` (spec §3.3): where the normal turns side-on to the
 * line of sight, `n̂ · (S − eye) = 0` (`n̂ · forward = 0` in orthographic). Marching squares on
 * the sign of that field over the window, each crossing refined on its grid edge, chained
 * into polylines; pieces whose ends meet within `tol` (across a periodic seam) are joined.
 */
export function silhouette(g: SurfaceGeom, grid: SurfaceGrid, view: Viewpoint, tol: number): Vec3[][] {
  const nu = Math.min(SILHOUETTE_MAX, Math.max(SILHOUETTE_MIN, grid.nu));
  const nv = Math.min(SILHOUETTE_MAX, Math.max(SILHOUETTE_MIN, grid.nv));
  const [u0, u1] = grid.u;
  const [v0, v1] = grid.v;
  const du = (u1 - u0) / nu;
  const dv = (v1 - v0) / nv;
  const field = sideOn(g, view, grid);
  const uvAt = (i: number, j: number): Uv => [u0 + i * du, v0 + j * dv];

  const f: number[] = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) f.push(field(...uvAt(i, j)));
  const at = (i: number, j: number) => f[j * (nu + 1) + i];

  // Crossings by edge: horizontal edges (i, j)–(i + 1, j) first, then vertical ones (i, j)–(i, j + 1).
  const crossings = new Map<number, Vec3>();
  const horizontal = (i: number, j: number) => j * nu + i;
  const vertical = (i: number, j: number) => (nv + 1) * nu + j * (nu + 1) + i;
  const crossing = (key: number, a: Uv, b: Uv, fa: number, fb: number): number => {
    if (!crossings.has(key)) {
      const s = refine((s) => field(a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])), fa, fb);
      crossings.set(key, evalSurface(g, a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])));
    }
    return key;
  };

  const segments: [number, number][] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const corners: [number, number][] = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      const values = corners.map(([ci, cj]) => at(ci, cj));
      const keys = [horizontal(i, j), vertical(i + 1, j), horizontal(i, j + 1), vertical(i, j)];
      const cut: (number | null)[] = keys.map((key, e) => {
        const [a, b] = [e, (e + 1) % 4];
        if (values[a] >= 0 === values[b] >= 0) return null;
        return crossing(key, uvAt(...corners[a]), uvAt(...corners[b]), values[a], values[b]);
      });
      const hit = cut.filter((k): k is number => k !== null);
      if (hit.length === 2) {
        segments.push([hit[0], hit[1]]);
      } else if (hit.length === 4) {
        // A saddle: the centre's side says which pair of corners the contour separates.
        const centre = field(u0 + (i + 0.5) * du, v0 + (j + 0.5) * dv);
        if (centre >= 0 === values[0] >= 0) segments.push([cut[0]!, cut[1]!], [cut[2]!, cut[3]!]);
        else segments.push([cut[3]!, cut[0]!], [cut[1]!, cut[2]!]);
      }
    }
  }
  const lines = chain(segments).map((keys) => keys.map((k) => crossings.get(k)!));
  return joinEnds(lines, tol).filter((line) => line.length >= 2);
}

/** The side-on field: the unit normal against the line of sight, the normal taken a hair inside where it vanishes (a pole, an apex). */
function sideOn(g: SurfaceGeom, view: Viewpoint, grid: SurfaceGrid): (u: number, v: number) => number {
  const hu = (grid.u[1] - grid.u[0]) * 1e-6;
  const hv = (grid.v[1] - grid.v[0]) * 1e-6;
  const uc = (grid.u[0] + grid.u[1]) / 2;
  const vc = (grid.v[0] + grid.v[1]) / 2;
  const normal = (u: number, v: number): { n: Vec3; degenerate: boolean } => {
    const su = scale(sub(evalSurface(g, u + hu, v), evalSurface(g, u - hu, v)), 1 / (2 * hu));
    const sv = scale(sub(evalSurface(g, u, v + hv), evalSurface(g, u, v - hv)), 1 / (2 * hv));
    const n = cross(su, sv);
    const size = norm(n);
    const reach = (norm(su) + norm(sv)) ** 2;
    return { n: size > 0 ? scale(n, 1 / size) : n, degenerate: size <= 1e-9 * reach };
  };
  return (u, v) => {
    let { n, degenerate } = normal(u, v);
    if (degenerate) n = normal(u + 1e-4 * (uc - u), v + 1e-4 * (vc - v)).n;
    return dot(n, view.ortho ? view.forward : sub(evalSurface(g, u, v), view.eye));
  };
}

/** The root of `h` on [0, 1] (`h(0) = ha` and `h(1) = hb` of opposite signs) by false position, Illinois variant. */
function refine(h: (s: number) => number, ha: number, hb: number): number {
  let [a, b] = [0, 1];
  let side = 0;
  for (let k = 0; k < MAX_STEPS && b - a > 1e-12; k++) {
    const s = (a * hb - b * ha) / (hb - ha);
    const hs = h(s);
    if (hs === 0) return s;
    if (hs >= 0 === ha >= 0) {
      [a, ha] = [s, hs];
      if (side === -1) hb /= 2;
      side = -1;
    } else {
      [b, hb] = [s, hs];
      if (side === 1) ha /= 2;
      side = 1;
    }
  }
  return (a * hb - b * ha) / (hb - ha);
}

/** Segments sharing an edge key, chained into paths of keys: open paths from their free ends, then the loops (closed back on their first key). */
function chain(segments: [number, number][]): number[][] {
  const at = new Map<number, number[]>();
  segments.forEach(([a, b], s) => {
    for (const k of [a, b]) at.set(k, [...(at.get(k) ?? []), s]);
  });
  const used = new Set<number>();
  const walk = (start: number, s: number): number[] => {
    const path = [start];
    let key = start;
    while (!used.has(s)) {
      used.add(s);
      const [a, b] = segments[s];
      key = a === key ? b : a;
      path.push(key);
      const next = (at.get(key) ?? []).find((t) => !used.has(t));
      if (next === undefined) break;
      s = next;
    }
    return path;
  };
  const paths: number[][] = [];
  for (const [key, list] of at) if (list.length === 1 && !used.has(list[0])) paths.push(walk(key, list[0]));
  segments.forEach(([a], s) => {
    if (!used.has(s)) paths.push(walk(a, s));
  });
  return paths;
}

/** Join polylines whose ends meet within `tol` (the two sides of a seam), until none do. */
function joinEnds(lines: Vec3[][], tol: number): Vec3[][] {
  const near = (p: Vec3, q: Vec3) => norm(sub(p, q)) <= tol;
  const out = lines.map((l) => [...l]);
  let joined = true;
  while (joined) {
    joined = false;
    for (let a = 0; a < out.length && !joined; a++) {
      for (let b = a + 1; b < out.length && !joined; b++) {
        const [p, q] = [out[a], out[b]];
        let merged: Vec3[] | null = null;
        if (near(p[p.length - 1], q[0])) merged = [...p, ...q.slice(1)];
        else if (near(p[p.length - 1], q[q.length - 1])) merged = [...p, ...q.slice(0, -1).reverse()];
        else if (near(p[0], q[q.length - 1])) merged = [...q, ...p.slice(1)];
        else if (near(p[0], q[0])) merged = [...q.slice().reverse(), ...p.slice(1)];
        if (merged) {
          out.splice(b, 1);
          out[a] = merged;
          joined = true;
        }
      }
    }
  }
  return out;
}
