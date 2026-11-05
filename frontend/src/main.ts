import "./style.css";
import { FrameScheduler } from "./frame";
import { Store } from "./store";
import { RunCounter, renderHeader } from "./ui/header";
import { mountKeys } from "./ui/keys";
import { mountPanel } from "./ui/panel";
import { type ActiveView, type AvailableViews, UiState, usableView } from "./ui/state";
import { applyTheme } from "./ui/theme";
import { View2D } from "./view2d/view";
import { View3D } from "./view3d/view";
import { HoverLink } from "./viewuv/link";
import { UvPane } from "./viewuv/pane";

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el as T;
}

const store = new Store();
const ui = new UiState();
applyTheme(ui.theme);

const toastEl = byId("toast");
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** A short message over the view (copied coordinates, presentation mode hint). */
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2500);
}

// A view that cannot start is recorded here and shown in the header, not toasted or overwritten
// by the next status. The other view and the panel keep working (a machine without WebGL gets
// the plane view only).
const failures: string[] = [];
const available: AvailableViews = { "2d": true, "3d": true };
function viewFailed(view: ActiveView, message: string): void {
  available[view] = false;
  failures.push(message);
}

const link = new HoverLink();
let view3d: View3D | null = null;
let uvpane: UvPane | null = null;
try {
  view3d = new View3D(store, ui, byId("view3d"), link);
  uvpane = new UvPane(store, ui, link, byId("view3d"));
} catch (err) {
  console.error("geomcore-viewer: 3D view failed", err);
  viewFailed("3d", `3D view unavailable: ${err instanceof Error ? err.message : String(err)}`);
}
const view2d = new View2D(store, ui, byId("view2d"), toast, (message) => {
  viewFailed("2d", message);
  shell.request(); // init finishes after the first render
});
mountPanel(store, ui, byId("object-list"));

const runs = new RunCounter();
const header = { title: byId("title"), status: byId("status"), run: byId("run"), count: byId("count") };
const stage = byId("stage");
const autofit = byId<HTMLInputElement>("autofit");
const labels = byId<HTMLInputElement>("labels");
const stepBar = byId("step-bar");
const stepSlider = byId<HTMLInputElement>("step-slider");
const stepLabel = byId("step-label");
const stepPrevious = byId<HTMLButtonElement>("step-previous");
const stepNext = byId<HTMLButtonElement>("step-next");
const shell = new FrameScheduler(() => {
  renderHeader(store, runs, header, failures);
  const view = usableView(ui.activeView(store.view, store.objects.values()), available);
  stage.dataset.view = view;
  byId<HTMLButtonElement>("view-2d").disabled = !available["2d"];
  byId<HTMLButtonElement>("view-3d").disabled = !available["3d"];
  byId("view-2d").setAttribute("aria-pressed", String(view === "2d"));
  byId("view-3d").setAttribute("aria-pressed", String(view === "3d"));
  byId("present").setAttribute("aria-pressed", String(ui.presenting));
  document.body.classList.toggle("presenting", ui.presenting);
  autofit.checked = ui.autoFit;
  labels.checked = ui.showLabels;
  stepBar.hidden = ui.steps.length <= 1;
  stepSlider.max = String(Math.max(0, ui.steps.length - 1));
  stepSlider.value = String(ui.stepIndex);
  stepLabel.textContent = ui.steps[ui.stepIndex] ?? "";
  stepPrevious.disabled = ui.stepIndex <= 0;
  stepNext.disabled = ui.stepIndex >= ui.steps.length - 1;
  view2d.setActive(view === "2d");
  view3d?.setActive(view === "3d");
  uvpane?.setActive(view === "3d");
});
store.onChange((ev) => {
  if (ev.type === "reset" || ev.type === "upsert") ui.setSteps(store.steps);
  shell.request();
});
ui.onChange((ev) => {
  if (ev === "theme") applyTheme(ui.theme);
  shell.request();
});
shell.request();

const fit = () => {
  view2d.fitRequested();
  view3d?.fitRequested();
};
const present = () => {
  ui.setPresenting(!ui.presenting);
  if (ui.presenting) toast("presentation mode · Esc to leave");
};
byId("fit").addEventListener("click", fit);
const chooseView = (view: ActiveView) => {
  if (available[view]) ui.setView(view);
};
byId("view-2d").addEventListener("click", () => chooseView("2d"));
byId("view-3d").addEventListener("click", () => chooseView("3d"));
byId("theme").addEventListener("click", () => ui.toggleTheme());
byId("present").addEventListener("click", present);
autofit.addEventListener("change", () => ui.setAutoFit(autofit.checked)); // turning it on refits both views
labels.addEventListener("change", () => ui.setShowLabels(labels.checked));
stepSlider.addEventListener("input", () => ui.setStep(Number(stepSlider.value)));
stepPrevious.addEventListener("click", () => ui.moveStep(-1));
stepNext.addEventListener("click", () => ui.moveStep(1));
byId("clear").addEventListener("click", () => void store.clearAll());
mountKeys({
  fit,
  present,
  theme: () => ui.toggleTheme(),
  view2d: () => chooseView("2d"),
  view3d: () => chooseView("3d"),
  uvpane: () => ui.toggleUvPane(),
  stepPrevious: () => ui.moveStep(-1),
  stepNext: () => ui.moveStep(1),
  escape: () => (ui.presenting ? ui.setPresenting(false) : ui.select(null)),
});

// Drag-and-drop a scene .json file anywhere on the page.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  void file.text().then((text) => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      store.setStatus(`could not parse ${file.name}`);
      return;
    }
    if (store.loadJson(raw, file.name)) store.setStatus(`static: ${file.name}`);
  });
});

// Debug and e2e access (the e2e tests read cameras and strokes through it).
Object.assign(window, { __gv: { store, ui, view2d, view3d, uvpane, link } });

void store.load();
