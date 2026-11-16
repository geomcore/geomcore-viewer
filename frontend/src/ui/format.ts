import type { Vec3 } from "../geom/vec";

/** A number with at most `decimals` decimals, trailing zeros dropped, never "-0". */
export function fmtNum(v: number, decimals = 3): string {
  if (Math.abs(v) >= 1e21) return String(v); // toFixed writes an exponent there, which the trim below would cut
  const s = v.toFixed(decimals);
  const trimmed = s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  return trimmed === "-0" ? "0" : trimmed;
}

/** "(x, y)" in the plane view, "(x, y, z)" in the 3D view, its panel and the (u,v) readout. */
export function fmtPoint(p: Vec3, dimensions: 2 | 3 = 3): string {
  const xy = `${fmtNum(p[0])}, ${fmtNum(p[1])}`;
  return dimensions === 2 ? `(${xy})` : `(${xy}, ${fmtNum(p[2])})`;
}

/** `meta.params` for the tooltip: a number, a tuple "(…)" or "—" for null; null when it is anything else. */
export function fmtParams(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return fmtNum(v, 4);
  if (v === null) return "—";
  if (Array.isArray(v)) {
    const parts = v.map(fmtParams);
    return parts.every((p) => p !== null) ? `(${parts.join(", ")})` : null;
  }
  return null;
}
