import { Page, expect, test } from "@playwright/test";

interface Camera {
  cx: number;
  cy: number;
  scale: number;
  width: number;
  height: number;
}
type Vec2 = [number, number];

const camera = (page: Page): Promise<Camera> =>
  page.evaluate(() => (window as unknown as { __gv: { view2d: { camera: Camera } } }).__gv.view2d.camera);

/** Screen extent of an object's strokes in the last frame, with the pane size. */
const strokeSpan = (page: Page, id: string) =>
  page.evaluate((id) => {
    const view = (window as unknown as { __gv: { view2d: { camera: Camera; strokesOf(id: string): { paths: Vec2[][] }[] } } })
      .__gv.view2d;
    const pts = view.strokesOf(id).flatMap((s) => s.paths.flat());
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const c = view.camera;
    return { n: pts.length, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), w: c.width, h: c.height };
  }, id);

/** Two animation frames: whatever a camera change scheduled has been drawn. */
const nextFrame = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/** Pairs of (tick label, object label) whose boxes on the page overlap by more than a pixel. */
const ticksUnderLabels = (page: Page) =>
  page.evaluate(() => {
    const boxes = (sel: string) => [...document.querySelectorAll(sel)].map((e) => ({ text: e.textContent, r: e.getBoundingClientRect() }));
    const labels = boxes(".labels .label");
    return boxes(".labels .tick").flatMap((t) =>
      labels
        .filter(({ r }) => t.r.left + 1 < r.right && r.left + 1 < t.r.right && t.r.top + 1 < r.bottom && r.top + 1 < t.r.bottom)
        .map((l) => `${t.text} under ${l.text}`),
    );
  });

const point = (id: string, x: number, y: number, group?: string) => ({
  id,
  label: id,
  geom: { type: "point", p: [x, y, 0] },
  ...(group ? { group } : {}),
});

test.beforeEach(async ({ request }) => {
  await request.post("/api/clear", { data: {} });
});

test("the sample scene renders in the plane view", async ({ page }) => {
  await page.goto("/?scene=sample-scene.json");
  await expect(page.locator("#title")).toHaveText("Conics and their intersections");
  await expect(page.locator("#stage")).toHaveAttribute("data-view", "2d");
  await expect(page.locator("#count")).toHaveText("17 objects");
  await expect(page.locator(".labels .label", { hasText: "P₂ (2.994, -0.123)" })).toBeVisible();
  await expect(page.locator(".labels .label.extra", { hasText: "F₁" })).toHaveCount(1);
  await expect.poll(async () => (await strokeSpan(page, "L")).n).toBeGreaterThan(1);
  await expect.poll(async () => (await strokeSpan(page, "A")).n).toBeGreaterThan(1);
  for (const id of ["T₁", "T₂", "U₁", "U₂"]) {
    await expect(page.locator(".labels .label", { hasText: new RegExp(`^${id} `) })).toBeVisible();
  }
  expect(await ticksUnderLabels(page)).toEqual([]);
});

test("zooming far out keeps line L spanning the view", async ({ page }) => {
  await page.goto("/?scene=sample-scene.json");
  await expect(page.locator("#count")).toHaveText("17 objects");
  await expect(page.locator(".labels .label", { hasText: "P₂ (2.994, -0.123)" })).toBeVisible(); // the sample is drawn
  const box = (await page.locator("#view2d").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 1500);
  await expect.poll(async () => (await camera(page)).scale).toBeLessThan(1);
  await nextFrame(page); // strokesOf reads the last drawn frame, so wait for the zoomed one
  await expect
    .poll(async () => {
      const s = await strokeSpan(page, "L");
      return (s.minX <= 0 && s.maxX >= s.w) || (s.minY <= 0 && s.maxY >= s.h);
    })
    .toBe(true);
});

test("a re-run swaps the scene but keeps the camera and hidden groups", async ({ page, request }) => {
  await request.post("/api/objects", { data: { run: "r1", title: "first", objects: [point("A", 0, 0), point("B", 1, 0, "other")] } });
  await page.goto("/");
  await expect(page.locator("#title")).toHaveText("first");
  await expect(page.locator("#run")).toHaveText("run 1");
  await expect(page.locator(".labels .label", { hasText: /^A / })).toBeVisible(); // drawn, so the camera is fitted
  const fitted = await camera(page);
  const box = (await page.locator("#view2d").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300); // the user zooms: auto-fit lets go of the camera
  await expect.poll(async () => (await camera(page)).scale).toBeLessThan(fitted.scale);
  const moved = await camera(page);

  const groupBox = page.locator('li.group[data-group="other"] .group-head input[type="checkbox"]');
  await groupBox.click();
  await expect(groupBox).not.toBeChecked();
  await expect(page.locator(".labels .label", { hasText: /^B / })).toHaveCount(0);

  await request.post("/api/objects", { data: { run: "r2", title: "second", objects: [point("C", 0.5, 0.5), point("D", 1, 1, "other")] } });
  await expect(page.locator("#title")).toHaveText("second");
  await expect(page.locator("#run")).toHaveText("run 2");
  await expect(page.locator(".labels .label", { hasText: "C (0.5, 0.5)" })).toBeVisible();
  await expect(page.locator(".labels .label", { hasText: /^D / })).toHaveCount(0);
  await expect(page.locator('li.group[data-group="other"] .group-head input[type="checkbox"]')).not.toBeChecked();
  expect(await camera(page)).toEqual(moved);
});

test("F fits the plane view with auto-fit off", async ({ page, request }) => {
  await request.post("/api/objects", { data: { run: "r1", title: "fit", objects: [point("A", 0, 0), point("B", 2, 1)] } });
  await page.goto("/");
  await expect(page.locator(".labels .label", { hasText: /^B / })).toBeVisible(); // drawn, so the camera is fitted
  await nextFrame(page);
  const fitted = await camera(page);
  await page.locator("#autofit").uncheck();
  const box = (await page.locator("#view2d").boundingBox())!;
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await camera(page)).scale).toBeLessThan(fitted.scale);
  await page.keyboard.press("f");
  await expect.poll(() => camera(page)).toEqual(fitted);
});

test("a selected object stays highlighted in the plane view until Esc", async ({ page, request }) => {
  await request.post("/api/objects", { data: { run: "r1", title: "select", objects: [point("A", 0, 0), point("B", 2, 1)] } });
  await page.goto("/");
  await expect(page.locator(".labels .label", { hasText: /^A / })).toBeVisible();
  await page.locator('li.object[data-id="A"]').click();
  await expect(page.locator(".labels .label.lit", { hasText: /^A / })).toBeVisible();
  await expect(page.locator(".labels .label.lit")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".labels .label.lit")).toHaveCount(0);
});

test("T switches the theme, P presents and Esc leaves", async ({ page }) => {
  await page.goto("/?scene=sample-scene.json");
  await expect(page.locator("#count")).toHaveText("17 objects");
  await page.keyboard.press("t");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("p");
  await expect(page.locator("#chrome")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#chrome")).toBeVisible();
  await page.keyboard.press("Control+t"); // a browser shortcut, not the viewer's T
  await nextFrame(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
