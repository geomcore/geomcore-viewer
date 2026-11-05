import { readFileSync } from "node:fs";
import { APIRequestContext, Page, expect, test } from "@playwright/test";

/** Post a scene saved by an example script (`--save frontend/e2e/scenes/<name>.json`) to the server. */
async function postScene(request: APIRequestContext, name: string): Promise<void> {
  const doc = JSON.parse(readFileSync(new URL(`./scenes/${name}.json`, import.meta.url), "utf8"));
  const res = await request.post("/api/objects", { data: doc });
  expect(res.ok()).toBe(true);
}

/** Pixels of the 3D canvas within 40 (per channel) of `hex`, after two frames. */
const pixelsLike = (page: Page, hex: string) =>
  page.evaluate(async (hex) => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const src = document.getElementById("canvas3d") as HTMLCanvasElement;
    const c = document.createElement("canvas");
    [c.width, c.height] = [src.width, src.height];
    const ctx = c.getContext("2d")!;
    ctx.drawImage(src, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (want.every((w, k) => Math.abs(px[i + k] - w) <= 40)) n++;
    return n;
  }, hex);

type CameraState = { alpha: number; beta: number; radius: number; ortho: boolean };
const camera3d = (page: Page): Promise<CameraState> =>
  page.evaluate(() => (window as unknown as { __gv: { view3d: { cameraState: CameraState } } }).__gv.view3d.cameraState);

test.beforeEach(async ({ request }) => {
  await request.post("/api/clear", { data: {} });
});

test("the quadrics scene renders in 3D with its intersection curves", async ({ page, request }) => {
  await postScene(request, "quadrics_3d");
  await page.goto("/");
  await expect(page.locator("#stage")).toHaveAttribute("data-view", "3d");
  await expect(page.locator("#count")).toHaveText("7 objects");
  await expect.poll(() => pixelsLike(page, "#c47f00")).toBeGreaterThan(100); // SY₁, 3 px wide
  await expect.poll(() => pixelsLike(page, "#b5448f")).toBeGreaterThan(100); // ΠK
});

test("the 3D toolbar snaps the camera and switches to orthographic", async ({ page, request }) => {
  await postScene(request, "quadrics_3d");
  await page.goto("/");
  await expect(page.locator("#count")).toHaveText("7 objects");
  await page.locator(".toolbar3d [data-snap=top]").click();
  expect((await camera3d(page)).beta).toBeLessThan(1e-3);
  await page.locator(".toolbar3d [data-snap=front]").click();
  expect((await camera3d(page)).beta).toBeCloseTo(Math.PI / 2, 6);
  await page.locator(".toolbar3d [data-projection]").click();
  await expect(page.locator(".toolbar3d [data-projection]")).toHaveText("ortho");
  expect((await camera3d(page)).ortho).toBe(true);
  await expect.poll(() => pixelsLike(page, "#c47f00")).toBeGreaterThan(100);
});

