import * as PIXI from "pixi.js";
import { sceneBounds } from "../geom/bounds";
import { inPlaneZ0 } from "../geom/planar";
import type { Vec2 } from "../geom/vec";
import { FrameScheduler } from "../frame";
import type { Store, StoreEvent } from "../store";
import { LabelItem, LabelLayer, TextMeasure } from "../ui/labels";
import type { UiEvent, UiState } from "../ui/state";
import { PALETTES, Palette } from "../ui/theme";
import { Camera2D, fitCamera, panBy, resizeCamera, shouldRefit, visibleRect, worldToScreen, zoomAt } from "./camera";
import { Hit, pickNearest } from "./pick";
import { LabelBox, placeLabels, uncoveredTicks } from "./placement";
import { formatTick, gridSpacing, ticks } from "./plane";
import { DrawList, Stroke, buildDrawList, describeHit } from "./render";

const LABEL_PX = 13;
const TICK_PX = 11;
/** Minor grid lines closer than this are left out. */
const MINOR_MIN_PX = 8;
const DRAG_PX = 3;
const WHEEL_ZOOM = 0.0015;
const EMPTY: DrawList = { strokes: [], dots: [], texts: [], pickables: [] };

/** A DOM label with its box on screen, so tick labels can give way to object labels. */
type BoxedLabel = LabelItem & LabelBox;

/** The plane z = 0 (spec §5.2): PixiJS strokes and dots, DOM labels, pan, zoom, hover and click. */
export class View2D {
  private app = new PIXI.Application();
  private grid = new PIXI.Graphics();
  private shapes = new PIXI.Graphics();
  private ready = false;
  private active = false;
  private cam: Camera2D = fitCamera(null, 0, 0);
  private userMoved = false;
  private sceneChanged = true;
  /** A "fit" waiting for the next drawn frame (which may come only once the view is shown). */
  private fitPending = false;
  private framePending = false;
  private list: DrawList = EMPTY;
  private highlight: string | null = null;
  private pointer: Vec2 | null = null;
  private labels: LabelLayer;
  private tooltip: HTMLDivElement;
  private measure = new TextMeasure();
  private frame = new FrameScheduler(() => this.draw());

