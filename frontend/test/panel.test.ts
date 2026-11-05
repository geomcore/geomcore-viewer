import { describe, expect, it } from "vitest";
import type { SceneObject } from "../src/protocol";
import { Store } from "../src/store";
import { panelModel } from "../src/ui/panel";
import { UiState } from "../src/ui/state";

const obj = (id: string, geom: unknown, extra: Partial<SceneObject> = {}) => ({ id, geom, ...extra }) as SceneObject;
const frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function storeOf(objects: SceneObject[]): Store {
  const store = new Store();
  store.reset({ version: 2, title: "", run: null, view: "auto", objects }, [{ id: "bad", message: "unknown type" }]);
  return store;
}

const scene = [
  obj("E", { type: "ellipse", frame, a: 3, b: 2 }, { group: "conics", style: { color: "#d1495b" } }),
  obj("P₁", { type: "point", p: [1.8412, 1.62, 0] }, { group: "intersections", label: "P₁" }),
  obj("note", { type: "note", text: "2 tangent points", level: "warn" }),
  obj("C", { type: "circle", frame, r: 1 }, { group: "conics" }),
  obj("S", { type: "points", positions: [[0, 0, 0], [1, 1, 0]] }),
];

describe("panelModel", () => {
  it("lists ungrouped rows first, then groups in order of appearance", () => {
    const model = panelModel(storeOf(scene), new UiState(null));
    expect(model.groups.map((g) => g.name)).toEqual([null, "conics", "intersections"]);
    expect(model.groups[0].rows.map((r) => r.id)).toEqual(["note", "S"]);
    expect(model.groups[1].rows.map((r) => r.id)).toEqual(["E", "C"]);
    expect(model.problems).toEqual([{ id: "bad", message: "unknown type" }]);
  });

  it("describes each row", () => {
    const model = panelModel(storeOf(scene), new UiState(null));
    const rows = model.groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.id === "P₁")).toMatchObject({ kind: "object", label: "P₁", detail: "(1.841, 1.62)" });
    expect(rows.find((r) => r.id === "S")).toMatchObject({ detail: "2 points" });
    expect(rows.find((r) => r.id === "E")).toMatchObject({ detail: "ellipse", color: "#d1495b" });
    expect(rows.find((r) => r.id === "note")).toEqual({ kind: "note", id: "note", text: "2 tangent points", warn: true });
  });

  it("keeps a tangent hit's name and adds the tangency to its detail", () => {
    const hit = obj("P·hit1", { type: "point", p: [1, 0, 0] }, { meta: { tag: "hit", tangent: true } });
    const [row] = panelModel(storeOf([hit]), new UiState(null)).groups[0].rows;
    expect(row).toMatchObject({ kind: "object", label: "P·hit1", detail: "tangent, (1, 0)" });
  });

  it("reflects visibility, collapse and selection", () => {
    const ui = new UiState(null);
    ui.setGroupVisible("conics", false);
    ui.setObjectVisible("P₁", false);
    ui.setCollapsed("intersections", true);
    ui.select("C");
    const model = panelModel(storeOf(scene), ui);
    const [, conics, intersections] = model.groups;
    expect(conics).toMatchObject({ visible: false, collapsed: false });
    expect(conics.rows[1]).toMatchObject({ id: "C", visible: true, shown: false, selected: true });
    expect(intersections).toMatchObject({ visible: true, collapsed: true });
    expect(intersections.rows[0]).toMatchObject({ visible: false, shown: false, selected: false });
  });

  it("names a pcurve's surface, and warns when that surface is missing or not a surface", () => {
    const uv = { type: "line", o: [0, 0, 0], d: [1, 0, 0] };
    const store = storeOf([
      obj("Y", { type: "cylinder", frame, r: 2 }, { label: "cyl" }),
      obj("ok", { type: "pcurve", surface: "Y", curve: uv }),
      obj("lost", { type: "pcurve", surface: "gone", curve: uv }),
      obj("odd", { type: "pcurve", surface: "ok", curve: uv }),
    ]);
    const rows = panelModel(store, new UiState(null)).groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.id === "ok")).toMatchObject({ detail: "pcurve on cyl", warn: false });
    expect(rows.find((r) => r.id === "lost")).toMatchObject({ detail: "no surface gone", warn: true });
    expect(rows.find((r) => r.id === "odd")).toMatchObject({ detail: "no surface ok", warn: true });
    expect(rows.find((r) => r.id === "Y")).toMatchObject({ detail: "cylinder", warn: false });
  });

  it("drops the ungrouped section when every object has a group", () => {
    const model = panelModel(storeOf([scene[0]]), new UiState(null));
    expect(model.groups.map((g) => g.name)).toEqual(["conics"]);
  });
});
