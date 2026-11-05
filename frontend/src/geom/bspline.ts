import type { Range } from "./types";
import type { Vec3 } from "./vec";

/**
 * Exact B-spline evaluation, mirroring geomcore (`curve_math/bspline.rs`,
 * `surface_math/bspline.rs`): Cox–de Boor basis functions (The NURBS Book,
 * A2.2), tensor-product for surfaces, homogeneous divide when rational.
 *
 * A direction is `degree`, distinct `knots` with `multiplicities`, and
 * `periodic`. A non-periodic parameter is clamped into its domain; a
 * periodic one wraps into its period (`last` itself closes the last span);
 * pole indices wrap modulo the pole count.
 */

/** One parametric direction: the wire form both clients send. */
export interface BsplineDirection {
  degree: number;
  knots: number[];
  multiplicities: number[];
  periodic: boolean;
}

/** The flat knot vector: knot `i` repeated `mults[i]` times. */
export function flatKnots(knots: number[], mults: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < knots.length; i++) for (let m = 0; m < mults[i]; m++) out.push(knots[i]);
  return out;
}

/** A direction's domain: the knot bounds, inset by `degree` when open. */
export function directionBounds(flat: number[], degree: number, periodic: boolean): Range {
  return periodic ? [flat[0], flat[flat.length - 1]] : [flat[degree], flat[flat.length - 1 - degree]];
}

/** `u` wrapped into the half-open `[first, last)` (see geomcore's `in_period`). */
function inPeriod(u: number, first: number, last: number): number {
  if (u >= first && u < last) return u;
  const period = last - first;
  return Math.max(first, u + period * Math.ceil((first - u) / period));
}

interface Span {
  /** Index of the first of the `degree + 1` weighting poles. */
  first: number;
  /** The non-zero basis functions there. */
  values: number[];
}

/** Cox–de Boor values from the knots around the span (NURBS Book A2.2). */
function basisValues(degree: number, left: number[], right: number[]): number[] {
  const out = [1];
  for (let j = 1; j <= degree; j++) {
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = out[r] / (right[r + 1] + left[j - r]);
      out[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    out[j] = saved;
  }
  return out;
}

/**
 * Locate `u`: the span's first pole and non-zero basis functions.
 * `poles` is the pole count (for wrapping); `seam` the first knot's
 * multiplicity (the periodic pole shift).
 */
export function locate(
  flat: number[],
  degree: number,
  periodic: boolean,
  poles: number,
  seam: number,
  u: number,
): Span {
  const left: number[] = [0];
  const right: number[] = [0];
  if (!periodic) {
    const lo = degree;
    const hi = flat.length - 1 - degree;
    const uc = Math.min(Math.max(u, flat[lo]), flat[hi]);
    // Rightmost lo <= s < hi with flat[s] <= u, then back over zero-width spans.
    let span = lo;
    let length = hi - lo;
    while (length > 1) {
      const half = Math.floor(length / 2);
      if (flat[span + half] <= uc) span += half;
      length -= half;
    }
    while (span > lo && flat[span] >= flat[span + 1]) span--;
    for (let j = 1; j <= degree; j++) {
      left[j] = uc - flat[span + 1 - j];
      right[j] = flat[span + j] - uc;
    }
    return { first: span - degree, values: basisValues(degree, left, right) };
  }
  const first = flat[0];
  const last = flat[flat.length - 1];
  const period = last - first;
  const uu = u === last ? last : inPeriod(u, first, last);
  // One period's knots: all but the trailing seam run, as many as the poles.
  const block = flat.slice(0, poles);
  const len = block.length;
  let local = 0;
  for (let i = 0; i < len; i++) if (block[i] <= uu) local = i;
  const knot = (i: number): number => {
    const k = ((i % len) + len) % len;
    return block[k] + period * Math.floor(i / len);
  };
  for (let j = 1; j <= degree; j++) {
    left[j] = uu - knot(local + 1 - j);
    right[j] = knot(local + j) - uu;
  }
  // Pole 0 starts the span opening at the last copy of the first knot.
  return { first: (local + poles + 1 - seam) % poles, values: basisValues(degree, left, right) };
}

/** Homogeneous weighted sum of the span's poles, divided unless non-rational. */
function sumSpan(
  pts: Vec3[],
  weights: number[] | undefined,
  n: number,
  periodic: boolean,
  first: number,
  values: number[],
): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  for (let j = 0; j < values.length; j++) {
    const index = periodic ? (first + j) % n : first + j;
    const p = pts[index];
    const b = weights ? values[j] * weights[index] : values[j];
    x += b * p[0];
    y += b * p[1];
    z += b * p[2];
    w += b;
  }
  return weights ? [x / w, y / w, z / w] : [x, y, z];
}

/** Point of a B-spline curve at `t`. */
export function evalBsplineCurve(
  degree: number,
  poles: Vec3[],
  weights: number[] | undefined,
  knots: number[],
  multiplicities: number[],
  periodic: boolean,
  t: number,
): Vec3 {
  const flat = flatKnots(knots, multiplicities);
  const { first, values } = locate(flat, degree, periodic, poles.length, multiplicities[0], t);
  return sumSpan(poles, weights, poles.length, periodic, first, values);
}

/** Point of a B-spline surface at `(u, v)`; poles are `nu` rows of `nv`, u-major. */
export function evalBsplineSurface(
  uDegree: number,
  vDegree: number,
  nu: number,
  nv: number,
  poles: Vec3[],
  weights: number[] | undefined,
  uKnots: number[],
  uMults: number[],
  vKnots: number[],
  vMults: number[],
  uPeriodic: boolean,
  vPeriodic: boolean,
  u: number,
  v: number,
): Vec3 {
  const uFlat = flatKnots(uKnots, uMults);
  const vFlat = flatKnots(vKnots, vMults);
  const su = locate(uFlat, uDegree, uPeriodic, nu, uMults[0], u);
  const sv = locate(vFlat, vDegree, vPeriodic, nv, vMults[0], v);
  // Tensor product: row iu (wrapping in periodic u), then along v (wrapping
  // only a periodic direction's last spans).
  const wrapsV = sv.first + vDegree >= nv;
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  for (let i = 0; i < su.values.length; i++) {
    const iu = uPeriodic ? (su.first + i) % nu : su.first + i;
    let ax = 0;
    let ay = 0;
    let az = 0;
    let aw = 0;
    for (let j = 0; j < sv.values.length; j++) {
      const iv = wrapsV ? (sv.first + j) % nv : sv.first + j;
      const index = iu * nv + iv;
      const p = poles[index];
      const b = weights ? sv.values[j] * weights[index] : sv.values[j];
      ax += b * p[0];
      ay += b * p[1];
      az += b * p[2];
      aw += b;
    }
    x += su.values[i] * ax;
    y += su.values[i] * ay;
    z += su.values[i] * az;
    w += su.values[i] * aw;
  }
  return weights ? [x / w, y / w, z / w] : [x, y, z];
}
