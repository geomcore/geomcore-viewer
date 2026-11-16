import { describe, expect, it } from "vitest";
import { displayName } from "../src/ui/names";
import type { SceneObject } from "../src/protocol";

const point = { type: "point", p: [0, 0, 0] } as const;

describe("displayName", () => {
  it("keeps the object's own label", () => {
    expect(displayName({ id: "step·curve1", geom: point, label: "circle" })).toBe("circle");
  });

  it("drops the step and then the result group from an id", () => {
    expect(displayName({ id: "step·intersection·contact2", geom: point, step: "step", group: "intersection" }))
      .toBe("contact2");
  });

  it("drops the step from an object without a label", () => {
    expect(displayName({ id: "step·ab12cd-1", geom: point, step: "step" })).toBe("ab12cd-1");
  });

  it("leaves an id alone when a prefix is not followed by the separator", () => {
    const o: SceneObject = { id: "stepwise·P", geom: point, step: "step", group: "P" };
    expect(displayName(o)).toBe("stepwise·P");
  });

  it("does not drop a group that is not in the id", () => {
    expect(displayName({ id: "P", geom: point, group: "intersection" })).toBe("P");
  });
});
