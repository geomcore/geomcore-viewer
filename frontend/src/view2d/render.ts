import { Rect, clipCurve2D, expandRect } from "../geom/clip";
import { evalCurve } from "../geom/curves";
import { curveExtras } from "../geom/extras";
import { inPlaneZ0 } from "../geom/planar";
import { Sampled, dashPolyline, sampleAdaptive } from "../geom/sample";
import { arrowPolylines } from "../geom/tessellate";
import { CurveGeom, isCurve } from "../geom/types";
import type { Vec2, Vec3 } from "../geom/vec";
import type { SceneObject } from "../protocol";
import { colorOf } from "../ui/colors";
import { fmtNum, fmtParams, fmtPoint } from "../ui/format";
import { scalarColors } from "../ui/colormap";
import { Palette, mixHex } from "../ui/theme";
import { Camera2D, screenToWorld, visibleRect, worldToScreen } from "./camera";
import type { Hit, Pickable } from "./pick";

export const LINE_PX = 2.5;
export const POINT_PX = 4.5;
export const HIGHLIGHT_PX = 1.5;
export const EXTRA_PX = 1.5;
export const EXTRA_DOT_PX = 3.5;
export const DASH: [number, number] = [7, 5];
/** How far extras move towards the background colour ("same color, lighter"). */
export const EXTRA_MIX = 0.45;
/** Curves are clipped to the viewport grown by this fraction on every side (spec §5.2). */
export const MARGIN = 0.1;

export interface DrawOptions {
  visible: (o: SceneObject) => boolean;
  palette: Palette;
  /** 1, or 1.5 in presentation mode. */
  widthScale: number;
  /** The hovered object, drawn thicker. */
  highlight: string | null;
  /** The selected object (spec §5.1), drawn like the hovered one. */
  selected: string | null;
}

export interface Stroke {
  id: string;
  extra: boolean;
  paths: Vec2[][];
  color: string;
  width: number;
  alpha: number;
}

export interface Dot {
  id: string;
  at: Vec2;
  color: string;
  radius: number;
  alpha: number;
  hollow: boolean;
}

export type TextKind = "text" | "point" | "curve" | "extra";

export interface TextItem {
  key: string;
  id: string;
  text: string;
  /** Screen anchor: the point, a spot on the curve, or the text's own position. */
  at: Vec2;
  color: string;
  kind: TextKind;
}

/** Everything one frame of the plane view paints, in screen pixels. */
export interface DrawList {
  strokes: Stroke[];
  dots: Dot[];
  texts: TextItem[];
  pickables: Pickable[];
}

const KIND_ORDER: Record<TextKind, number> = { text: 0, point: 1, curve: 2, extra: 3 };

const labelOf = (o: SceneObject): string => o.label ?? o.id;
/** Result operands keep their label for hover but do not draw one in the view. */
const labelsOn = (o: SceneObject): boolean => o.meta?.operand !== true;
const insideRect = (r: Rect, p: Vec3): boolean => p[0] >= r.xmin && p[0] <= r.xmax && p[1] >= r.ymin && p[1] <= r.ymax;

/** The curve's visible pieces as screen polylines: clipped in closed form, then sampled to ≤ 0.25 px. */
export function curvePolylines(g: CurveGeom, cam: Camera2D, clip: Rect): Sampled[] {
  const toScreen = (t: number): Vec2 => {
    const p = evalCurve(g, t);
    return worldToScreen(cam, p[0], p[1]);
  };
  return clipCurve2D(g, clip).map(([a, b]) => sampleAdaptive(toScreen, a, b));
}

/** Where a curve's label goes: 30 % along the longest run of its points inside the pane. */
function curveAnchor(pieces: Sampled[], cam: Camera2D): Vec2 | null {
  let best: Vec2[] = [];
  for (const piece of pieces) {
    let run: Vec2[] = [];
    for (const p of piece.pts) {
      if (p[0] >= 0 && p[0] <= cam.width && p[1] >= 0 && p[1] <= cam.height) {
        run.push(p);
        if (run.length > best.length) best = run;
      } else {
        run = [];
      }
    }
  }
  return best.length ? best[Math.floor((best.length - 1) * 0.3)] : null;
}

/**
 * The draw list for one frame: strokes, dots and labels of every visible planar object,
 * plus what hover can pick. Pure (no PixiJS, no DOM), so the whole plane view is testable.
 */
