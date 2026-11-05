import * as BABYLON from "@babylonjs/core";
import { Changes, FrameScheduler } from "../frame";
import { sameBox, sceneBounds, viewBox } from "../geom/bounds";
import { uvAt } from "../geom/pcurve";
import { evalSurface } from "../geom/surfaces";
import { isPcurve, isSurface } from "../geom/types";
import type { Box, Vec2, Vec3 } from "../geom/vec";
import type { SceneObject } from "../protocol";
import type { Store } from "../store";
import { LabelItem, LabelLayer, TextMeasure } from "../ui/labels";
import type { UiEvent, UiState } from "../ui/state";
import { PALETTES, Palette, mixHex } from "../ui/theme";
import { placeLabels } from "../view2d/placement";
import type { HoverLink, UvHover } from "../viewuv/link";
import { EXTRA_MIX, TextKind } from "../view2d/render";
import { SNAPS, Snap, cameraScale, fitRadius, orthoExtents, pixelSize } from "./camera";
import { Hit3D, Project, describeHit3D, pickProjected, surfaceUv } from "./pick";
import { Lines3D, Markers3D, ObjectDraw3D, POINT_PX, Text3D, hasCurves, objectDraw3D, screenPx } from "./render";
import { Ground, ground } from "./scene";

const v3 = (p: Vec3) => new BABYLON.Vector3(p[0], p[1], p[2]);
const color3 = (hex: string) => BABYLON.Color3.FromHexString(hex);
/** GreasedLine's width is twice what it covers on screen (measured: width 6 draws 3 px). */
const GREASED_PER_PX = 2;
const AXIS_PX = 2;
const LABEL_PX = 13;
/** Labels of the hovered or selected object first, then text, points, curves and surfaces, extras last. */
const KIND_ORDER: Record<TextKind, number> = { text: 0, point: 1, curve: 2, extra: 3 };

/** One object's Babylon meshes, kept with what they were built from (highlight and marker sizes change per frame). */
interface Built {
  draw: ObjectDraw3D;
  meshes: BABYLON.AbstractMesh[];
  lines: { mesh: BABYLON.GreasedLineBaseMesh; part: Lines3D }[];
  markers: Marker[];
  surface: BABYLON.StandardMaterial | null;
}

/** Thin-instanced spheres and the positions they stand at. */
interface Marker {
  mesh: BABYLON.Mesh;
  part: Markers3D;
  matrices: Float32Array;
}

/**
 * The 3D view (spec §5.3), z up and right-handed like geomcore: constant-pixel GreasedLine
 * curves, tessellated surfaces, screen-size markers, a ground grid and axis triad, and a
 * toolbar for perspective/orthographic and the snap views. Renders only while shown.
 */
export class View3D {
  readonly scene: BABYLON.Scene;
  readonly camera: BABYLON.ArcRotateCamera;
  readonly canvas: HTMLCanvasElement;
  private engine: BABYLON.Engine;
  private built = new Map<string, Built>();
  private groundMeshes: BABYLON.AbstractMesh[] = [];
  private box: Box = viewBox([]);
  private withCurves = false;
  private ortho = false;
  private userMoved = false;
  private active = false;
  /** A "fit" waiting for a shown, laid-out pane (a hidden canvas would give a stale aspect). */
  private fitPending = true;
  private framePending = false;
  private changes = new Changes();
  private frame = new FrameScheduler(() => this.flush());
  private toolbar: HTMLDivElement;
  private axes: Ground["axes"] = [];
  private labels: LabelLayer;
  private tooltip: HTMLDivElement;
  private measure = new TextMeasure();
  /** Labels follow the camera: re-placed after a frame in which it (or the scene) moved. */
  private labelsDirty = true;
  private hover: Hit3D | null = null;
  /** The point the (u,v) pane's pointer is at, S(u, v), on its surface. */
  private cursor: Marker | null = null;

