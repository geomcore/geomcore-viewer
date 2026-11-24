import { FrameScheduler } from "../frame";
import { viewBox } from "../geom/bounds";
import { evalSurface } from "../geom/surfaces";
import type { Vec2 } from "../geom/vec";
import type { Store } from "../store";
import { fmtNum } from "../ui/format";
import { FONT_FAMILY } from "../ui/labels";
import type { UiState } from "../ui/state";
import { PALETTES } from "../ui/theme";
import { gridSpacing, ticks } from "../view2d/plane";
import { HoverLink } from "./link";
import { PlotRect, UvModel, fromPane, hoverText, toPane, uvModel, uvSubject, wrapUv } from "./model";

/** Space for tick labels and axis names around the plot. */
const PAD = { left: 44, right: 18, top: 12, bottom: 26 };
const LINE_PX = 2;
const DASH: [number, number] = [6, 4];

/**
 * The linked (u,v) pane (spec §5.4): a pane alongside the 3D view showing a surface's (u,v)
 * window, its seams and the pcurves on it. Hover in it puts a marker on the surface in 3D;
 * hover on the surface or a pcurve in 3D puts one here.
 */
export class UvPane {
  readonly root: HTMLDivElement;
  private title: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private readout: HTMLDivElement;
  private ctx: CanvasRenderingContext2D | null;
  private active = false;
  private model: UvModel | null = null;
  private frame = new FrameScheduler(() => this.draw());

  constructor(
    private store: Store,
    private ui: UiState,
    private link: HoverLink,
    host: HTMLElement,
    private toggle: HTMLButtonElement,
  ) {
    this.root = document.createElement("div");
    this.root.id = "surface-domain";
    this.root.className = "uvpane";
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-labelledby", "uv-title");
    this.root.hidden = true;
    this.title = document.createElement("div");
    this.title.id = "uv-title";
    this.title.className = "uv-title";
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-label", "Surface parameter plot");
    this.readout = document.createElement("div");
    this.readout.className = "uv-readout";
    this.root.append(this.title, this.canvas, this.readout);
    host.appendChild(this.root);
    this.ctx = this.canvas.getContext("2d");
    toggle.addEventListener("click", () => ui.toggleUvPane());
    new ResizeObserver(() => this.frame.request()).observe(this.canvas);
    store.onChange(() => this.frame.request());
    ui.onChange(() => this.frame.request());
    link.onChange(() => this.frame.request());
    this.canvas.addEventListener("pointermove", (ev) => this.pointer(ev));
    this.canvas.addEventListener("pointerleave", () => {
      if (this.link.current?.from === "uv") this.link.set(null);
    });
  }

  /** Debug and e2e access: what the pane shows (null when hidden). */
  get shown(): UvModel | null {
    return this.root.hidden ? null : this.model;
  }

  /** The pane belongs to the 3D view: it is drawn only while that view is shown. */
  setActive(active: boolean): void {
    this.active = active;
    this.frame.request();
  }

  private get scale(): number {
    return this.ui.presenting && this.canvas.clientHeight >= 180 ? 1.25 : 1;
  }

  private plot(): PlotRect {
    const k = this.scale;
    return {
      left: PAD.left * k,
      top: PAD.top * k,
      width: Math.max(1, this.canvas.clientWidth - (PAD.left + PAD.right) * k),
      height: Math.max(1, this.canvas.clientHeight - (PAD.top + PAD.bottom) * k),
    };
  }

  private pointer(ev: PointerEvent): void {
    const m = this.model;
    if (!m) return;
    const r = this.canvas.getBoundingClientRect();
    const { uv, inside } = fromPane(m, this.plot(), [ev.clientX - r.left, ev.clientY - r.top]);
    if (inside) this.link.set({ surface: m.surface.id, uv, from: "uv" });
    else if (this.link.current?.from === "uv") this.link.set(null);
  }

