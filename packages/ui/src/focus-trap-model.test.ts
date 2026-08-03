import { describe, expect, it } from "vitest";
import { getFocusTrapTarget } from "./focus-trap-model";

describe("focus trap model", () => {
  it("wraps focus from the last element to the first", () => {
    expect(getFocusTrapTarget(2, "forward", 3)).toBe(0);
  });

  it("wraps focus from the first element to the last", () => {
    expect(getFocusTrapTarget(0, "backward", 3)).toBe(2);
  });

  it("leaves focus alone away from a trap boundary", () => {
    expect(getFocusTrapTarget(1, "forward", 3)).toBeNull();
    expect(getFocusTrapTarget(1, "backward", 3)).toBeNull();
    expect(getFocusTrapTarget(-1, "forward", 3)).toBeNull();
  });
});