  constructor(
    private store: Store,
    private ui: UiState,
    private host: HTMLElement,
    private link: HoverLink,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "canvas3d";
    host.appendChild(this.canvas);
    this.engine = new BABYLON.Engine(this.canvas, true, { preserveDrawingBuffer: true, stencil: false });
    this.scene = new BABYLON.Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.camera = new BABYLON.ArcRotateCamera("cam", SNAPS.iso.alpha, SNAPS.iso.beta, 10, BABYLON.Vector3.Zero(), this.scene);
    this.camera.upVector = new BABYLON.Vector3(0, 0, 1);
    this.camera.lowerBetaLimit = 0; // the top view looks straight down
    this.camera.attachControl(this.canvas, true);
    // Once the user has orbited, panned or zoomed, auto-fit leaves the camera alone until "fit".
    this.canvas.addEventListener("pointermove", (ev) => {
      if (ev.buttons) this.userMoved = true;
    });
    this.canvas.addEventListener("wheel", () => (this.userMoved = true), { passive: true });
    this.canvas.addEventListener("keydown", (ev) => {
      if (ev.key.startsWith("Arrow")) this.userMoved = true; // the camera's keyboard input
    });
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0.3, 0.5, 1), this.scene);
    // The grid is a backdrop: drawn first (group 0) without writing depth, then the scene
    // (group 1) over it, so curves lying on z = 0 are not speckled by the lines they cross.
    this.scene.setRenderingAutoClearDepthStencil(1, false, false, false);
    this.scene.onBeforeRenderObservable.add(() => this.beforeRender());
    this.scene.onAfterRenderObservable.add(() => this.afterRender());
    this.camera.onViewMatrixChangedObservable.add(() => (this.labelsDirty = true));
    this.toolbar = this.makeToolbar();
    this.labels = new LabelLayer(host);
    this.tooltip = document.createElement("div");
    this.tooltip.className = "tooltip";
    this.tooltip.hidden = true;
    host.appendChild(this.tooltip);
    this.listenHover();
    link.onChange((h) => this.showCursor(h));
    store.onChange((ev) => {
      if (ev.type === "meta") return;
      this.changes.note(ev);
      this.frame.request();
    });
    ui.onChange((ev) => this.uiChanged(ev));
    new ResizeObserver(() => {
      if (!this.active) return;
      this.resize();
      this.frame.request();
    }).observe(host);
    this.applyTheme();
    this.rebuild();
  }

  /** Debug and e2e access: the camera's position and projection. */
  get cameraState(): { alpha: number; beta: number; radius: number; target: Vec3; ortho: boolean } {
    const t = this.camera.target;
    return { alpha: this.camera.alpha, beta: this.camera.beta, radius: this.camera.radius, target: [t.x, t.y, t.z], ortho: this.ortho };
  }

  /** Debug and e2e access: where a world point is drawn on the canvas (null behind the camera). */
  screenOf(p: Vec3): Vec2 | null {
    return this.projector()(p);
  }

  /** Render (and apply pending changes) only while the 3D view is the one shown. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      this.resize();
      this.engine.runRenderLoop(() => this.scene.render());
      this.frame.request();
    } else {
      this.engine.stopRenderLoop();
    }
  }

  /** The "fit" button or key (or turning auto-fit on): frame the scene and follow it again, once the pane is shown. */
  fitRequested(): void {
    this.userMoved = false;
    this.fitPending = true;
    this.frame.request();
  }

  setSnap(snap: Snap): void {
    this.camera.alpha = SNAPS[snap].alpha;
    this.camera.beta = SNAPS[snap].beta;
  }

  setOrtho(ortho: boolean): void {
    this.ortho = ortho;
    this.camera.mode = ortho ? BABYLON.Camera.ORTHOGRAPHIC_CAMERA : BABYLON.Camera.PERSPECTIVE_CAMERA;
    this.toolbar.querySelector("[data-projection]")!.textContent = ortho ? "ortho" : "persp";
  }

  private makeToolbar(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "toolbar3d";
    const button = (text: string, title: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      b.addEventListener("click", onClick);
      bar.appendChild(b);
      return b;
    };
    button("persp", "Perspective or orthographic", () => this.setOrtho(!this.ortho)).dataset.projection = "";
    for (const snap of ["top", "front", "right", "iso"] as Snap[]) button(snap, `${snap} view`, () => this.setSnap(snap)).dataset.snap = snap;
    this.host.appendChild(bar);
    return bar;
  }

  private get palette(): Palette {
    return PALETTES[this.ui.theme];
  }

  private get widthScale(): number {
    return this.ui.presenting ? 1.5 : 1;
  }

  private resize(): void {
    this.engine.resize();
    this.labelsDirty = true;
    const resolution = new BABYLON.Vector2(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    for (const b of this.built.values()) for (const l of b.lines) l.mesh.greasedLineMaterial!.resolution = resolution;
    for (const m of this.groundMeshes) {
      const line = m as BABYLON.GreasedLineBaseMesh;
      if (line.greasedLineMaterial) line.greasedLineMaterial.resolution = resolution;
    }
  }

  /** Babylon's own size never reads 0 (resize() falls back to a default), so ask the element. */
  private laidOut(): boolean {
    return this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0;
  }

  /** Store changes folded since the last frame. While hidden they keep accumulating. */
  private flush(): void {
    if (!this.active || !this.laidOut()) return;
    const { reset, ids } = this.changes.take();
    const objects = [...this.store.objects.values()];
    const box = viewBox(objects.map((o) => o.geom));
    const withCurves = hasCurves(objects);
    // Infinite curves, default surface windows and default opacity depend on the whole scene: rebuild when they move.
    if (reset || !sameBox(box, this.box) || withCurves !== this.withCurves) {
      this.rebuild();
    } else {
      const touched = new Set(ids);
      for (const o of objects) if (isPcurve(o.geom) && touched.has(o.geom.surface)) touched.add(o.id); // a pcurve follows its surface
      for (const id of touched) {
        const o = this.store.objects.get(id);
        if (o) this.show(o);
        else this.drop(id);
      }
    }
    if (this.fitPending || (this.ui.autoFit && !this.userMoved)) {
      this.fit();
      this.fitPending = false;
    } else {
      this.applyScale();
    }
    if (this.framePending) {
      this.framePending = false;
      this.frameSelected();
    }
    if (this.hover && !this.built.has(this.hover.id)) this.setHover(null, null);
  }

  private uiChanged(ev: UiEvent): void {
    if (ev === "theme") {
      this.applyTheme();
      this.rebuild(); // extras and the grid take their colours from the palette
    } else if (ev === "labels") {
      this.labelsDirty = true;
    } else if (ev === "visibility" || ev === "frame") {
      for (const [id, b] of this.built) {
        const o = this.store.objects.get(id);
        const visible = o ? this.ui.isVisible(o) : false;
        b.meshes.forEach((m) => m.setEnabled(visible));
      }
      this.labelsDirty = true;
    } else if (ev === "selection") {
      this.applyHighlight();
      // The radius depends on the pane's aspect ratio: a hidden or unsized canvas would get a wrong one, so wait for a flush.
      this.framePending = true;
      this.frame.request();
    } else if (ev === "presenting") {
      this.applyHighlight();
      this.labelsDirty = true;
    } else if (ev === "autofit" && this.ui.autoFit) {
      this.fitRequested();
    }
  }

  private applyTheme(): void {
    this.scene.clearColor = BABYLON.Color4.FromHexString(`${this.palette.bg}ff`);
  }

  /** Frame the selected object; one without extent (a point, an infinite curve's origin) is only re-targeted. */
  private frameSelected(): void {
    const o = this.ui.selected ? this.store.objects.get(this.ui.selected) : undefined;
    const b = o ? sceneBounds([o.geom]) : null;
    if (!b) return;
    this.camera.target.copyFrom(v3(b.min).add(v3(b.max)).scale(0.5));
    if (v3(b.max).subtract(v3(b.min)).length() > 0) this.camera.radius = fitRadius(b, this.engine.getAspectRatio(this.camera));
    this.userMoved = true;
  }

  /** Clip planes and zoom feel follow the scene's size, also when the camera is not moved. */
  private applyScale(): void {
    const b = sceneBounds(this.geoms());
    if (b) Object.assign(this.camera, cameraScale(fitRadius(b, this.engine.getAspectRatio(this.camera))));
  }

  private fit(): void {
    const b = sceneBounds(this.geoms());
    if (!b) return;
    this.camera.target.copyFrom(v3(b.min).add(v3(b.max)).scale(0.5));
    this.camera.radius = fitRadius(b, this.engine.getAspectRatio(this.camera));
    this.applyScale();
  }

  private geoms() {
    return [...this.store.objects.values()].map((o) => o.geom);
  }

  /** Per frame: orthographic extents follow the zoom, markers keep their pixel size. */
  private beforeRender(): void {
    const aspect = this.engine.getAspectRatio(this.camera);
    if (this.ortho) Object.assign(this.camera, orthoExtents(this.camera.radius, this.camera.fov, aspect));
    const gauge = {
      ortho: this.ortho,
      fov: this.camera.fov,
      orthoHeight: (this.camera.orthoTop ?? 0) - (this.camera.orthoBottom ?? 0),
      heightPx: this.engine.getRenderHeight(),
    };
    const eye = this.camera.position;
    const forward = this.camera.getForwardRay(1).direction;
    const ws = this.widthScale;
    const size = ({ mesh, part, matrices }: Marker, lit: boolean) => {
      const px = screenPx(part.px, ws, lit);
      part.at.forEach((p, i) => {
        const depth = (p[0] - eye.x) * forward.x + (p[1] - eye.y) * forward.y + (p[2] - eye.z) * forward.z;
        const s = 2 * px * pixelSize(gauge, depth); // the marker mesh is a unit-diameter sphere
        BABYLON.Matrix.ScalingToRef(s, s, s, scratch);
        scratch.setTranslationFromFloats(p[0], p[1], p[2]);
        scratch.copyToArray(matrices, 16 * i);
      });
      mesh.thinInstanceBufferUpdated("matrix");
    };
    for (const b of this.built.values()) {
      const lit = this.isLit(b.draw.id);
      for (const marker of b.markers) size(marker, lit);
    }
    if (this.cursor) size(this.cursor, false);
  }

  /** Spec §5.4: the (u,v) pane's pointer, shown on its surface at S(u, v). */
  private showCursor(h: UvHover | null): void {
    if (this.cursor) disposeMesh(this.cursor.mesh);
    this.cursor = null;
    const s = h?.from === "uv" ? this.store.objects.get(h.surface)?.geom : undefined;
    if (!h || !s || !isSurface(s)) return;
    const at = evalSurface(s, h.uv[0], h.uv[1]);
    this.cursor = this.markers("uv-cursor", { id: h.surface, at: [at], color: this.palette.text, px: POINT_PX, alpha: 1, extra: false });
    this.cursor.mesh.renderingGroupId = 1;
  }

  /** Spec §5.4: a hover on a surface or a pcurve tells the (u,v) pane where it is. */
  private publish(hit: Hit3D | null): void {
    const o = hit ? this.store.objects.get(hit.id) : undefined;
    let next: UvHover | null = null;
    if (hit && o && hit.uv) next = { surface: o.id, uv: hit.uv, from: "3d" };
    else if (hit && o && isPcurve(o.geom) && hit.t !== null) next = { surface: o.geom.surface, uv: uvAt(o.geom.curve, hit.t), from: "3d" };
    if (next || this.link.current?.from === "3d") this.link.set(next);
  }

  private isLit(id: string): boolean {
    return id === this.ui.selected || id === this.hover?.id;
  }

  /** Line widths and surface glow for the selection and presentation mode. */
  private applyHighlight(): void {
    for (const b of this.built.values()) this.applyHighlightTo(b);
  }

  private applyHighlightTo(b: Built): void {
    const lit = this.isLit(b.draw.id);
    const ws = this.widthScale;
    for (const { mesh, part } of b.lines) mesh.greasedLineMaterial!.width = GREASED_PER_PX * screenPx(part.px, ws, lit && !part.extra);
    if (b.surface) b.surface.emissiveColor = lit ? b.surface.diffuseColor.scale(0.35) : BABYLON.Color3.Black();
  }

  private rebuild(): void {
    const objects = [...this.store.objects.values()];
    this.box = viewBox(objects.map((o) => o.geom));
    this.withCurves = hasCurves(objects);
    for (const id of [...this.built.keys()]) this.drop(id);
    for (const o of objects) this.show(o);
    this.buildGround();
  }

  /** World → canvas pixels with the camera of the last frame; null behind a perspective camera. */
  private projector(): Project {
    const vp = this.camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    const transform = this.scene.getTransformMatrix();
    const eye = this.camera.position;
    const fwd = this.camera.getForwardRay(1).direction;
    const near = this.camera.minZ;
    const out = new BABYLON.Vector3();
    return (p) => {
      if (!this.ortho && (p[0] - eye.x) * fwd.x + (p[1] - eye.y) * fwd.y + (p[2] - eye.z) * fwd.z <= near) return null;
      BABYLON.Vector3.ProjectToRef(v3(p), BABYLON.Matrix.IdentityReadOnly, transform, vp, out);
      return [out.x, out.y];
    };
  }

  private afterRender(): void {
    if (!this.labelsDirty) return;
    this.labelsDirty = false;
    this.renderLabels();
  }

  /** A label's size on screen: its measured width plus a margin, by the line height of `.labels` (1.35). */
  private textSize(text: string, px: number, weight = 400): { w: number; h: number } {
    return { w: Math.ceil(this.measure.width(text, px, weight)) + 2, h: Math.ceil(px * 1.35) };
  }

  /** Spec §5.3: labels as a projected DOM overlay, placed like the plane view's; the axis letters at the triad's tips. */
  private renderLabels(): void {
    const project = this.projector();
    const px = LABEL_PX * this.widthScale;
    const texts: (Text3D & { s: [number, number] })[] = [];
    if (this.ui.showLabels) {
      for (const [id, b] of this.built) {
        const o = this.store.objects.get(id);
        if (!o || !this.ui.isVisible(o)) continue;
        for (const t of b.draw.texts) {
          const s = project(t.at);
          if (s) texts.push({ ...t, s });
        }
      }
    }
    const rank = (t: Text3D) => (this.isLit(t.id) ? -1 : KIND_ORDER[t.kind]);
    texts.sort((a, b) => rank(a) - rank(b));
    const sizes = texts.map((t) => this.textSize(t.text, px, 600));
    const requests = texts.map((t, i) => ({ key: t.key, ax: t.s[0], ay: t.s[1], ...sizes[i], fixed: t.kind === "text" }));
    const byKey = new Map(texts.map((t, i) => [t.key, { t, size: sizes[i] }]));
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const palette = this.palette;
    const items: LabelItem[] = placeLabels(requests, w, h).map((p) => {
      const { t } = byKey.get(p.key)!;
      const className = t.kind === "extra" ? "label extra" : this.isLit(t.id) ? "label lit" : "label";
      return { key: p.key, text: t.text, left: p.left, top: p.top, className, fontPx: px, color: t.color ?? palette.text };
    });
    for (const axis of this.axes) {
      const s = project(axis.to);
      if (s) items.push({ key: `axis:${axis.name}`, text: axis.name, left: s[0] + 3, top: s[1] - px * 1.4, className: "tick", fontPx: px, color: axis.color });
    }
    this.labels.render(items);
  }

  /** What is under the pointer: the nearest curve or point within 8 px, else the surface hit by the ray. */
  private pick(x: number, y: number): Hit3D | null {
    const items = [];
    for (const [id, b] of this.built) {
      const o = this.store.objects.get(id);
      if (o && this.ui.isVisible(o)) items.push(b.draw.pick);
    }
    const near = pickProjected(items, this.projector(), x, y);
    if (near) return near;
    const info = this.scene.pick(x, y, (m) => m.isEnabled() && m.metadata?.id !== undefined);
    if (!info?.hit || !info.pickedMesh || !info.pickedPoint) return null;
    const id: string = info.pickedMesh.metadata.id;
    const grid = this.built.get(id)?.draw.surface?.grid;
    const st = info.getTextureCoordinates();
    const p = info.pickedPoint;
    return { id, dist: 0, at: [p.x, p.y, p.z], t: null, index: null, uv: grid && st ? surfaceUv(grid, [st.x, st.y]) : null };
  }

  /** Highlight the hovered object and show its tooltip (null hides both). */
  private setHover(hit: Hit3D | null, pointer: [number, number] | null): void {
    const changed = hit?.id !== this.hover?.id;
    this.hover = hit;
    this.publish(hit);
    if (changed) {
      this.applyHighlight();
      this.labelsDirty = true;
    }
    const o = hit ? this.store.objects.get(hit.id) : undefined;
    if (!hit || !o || !pointer) {
      this.tooltip.hidden = true;
      return;
    }
    this.tooltip.replaceChildren(
      ...describeHit3D(o, hit, (id) => this.store.objects.get(id)?.geom).map((line, i) => {
        const div = document.createElement("div");
        if (i === 0) div.className = "head";
        div.textContent = line;
        return div;
      }),
    );
    this.tooltip.hidden = false;
    const [x, y] = pointer;
    const width = this.canvas.clientWidth;
    const left = x + 14 + this.tooltip.offsetWidth > width ? x - 14 - this.tooltip.offsetWidth : x + 14;
    this.tooltip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, y + 14)}px)`;
  }

  private listenHover(): void {
    this.canvas.addEventListener("pointermove", (ev) => {
      if (ev.buttons) {
        this.setHover(null, null); // orbiting or panning
        return;
      }
      const r = this.canvas.getBoundingClientRect();
      const x = ev.clientX - r.left;
      const y = ev.clientY - r.top;
      this.setHover(this.pick(x, y), [x, y]);
    });
    this.canvas.addEventListener("pointerleave", () => this.setHover(null, null));
  }

  private drop(id: string): void {
    this.built.get(id)?.meshes.forEach(disposeMesh);
    this.built.delete(id);
    this.labelsDirty = true;
  }

  private show(o: SceneObject): void {
    this.drop(o.id);
    const draw = objectDraw3D(o, { box: this.box, lookup: (id) => this.store.objects.get(id)?.geom, withCurves: this.withCurves });
    const b: Built = { draw, meshes: [], lines: [], markers: [], surface: null };
    for (const part of draw.lines) {
      const color = part.extra ? mixHex(part.color, this.palette.bg, EXTRA_MIX) : part.color;
      const mesh = this.greasedLine(`l-${o.id}`, part.paths, color, part.px, part.alpha);
      b.lines.push({ mesh, part });
      b.meshes.push(mesh);
    }
    if (draw.surface) {
      const s = draw.surface;
      const mesh = new BABYLON.Mesh(`s-${o.id}`, this.scene);
      const data = new BABYLON.VertexData();
      data.positions = s.mesh.positions;
      data.indices = s.mesh.indices;
      if (s.mesh.uvs.length) data.uvs = s.mesh.uvs;
      data.normals = [];
      BABYLON.VertexData.ComputeNormals(s.mesh.positions, s.mesh.indices, data.normals);
      if (s.colors) data.colors = s.colors;
      data.applyToMesh(mesh);
      mesh.useVertexColors = s.colors !== undefined;
      const mat = new BABYLON.StandardMaterial(`m-${o.id}`, this.scene);
      mat.diffuseColor = s.colors ? new BABYLON.Color3(1, 1, 1) : color3(s.color);
      mat.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
      mat.backFaceCulling = false;
      mat.twoSidedLighting = true;
      mat.alpha = s.alpha;
      mat.zOffset = 1; // curves lying on the surface stay in front of it
      mat.zOffsetUnits = 1;
      mesh.material = mat;
      mesh.metadata = { id: o.id };
      b.surface = mat;
      b.meshes.push(mesh);
    }
    for (const part of draw.markers) {
      const marker = this.markers(`p-${o.id}`, part);
      b.markers.push(marker);
      b.meshes.push(marker.mesh);
    }
    const visible = this.ui.isVisible(o);
    b.meshes.forEach((m) => {
      m.renderingGroupId = 1;
      m.setEnabled(visible);
    });
    this.built.set(o.id, b);
    this.applyHighlightTo(b);
  }

  /**
   * Constant-pixel-width lines: Babylon's `sizeAttenuation: true` is what keeps the width in
   * pixels. The default (standard) material type: the simple one disposes the shared empty
   * colours texture along with its material (Babylon 8.56), which blanks every later line.
   */
  private greasedLine(name: string, paths: Vec3[][], color: string, px: number, alpha: number): BABYLON.GreasedLineBaseMesh {
    const mesh = BABYLON.CreateGreasedLine(
      name,
      { points: paths.map((p) => p.flat()) },
      {
        color: color3(color),
        width: GREASED_PER_PX * px,
        sizeAttenuation: true,
        resolution: new BABYLON.Vector2(this.engine.getRenderWidth(), this.engine.getRenderHeight()),
      },
      this.scene,
    );
    mesh.material!.alpha = alpha;
    mesh.isPickable = false;
    return mesh;
  }

  /** One unit sphere drawn at every position (thin instances), resized each frame to keep its pixel radius. */
  private markers(name: string, part: Markers3D): Marker {
    const mesh = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 1, segments: 8 }, this.scene);
    const mat = new BABYLON.StandardMaterial(`${name}-m`, this.scene);
    const color = color3(part.extra ? mixHex(part.color, this.palette.bg, EXTRA_MIX) : part.color);
    // A scalar-coloured cloud tints every instance: white diffuse lets the instance colours through.
    mat.diffuseColor = part.colors ? new BABYLON.Color3(1, 1, 1) : color;
    mat.emissiveColor = part.colors ? color3("#000000") : color.scale(0.6);
    mat.alpha = part.alpha;
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true; // thin instances move every frame: skip culling against stale bounds
    const matrices = new Float32Array(16 * part.at.length);
    part.at.forEach((p, i) => BABYLON.Matrix.Translation(p[0], p[1], p[2]).copyToArray(matrices, 16 * i));
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
    if (part.colors?.length === part.at.length) {
      const colors = new Float32Array(4 * part.at.length);
      part.colors.forEach((hex, i) => {
        const c = color3(hex);
        colors.set([c.r, c.g, c.b, 1], 4 * i);
      });
      mesh.thinInstanceSetBuffer("color", colors, 4, false);
    }
    return { mesh, part, matrices };
  }

  /** Spec §5.3: the grid on z = 0 and the axis triad. */
  private buildGround(): void {
    this.groundMeshes.forEach(disposeMesh);
    const g = ground(this.box);
    this.axes = g.axes;
    this.labelsDirty = true;
    const palette = this.palette;
    const lineSystem = (name: string, lines: Vec3[][], color: string) => {
      const mesh = BABYLON.MeshBuilder.CreateLineSystem(name, { lines: lines.map((l) => l.map(v3)) }, this.scene);
      mesh.color = color3(color);
      mesh.material!.disableDepthWrite = true;
      mesh.isPickable = false;
      return mesh;
    };
    this.groundMeshes = [lineSystem("grid-minor", g.minor, palette.gridMinor), lineSystem("grid-major", g.major, palette.gridMajor)];
    for (const axis of g.axes) {
      const mesh = this.greasedLine(`axis-${axis.name}`, [[[0, 0, 0], axis.to]], axis.color, AXIS_PX, 1);
      mesh.renderingGroupId = 1; // over the grid lines it runs along
      this.groundMeshes.push(mesh);
    }
  }
}

const scratch = new BABYLON.Matrix();

/** Dispose a mesh and its own material (not textures: plain-coloured GreasedLines share one). */
function disposeMesh(m: BABYLON.AbstractMesh): void {
  const mat = m.material;
  m.dispose();
  mat?.dispose();
}
