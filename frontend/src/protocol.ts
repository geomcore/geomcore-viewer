// Scene protocol v2: types, validation and v1 migration. Mirrors protocol/SCENE.md.
import { inPlaneZ0 } from "./geom/planar";
import { CURVE_TYPES, Geom, SURFACE_TYPES, UvCurve } from "./geom/types";
import type { Vec3 } from "./geom/vec";

export const PROTOCOL = 2;

export interface Style {
  color?: string;
  width?: number;
  dashed?: boolean;
  opacity?: number;
}

export interface SceneObject {
  id: string;
  geom: Geom;
  label?: string;
  group?: string;
  source?: string;
  style?: Style;
  extras?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export type ViewMode = "auto" | "2d" | "3d";

export interface SceneDoc {
  version: 2;
  title: string;
  run: string | null;
  view: ViewMode;
  objects: SceneObject[];
}

export interface Problem {
  id: string;
  message: string;
}

export type ServerEvent =
  | { type: "scene"; doc: unknown }
  | { type: "run"; run: string; keep: boolean }
  | { type: "upsert"; objects: unknown[]; title?: string; view?: string }
  | { type: "remove"; id: string }
  | { type: "clear" };

type FieldKind = "vec" | "vecs" | "num" | "nums" | "frame" | "str";

const FIELDS: Record<string, Record<string, FieldKind>> = {
  line: { o: "vec", d: "vec" },
  circle: { frame: "frame", r: "num" },
  ellipse: { frame: "frame", a: "num", b: "num" },
  parabola: { frame: "frame", f: "num" },
  hyperbola: { frame: "frame", a: "num", b: "num" },
  plane: { frame: "frame" },
  cylinder: { frame: "frame", r: "num" },
  cone: { frame: "frame", semi_angle: "num", ref_radius: "num" },
  sphere: { frame: "frame", r: "num" },
  torus: { frame: "frame", R: "num", r: "num" },
  polyline: { points: "vecs" },
  mesh: { vertices: "vecs", indices: "nums" },
  point: { p: "vec" },
  points: { positions: "vecs" },
  arrow: { at: "vec", vec: "vec" },
  text: { at: "vec", text: "str" },
  note: { text: "str" },
};
const POSITIVE = ["r", "a", "b", "R"];
const UV_CURVES: ReadonlySet<string> = new Set(["line", "circle", "polyline"]);
const PROFILE_TYPES: ReadonlySet<string> = new Set([...CURVE_TYPES, "polyline"]);
const VIEWS: ReadonlySet<string> = new Set(["auto", "2d", "3d"]);

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function asVec(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || (v.length !== 2 && v.length !== 3) || !v.every(finite)) return null;
  return [v[0], v[1], v.length === 3 ? v[2] : 0];
}

