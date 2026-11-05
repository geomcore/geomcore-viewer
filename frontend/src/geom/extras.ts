import type { CurveGeom } from "./types";
import { Vec3, add, inFrame, scale } from "./vec";

export type LineGeom = Extract<CurveGeom, { type: "line" }>;

/** Construction elements of a conic: infinite lines (drawn like any line) and named points. */
export interface Extras {
  lines: LineGeom[];
  points: { p: Vec3; name: string }[];
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
