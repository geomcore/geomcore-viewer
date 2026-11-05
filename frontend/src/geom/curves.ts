import { evalBsplineCurve } from "./bspline";
import type { CurveGeom } from "./types";
import { Vec3, add, inFrame, scale } from "./vec";

/** Point at parameter `t` — formulas identical to geomcore (protocol/SCENE.md). */
export function evalCurve(g: CurveGeom, t: number): Vec3 {
  switch (g.type) {
    case "line":
      return add(g.o, scale(g.d, t));
    case "circle":
      return inFrame(g.frame, g.r * Math.cos(t), g.r * Math.sin(t));
    case "ellipse":
      return inFrame(g.frame, g.a * Math.cos(t), g.b * Math.sin(t));
    case "parabola":
      return inFrame(g.frame, (t * t) / (4 * g.f), t);
    case "hyperbola":
      return inFrame(g.frame, g.a * Math.cosh(t), g.b * Math.sinh(t));
    case "bspline_curve":
      return evalBsplineCurve(g.degree, g.poles, g.weights, g.knots, g.multiplicities, g.periodic, t);
  }
}
