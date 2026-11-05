import { FrameScheduler } from "../frame";
import { pcurveSurface } from "../geom/pcurve";
import type { Problem, SceneObject } from "../protocol";
import type { Store } from "../store";
import { colorOf } from "./colors";
import { fmtPoint } from "./format";
import type { UiState } from "./state";

export interface ObjectRow {
  kind: "object";
  id: string;
  label: string;
  /** Coordinates for a point, "N points", a pcurve's surface, else the geometry type. */
  detail: string;
  /** The detail is a problem (a pcurve whose surface is missing). */
  warn: boolean;
  color: string;
  /** The object's own checkbox. */
  visible: boolean;
  /** Drawn: its own checkbox and its group's are both on. */
  shown: boolean;
  selected: boolean;
}

export interface NoteRow {
  kind: "note";
  id: string;
  text: string;
  warn: boolean;
}

export interface GroupModel {
  /** null for the objects without a group, listed first. */
  name: string | null;
  visible: boolean;
  collapsed: boolean;
  rows: (ObjectRow | NoteRow)[];
}

export interface PanelModel {
  groups: GroupModel[];
  problems: Problem[];
}

function detailOf(o: SceneObject, objects: Map<string, SceneObject>): { detail: string; warn: boolean } {
  const g = o.geom;
  if (g.type === "point") return { detail: fmtPoint(g.p), warn: false };
  if (g.type === "points") return { detail: `${g.positions.length} points`, warn: false };
  if (g.type === "pcurve") {
    if (!pcurveSurface(g, (id) => objects.get(id)?.geom)) return { detail: `no surface ${g.surface}`, warn: true };
    const surface = objects.get(g.surface)!;
    return { detail: `pcurve on ${surface.label ?? surface.id}`, warn: false };
  }
  return { detail: g.type, warn: false };
}

/** What the panel shows, from the scene and the UI state (pure, so it is unit-tested). */
export function panelModel(store: Store, ui: UiState): PanelModel {
  const groups = new Map<string | null, GroupModel>([[null, { name: null, visible: true, collapsed: false, rows: [] }]]);
  for (const o of store.objects.values()) {
    if (!ui.inStep(o)) continue;
    const name = o.group ?? null;
    let group = groups.get(name);
    if (!group) {
      group = { name, visible: !ui.hiddenGroups.has(name!), collapsed: ui.collapsedGroups.has(name!), rows: [] };
      groups.set(name, group);
    }
    const g = o.geom;
    if (g.type === "note") {
      group.rows.push({ kind: "note", id: o.id, text: g.text, warn: g.level === "warn" });
      continue;
    }
    group.rows.push({
      kind: "object",
      id: o.id,
      label: o.label ?? o.id,
      ...detailOf(o, store.objects),
      color: colorOf(o),
      visible: !ui.hiddenIds.has(o.id),
      shown: ui.isVisible(o),
      selected: ui.selected === o.id,
    });
  }
  return { groups: [...groups.values()].filter((g) => g.rows.length > 0), problems: [...store.problems.values()] };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function checkbox(checked: boolean, label: string, onChange: (checked: boolean) => void): HTMLInputElement {
  const box = el("input");
  box.type = "checkbox";
  box.checked = checked;
  box.setAttribute("aria-label", label);
  box.addEventListener("click", (ev) => ev.stopPropagation()); // toggling visibility is not selecting
  box.addEventListener("change", () => onChange(box.checked));
  return box;
}

/**
 * The side panel (spec §5.1): objects grouped by `group`, each with a visibility checkbox,
 * colour swatch, label and detail; click a row to select (and frame) it, again to deselect.
 * Notes and rejected objects are listed too. Rebuilt at most once per frame.
 */
export function mountPanel(store: Store, ui: UiState, list: HTMLElement): void {
  const objectRow = (row: ObjectRow): HTMLLIElement => {
    const li = el("li", `object${row.selected ? " selected" : ""}${row.shown ? "" : " hidden"}`);
    li.dataset.id = row.id;
    const swatch = el("span", "swatch");
    swatch.style.background = row.color;
    li.append(
      checkbox(row.visible, `show ${row.label}`, (on) => ui.setObjectVisible(row.id, on)),
      swatch,
      el("span", "name", row.label),
      el("span", row.warn ? "detail warn" : "detail", row.detail),
    );
    li.addEventListener("click", () => ui.select(ui.selected === row.id ? null : row.id));
    return li;
  };
  const noteRow = (row: NoteRow): HTMLLIElement => el("li", `note ${row.warn ? "warn" : "info"}`, `${row.warn ? "⚠" : "ⓘ"} ${row.text}`);
  const rowsOf = (group: GroupModel) => group.rows.map((r) => (r.kind === "object" ? objectRow(r) : noteRow(r)));
  const render = () => {
    const model = panelModel(store, ui);
    const items: HTMLLIElement[] = [];
    for (const group of model.groups) {
      if (group.name === null) {
        items.push(...rowsOf(group));
        continue;
      }
      const name = group.name;
      const li = el("li", `group${group.collapsed ? " collapsed" : ""}`);
      li.dataset.group = name;
      const head = el("div", "group-head");
      const twisty = el("button", "twisty", group.collapsed ? "▸" : "▾");
      twisty.setAttribute("aria-expanded", String(!group.collapsed));
      twisty.setAttribute("aria-label", `${group.collapsed ? "expand" : "collapse"} ${name}`);
      twisty.addEventListener("click", () => ui.setCollapsed(name, !group.collapsed));
      head.append(
        twisty,
        checkbox(group.visible, `show group ${name}`, (on) => ui.setGroupVisible(name, on)),
        el("span", "name", name),
        el("span", "detail", String(group.rows.length)),
      );
      li.append(head);
      if (!group.collapsed) {
        const ul = el("ul");
        ul.append(...rowsOf(group));
        li.append(ul);
      }
      items.push(li);
    }
    for (const p of model.problems) items.push(el("li", "problem", `⚠ ${p.id}: ${p.message}`));
    list.replaceChildren(...items);
  };
  const frame = new FrameScheduler(render);
  store.onChange((ev) => {
    if (ev.type !== "meta") frame.request();
  });
  ui.onChange((ev) => {
    if (ev === "visibility" || ev === "selection" || ev === "collapse" || ev === "step") frame.request();
  });
  render();
}
