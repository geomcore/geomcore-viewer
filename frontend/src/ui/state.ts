import { inPlaneZ0 } from "../geom/planar";
import type { SceneObject, ViewMode } from "../protocol";
import type { Theme } from "./theme";

export type ActiveView = "2d" | "3d";
export type AvailableViews = Record<ActiveView, boolean>;

/** `view` if it can be shown, else the other one (a dead pane explains nothing); `view` when neither can. */
export function usableView(view: ActiveView, available: AvailableViews): ActiveView {
  const other: ActiveView = view === "2d" ? "3d" : "2d";
  return !available[view] && available[other] ? other : view;
}

export type UiEvent = "theme" | "presenting" | "view" | "visibility" | "selection" | "autofit" | "collapse" | "uvpane" | "labels";

/** The part of `Storage` the UI needs (tests pass a Map-backed fake). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const THEME_KEY = "geomcore-viewer.theme";

function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // a sandboxed page throws on access
  }
}

/** "2d" when every object lies in z = 0 (an empty scene too), else "3d". */
export function autoView(objects: Iterable<SceneObject>): ActiveView {
  for (const o of objects) if (!inPlaneZ0(o.geom)) return "3d";
  return "2d";
}

function toggle(set: Set<string>, key: string, present: boolean): void {
  if (present) set.add(key);
  else set.delete(key);
}

/**
 * Page state that is not scene data: theme, presentation mode, the view the user picked,
 * auto-fit, visibility, collapsed groups and the selection. It outlives run swaps, so
 * hidden groups and ids stay hidden when a re-run brings objects with the same group
 * name or id (spec §5.1).
 */
export class UiState {
  theme: Theme;
  presenting = false;
  autoFit = true;
  /** Spec §5.4: the (u,v) pane shows when the scene has something for it; U hides it (and brings it back). */
  uvPane = true;
  /** Object labels in both views; the header's "labels" toggle turns them off (axis ticks stay). */
  showLabels = true;
  viewOverride: ActiveView | null = null;
  selected: string | null = null;
  readonly hiddenIds = new Set<string>();
  readonly hiddenGroups = new Set<string>();
  readonly collapsedGroups = new Set<string>();
  private handlers = new Set<(ev: UiEvent) => void>();

  constructor(private storage: KeyValueStore | null = browserStorage()) {
    this.theme = this.read(THEME_KEY) === "dark" ? "dark" : "light";
  }

  onChange(handler: (ev: UiEvent) => void): void {
    this.handlers.add(handler);
  }

  private emit(ev: UiEvent): void {
    for (const handler of this.handlers) handler(ev);
  }

  private read(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    try {
      this.storage?.setItem(THEME_KEY, theme);
    } catch {
      /* storage full or blocked: the theme still applies to this page */
    }
    this.emit("theme");
  }

  toggleTheme(): void {
    this.setTheme(this.theme === "light" ? "dark" : "light");
  }

  setPresenting(on: boolean): void {
    if (on === this.presenting) return;
    this.presenting = on;
    this.emit("presenting");
  }

  setAutoFit(on: boolean): void {
    this.autoFit = on;
    this.emit("autofit");
  }

  toggleUvPane(): void {
    this.uvPane = !this.uvPane;
    this.emit("uvpane");
  }

  setShowLabels(on: boolean): void {
    if (on === this.showLabels) return;
    this.showLabels = on;
    this.emit("labels");
  }

  setView(view: ActiveView): void {
    this.viewOverride = view;
    this.emit("view");
  }

  /** The view to show: the user's pick (keys 2/3, header switch), else the scene's, else auto. */
  activeView(sceneView: ViewMode, objects: Iterable<SceneObject>): ActiveView {
    if (this.viewOverride) return this.viewOverride;
    return sceneView === "auto" ? autoView(objects) : sceneView;
  }

  isVisible(o: SceneObject): boolean {
    return !this.hiddenIds.has(o.id) && !(o.group !== undefined && this.hiddenGroups.has(o.group));
  }

  setObjectVisible(id: string, visible: boolean): void {
    toggle(this.hiddenIds, id, !visible);
    this.emit("visibility");
  }

  setGroupVisible(group: string, visible: boolean): void {
    toggle(this.hiddenGroups, group, !visible);
    this.emit("visibility");
  }

  setCollapsed(group: string, collapsed: boolean): void {
    toggle(this.collapsedGroups, group, collapsed);
    this.emit("collapse");
  }

  /** Select an object (views frame it), or clear the selection with null. */
  select(id: string | null): void {
    this.selected = id;
    this.emit("selection");
  }
}
