import { describe, expect, it, vi } from "vitest";
import type { SceneObject } from "../src/protocol";
import { KeyValueStore, UiState, autoView, usableView } from "../src/ui/state";

function memory(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const obj = (id: string, geom: unknown, group?: string) => ({ id, geom, ...(group ? { group } : {}) }) as SceneObject;
const point = (id: string, z = 0, group?: string) => obj(id, { type: "point", p: [1, 2, z] }, group);
const frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

describe("UiState theme", () => {
  it("starts light, reads a stored dark theme and persists toggles", () => {
    expect(new UiState(memory()).theme).toBe("light");
    const storage = memory({ "geomcore-viewer.theme": "dark" });
    const ui = new UiState(storage);
    expect(ui.theme).toBe("dark");
    ui.toggleTheme();
    expect(ui.theme).toBe("light");
    expect(storage.data.get("geomcore-viewer.theme")).toBe("light");
  });

  it("survives a storage that throws, and works without one", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const ui = new UiState(broken);
    expect(ui.theme).toBe("light");
    expect(() => ui.toggleTheme()).not.toThrow();
    expect(ui.theme).toBe("dark");
    const bare = new UiState(null);
    bare.toggleTheme();
    expect(bare.theme).toBe("dark");
  });
});

describe("UiState view", () => {
  it("picks 2D for planar or empty scenes and 3D otherwise", () => {
    expect(autoView([])).toBe("2d");
    expect(autoView([point("a"), obj("c", { type: "circle", frame, r: 1 })])).toBe("2d");
    expect(autoView([obj("n", { type: "note", text: "hi" })])).toBe("2d");
    expect(autoView([point("a"), point("b", 1)])).toBe("3d");
    expect(autoView([obj("s", { type: "sphere", frame, r: 1 })])).toBe("3d");
  });

  it("prefers the user's pick, then the scene's view, then auto", () => {
    const ui = new UiState(null);
    const planar = [point("a")];
    expect(ui.activeView("auto", planar)).toBe("2d");
    expect(ui.activeView("3d", planar)).toBe("3d");
    ui.setView("2d");
    expect(ui.activeView("3d", planar)).toBe("2d");
  });
});

describe("UiState visibility and selection", () => {
  it("keeps hidden groups and ids across runs", () => {
    const ui = new UiState(null);
    ui.setGroupVisible("conics", false);
    ui.setObjectVisible("P₁", false);
    // a re-run brings new objects: matched by group name and by id
    expect(ui.isVisible(point("E2", 0, "conics"))).toBe(false);
    expect(ui.isVisible(point("P₁", 0, "intersections"))).toBe(false);
    expect(ui.isVisible(point("Q₁", 0, "intersections"))).toBe(true);
    ui.setGroupVisible("conics", true);
    expect(ui.isVisible(point("E2", 0, "conics"))).toBe(true);
  });

  it("tells listeners what changed", () => {
    const ui = new UiState(null);
    const seen = vi.fn();
    ui.onChange(seen);
    ui.select("a");
    ui.setPresenting(true);
    ui.setPresenting(true); // no change, no event
    ui.setAutoFit(false);
    ui.setCollapsed("g", true);
    ui.toggleUvPane();
    ui.setShowLabels(false);
    expect(seen.mock.calls.map((c) => c[0])).toEqual(["selection", "presenting", "autofit", "collapse", "uvpane", "labels"]);
    expect(ui.uvPane).toBe(false);
    expect(ui.showLabels).toBe(false);
    expect(ui.selected).toBe("a");
    expect(ui.collapsedGroups.has("g")).toBe(true);
  });
  it("shows one frame at a time and keeps unscoped objects", () => {
    const ui = new UiState(null);
    const seen = vi.fn();
    ui.onChange(seen);
    const a = { id: "a", frame: "one", geom: { type: "point", p: [0, 0, 0] } };
    const b = { id: "b", frame: "two", geom: { type: "point", p: [0, 0, 0] } };
    const always = { id: "c", geom: { type: "point", p: [0, 0, 0] } };
    expect(ui.inFrame(a) && ui.inFrame(b) && ui.inFrame(always)).toBe(true);
    ui.setFrames(["one", "two"]);
    expect(seen.mock.calls.map((c) => c[0])).toEqual(["frame"]);
    expect(ui.isVisible(a)).toBe(true);
    expect(ui.isVisible(b)).toBe(false);
    expect(ui.isVisible(always)).toBe(true);
    ui.setFrame(1);
    expect(ui.isVisible(a)).toBe(false);
    expect(ui.isVisible(b)).toBe(true);
    ui.stepFrame(5); // clamped
    expect(ui.frameIndex).toBe(1);
    ui.setFrame(0);
    expect(ui.frameIndex).toBe(0);
    ui.setFrames(["one"]); // the shown frame survives when it still exists
    expect(ui.frameIndex).toBe(0);
    expect(ui.isVisible({ ...a })).toBe(true);
  });
});

describe("usableView", () => {
  it("falls back to the available view, and never leaves the choice when both or neither work", () => {
    expect(usableView("3d", { "2d": true, "3d": false })).toBe("2d");
    expect(usableView("2d", { "2d": false, "3d": true })).toBe("3d");
    expect(usableView("3d", { "2d": true, "3d": true })).toBe("3d");
    expect(usableView("3d", { "2d": false, "3d": false })).toBe("3d");
  });
});