export function buildDrawList(objects: Iterable<SceneObject>, cam: Camera2D, opts: DrawOptions): DrawList {
  const out: DrawList = { strokes: [], dots: [], texts: [], pickables: [] };
  const clip = expandRect(visibleRect(cam), MARGIN);
  const ws = opts.widthScale;
  const isLit = (id: string): boolean => id === opts.highlight || id === opts.selected;
  const dash = (paths: Vec2[][]): Vec2[][] => paths.flatMap((p) => dashPolyline(p, DASH[0] * ws, DASH[1] * ws));
  const screen = (p: Vec3): Vec2 => worldToScreen(cam, p[0], p[1]);
  for (const o of objects) {
    const g = o.geom;
    if (g.type === "note" || !inPlaneZ0(g) || !opts.visible(o)) continue;
    const color = colorOf(o);
    const lit = isLit(o.id) ? HIGHLIGHT_PX : 0;
    const alpha = Math.min(Math.max(o.style?.opacity ?? 1, 0), 1);
    const width = (o.style?.width ?? LINE_PX) * ws + lit;
    const stroke = (paths: Vec2[][]) =>
      out.strokes.push({ id: o.id, extra: false, paths: o.style?.dashed ? dash(paths) : paths, color, width, alpha });
    const pick: Pickable = { id: o.id, polylines: [], dots: [] };
    out.pickables.push(pick);
    if (isCurve(g)) {
      const pieces = curvePolylines(g, cam, clip);
      stroke(pieces.map((s) => s.pts));
      pick.polylines = pieces.map((s) => ({ pts: s.pts, ts: s.ts }));
      const anchor = curveAnchor(pieces, cam);
      if (anchor && labelsOn(o)) out.texts.push({ key: `c:${o.id}`, id: o.id, text: labelOf(o), at: anchor, color: opts.palette.text, kind: "curve" });
      if (o.extras) {
        const extras = curveExtras(g, o.extras);
        const faded = mixHex(color, opts.palette.bg, EXTRA_MIX);
        const lines = extras.lines.flatMap((l) => curvePolylines(l, cam, clip).map((s) => s.pts));
        if (lines.length) out.strokes.push({ id: o.id, extra: true, paths: dash(lines), color: faded, width: EXTRA_PX * ws, alpha });
        for (const x of extras.points) {
          if (!insideRect(clip, x.p)) continue;
          const at = screen(x.p);
          out.dots.push({ id: o.id, at, color: faded, radius: EXTRA_DOT_PX * ws, alpha, hollow: true });
          out.texts.push({ key: `x:${o.id}:${x.name}`, id: o.id, text: x.name, at, color: opts.palette.text, kind: "extra" });
        }
      }
    } else if (g.type === "polyline" || g.type === "arrow") {
      const lines = g.type === "polyline" ? [g.points] : arrowPolylines(g.at, g.vec);
      const paths = lines.map((l) => l.map(screen));
      stroke(paths);
      pick.polylines = paths.map((pts) => ({ pts, ts: null }));
    } else if (g.type === "point") {
      if (!insideRect(clip, g.p)) continue;
      const at = screen(g.p);
      out.dots.push({ id: o.id, at, color, radius: POINT_PX * ws + lit, alpha, hollow: false });
      pick.dots.push({ at, index: 0 });
      if (labelsOn(o)) out.texts.push({ key: `p:${o.id}`, id: o.id, text: `${labelOf(o)} ${fmtPoint(g.p)}`, at, color: opts.palette.text, kind: "point" });
    } else if (g.type === "points") {
      const radius = (g.size ?? 3) * ws + lit;
      const scalars = g.values ? scalarColors(g.values, g.colormap) : null;
      g.positions.forEach((p, index) => {
        if (!insideRect(clip, p)) return;
        const at = screen(p);
        out.dots.push({ id: o.id, at, color: scalars?.[index] ?? color, radius, alpha, hollow: false });
        pick.dots.push({ at, index });
      });
      const first = g.positions[0];
      if (insideRect(clip, first)) {
        if (labelsOn(o)) out.texts.push({ key: `p:${o.id}`, id: o.id, text: labelOf(o), at: screen(first), color: opts.palette.text, kind: "point" });
      }
    } else if (g.type === "text") {
      const textColor = o.style?.color ? color : opts.palette.text;
      out.texts.push({ key: `t:${o.id}`, id: o.id, text: g.text, at: screen(g.at), color: textColor, kind: "text" });
    }
  }
  const rank = (t: TextItem) => (isLit(t.id) ? -1 : KIND_ORDER[t.kind]);
  out.texts.sort((a, b) => rank(a) - rank(b));
  return out;
}

/** Tooltip lines for a hover hit: "label · type", the curve parameter, the coordinates, `meta.params`. */
export function describeHit(o: SceneObject, hit: Hit, cam: Camera2D): string[] {
  const g = o.geom;
  const lines = [`${labelOf(o)} · ${g.type}`];
  let at: Vec3;
  if (g.type === "point") {
    at = g.p;
  } else if (g.type === "points" && hit.index !== null) {
    at = g.positions[hit.index];
  } else if (isCurve(g) && hit.t !== null) {
    lines.push(`t = ${fmtNum(hit.t, 4)}`);
    at = evalCurve(g, hit.t);
  } else {
    const [x, y] = screenToWorld(cam, hit.at[0], hit.at[1]);
    at = [x, y, 0];
  }
  lines.push(fmtPoint(at));
  const params = fmtParams(o.meta?.params);
  if (params !== null) lines.push(`params ${params}`);
  return lines;
}
