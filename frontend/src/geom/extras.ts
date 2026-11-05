import type { CurveGeom } from "./types";
import { Vec3, add, inFrame, scale } from "./vec";

export type LineGeom = Extract<CurveGeom, { type: "line" }>;

/** Construction elements of a conic: infinite lines (drawn like any line) and named points. */
export interface Extras {
  lines: LineGeom[];
  points: { p: Vec3; name: string }[];
  /** Extra polylines: a control polygon, comb teeth and envelope, normal segments. */
  paths?: Vec3[][];
}

/** A `[x, y, z]` array from client data, 2-component vectors padded with z = 0. */
function asVec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || (v.length !== 2 && v.length !== 3)) return null;
  if (!v.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  return [v[0], v[1], v.length === 3 ? v[2] : 0];
}

/**
 * Extras whose data the client computes and sends (protocol `extras.poles`, `knots`, `comb`,
 * `normals`): the page only receives sampled geometry, so the control net, knot points,
 * curvature combs and normals come pre-computed. Missing or malformed data gives nothing.
 */
export function dataExtras(wanted: Record<string, unknown>): Extras {
  const out: Extras = { lines: [], points: [], paths: [] };
  const path = (pts: Vec3[]): void => {
    out.paths!.push(pts);
  };
  const points = (value: unknown): Vec3[] =>
    Array.isArray(value) ? value.map(asVec3).filter((p): p is Vec3 => p !== null) : [];

  const poles = points(wanted.poles);
  if (poles.length) {
    if (poles.length >= 2) path(poles);
    for (const p of poles) out.points.push({ p, name: "" });
  }
  for (const p of points(wanted.knots)) out.points.push({ p, name: "" });

  const comb = wanted.comb;
  if (comb !== null && typeof comb === "object") {
    const teeth = Array.isArray((comb as { teeth?: unknown }).teeth) ? (comb as { teeth: unknown[] }).teeth : [];
    const tips: Vec3[] = [];
    for (const tooth of teeth) {
      if (!Array.isArray(tooth) || tooth.length !== 2) continue;
      const [a, b] = tooth.map(asVec3);
      if (!a || !b) continue;
      if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) === 0) continue;
      path([a, b]);
      tips.push(b);
    }
    if (tips.length >= 2) path(tips);
  }

  for (const pair of Array.isArray(wanted.normals) ? wanted.normals : []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [a, b] = pair.map(asVec3);
    if (a && b) path([a, b]);
  }
  return out;
}

/**
 * The extras an object asks for (protocol `extras`: foci, center, axes, asymptotes,
 * directrix, vertex), derived from the analytic parameters. Unknown keys, false values
 * and extras that do not apply to the curve (asymptotes of an ellipse) give nothing.
 */
export function curveExtras(g: CurveGeom, wanted: Record<string, unknown>): Extras {
  const out: Extras = { lines: [], points: [] };
  if (g.type === "line" || g.type === "bspline_curve") return out; // no frame, no conic extras
  const on = (key: string): boolean => Boolean(wanted[key]);
  const f = g.frame;
  const at = (cx: number, cy: number): Vec3 => inFrame(f, cx, cy);
  const line = (o: Vec3, d: Vec3) => out.lines.push({ type: "line", o, d });
  const point = (p: Vec3, name: string) => out.points.push({ p, name });
  const axes = () => {
    line(f.o, f.x);
    line(f.o, f.y);
  };
  switch (g.type) {
    case "circle":
      if (on("center") || on("foci")) point(f.o, "O"); // a circle's foci coincide with its center
      if (on("axes")) axes();
      break;
    case "ellipse": {
      const major = g.a >= g.b; // the foci lie on the longer axis
      const c = Math.sqrt(Math.abs(g.a * g.a - g.b * g.b));
      const big = Math.max(g.a, g.b);
      const along = (s: number) => (major ? at(s, 0) : at(0, s));
      if (on("foci")) {
        point(along(c), "F₁");
        point(along(-c), "F₂");
      }
      if (on("center")) point(f.o, "O");
      if (on("vertex")) {
        point(at(g.a, 0), "V₁");
        point(at(-g.a, 0), "V₂");
        point(at(0, g.b), "V₃");
        point(at(0, -g.b), "V₄");
      }
      if (on("axes")) axes();
      if (on("directrix") && c > 0) {
        const d = (big * big) / c;
        const dir = major ? f.y : f.x;
        line(along(d), dir);
        line(along(-d), dir);
      }
      break;
    }
    case "parabola":
      // P(t) = o + t²/(4f)·x + t·y: focus at f·x, directrix through −f·x along y.
      if (on("foci")) point(at(g.f, 0), "F");
      if (on("vertex")) point(f.o, "V");
      if (on("axes")) line(f.o, f.x);
      if (on("directrix")) line(at(-g.f, 0), f.y);
      break;
    case "hyperbola": {
      // One branch, P(t) = o + a·cosh t·x + b·sinh t·y.
      const c = Math.hypot(g.a, g.b);
      if (on("foci")) {
        point(at(c, 0), "F₁");
        point(at(-c, 0), "F₂");
      }
      if (on("center")) point(f.o, "O");
      if (on("vertex")) point(at(g.a, 0), "V");
      if (on("axes")) axes();
      if (on("asymptotes")) {
        line(f.o, add(scale(f.x, g.a), scale(f.y, g.b)));
        line(f.o, add(scale(f.x, g.a), scale(f.y, -g.b)));
      }
      if (on("directrix")) line(at((g.a * g.a) / c, 0), f.y); // the drawn branch's directrix
      break;
    }
  }
  return out;
}
