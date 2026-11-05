import { directionBounds, evalBsplineSurface, flatKnots } from "./bspline";
import type { Range, SurfaceGeom } from "./types";
import { Vec3, inFrame } from "./vec";

const TAU = 2 * Math.PI;

/** Point at `(u, v)` — formulas identical to geomcore (protocol/SCENE.md). */
export function evalSurface(g: SurfaceGeom, u: number, v: number): Vec3 {
  switch (g.type) {
    case "plane":
      return inFrame(g.frame, u, v);
    case "cylinder":
      return inFrame(g.frame, g.r * Math.cos(u), g.r * Math.sin(u), v);
    case "cone": {
      const radius = g.ref_radius + v * Math.sin(g.semi_angle);
      return inFrame(g.frame, radius * Math.cos(u), radius * Math.sin(u), v * Math.cos(g.semi_angle));
    }
    case "sphere": {
      const rc = g.r * Math.cos(v);
      return inFrame(g.frame, rc * Math.cos(u), rc * Math.sin(u), g.r * Math.sin(v));
    }
    case "torus": {
      const rho = g.R + g.r * Math.cos(v);
      return inFrame(g.frame, rho * Math.cos(u), rho * Math.sin(u), g.r * Math.sin(v));
    }
    case "bspline_surface":
      return evalBsplineSurface(
        g.u_degree, g.v_degree, g.nu, g.nv, g.poles, g.weights,
        g.u_knots, g.u_multiplicities, g.v_knots, g.v_multiplicities,
        g.u_periodic, g.v_periodic, u, v,
      );
  }
}

/** A B-spline direction's domain, from its knots. */
function bsplineDomain(knots: number[], mults: number[], degree: number, periodic: boolean): Range {
  return directionBounds(flatKnots(knots, mults), degree, periodic);
}

/** Full periods of closed parameter directions; null where the surface is infinite. */
export function naturalWindow(g: SurfaceGeom): { u: Range | null; v: Range | null } {
  switch (g.type) {
    case "plane":
      return { u: null, v: null };
    case "cylinder":
    case "cone":
      return { u: [0, TAU], v: null };
    case "sphere":
      return { u: [0, TAU], v: [-Math.PI / 2, Math.PI / 2] };
    case "torus":
      return { u: [0, TAU], v: [0, TAU] };
    case "bspline_surface":
      // A B-spline patch is finite by construction: its knot domain.
      return {
        u: bsplineDomain(g.u_knots, g.u_multiplicities, g.u_degree, g.u_periodic),
        v: bsplineDomain(g.v_knots, g.v_multiplicities, g.v_degree, g.v_periodic),
      };
  }
}

/** The period of each parameter direction that wraps around, null for one that does not. */
export function periods(g: SurfaceGeom): { u: number | null; v: number | null } {
  switch (g.type) {
    case "plane":
      return { u: null, v: null };
    case "cylinder":
    case "cone":
    case "sphere":
      return { u: TAU, v: null };
    case "torus":
      return { u: TAU, v: TAU };
    case "bspline_surface": {
      const u = bsplineDomain(g.u_knots, g.u_multiplicities, g.u_degree, g.u_periodic);
      const v = bsplineDomain(g.v_knots, g.v_multiplicities, g.v_degree, g.v_periodic);
      return { u: g.u_periodic ? u[1] - u[0] : null, v: g.v_periodic ? v[1] - v[0] : null };
    }
  }
}

/** Window to tessellate: explicit, else natural, else ±fallbackHalf (`assumed` = a fallback was used). */
export function surfaceWindow(g: SurfaceGeom, fallbackHalf: number): { u: Range; v: Range; assumed: boolean } {
  const natural = naturalWindow(g);
  const fallback: Range = [-fallbackHalf, fallbackHalf];
  const u = g.window?.u ?? natural.u;
  const v = g.window?.v ?? natural.v;
  return { u: u ?? fallback, v: v ?? fallback, assumed: u === null || v === null };
}
