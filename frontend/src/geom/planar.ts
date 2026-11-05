import type { Geom } from "./types";
import type { Vec3 } from "./vec";

const EPS = 1e-9;
const flat = (p: Vec3) => Math.abs(p[2]) < EPS;
const upright = (z: Vec3) => Math.abs(z[0]) < EPS && Math.abs(z[1]) < EPS;

/** True when the geometry lies in the z = 0 plane (drawable in the 2D plane view). */
export function inPlaneZ0(g: Geom): boolean {
  switch (g.type) {
    case "point": return flat(g.p);
    case "box": return flat(g.min) && flat(g.max);
    case "bspline_curve": return g.poles.every(flat);
    case "points": return g.positions.every(flat);
    case "polyline": return g.points.every(flat);
    case "line": return flat(g.o) && flat(g.d);
    case "circle": case "ellipse": case "parabola": case "hyperbola": return flat(g.frame.o) && upright(g.frame.z);
    case "arrow": return flat(g.at) && flat(g.vec);
    case "text": return flat(g.at);
    case "note": return true;
    default: return false; // surfaces and meshes are 3D
  }
}