  constructor(
    private store: Store,
    private ui: UiState,
    private host: HTMLElement,
    private notify: (message: string) => void,
    /** Where the init failure goes (it must outlive a toast); defaults to `notify`. */
    private onFailure: (message: string) => void = notify,
  ) {
    this.labels = new LabelLayer(host);
    this.tooltip = document.createElement("div");
    this.tooltip.className = "tooltip";
    this.tooltip.hidden = true;
    host.appendChild(this.tooltip);
    store.onChange((ev) => this.onStore(ev));
    ui.onChange((ev) => this.onUi(ev));
    new ResizeObserver(() => this.frame.request()).observe(host);
    this.listen();
    void this.app
      .init({
        autoStart: false,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
        preference: "webgl",
        background: PALETTES[ui.theme].bg,
        width: Math.max(host.clientWidth, 1),
        height: Math.max(host.clientHeight, 1),
      })
      .then(() => {
        host.prepend(this.app.canvas);
        this.app.stage.addChild(this.grid, this.shapes);
        this.ready = true;
        this.frame.request();
      })
      .catch((err: unknown) => {
        console.error("geomcore-viewer: 2D view failed", err);
        onFailure(`2D view failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** Debug and e2e access: the current camera. */
  get camera(): Camera2D {
    return { ...this.cam };
  }

  /** Debug and e2e access: the strokes of one object in the last frame, in screen pixels. */
  strokesOf(id: string): Stroke[] {
    return this.list.strokes.filter((s) => s.id === id);
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.frame.request();
  }

  /** The "fit" button or key, or auto-fit turned back on: frame the scene and follow it again. */
  fitRequested(): void {
    this.userMoved = false;
    this.fitPending = true;
    this.frame.request();
  }

  private onStore(ev: StoreEvent): void {
    if (ev.type === "meta") return;
    this.sceneChanged = true;
    this.frame.request();
  }

  private onUi(ev: UiEvent): void {
    if (ev === "autofit") {
      if (this.ui.autoFit) this.fitRequested();
    } else if (ev === "selection") {
      // Framing needs a laid-out camera: a hidden or never-drawn pane would get a degenerate scale, so wait for draw().
      if (this.active && this.cam.width > 0 && this.cam.height > 0) this.frameSelected();
      else this.framePending = true;
      this.frame.request(); // the selection is drawn highlighted, and a cleared one no longer is
    } else if (ev !== "collapse" && ev !== "view") {
      this.frame.request(); // theme, presentation mode, visibility
    }
  }

  /** Frame the selected object; a point (or an infinite curve, whose box is its origin) is only centred. */
  private frameSelected(): void {
    const o = this.ui.selected ? this.store.objects.get(this.ui.selected) : undefined;
    if (!o || !inPlaneZ0(o.geom) || o.geom.type === "note") return;
    const box = sceneBounds([o.geom]);
    if (!box) return;
    const flat = box.max[0] === box.min[0] && box.max[1] === box.min[1];
    this.cam = flat
      ? { ...this.cam, cx: box.min[0], cy: box.min[1] }
      : fitCamera(box, this.cam.width, this.cam.height);
    this.userMoved = true;
    this.frame.request();
  }

  private planarBounds() {
    const geoms = [];
    for (const o of this.store.objects.values()) if (o.geom.type !== "note" && inPlaneZ0(o.geom)) geoms.push(o.geom);
    return sceneBounds(geoms);
  }

  private get palette(): Palette {
    return PALETTES[this.ui.theme];
  }

  private get widthScale(): number {
    return this.ui.presenting ? 1.5 : 1;
  }

  private draw(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!this.ready || !this.active || width === 0 || height === 0) return;
    if (this.app.screen.width !== width || this.app.screen.height !== height) this.app.renderer.resize(width, height);
    const refit = shouldRefit({
      fitRequested: this.fitPending,
      autoFit: this.ui.autoFit,
      userMoved: this.userMoved,
      sceneChanged: this.sceneChanged,
      resized: this.cam.width !== width || this.cam.height !== height,
    });
    this.cam = refit ? fitCamera(this.planarBounds(), width, height) : resizeCamera(this.cam, width, height);
    this.sceneChanged = false;
    this.fitPending = false;
    if (this.framePending) {
      this.framePending = false;
      this.frameSelected();
    }
    const palette = this.palette;
    this.app.renderer.background.color = palette.bg;
    const tickLabels = this.drawGrid(palette);
    this.list = buildDrawList(this.store.objects.values(), this.cam, {
      visible: (o) => this.ui.isVisible(o),
      palette,
      widthScale: this.widthScale,
      highlight: this.highlight,
      selected: this.ui.selected,
    });
    if (this.highlight && !this.list.pickables.some((p) => p.id === this.highlight)) this.hover(null);
    this.paint();
    const texts = this.placeTexts();
    this.labels.render([...uncoveredTicks(tickLabels, texts), ...texts]);
    this.app.render();
  }

  /** Minor and major grid lines, the axes, and the tick labels pinned inside the pane. */
  private drawGrid(palette: Palette): BoxedLabel[] {
    const g = this.grid.clear();
    const c = this.cam;
    const r = visibleRect(c);
    const { major, minor } = gridSpacing(c.scale);
    const vertical = (x: number, color: string, width: number) => {
      const sx = Math.round(worldToScreen(c, x, 0)[0]) + 0.5;
      g.moveTo(sx, 0).lineTo(sx, c.height).stroke({ width, color });
    };
    const horizontal = (y: number, color: string, width: number) => {
      const sy = Math.round(worldToScreen(c, 0, y)[1]) + 0.5;
      g.moveTo(0, sy).lineTo(c.width, sy).stroke({ width, color });
    };
    if (minor * c.scale >= MINOR_MIN_PX) {
      for (const x of ticks(r.xmin, r.xmax, minor)) vertical(x, palette.gridMinor, 1);
      for (const y of ticks(r.ymin, r.ymax, minor)) horizontal(y, palette.gridMinor, 1);
    }
    const xs = ticks(r.xmin, r.xmax, major);
    const ys = ticks(r.ymin, r.ymax, major);
    for (const x of xs) vertical(x, palette.gridMajor, 1);
    for (const y of ys) horizontal(y, palette.gridMajor, 1);
    const [ox, oy] = worldToScreen(c, 0, 0);
    if (ox >= 0 && ox <= c.width) vertical(0, palette.axis, 1.5);
    if (oy >= 0 && oy <= c.height) horizontal(0, palette.axis, 1.5);

    const px = TICK_PX * this.widthScale;
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    const labelTop = clamp(oy + 4, 2, c.height - px * 1.4 - 2); // the x labels follow the x axis, kept on screen
    const items: BoxedLabel[] = [];
    for (const x of xs) {
      const text = formatTick(x, major);
      if (text === "0") continue; // the origin is labelled once, on the y axis
      const left = worldToScreen(c, x, 0)[0] + 3;
      const size = this.textSize(text, px);
      items.push({ key: `tx:${text}`, text, left, top: labelTop, ...size, className: "tick", fontPx: px, color: palette.axis });
    }
    for (const y of ys) {
      const text = formatTick(y, major);
      const size = this.textSize(text, px);
      const left = clamp(ox + 4, 2, c.width - size.w);
      const top = worldToScreen(c, 0, y)[1] - px * 1.4;
      items.push({ key: `ty:${text}`, text, left, top, ...size, className: "tick", fontPx: px, color: palette.axis });
    }
    return items;
  }

  private paint(): void {
    const g = this.shapes.clear();
    const bg = this.palette.bg;
    for (const s of this.list.strokes) {
      let any = false;
      for (const path of s.paths) {
        if (path.length < 2) continue;
        g.moveTo(path[0][0], path[0][1]);
        for (let i = 1; i < path.length; i++) g.lineTo(path[i][0], path[i][1]);
        any = true;
      }
      if (any) g.stroke({ width: s.width, color: s.color, alpha: s.alpha, cap: "round", join: "round" });
    }
    for (const d of this.list.dots) {
      g.circle(d.at[0], d.at[1], d.radius);
      if (d.hollow) g.fill({ color: bg }).stroke({ width: 1.5 * this.widthScale, color: d.color, alpha: d.alpha });
      else g.fill({ color: d.color, alpha: d.alpha });
    }
  }

  /** A label's size on screen: its measured width plus a margin, by the line height of `.labels` (1.35). */
  private textSize(text: string, px: number, weight = 400): { w: number; h: number } {
    return { w: Math.ceil(this.measure.width(text, px, weight)) + 2, h: Math.ceil(px * 1.35) };
  }

  /** Object labels where they do not overlap (spec §5.2), as DOM items. */
  private placeTexts(): BoxedLabel[] {
    if (!this.ui.showLabels) return [];
    const px = LABEL_PX * this.widthScale;
    const requests = this.list.texts.map((t) => ({
      key: t.key,
      ax: t.at[0],
      ay: t.at[1],
      ...this.textSize(t.text, px, 600),
      fixed: t.kind === "text",
    }));
    const byKey = new Map(this.list.texts.map((t, i) => [t.key, { t, size: requests[i] }]));
    return placeLabels(requests, this.cam.width, this.cam.height).map((p) => {
      const { t, size } = byKey.get(p.key)!;
      const lit = t.id === this.highlight || t.id === this.ui.selected;
      const className = t.kind === "extra" ? "label extra" : lit ? "label lit" : "label";
      return { key: p.key, text: t.text, left: p.left, top: p.top, w: size.w, h: size.h, className, fontPx: px, color: t.color };
    });
  }

  private hit(x: number, y: number): Hit | null {
    return pickNearest(this.list.pickables, x, y);
  }

  /** Highlight the hovered object and show its tooltip (null hides both). */
  private hover(hit: Hit | null): void {
    const id = hit?.id ?? null;
    if (id !== this.highlight) {
      this.highlight = id;
      this.frame.request();
    }
    const o = hit ? this.store.objects.get(hit.id) : undefined;
    if (!hit || !o || !this.pointer) {
      this.tooltip.hidden = true;
      return;
    }
    this.tooltip.replaceChildren(
      ...describeHit(o, hit, this.cam).map((line, i) => {
        const div = document.createElement("div");
        if (i === 0) div.className = "head";
        div.textContent = line;
        return div;
      }),
    );
    this.tooltip.hidden = false;
    const [px, py] = this.pointer;
    const left = px + 14 + this.tooltip.offsetWidth > this.cam.width ? px - 14 - this.tooltip.offsetWidth : px + 14;
    this.tooltip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, py + 14)}px)`;
  }

  /** Clicking a point copies its coordinates; clicking a curve does nothing (hover already shows it). */
  private click(x: number, y: number): void {
    const hit = this.hit(x, y);
    const o = hit ? this.store.objects.get(hit.id) : undefined;
    if (!hit || !o) return;
    const g = o.geom;
    const p = g.type === "point" ? g.p : g.type === "points" && hit.index !== null ? g.positions[hit.index] : null;
    if (!p) return;
    const text = `(${p[0]}, ${p[1]})`;
    const label = o.label ?? o.id;
    if (!navigator.clipboard) {
      this.notify(`${label} ${text}: copying needs https or localhost`);
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => this.notify(`copied ${label} ${text}`),
      () => this.notify(`could not copy ${label} ${text}`),
    );
  }

  private listen(): void {
    const host = this.host;
    host.style.touchAction = "none";
    let down: { x: number; y: number; id: number; dragging: boolean } | null = null;
    const local = (ev: PointerEvent | WheelEvent): Vec2 => {
      const rect = host.getBoundingClientRect();
      return [ev.clientX - rect.left, ev.clientY - rect.top];
    };
    host.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || (ev.target as Element).closest?.(".label")) return; // labels stay selectable
      const [x, y] = local(ev);
      down = { x, y, id: ev.pointerId, dragging: false };
      host.setPointerCapture(ev.pointerId);
    });
    host.addEventListener("pointermove", (ev) => {
      const [x, y] = local(ev);
      this.pointer = [x, y];
      if (!down) {
        this.hover(this.hit(x, y));
        return;
      }
      if (!down.dragging && Math.hypot(x - down.x, y - down.y) < DRAG_PX) return;
      if (!down.dragging) this.hover(null);
      this.cam = panBy(this.cam, x - down.x, y - down.y);
      down.x = x;
      down.y = y;
      down.dragging = true;
      this.userMoved = true;
      this.frame.request();
    });
    const release = (ev: PointerEvent, click: boolean) => {
      if (!down || ev.pointerId !== down.id) return;
      if (click && !down.dragging) this.click(...local(ev));
      down = null;
      if (host.hasPointerCapture(ev.pointerId)) host.releasePointerCapture(ev.pointerId);
    };
    host.addEventListener("pointerup", (ev) => release(ev, true));
    host.addEventListener("pointercancel", (ev) => release(ev, false));
    host.addEventListener("pointerleave", () => {
      this.pointer = null;
      if (!down) this.hover(null);
    });
    host.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const [x, y] = local(ev);
        const delta = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY; // lines → pixels (Firefox)
        this.cam = zoomAt(this.cam, x, y, Math.exp(-delta * WHEEL_ZOOM));
        this.userMoved = true;
        this.frame.request();
      },
      { passive: false },
    );
  }
}