function normalize(value: unknown, kind: FieldKind): unknown {
  switch (kind) {
    case "vec":
      return asVec(value);
    case "vecs": {
      if (!Array.isArray(value)) return null;
      const vecs = value.map(asVec);
      return vecs.every((v) => v !== null) ? vecs : null;
    }
    case "num":
      return finite(value) ? value : null;
    case "nums":
      return Array.isArray(value) && value.every((i) => Number.isInteger(i) && i >= 0) ? value : null;
    case "str":
      return typeof value === "string" ? value : null;
    case "frame": {
      if (typeof value !== "object" || value === null) return null;
      const f = value as Record<string, unknown>;
      const axes = ["o", "x", "y", "z"].map((k) => asVec(f[k]));
      return axes.every((a) => a !== null) ? { o: axes[0], x: axes[1], y: axes[2], z: axes[3] } : null;
    }
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const isRange = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every(finite);

function validWindow(w: unknown): boolean {
  const r = record(w);
  return r !== undefined && (r.u === undefined || isRange(r.u)) && (r.v === undefined || isRange(r.v));
}

/** Validate one geometry (its `type` is a string): the normalized geometry, or why it is rejected. */
function parseGeom(g: Record<string, unknown>): Geom | string {
  const type = g.type as string;
  if (type === "pcurve") return parsePcurve(g);
  if (type === "extrusion" || type === "revolution") return parseSweepSurface(type, g);
  const fields = Object.prototype.hasOwnProperty.call(FIELDS, type) ? FIELDS[type] : undefined;
  if (!fields) return `unknown type "${type}"`;
  const geom: Record<string, unknown> = { ...g };
  for (const [key, kind] of Object.entries(fields)) {
    const value = normalize(g[key], kind);
    if (value === null) return `${type}.${key} is missing or malformed`;
    geom[key] = value;
  }
  for (const key of POSITIVE) if (key in fields && (geom[key] as number) <= 0) return `${type}.${key} must be positive`;
  if (type === "parabola" && geom.f === 0) return "parabola.f must be non-zero";
  if (type === "line" && Math.hypot(...(geom.d as Vec3)) === 0) return "line.d must be non-zero";
  if (type === "polyline" && (geom.points as Vec3[]).length < 2) return "polyline.points needs at least 2 points";
  if (type === "points" && (geom.positions as Vec3[]).length === 0) return "points.positions must not be empty";
  if (type === "mesh") {
    if ((geom.indices as number[]).length === 0) return "mesh.indices must be a non-empty multiple of 3";
    const n = (geom.vertices as Vec3[]).length;
    const idx = geom.indices as number[];
    if (idx.length % 3 !== 0 || idx.some((i) => i >= n)) return "mesh.indices must be triangles indexing vertices";
  }
  if ((type === "points" || type === "mesh") && (g.values !== undefined || g.colormap !== undefined)) {
    const count = type === "points" ? (geom.positions as Vec3[]).length
      : type === "mesh" ? (geom.vertices as Vec3[]).length : 0;
    const problem = parseScalars(type, g, geom, count);
    if (problem) return problem;
  }
  if (SURFACE_TYPES.has(type) && g.window !== undefined && !validWindow(g.window)) {
    return `${type}.window must be {u?: [a, b], v?: [a, b]}`;
  }
  if (CURVE_TYPES.has(type) && g.range !== undefined && !isRange(g.range)) return `${type}.range must be [t0, t1]`;
  return geom as unknown as Geom;
}

/** `values` (one per point or vertex) and `colormap` for a scalar-coloured cloud or mesh. */
function parseScalars(type: string, raw: Record<string, unknown>, geom: Record<string, unknown>,
                      count: number): string | undefined {
  if (raw.colormap !== undefined && typeof raw.colormap !== "string") return `${type}.colormap must be a string`;
  if (raw.values === undefined) return `${type}.colormap needs values`;
  if (!Array.isArray(raw.values) || !raw.values.every(finite)) return `${type}.values must be finite numbers`;
  if (raw.values.length !== count) {
    return `${type}.values needs one per ${type === "points" ? "point" : "vertex"} (${count})`;
  }
  geom.values = raw.values;
  if (raw.colormap !== undefined) geom.colormap = raw.colormap;
  return undefined;
}

/** An extrusion or revolution: its profile curve plus the sweep, and an optional window.
 * The profile is a curve or an index-parameterized polyline. */
function parseSweepSurface(type: "extrusion" | "revolution", g: Record<string, unknown>): Geom | string {
  const p = record(g.profile);
  if (!p || typeof p.type !== "string" || !PROFILE_TYPES.has(p.type)) {
    return `${type}.profile must be a curve or a polyline`;
  }
  const profile = parseGeom(p);
  if (typeof profile === "string") return `${type}.${profile}`;
  const direction = asVec(g.direction);
  if (direction === null || Math.hypot(...direction) === 0) return `${type}.direction must be a non-zero vector`;
  if (g.window !== undefined && !validWindow(g.window)) return `${type}.window must be {u?: [a, b], v?: [a, b]}`;
  const geom: Record<string, unknown> = { type, profile, direction };
  if (type === "revolution") {
    const origin = asVec(g.origin);
    if (origin === null) return "revolution.origin must be a point";
    geom.origin = origin;
  }
  if (g.window !== undefined) geom.window = g.window;
  return geom as unknown as Geom;
}

/** A pcurve: its surface's object id, and a line, circle or polyline in z = 0 holding (u, v). */
function parsePcurve(g: Record<string, unknown>): Geom | string {
  const surface = str(g.surface);
  if (surface === undefined) return "pcurve.surface must be an object id";
  const c = record(g.curve);
  if (!c || typeof c.type !== "string" || !UV_CURVES.has(c.type)) return "pcurve.curve must be a line, circle or polyline";
  const curve = parseGeom(c);
  if (typeof curve === "string") return `pcurve.${curve}`;
  if (!inPlaneZ0(curve)) return "pcurve.curve must lie in z = 0 (x is u, y is v)";
  return { type: "pcurve", surface, curve: curve as UvCurve };
}

/** Validate one object (v1 entities are migrated first). Never throws. */
export function parseObject(raw: unknown): { object: SceneObject } | { problem: Problem } {
  const r = record(raw);
  if (!r) return { problem: { id: "?", message: "object is not a JSON object" } };
  if (typeof r.kind === "string") return parseObject(migrateV1(r));
  const id = typeof r.id === "string" ? r.id : "?";
  const fail = (message: string) => ({ problem: { id, message } });
  if (id === "?") return fail("missing string id");
  const g = record(r.geom);
  if (!g || typeof g.type !== "string") return fail("missing geom.type");
  const geom = parseGeom(g);
  if (typeof geom === "string") return fail(geom);
  const object: SceneObject = { id, geom };
  const label = str(r.label);
  if (label) object.label = label;
  const group = str(r.group);
  if (group) object.group = group;
  const source = str(r.source);
  if (source) object.source = source;
  const style = record(r.style);
  if (style) object.style = style as Style;
  const extras = record(r.extras);
  if (extras) object.extras = extras;
  const meta = record(r.meta);
  if (meta) object.meta = meta;
  return { object };
}

/** v1 entity → v2 object (see SCENE.md "Compatibility"). */
export function migrateV1(e: Record<string, unknown>): Record<string, unknown> {
  const style: Style = {};
  if (typeof e.color === "string") style.color = e.color;
  if (typeof e.opacity === "number") style.opacity = e.opacity;
  const base: Record<string, unknown> = { id: e.id, label: e.name, style };
  switch (e.kind) {
    case "curve3d":
    case "curve2d":
      return { ...base, geom: { type: "polyline", points: e.points } };
    case "surface":
      return { ...base, geom: { type: "mesh", vertices: e.vertices, indices: e.indices } };
    case "points3d":
    case "points2d":
      return { ...base, geom: { type: "points", positions: e.positions, ...(e.size !== undefined ? { size: e.size } : {}) } };
    default:
      return { ...base, geom: { type: `v1:${String(e.kind)}` } };
  }
}

export class VersionError extends Error {}

/** Parse a v1 or v2 document; invalid objects become problems, other versions throw. */
export function parseDoc(raw: unknown): { doc: SceneDoc; problems: Problem[] } {
  const r = record(raw) ?? {};
  const items = r.version === 1 ? r.entities : r.version === PROTOCOL ? r.objects : undefined;
  if (!Array.isArray(items)) throw new VersionError(`unsupported scene version ${String(r.version)} (this viewer reads 1 and 2)`);
  const objects: SceneObject[] = [];
  const problems: Problem[] = [];
  for (const item of items) {
    const parsed = parseObject(item);
    if ("object" in parsed) objects.push(parsed.object);
    else problems.push(parsed.problem);
  }
  const view = typeof r.view === "string" && VIEWS.has(r.view) ? (r.view as ViewMode) : "auto";
  return { doc: { version: 2, title: str(r.title) ?? "", run: str(r.run) ?? null, view, objects }, problems };
}
