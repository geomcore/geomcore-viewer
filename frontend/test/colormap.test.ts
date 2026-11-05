import { describe, expect, it } from "vitest";
import {
  COLORMAPS,
  DEFAULT_COLORMAP,
  colormapHex,
  colormapRgb,
  normalized,
  scalarColors,
  scalarRgba,
} from "../src/ui/colormap";

describe("colormaps", () => {
  it("clamps to the first and last anchors and stays inside the gamut", () => {
    expect(colormapHex("viridis", -1)).toBe(colormapHex("viridis", 0));
    expect(colormapHex("viridis", 2)).toBe(colormapHex("viridis", 1));
    for (const name of COLORMAPS) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const rgb = colormapRgb(name, t);
        expect(rgb.every((c) => c >= 0 && c <= 1), `${name} at ${t}`).toBe(true);
        expect(colormapHex(name, t)).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("falls back to the default map for an unknown name", () => {
    expect(colormapHex("nope", 0.3)).toBe(colormapHex(DEFAULT_COLORMAP, 0.3));
  });

  it("normalizes a field over its own range, with a constant field in the middle", () => {
    expect(normalized([2, 4, 6])).toEqual([0, 0.5, 1]);
    expect(normalized([3, 3])).toEqual([0.5, 0.5]);
    expect(normalized([])).toEqual([]);
  });

  it("makes one colour or one RGBA vertex per value", () => {
    expect(scalarColors([0, 1], "turbo")).toHaveLength(2);
    const rgba = scalarRgba([0, 0.5, 1], "coolwarm");
    expect(rgba).toHaveLength(12);
    expect(rgba.filter((_, i) => i % 4 === 3)).toEqual([1, 1, 1]);
  });
});
