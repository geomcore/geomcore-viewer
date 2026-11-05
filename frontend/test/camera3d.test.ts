import { ArcRotateCamera, Camera, Matrix, NullEngine, Scene, Vector3, Viewport } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { Vec3 } from "../src/geom/vec";
import { SNAPS, Snap, WHEEL_PERCENTAGE, cameraScale, fitRadius, initWheelZoom, orthoExtents, pixelSize } from "../src/view3d/camera";

const W = 400;
const H = 300;

/** A z-up, right-handed Babylon scene without WebGL, like the view's. */
function rig() {
  const engine = new NullEngine({ renderWidth: W, renderHeight: H, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const cam = new ArcRotateCamera("cam", 0, 1, 10, Vector3.Zero(), scene);
  cam.upVector = new Vector3(0, 0, 1);
  cam.lowerBetaLimit = 0;
  const project = (p: Vec3): [number, number] => {
    scene.updateTransformMatrix(true);
    const s = Vector3.Project(new Vector3(...p), Matrix.Identity(), scene.getTransformMatrix(), new Viewport(0, 0, W, H));
    return [s.x, s.y];
  };
  return { cam, project };
}

function snapTo(cam: ArcRotateCamera, snap: Snap): void {
  cam.alpha = SNAPS[snap].alpha;
  cam.beta = SNAPS[snap].beta;
}

describe("cameraScale", () => {
  it("keeps Babylon's default pan feel at a radius of 10 and brackets the zoom", () => {
    const s = cameraScale(10);
    expect(s.panningSensibility).toBeCloseTo(1000);
    expect(s.lowerRadiusLimit).toBeCloseTo(0.1);
    expect(s.upperRadiusLimit).toBeCloseTo(1000);
  });

  it("scales the clip planes, pan feel and zoom limits with the scene", () => {
    const small = cameraScale(0.01);
    const large = cameraScale(1000);
    expect(small.minZ).toBeCloseTo(1e-5);
    expect(small.maxZ).toBeCloseTo(1);
    expect(large.maxZ).toBeCloseTo(1e5);
    expect(small.panningSensibility).toBeGreaterThan(large.panningSensibility);
    expect(small.lowerRadiusLimit).toBeCloseTo(1e-4);
    expect(large.upperRadiusLimit).toBeCloseTo(1e5);
  });

  it("zooms by a fixed gentle fraction of the current radius", () => {
    expect(WHEEL_PERCENTAGE).toBeGreaterThan(0);
    expect(WHEEL_PERCENTAGE).toBeLessThan(0.05);
    const { cam } = rig();
    initWheelZoom(cam);
    const wheel = cam.inputs.attached.mousewheel as { wheelDeltaPercentage?: number };
    expect(wheel.wheelDeltaPercentage).toBe(WHEEL_PERCENTAGE);
  });
});

describe("snap views", () => {
  /** Screen direction of a world axis from the origin: [right, up] in pixels. */
  const screenDir = (snap: Snap, axis: Vec3): [number, number] => {
    const { cam, project } = rig();
    snapTo(cam, snap);
    const [ox, oy] = project([0, 0, 0]);
    const [x, y] = project(axis);
    return [x - ox, oy - y];
  };
  // Babylon nudges β = 0 off the pole by 1e-4 rad: the view axis then shows as a few thousandths of a pixel.
  const right = (d: [number, number]) => d[0] > 10 && Math.abs(d[1]) < 0.01;
  const up = (d: [number, number]) => d[1] > 10 && Math.abs(d[0]) < 0.01;
  const away = (d: [number, number]) => Math.hypot(...d) < 0.01;

  it("top looks down z with x right and y up, like the plane view", () => {
    expect(right(screenDir("top", [1, 0, 0]))).toBe(true);
    expect(up(screenDir("top", [0, 1, 0]))).toBe(true);
    expect(away(screenDir("top", [0, 0, 1]))).toBe(true);
  });

  it("front shows x right and z up", () => {
    expect(right(screenDir("front", [1, 0, 0]))).toBe(true);
    expect(up(screenDir("front", [0, 0, 1]))).toBe(true);
    expect(away(screenDir("front", [0, 1, 0]))).toBe(true);
  });

  it("right shows y right and z up", () => {
    expect(right(screenDir("right", [0, 1, 0]))).toBe(true);
    expect(up(screenDir("right", [0, 0, 1]))).toBe(true);
    expect(away(screenDir("right", [1, 0, 0]))).toBe(true);
  });

  it("iso sits on the (1, −1, 1) diagonal with z up", () => {
    const { cam } = rig();
    snapTo(cam, "iso");
    cam.getViewMatrix(true); // the camera's position follows its angles when the view matrix is rebuilt
    const p = cam.position.normalizeToNew();
    [p.x, p.y, p.z].forEach((c, i) => expect(c).toBeCloseTo([1, -1, 1][i] / Math.sqrt(3), 9));
    expect(screenDir("iso", [0, 0, 1])[1]).toBeGreaterThan(10);
  });
});

describe("orthographic camera", () => {
  it("shows at the target what the perspective camera shows there", () => {
    const { cam, project } = rig();
    snapTo(cam, "front");
    const edge: Vec3 = [0, 0, 10 * Math.tan(cam.fov / 2)]; // the top of the perspective view at the target
    expect(project(edge)[1]).toBeCloseTo(0, 4);
    cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    Object.assign(cam, orthoExtents(cam.radius, cam.fov, W / H));
    expect(project(edge)[1]).toBeCloseTo(0, 4);
    expect(project([10 * Math.tan(cam.fov / 2) * (W / H), 0, 0])[0]).toBeCloseTo(W, 4);
  });
});

describe("pixelSize", () => {
  it("is the world length that projects to one pixel, in perspective and orthographic", () => {
    const { cam, project } = rig();
    snapTo(cam, "front");
    const at = (z: number, depth: number): Vec3 => [0, depth - 10, z]; // the camera is at y = -10, looking along +y
    for (const depth of [5, 10, 20]) {
      const s = pixelSize({ ortho: false, fov: cam.fov, orthoHeight: 0, heightPx: H }, depth);
      expect(project(at(0, depth))[1] - project(at(s, depth))[1]).toBeCloseTo(1, 6);
    }
    cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    const ex = orthoExtents(cam.radius, cam.fov, W / H);
    Object.assign(cam, ex);
    const s = pixelSize({ ortho: true, fov: cam.fov, orthoHeight: ex.orthoTop - ex.orthoBottom, heightPx: H }, 123);
    expect(project([0, 0, 0])[1] - project([0, 0, s])[1]).toBeCloseTo(1, 6);
  });
});

describe("fitRadius", () => {
  it("backs off three half-diagonals, more in a narrow pane", () => {
    const box = { min: [0, 0, 0] as Vec3, max: [2, 2, 1] as Vec3 };
    expect(fitRadius(box, 2)).toBeCloseTo(4.5, 12);
    expect(fitRadius(box, 0.5)).toBeCloseTo(9, 12);
    expect(fitRadius({ min: [1, 1, 1], max: [1, 1, 1] }, 1)).toBeCloseTo(3e-6, 18);
  });
});
