import { halfSize } from "../geom/bounds";
import { pcurveRanges, pcurveSeeds, uvAt } from "../geom/pcurve";
import { sampleAdaptive } from "../geom/sample";
import { periods, surfaceWindow } from "../geom/surfaces";
import { Range, SurfaceGeom, isPcurve, isSurface } from "../geom/types";
import type { Box, Vec2, Vec3 } from "../geom/vec";
import type { SceneObject } from "../protocol";
import { colorOf } from "../ui/colors";
import { fmtNum, fmtPoint } from "../ui/format";
import { displayName } from "../ui/names";
import { ticks } from "../view2d/plane";

/** One pcurve as the pane draws it: (u, v) paths wrapped into the window, cut at the seams. */
export interface UvPath {
  id: string;
  label: string;
  color: string;
  dashed: boolean;
  paths: Vec2[][];
}

export interface UvModel {
  surface: SceneObject;
  geom: SurfaceGeom;
  u: Range;
  v: Range;
  /** Periods of the directions that wrap (2π), null for the others. */
  period: { u: number | null; v: number | null };
  /** Seam lines inside the window: u (or v) = a multiple of the period. */
  seams: { u: number[]; v: number[] };
  curves: UvPath[];
}

/**
 * The surface the (u,v) pane shows (spec §5.4): the selected surface, else the surface of
 * the selected pcurve, else that of the first pcurve in the scene; null when none applies
 * (the pane then stays hidden). A pcurve whose surface is missing gives nothing.
 */
export function uvSubject(objects: ReadonlyMap<string, SceneObject>, selected: string | null): SceneObject | null {
  const surfaceOf = (o: SceneObject | undefined): SceneObject | null => {
    if (!o) return null;
    if (isSurface(o.geom)) return o;
    if (!isPcurve(o.geom)) return null;
    const s = objects.get(o.geom.surface);
    return s && isSurface(s.geom) ? s : null;
  };
  const picked = selected ? surfaceOf(objects.get(selected)) : null;
  if (picked) return picked;
  for (const o of objects.values()) {
    if (!isPcurve(o.geom)) continue;
    const s = surfaceOf(o);
    if (s) return s;
  }
  return null;
}

/** Lift x into [lo, lo + period) — or leave it when the direction does not wrap. */
const wrap = (x: number, lo: number, period: number | null): number => (period ? lo + ((((x - lo) % period) + period) % period) : x);

/** A (u, v) point moved into the window across the periodic directions (where the pane draws it). */
export function wrapUv(m: Pick<UvModel, "u" | "v" | "period">, uv: Vec2): Vec2 {
  return [wrap(uv[0], m.u[0], m.period.u), wrap(uv[1], m.v[0], m.period.v)];
}

/**
 * Cut a path where it crosses a seam of `axis` (lo + k·period) and shift each piece into
 * [lo, lo + period], adding the crossing point at both ends of the cut. A path that only
 * touches a seam at its end leaves no zero-length piece behind.
 */
export function wrapAxis(path: Vec2[], axis: 0 | 1, lo: number, period: number): Vec2[][] {
  const cell = (p: Vec2) => Math.floor((p[axis] - lo) / period);
  const shift = (p: Vec2, k: number): Vec2 => (axis === 0 ? [p[0] - k * period, p[1]] : [p[0], p[1] - k * period]);
  const out: Vec2[][] = [];
  if (!path.length) return out;
  let k = cell(path[0]);
  let piece: Vec2[] = [shift(path[0], k)];
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]];
    const kb = cell(b);
    while (k !== kb) {
      const step = kb > k ? 1 : -1;
      const seam = lo + (step > 0 ? k + 1 : k) * period;
      const s = (seam - a[axis]) / (b[axis] - a[axis]);
      const c: Vec2 = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
      piece.push(shift(c, k));
      out.push(piece);
      k += step;
      piece = [shift(c, k)];
    }
    piece.push(shift(b, k));
  }
  out.push(piece);
  const tol = 1e-9 * period;
  return out.filter((p) => p.some((q) => Math.abs(q[0] - p[0][0]) > tol || Math.abs(q[1] - p[0][1]) > tol));
}

/**
 * What the (u,v) pane draws for `subject`: its window (as the 3D view tessellates it), the
 * seams, and every visible pcurve on it, sampled over the same parameter intervals the 3D
 * view lifts and wrapped into the window.
 */
export function uvModel(objects: Iterable<SceneObject>, subject: SceneObject, box: Box, visible: (o: SceneObject) => boolean): UvModel {
  const geom = subject.geom as SurfaceGeom;
  const { u, v } = surfaceWindow(geom, halfSize(box));
  const period = periods(geom);
  const seams = {
    u: period.u ? ticks(u[0], u[1], period.u) : [],
    v: period.v ? ticks(v[0], v[1], period.v) : [],
  };
  const tol = 5e-4 * Math.max(u[1] - u[0], v[1] - v[0]);
  const curves: UvPath[] = [];
  for (const o of objects) {
    const g = o.geom;
    if (!isPcurve(g) || g.surface !== subject.id || !visible(o)) continue;
    let paths = pcurveRanges(g, geom, box).map(([a, b]) => sampleAdaptive((t) => uvAt(g.curve, t), a, b, tol, 4096, pcurveSeeds(g.curve, geom, a, b)).pts);
    if (period.u) paths = paths.flatMap((p) => wrapAxis(p, 0, u[0], period.u!));
    if (period.v) paths = paths.flatMap((p) => wrapAxis(p, 1, v[0], period.v!));
    curves.push({ id: o.id, label: displayName(o), color: colorOf(o), dashed: Boolean(o.style?.dashed), paths });
  }
  return { surface: subject, geom, u, v, period, seams, curves };
}

/** The pane's plot area in CSS pixels: the window is stretched to fill it (u and v need not share a scale). */
export interface PlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** (u, v) → pane pixels: u grows to the right, v upwards. */
export function toPane(m: Pick<UvModel, "u" | "v">, r: PlotRect, uv: Vec2): Vec2 {
  return [r.left + ((uv[0] - m.u[0]) / (m.u[1] - m.u[0])) * r.width, r.top + r.height - ((uv[1] - m.v[0]) / (m.v[1] - m.v[0])) * r.height];
}

/** Pane pixels → (u, v); `inside` tells whether the point is in the window. */
export function fromPane(m: Pick<UvModel, "u" | "v">, r: PlotRect, p: Vec2): { uv: Vec2; inside: boolean } {
  const su = (p[0] - r.left) / r.width;
  const sv = (r.top + r.height - p[1]) / r.height;
  const uv: Vec2 = [m.u[0] + su * (m.u[1] - m.u[0]), m.v[0] + sv * (m.v[1] - m.v[0])];
  return { uv, inside: su >= 0 && su <= 1 && sv >= 0 && sv <= 1 };
}

/** The pane's readout for a linked hover: "u 1.571 · v 0.5 → (x, y, z)". */
export function hoverText(uv: Vec2, p: Vec3): string {
  return `u ${fmtNum(uv[0])} · v ${fmtNum(uv[1])} → ${fmtPoint(p)}`;
}
