import { describe, expect, it } from "vitest";
import { fmtNum, fmtParams, fmtPoint } from "../src/ui/format";

describe("format", () => {
  it("keeps up to 3 decimals and drops trailing zeros", () => {
    expect(fmtNum(1.84)).toBe("1.84");
    expect(fmtNum(1.6180339)).toBe("1.618");
    expect(fmtNum(2)).toBe("2");
    expect(fmtNum(2.0004)).toBe("2");
    expect(fmtNum(-0.0001)).toBe("0");
    expect(fmtNum(1500)).toBe("1500");
    expect(fmtNum(0.785398, 4)).toBe("0.7854");
  });

  it("keeps the exponent of numbers too large for toFixed", () => {
    expect(fmtNum(1.2e30)).toBe("1.2e+30");
    expect(fmtNum(-1e21)).toBe("-1e+21");
    expect(fmtNum(1e20)).toBe("100000000000000000000");
  });

  it("writes plane points without z, 3D points with it", () => {
    expect(fmtPoint([1.84, 1.62, 0], 2)).toBe("(1.84, 1.62)");
    expect(fmtPoint([1, -2, 0.5], 2)).toBe("(1, -2)");
    expect(fmtPoint([1.84, 1.62, 0])).toBe("(1.84, 1.62, 0)");
    expect(fmtPoint([0, 0, 0])).toBe("(0, 0, 0)");
    expect(fmtPoint([1, -2, 0.5])).toBe("(1, -2, 0.5)");
  });

  it("formats meta params generically", () => {
    expect(fmtParams(0.785398)).toBe("0.7854");
    expect(fmtParams([0.785398, 2.1])).toBe("(0.7854, 2.1)");
    expect(fmtParams([1, null])).toBe("(1, —)");
    expect(fmtParams("t")).toBeNull();
    expect(fmtParams(undefined)).toBeNull();
    expect(fmtParams([1, {}])).toBeNull();
  });
});