  private draw(): void {
    const available = this.active ? uvSubject(this.store.objects, this.ui.selected) : null;
    const subject = this.ui.uvPane ? available : null;
    this.toggle.hidden = !available;
    this.toggle.setAttribute("aria-pressed", String(Boolean(subject)));
    if (this.link.current?.from === "uv" && (!subject || this.link.current.surface !== subject.id)) this.link.set(null);
    this.root.hidden = !subject;
    if (!subject || !this.ctx) {
      this.model = null;
      return;
    }
    const objects = [...this.store.objects.values()];
    const m = uvModel(objects, subject, viewBox(objects.map((o) => o.geom)), (o) => this.ui.isVisible(o));
    this.model = m;
    const k = this.scale;
    const [w, h] = [this.canvas.clientWidth, this.canvas.clientHeight];
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      [this.canvas.width, this.canvas.height] = [Math.round(w * dpr), Math.round(h * dpr)];
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const palette = PALETTES[this.ui.theme];
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, w, h);
    const r = this.plot();
    const at = (uv: Vec2) => toPane(m, r, uv);
    const segment = (a: Vec2, b: Vec2, color: string, width: number, dash: number[] = []) => {
      ctx.beginPath();
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.moveTo(...at(a));
      ctx.lineTo(...at(b));
      ctx.stroke();
    };

    // Grid and tick labels: about four steps across each direction.
    ctx.font = `${10 * k}px ${FONT_FAMILY}`;
    ctx.fillStyle = palette.axis;
    const su = gridSpacing(1, (m.u[1] - m.u[0]) / 4).major;
    const sv = gridSpacing(1, (m.v[1] - m.v[0]) / 4).major;
    for (const u of ticks(m.u[0], m.u[1], su)) {
      segment([u, m.v[0]], [u, m.v[1]], palette.gridMajor, 1);
      const [x] = at([u, m.v[0]]);
      ctx.textAlign = "center";
      ctx.fillText(fmtNum(u, 2), x, h - 9 * k);
    }
    for (const v of ticks(m.v[0], m.v[1], sv)) {
      segment([m.u[0], v], [m.u[1], v], palette.gridMajor, 1);
      const [, y] = at([m.u[0], v]);
      ctx.textAlign = "right";
      ctx.fillText(fmtNum(v, 2), r.left - 4 * k, y + 3 * k);
    }
    ctx.textAlign = "center";
    ctx.fillText("u", w - 7 * k, h - 9 * k);
    ctx.fillText("v", 10 * k, 12 * k);
    ctx.setLineDash([]);
    ctx.strokeStyle = palette.axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.left, r.top, r.width, r.height);
    // Seams: where the surface's parameter wraps around.
    for (const u of m.seams.u) segment([u, m.v[0]], [u, m.v[1]], palette.axis, 1.5 * k, [3 * k, 3 * k]);
    for (const v of m.seams.v) segment([m.u[0], v], [m.u[1], v], palette.axis, 1.5 * k, [3 * k, 3 * k]);

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.left, r.top, r.width, r.height);
    ctx.clip();
    for (const c of m.curves) {
      ctx.setLineDash(c.dashed ? DASH.map((d) => d * k) : []);
      ctx.strokeStyle = c.color;
      ctx.lineWidth = LINE_PX * k;
      ctx.beginPath();
      for (const path of c.paths) {
        ctx.moveTo(...at(path[0]));
        for (const p of path.slice(1)) ctx.lineTo(...at(p));
      }
      ctx.stroke();
    }
    const hover = this.link.current;
    if (hover && hover.surface === m.surface.id) {
      const [x, y] = at(wrapUv(m, hover.uv));
      ctx.setLineDash([]);
      ctx.fillStyle = palette.text;
      ctx.beginPath();
      ctx.arc(x, y, 4 * k, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();

    const label = m.surface.label ?? m.surface.id;
    this.title.textContent = `${label} · ${m.geom.type} (u, v)`;
    this.title.title = this.title.textContent;
    const readout = hover && hover.surface === m.surface.id
      ? hoverText(hover.uv, evalSurface(m.geom, hover.uv[0], hover.uv[1]))
      : "";
    this.readout.textContent = readout;
    this.readout.title = readout;
  }
}
