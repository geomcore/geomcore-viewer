import type { Frame, Vec3 } from "./vec";

export type Range = [number, number];

export interface Window {
  u?: Range;
  v?: Range;
}

export type CurveGeom =
  | { type: "line"; o: Vec3; d: Vec3; range?: Range }
  | { type: "circle"; frame: Frame; r: number; range?: Range }
  | { type: "ellipse"; frame: Frame; a: number; b: number; range?: Range }
  | { type: "parabola"; frame: Frame; f: number; range?: Range }
  | { type: "hyperbola"; frame: Frame; a: number; b: number; range?: Range }
  | BsplineCurveGeom;

export type SurfaceGeom =
  | { type: "plane"; frame: Frame; window?: Window }
  | { type: "cylinder"; frame: Frame; r: number; window?: Window }
  | { type: "cone"; frame: Frame; semi_angle: number; ref_radius: number; window?: Window }
  | { type: "sphere"; frame: Frame; r: number; window?: Window }
  | { type: "torus"; frame: Frame; R: number; r: number; window?: Window }
  | BsplineSurfaceGeom;

/** An exact B-spline curve, as geomcore stores it: degree, control poles,
 * per-pole weights (absent when not rational), distinct knots with
 * multiplicities, and periodicity. A trimmed piece carries `range`. */
export interface BsplineCurveGeom {
  type: "bspline_curve";
  degree: number;
  poles: Vec3[];
  weights?: number[];
  knots: number[];
  multiplicities: number[];
  periodic: boolean;
  range?: Range;
}

/** An exact B-spline surface: `nu` rows of `nv` poles (u-major), weights when
 * rational, distinct knots with multiplicities and periodicity per direction. */
export interface BsplineSurfaceGeom {
  type: "bspline_surface";
  u_degree: number;
  v_degree: number;
  nu: number;
  nv: number;
  poles: Vec3[];
  weights?: number[];
  u_knots: number[];
  u_multiplicities: number[];
  v_knots: number[];
  v_multiplicities: number[];
  u_periodic: boolean;
  v_periodic: boolean;
  window?: Window;
}

export type MarkerGeom =
  | { type: "polyline"; points: Vec3[] }
  | { type: "mesh"; vertices: Vec3[]; indices: number[] }
  | { type: "box"; min: Vec3; max: Vec3 }
  | { type: "point"; p: Vec3 }
  | { type: "points"; positions: Vec3[]; size?: number }
  | { type: "arrow"; at: Vec3; vec: Vec3 }
  | { type: "text"; at: Vec3; text: string }
  | { type: "note"; text: string; level?: "info" | "warn" };

/** A curve in a surface's (u, v) plane: a line, circle or polyline in z = 0, x read as u and y as v. */
export type UvCurve = Extract<CurveGeom, { type: "line" | "circle" }> | Extract<MarkerGeom, { type: "polyline" }>;

/** A curve given by the parameters of the surface it lies on (protocol `pcurve`), drawn at S(curve(t)). */
export interface PcurveGeom {
  type: "pcurve";
  /** The surface's object id. */
  surface: string;
  curve: UvCurve;
}

export type Geom = CurveGeom | SurfaceGeom | MarkerGeom | PcurveGeom;

export const CURVE_TYPES: ReadonlySet<string> = new Set(["line", "circle", "ellipse", "parabola", "hyperbola", "bspline_curve"]);
export const SURFACE_TYPES: ReadonlySet<string> = new Set(["plane", "cylinder", "cone", "sphere", "torus", "bspline_surface"]);

export const isCurve = (g: Geom): g is CurveGeom => CURVE_TYPES.has(g.type);
export const isSurface = (g: Geom): g is SurfaceGeom => SURFACE_TYPES.has(g.type);
export const isPcurve = (g: Geom): g is PcurveGeom => g.type === "pcurve";
