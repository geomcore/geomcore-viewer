import type { ArcRotateCamera } from "@babylonjs/core";
import type { Box } from "../geom/vec";

/** Panning feel (Babylon default 1000) at a camera radius of 10. */
const PAN_FEEL = 10000;
/**
 * Wheel zoom as a fraction of the current distance: one mouse-wheel notch
 * travels ~12% of the way, at any depth. (Babylon's default world-unit steps
 * scaled with the scene instead: a notch ate most of the radius, slammed the
 * camera into its target, and flipped the view.)
 */
export const WHEEL_PERCENTAGE = 0.012;

/**
 * Clip planes, pan feel and zoom limits for a scene that fits a camera at
 * `radius`. Babylon's defaults (clip 1 .. 10000, unbounded radius) would hide
 * scenes much smaller or larger than ~10 units, and let a zoom dive through
 * the target to the other side.
 */
export function cameraScale(radius: number) {
  return {
    minZ: radius / 1000,
    maxZ: radius * 100,
    panningSensibility: PAN_FEEL / radius,
    lowerRadiusLimit: radius / 100,
    upperRadiusLimit: radius * 100,
  };
}

/** The wheel input zooms by percentage of the current radius (see WHEEL_PERCENTAGE). */
export function initWheelZoom(camera: ArcRotateCamera): void {
  const wheel = camera.inputs.attached.mousewheel as { wheelDeltaPercentage?: number } | undefined;
  if (wheel) wheel.wheelDeltaPercentage = WHEEL_PERCENTAGE;
}

export type Snap = "top" | "front" | "right" | "iso";

/**
 * Snap views (spec §5.3) as ArcRotate angles for a z-up, right-handed scene, where the
 * camera sits at target + r (cos α sin β, −sin α sin β, cos β). Top looks down −z with x
 * right and y up, like the plane view; front looks along +y (x right, z up); right along −x
 * (y right, z up); iso from (1, −1, 1). Top needs the camera's lowerBetaLimit at 0.
 */
export const SNAPS: Record<Snap, { alpha: number; beta: number }> = {
  top: { alpha: Math.PI / 2, beta: 0 },
  front: { alpha: Math.PI / 2, beta: Math.PI / 2 },
  right: { alpha: 0, beta: Math.PI / 2 },
  iso: { alpha: Math.PI / 4, beta: Math.acos(1 / Math.sqrt(3)) },
};

/** Distance at which the camera frames `box` (the field of view is vertical, so a narrow pane backs off). */
export function fitRadius(box: Box, aspect: number): number {
  const halfDiagonal = Math.hypot(...box.max.map((m, i) => m - box.min[i])) / 2;
  return (Math.max(halfDiagonal, 1e-6) * 3) / Math.min(1, aspect || 1);
}

/** Orthographic extents that show at the target what the perspective camera at `radius` shows there. */
export function orthoExtents(radius: number, fov: number, aspect: number) {
  const half = radius * Math.tan(fov / 2);
  return { orthoTop: half, orthoBottom: -half, orthoLeft: -half * aspect, orthoRight: half * aspect };
}

export interface PixelGauge {
  ortho: boolean;
  /** Vertical field of view (perspective). */
  fov: number;
  /** orthoTop − orthoBottom (orthographic). */
  orthoHeight: number;
  /** The pane's height in CSS pixels. */
  heightPx: number;
}

/** World length of one CSS pixel at `depth` along the view direction (screen-size markers). */
export function pixelSize(g: PixelGauge, depth: number): number {
  const visible = g.ortho ? g.orthoHeight : 2 * Math.max(depth, 0) * Math.tan(g.fov / 2);
  return visible / Math.max(g.heightPx, 1);
}
