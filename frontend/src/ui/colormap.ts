/** Value → colour maps for scalar fields on point clouds and meshes (protocol `colormap`). */
export type Rgb = [number, number, number];

/** Perceptually even maps as RGB anchors, sampled linearly in sRGB. */
const MAPS: Record<string, Rgb[]> = {
  viridis: [
    [0.267, 0.005, 0.329], [0.282, 0.14, 0.458], [0.254, 0.265, 0.53], [0.207, 0.372, 0.553],
    [0.164, 0.471, 0.558], [0.128, 0.567, 0.551], [0.135, 0.659, 0.518], [0.267, 0.749, 0.441],
    [0.478, 0.821, 0.318], [0.741, 0.873, 0.15], [0.993, 0.906, 0.144],
  ],
  plasma: [
    [0.05, 0.03, 0.528], [0.216, 0.07, 0.605], [0.418, 0.001, 0.658], [0.604, 0.106, 0.588],
    [0.741, 0.216, 0.522], [0.846, 0.341, 0.42], [0.925, 0.475, 0.325], [0.973, 0.62, 0.227],
    [0.992, 0.765, 0.153], [0.973, 0.91, 0.188], [0.941, 0.975, 0.131],
  ],
  turbo: [
    [0.188, 0.071, 0.232], [0.255, 0.271, 0.671], [0.275, 0.459, 0.929], [0.224, 0.635, 0.988],
    [0.106, 0.812, 0.831], [0.141, 0.925, 0.651], [0.38, 0.988, 0.424], [0.643, 0.988, 0.243],
    [0.82, 0.91, 0.204], [0.953, 0.776, 0.227], [0.996, 0.608, 0.176], [0.953, 0.388, 0.082],
    [0.796, 0.165, 0.016], [0.478, 0.016, 0.012],
  ],
  coolwarm: [
    [0.23, 0.299, 0.753], [0.404, 0.533, 0.933], [0.604, 0.733, 1.0], [0.788, 0.843, 0.941],
    [0.929, 0.929, 0.918], [0.969, 0.831, 0.753], [0.965, 0.647, 0.51], [0.886, 0.412, 0.322],
    [0.706, 0.016, 0.149],
  ],
  gray: [[0, 0, 0], [1, 1, 1]],
};

export const COLORMAPS: readonly string[] = Object.keys(MAPS);
export const DEFAULT_COLORMAP = "viridis";

const clamp01 = (t: number): number => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0);

/** The RGB colour of `t` ∈ [0, 1] in a named map; an unknown name falls back to viridis. */
export function colormapRgb(name: string | undefined, t: number): Rgb {
  const stops = (name !== undefined && MAPS[name]) || MAPS[DEFAULT_COLORMAP];
  const x = clamp01(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const s = x - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

const hex2 = (x: number): string => Math.round(clamp01(x) * 255).toString(16).padStart(2, "0");

/** The CSS hex colour of `t` in a named map. */
export function colormapHex(name: string | undefined, t: number): string {
  const [r, g, b] = colormapRgb(name, t);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** Normalized positions of `values` across their own range (a constant field sits at 0.5). */
export function normalized(values: readonly number[]): number[] {
  let low = Infinity;
  let high = -Infinity;
  for (const v of values) {
    if (v < low) low = v;
    if (v > high) high = v;
  }
  if (!(high > low)) return values.map(() => 0.5);
  return values.map((v) => (v - low) / (high - low));
}

/** One hex colour per value. */
export function scalarColors(values: readonly number[], colormap?: string): string[] {
  return normalized(values).map((t) => colormapHex(colormap, t));
}

/** One RGBA vertex colour per value, as Babylon's flat float buffer. */
export function scalarRgba(values: readonly number[], colormap?: string): number[] {
  const out: number[] = [];
  for (const t of normalized(values)) {
    const [r, g, b] = colormapRgb(colormap, t);
    out.push(r, g, b, 1);
  }
  return out;
}
