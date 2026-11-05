import { halfSize } from "../geom/bounds";
import { curveExtras, dataExtras } from "../geom/extras";
import { liftPcurve, pcurveSurface } from "../geom/pcurve";
import { Sampled, dashPolyline } from "../geom/sample";
import { evalSurface } from "../geom/surfaces";
import {
  SurfaceGrid,
  TriMesh,
  WORLD_TOL,
  arrowPolylines,
  curvePieces,
  isoLines,
  surfaceGrid,
  tessellateSurface,
  windowEdges,
} from "../geom/tessellate";
import { Geom, isCurve, isPcurve, isSurface } from "../geom/types";
import type { Box, Vec3 } from "../geom/vec";
import type { SceneObject } from "../protocol";
import { colorOf } from "../ui/colors";
import { fmtPoint } from "../ui/format";
import type { TextKind } from "../view2d/render";

/** Spec §5.3: curves are 3 px wide whatever the zoom. */
export const LINE_PX = 3;
/** Isolines and a wireframe's window edges. */
export const EDGE_PX = 1;
export const EXTRA_PX = 1.5;
/** Marker radii, like the plane view's dots. */
export const POINT_PX = 4.5;
export const EXTRA_DOT_PX = 3.5;
export const HIGHLIGHT_PX = 1.5;
/** Spec §5.3: surfaces default to this opacity when the scene has curves, so the curves on them show. */
export const SURFACE_ALPHA_WITH_CURVES = 0.45;
/** `isolines: true`, and the lines of `wire` when it has no `isolines` of its own. */
export const ISOLINES: [number, number] = [12, 6];
export const WIRE_ISOLINES: [number, number] = [24, 12];
/** 3D dashes are cut in world units: this fraction of the view box's half-size drawn, then skipped. */
export const DASH: [number, number] = [0.03, 0.02];

export interface Lines3D {
  id: string;
  extra: boolean;
  paths: Vec3[][];
  color: string;
  /** Width in CSS pixels before presentation scaling and highlight. */
  px: number;
  alpha: number;
}

export interface Surface3D {
  id: string;
  mesh: TriMesh;
  /** The analytic surface's grid (picking maps the mesh's normalized uvs back through it); null for a mesh. */
  grid: SurfaceGrid | null;
  color: string;
  alpha: number;
}

export interface Markers3D {
  id: string;
  at: Vec3[];
  color: string;
  /** Radius in CSS pixels before presentation scaling and highlight. */
  px: number;
  alpha: number;
  extra: boolean;
}

export interface Text3D {
  key: string;
  id: string;
  text: string;
  at: Vec3;
  /** null: the theme's text colour. */
  color: string | null;
  kind: TextKind;
}

/** What hover can hit, in world space: polylines (with their parameters, for curves and pcurves) and dots. */
export interface Pickable3D {
  id: string;
  polylines: { pts: Vec3[]; ts: number[] | null }[];
  dots: Vec3[];
}

/** One object's share of the 3D scene. */
export interface ObjectDraw3D {
  id: string;
  lines: Lines3D[];
  surface: Surface3D | null;
  markers: Markers3D[];
  texts: Text3D[];
  pick: Pickable3D;
}

export interface Context3D {
  /** The view box (spec §5.3: the scene's ×1.5): infinite curves are clipped to it, windowless surfaces sized by it. */
  box: Box;
  /** Other objects' geometry by id (a pcurve's surface). */
  lookup: (id: string) => Geom | undefined;
  /** The scene has a curve, polyline or pcurve (default surface opacity). */
  withCurves: boolean;
}

const labelOf = (o: SceneObject): string => o.label ?? o.id;

/** True when surfaces default to see-through: some curve, polyline or pcurve is in the scene. */
export function hasCurves(objects: Iterable<SceneObject>): boolean {
  for (const o of objects) if (isCurve(o.geom) || isPcurve(o.geom) || o.geom.type === "polyline") return true;
  return false;
}

/** A surface's opacity: `style.opacity` when given (clamped), else 0.45 among curves and 1 alone. */
export function surfaceAlpha(o: SceneObject, withCurves: boolean): number {
  const given = o.style?.opacity;
  if (given !== undefined) return Math.min(Math.max(given, 0), 1);
  return withCurves ? SURFACE_ALPHA_WITH_CURVES : 1;
}

/** Isoline counts from the `isolines` and `wire` extras: `[nu, nv]`, `true` for the default, else none. */
export function isolineCounts(extras: Record<string, unknown> | undefined): [number, number] | null {
  const iso = extras?.isolines;
  if (Array.isArray(iso) && iso.length === 2 && iso.every((n) => Number.isInteger(n) && n >= 0)) return [iso[0], iso[1]];
  if (iso === true) return ISOLINES;
  return extras?.wire ? WIRE_ISOLINES : null;
}

/** Width or radius on screen: the base pixels × presentation scale, plus the highlight when hovered or selected. */
export const screenPx = (px: number, widthScale: number, lit: boolean): number => px * widthScale + (lit ? HIGHLIGHT_PX : 0);

/** Where a curve's label goes: 30 % along its longest piece. */
function curveAnchor(pieces: Vec3[][]): Vec3 | null {
  let best: Vec3[] = [];
  for (const p of pieces) if (p.length > best.length) best = p;
  return best.length ? best[Math.floor((best.length - 1) * 0.3)] : null;
}