test("hovering a 3D curve highlights it and shows its parameter and point", async ({ page, request }) => {
  await postScene(request, "quadrics_3d");
  await page.goto("/");
  await expect(page.locator("#count")).toHaveText("7 objects");
  await expect.poll(() => pixelsLike(page, "#c47f00")).toBeGreaterThan(100); // drawn, so the camera has its first frame
  const [x, y] = await page.evaluate(() => {
    const gv = (window as unknown as { __gv: { view3d: { screenOf(p: number[]): number[]; canvas: HTMLCanvasElement } } }).__gv;
    const s = gv.view3d.screenOf([0, -2, Math.sqrt(5)]); // SY₁: the circle of radius 2 at z = √5
    const r = gv.view3d.canvas.getBoundingClientRect();
    return [r.left + s[0], r.top + s[1]];
  });
  await page.mouse.move(x, y);
  const tooltip = page.locator("#view3d .tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator(".head")).toHaveText("SY₁ · circle");
  await expect(tooltip).toContainText("t = ");
  await expect(tooltip).toContainText(", 2.236)"); // on SY₁, whatever t the pointer lands on
  await expect(page.locator("#view3d .labels .label.lit")).toHaveText("SY₁");
});

test("the (u,v) pane shows the pcurves' surface, and U hides it", async ({ page, request }) => {
  await postScene(request, "pcurve");
  await page.goto("/");
  const pane = page.locator(".uvpane");
  await expect(pane).toBeVisible();
  await expect(pane.locator(".uv-title")).toHaveText("Y · cylinder (u, v)");
  await page.keyboard.press("u");
  await expect(pane).toBeHidden();
  await page.keyboard.press("u");
  await expect(pane).toBeVisible();
  await page.keyboard.press("2");
  await expect(pane).toBeHidden(); // it belongs to the 3D view
});

test("hover links the (u,v) pane and the 3D view both ways", async ({ page, request }) => {
  await postScene(request, "pcurve");
  await page.goto("/");
  await expect.poll(() => pixelsLike(page, "#00798c")).toBeGreaterThan(100); // the ring is drawn
  const box = (await page.locator(".uvpane canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".uv-readout")).toContainText("→ (");
  expect(await page.evaluate(() => (window as unknown as { __gv: { view3d: { scene: { getMeshByName(n: string): unknown } } } }).__gv.view3d.scene.getMeshByName("uv-cursor") !== null)).toBe(true);
  const [x, y] = await page.evaluate(() => {
    const gv = (window as unknown as { __gv: { view3d: { screenOf(p: number[]): number[]; canvas: HTMLCanvasElement } } }).__gv;
    const s = gv.view3d.screenOf([0, -2, 1.5]); // the ring at u = 3π/2, facing the camera
    const r = gv.view3d.canvas.getBoundingClientRect();
    return [r.left + s[0], r.top + s[1]];
  });
  await page.mouse.move(x, y);
  await expect(page.locator("#view3d .tooltip .head")).toHaveText("ring · pcurve");
  await expect(page.locator(".uv-readout")).toContainText("· v 1.5 → (");
});

test("selecting a surface shows it in the (u,v) pane", async ({ page, request }) => {
  await postScene(request, "quadrics_3d");
  await page.goto("/");
  await expect(page.locator("#count")).toHaveText("7 objects");
  await expect(page.locator(".uvpane")).toBeHidden(); // no pcurve, nothing selected
  await page.locator("#object-list li.object", { hasText: "S" }).first().click();
  await expect(page.locator(".uvpane .uv-title")).toHaveText("S · sphere (u, v)");
  await page.keyboard.press("Escape");
  await expect(page.locator(".uvpane")).toBeHidden();
});

test("the B-spline scene renders exact curves, patch, pcurve and box", async ({ page, request }) => {
  await postScene(request, "bspline");
  await page.goto("/");
  await expect(page.locator("#stage")).toHaveAttribute("data-view", "3d");
  await expect(page.locator("#count")).toHaveText("6 objects");
  await expect.poll(() => pixelsLike(page, "#00798c")).toBeGreaterThan(100); // the trimmed piece
  await expect(page.locator(".uvpane")).toBeVisible(); // the diag pcurve's surface
  await expect(page.locator(".uvpane .uv-title")).toHaveText("patch · bspline_surface (u, v)");
});

test("wheel zoom is gentle, proportional, and never dives through the target", async ({ page, request }) => {
  await postScene(request, "quadrics_3d");
  await page.goto("/");
  await page.waitForTimeout(800); // let auto-fit land first
  const state = () => page.evaluate(() => {
    const c = (window as unknown as { __gv: { view3d: { cameraState: { alpha: number; radius: number } } } })
      .__gv.view3d.cameraState;
    return { alpha: c.alpha, radius: c.radius };
  });
  const before = await state();
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -120); // one notch in
  await page.waitForTimeout(1200); // let inertia settle
  const after = await state();
  const ratio = after.radius / before.radius;
  expect(ratio).toBeGreaterThan(0.8); // ~12% closer, not a collapse
  expect(ratio).toBeLessThan(0.97);
  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(0, -240); // keep diving
    await page.waitForTimeout(250);
  }
  const deep = await state();
  expect(deep.radius).toBeGreaterThan(0); // clamped above the target: no flip to the far side
  expect(deep.alpha).toBeCloseTo(before.alpha, 6);
});

test("a hidden torus dashes and fades what it hides, and only that", async ({ page, request }) => {
  await postScene(request, "hidden_lines");
  await page.goto("/");
  await expect(page.locator("#count")).toHaveText("3 objects");
  // The core circle runs inside the tube: never seen, only its faint dashes (#d35400 towards the background, at 0.6).
  await expect.poll(() => pixelsLike(page, "#ebc2a8")).toBeGreaterThan(100);
  expect(await pixelsLike(page, "#d35400")).toBeLessThan(20);
  // The outer ring is in front of the torus over half its turn: solid there.
  await expect.poll(() => pixelsLike(page, "#2c7a3f")).toBeGreaterThan(100);
  // The torus's own front isolines and silhouette stay solid.
  await expect.poll(() => pixelsLike(page, "#3b6fd4")).toBeGreaterThan(100);

  // A torus switched off in the panel hides nothing; switched back on, it does again.
  const torus = page.locator('li.object[data-id="T"] input[type="checkbox"]');
  await torus.uncheck();
  await expect.poll(() => pixelsLike(page, "#d35400")).toBeGreaterThan(100);
  await torus.check();
  await expect.poll(() => pixelsLike(page, "#d35400")).toBeLessThan(20);

  // `"hide"` drops what is behind: the core circle is gone, neither solid nor faint. The faint
  // count never reaches 0 (the red axis's antialiasing is close), so compare it with the dashed one.
  const dashed = await pixelsLike(page, "#ebc2a8");
  const doc = JSON.parse(readFileSync(new URL("./scenes/hidden_lines.json", import.meta.url), "utf8"));
  doc.objects[0].extras = { wire: true, hidden: "hide" };
  expect((await request.post("/api/objects", { data: { objects: [doc.objects[0]] } })).ok()).toBe(true);
  await expect.poll(() => pixelsLike(page, "#ebc2a8")).toBeLessThan(dashed - 300);
  expect(await pixelsLike(page, "#d35400")).toBeLessThan(20);
  await expect.poll(() => pixelsLike(page, "#2c7a3f")).toBeGreaterThan(100);

  // Without `hidden`, the wireframe hides nothing: the core circle is solid again.
  doc.objects[0].extras = { wire: true };
  expect((await request.post("/api/objects", { data: { objects: [doc.objects[0]] } })).ok()).toBe(true);
  await expect.poll(() => pixelsLike(page, "#d35400")).toBeGreaterThan(100);
});
