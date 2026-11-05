import { evalCurve } from "./curves";
import { evalSurface, surfaceWindow } from "./surfaces";
import { Geom, Range, CurveGeom, isSurface } from "./types";
import { Box, Vec3, add } from "./vec";

const FALLBACK: Box = { min: [-5, -5, -5], max: [5, 5, 5] };

/**
 * Bounding box of everything with a finite extent. Infinite curves add only
 * their origin; a ranged curve adds its endpoints (and a conic its vertex when
 * in range); surfaces add a coarse sample of their window; notes add nothing.
 */
export function sceneBounds(geoms: Iterable<Geom>): Box | null {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let found = false;
  const grow = (p: Vec3, pad = 0) => {
    found = true;
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i] - pad);
      max[i] = Math.max(max[i], p[i] + pad);
    }
  };
  /** A ranged curve is finite: grow by its endpoints and, for conics, by the vertex when t = 0 is in range. */
  const growRange = (g: CurveGeom, [t0, t1]: Range) => {
    grow(evalCurve(g, t0));
    grow(evalCurve(g, t1));
    if (g.type !== "line" && t0 <= 0 && 0 <= t1) grow(evalCurve(g, 0));
  };
  for (const g of geoms) {
    switch (g.type) {
      case "point": grow(g.p); break;
      case "points": g.positions.forEach((p) => grow(p)); break;
      case "polyline": g.points.forEach((p) => grow(p)); break;
      case "mesh": g.vertices.forEach((p) => grow(p)); break;
      case "box": grow(g.min); grow(g.max); break;
      case "arrow": grow(g.at); grow(add(g.at, g.vec)); break;
      case "text": grow(g.at); break;
      case "line":
        if (g.range) growRange(g, g.range);
        else grow(g.o);
        break;
      case "parabola": case "hyperbola":
        if (g.range) growRange(g, g.range);
        else grow(g.frame.o);
        break;
      case "circle": grow(g.frame.o, g.r); break;
      case "ellipse": grow(g.frame.o, Math.max(g.a, g.b)); break;
      case "bspline_curve": g.poles.forEach((p) => grow(p)); break; // the convex hull holds the curve
      case "bspline_surface": g.poles.forEach((p) => grow(p)); break; // weights are positive: the hull holds the patch
      case "note": break;
      default:
        if (isSurface(g)) {
          const { u, v } = surfaceWindow(g, 5);
          for (let i = 0; i <= 4; i++)
            for (let j = 0; j <= 4; j++)
              grow(evalSurface(g, u[0] + ((u[1] - u[0]) * i) / 4, v[0] + ((v[1] - v[0]) * j) / 4));
        }
    }
  }
  return found ? { min, max } : null;
}

/** Region infinite geometry is drawn in: the scene box grown ×1.5 into a cube (half-size ≥ 1), or ±5. */
export function viewBox(geoms: Iterable<Geom>): Box {
  const b = sceneBounds(geoms);
  if (!b) return FALLBACK;
  const center = b.min.map((m, i) => (m + b.max[i]) / 2) as Vec3;
  const half = Math.max(1, 1.5 * Math.max(...b.min.map((m, i) => (b.max[i] - m) / 2)));
  return { min: center.map((c) => c - half) as Vec3, max: center.map((c) => c + half) as Vec3 };
}

export const halfSize = (b: Box): number => Math.max(...b.min.map((m, i) => (b.max[i] - m) / 2));

export const sameBox = (a: Box, b: Box): boolean =>
  a.min.every((m, i) => m === b.min[i]) && a.max.every((m, i) => m === b.max[i]);