/**
 * The 3D view's share of one object (spec §5.3): line pieces, a surface mesh, markers,
 * labels and what hover can pick, all in world units. Pure, so the view's content is
 * testable without WebGL; widths stay in pixels for the view to scale.
 */
export function objectDraw3D(o: SceneObject, ctx: Context3D): ObjectDraw3D {
  const out: ObjectDraw3D = { id: o.id, lines: [], surface: null, markers: [], texts: [], pick: { id: o.id, polylines: [], dots: [] } };
  const g = o.geom;
  const color = colorOf(o);
  const alpha = Math.min(Math.max(o.style?.opacity ?? 1, 0), 1);
  const half = halfSize(ctx.box);
  const tol = WORLD_TOL * half;
  const dash = (paths: Vec3[][]): Vec3[][] => paths.flatMap((p) => dashPolyline(p, DASH[0] * half, DASH[1] * half));
  const stroke = (paths: Vec3[][], extra = false, px = extra ? EXTRA_PX : (o.style?.width ?? LINE_PX)) => {
    const drawn = paths.filter((p) => p.length >= 2);
    if (drawn.length) out.lines.push({ id: o.id, extra, paths: extra || o.style?.dashed ? dash(drawn) : drawn, color, px, alpha });
  };
  const curve = (pieces: Sampled<Vec3>[]) => {
    const paths = pieces.map((s) => s.pts);
    stroke(paths);
    out.pick.polylines.push(...pieces.map((s) => ({ pts: s.pts, ts: s.ts })));
    const at = curveAnchor(paths);
    if (at) out.texts.push({ key: `c:${o.id}`, id: o.id, text: labelOf(o), at, color: null, kind: "curve" });
  };

  if (isCurve(g)) {
    curve(curvePieces(g, ctx.box, tol));
    if (o.extras) {
      const extras = curveExtras(g, o.extras);
      stroke(extras.lines.flatMap((l) => curvePieces(l, ctx.box, tol).map((s) => s.pts)), true);
      if (extras.points.length) {
        out.markers.push({ id: o.id, at: extras.points.map((x) => x.p), color, px: EXTRA_DOT_PX, alpha, extra: true });
        for (const x of extras.points) {
          if (x.name) out.texts.push({ key: `x:${o.id}:${x.name}`, id: o.id, text: x.name, at: x.p, color: null, kind: "extra" });
        }
      }
    }
  } else if (isPcurve(g)) {
    const s = pcurveSurface(g, ctx.lookup);
    if (s) curve(liftPcurve(g, s, ctx.box, tol));
  } else if (isSurface(g)) {
    const grid = surfaceGrid(g, half, tol);
    out.surface = { id: o.id, mesh: tessellateSurface(g, grid), grid, color, alpha: surfaceAlpha(o, ctx.withCurves) };
    const counts = isolineCounts(o.extras);
    if (counts) stroke(isoLines(g, grid, counts[0], counts[1]), false, EDGE_PX);
    if (o.extras?.wire) {
      stroke(windowEdges(g, grid), false, EDGE_PX);
      out.surface = null; // a wireframe is its lines only
    }
    const mid = evalSurface(g, (grid.u[0] + grid.u[1]) / 2, (grid.v[0] + grid.v[1]) / 2);
    out.texts.push({ key: `s:${o.id}`, id: o.id, text: labelOf(o), at: mid, color: null, kind: "curve" });
  } else if (g.type === "mesh") {
    const mesh = { positions: g.vertices.flat(), indices: g.indices, uvs: [] };
    out.surface = { id: o.id, mesh, grid: null, color, alpha: surfaceAlpha(o, ctx.withCurves) };
  } else if (g.type === "polyline" || g.type === "arrow") {
    const lines = g.type === "polyline" ? [g.points] : arrowPolylines(g.at, g.vec);
    stroke(lines);
    out.pick.polylines = lines.map((pts) => ({ pts, ts: null }));
  } else if (g.type === "point") {
    out.markers.push({ id: o.id, at: [g.p], color, px: POINT_PX, alpha, extra: false });
    out.pick.dots.push(g.p);
    out.texts.push({ key: `p:${o.id}`, id: o.id, text: `${labelOf(o)} ${fmtPoint(g.p)}`, at: g.p, color: null, kind: "point" });
  } else if (g.type === "points") {
    out.markers.push({ id: o.id, at: g.positions, color, px: g.size ?? 3, alpha, extra: false });
    out.pick.dots.push(...g.positions);
    if (g.positions.length) out.texts.push({ key: `p:${o.id}`, id: o.id, text: labelOf(o), at: g.positions[0], color: null, kind: "point" });
  } else if (g.type === "text") {
    out.texts.push({ key: `t:${o.id}`, id: o.id, text: g.text, at: g.at, color: o.style?.color ? color : null, kind: "text" });
  }
  if (o.extras) {
    // Extras the client computed from the exact object: control polygons, knot points, combs, normals.
    const data = dataExtras(o.extras);
    stroke(data.paths ?? [], true);
    if (data.points.length) {
      out.markers.push({ id: o.id, at: data.points.map((x) => x.p), color, px: EXTRA_DOT_PX, alpha, extra: true });
    }
  }
  return out;
}
