import { describe, expect, it } from "vitest";
import { keyAction } from "../src/ui/keys";

const press = (key: string, extra: Partial<Parameters<typeof keyAction>[0]> = {}) =>
  keyAction({ key, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra });
const target = (tagName: string, more: Record<string, unknown> = {}) => ({ tagName, ...more }) as unknown as EventTarget;

describe("keyAction", () => {
  it("maps the spec keys, either case", () => {
    expect(press("f")).toBe("fit");
    expect(press("F")).toBe("fit");
    expect(press("p")).toBe("present");
    expect(press("t")).toBe("theme");
    expect(press("2")).toBe("view2d");
    expect(press("3")).toBe("view3d");
    expect(press("ArrowLeft")).toBe("framePrev");
    expect(press("ArrowRight")).toBe("frameNext");
    expect(press("Escape")).toBe("escape");
  });

  it("toggles the (u,v) pane with U", () => {
    expect(press("u")).toBe("uvpane");
    expect(press("U")).toBe("uvpane");
  });

  it("finds 2 and 3 by position on layouts where they need Shift (AZERTY)", () => {
    expect(press("é", { code: "Digit2" })).toBe("view2d");
    expect(press('"', { code: "Digit3" })).toBe("view3d");
    expect(press("t", { code: "Digit2" })).toBe("theme"); // a layout's own letter keeps its meaning
    expect(press("à", { code: "Digit0" })).toBeNull();
  });

  it("leaves other keys alone", () => {
    expect(press("a")).toBeNull();
    expect(press(" ")).toBeNull();
  });

  it("leaves Ctrl, ⌘ and Alt combinations to the browser", () => {
    expect(press("f", { ctrlKey: true })).toBeNull(); // find
    expect(press("p", { metaKey: true })).toBeNull(); // print
    expect(press("t", { altKey: true })).toBeNull();
  });

  it("ignores keys typed into text fields", () => {
    expect(press("f", { target: target("INPUT", { type: "text" }) })).toBeNull();
    expect(press("f", { target: target("INPUT", { type: "search" }) })).toBeNull();
    expect(press("f", { target: target("TEXTAREA") })).toBeNull();
    expect(press("2", { target: target("SELECT") })).toBeNull();
    expect(press("t", { target: target("DIV", { isContentEditable: true }) })).toBeNull();
  });

  it("still works with a panel checkbox or a button focused", () => {
    expect(press("f", { target: target("INPUT", { type: "checkbox" }) })).toBe("fit");
    expect(press("p", { target: target("BUTTON") })).toBe("present");
  });
});
