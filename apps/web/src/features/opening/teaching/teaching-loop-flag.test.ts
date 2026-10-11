import { describe, expect, it } from "vitest";
import { isOpeningTeachingLoopEnabled } from "./teaching-loop-flag";

describe("isOpeningTeachingLoopEnabled", () => {
  it("defaults off", () => {
    expect(isOpeningTeachingLoopEnabled({})).toBe(false);
    expect(isOpeningTeachingLoopEnabled({ OPENING_TEACHING_LOOP: "0" })).toBe(false);
    expect(isOpeningTeachingLoopEnabled({ OPENING_TEACHING_LOOP: "false" })).toBe(false);
    expect(isOpeningTeachingLoopEnabled({ OPENING_TEACHING_LOOP: "" })).toBe(false);
  });

  it("truthy parse mirrors teaching-workspace-flag (1/true/yes)", () => {
    expect(isOpeningTeachingLoopEnabled({ OPENING_TEACHING_LOOP: "1" })).toBe(true);
    expect(isOpeningTeachingLoopEnabled({ OPENING_TEACHING_LOOP: "true" })).toBe(true);
    expect(isOpeningTeachingLoopEnabled({ OPENING_TEACHING_LOOP: "yes" })).toBe(true);
    expect(isOpeningTeachingLoopEnabled({ OPENING_TEACHING_LOOP: "YES" })).toBe(true);
    expect(
      isOpeningTeachingLoopEnabled({ NEXT_PUBLIC_OPENING_TEACHING_LOOP: "1" }),
    ).toBe(true);
  });

  it("prefers OPENING_TEACHING_LOOP over NEXT_PUBLIC_* when both set", () => {
    expect(
      isOpeningTeachingLoopEnabled({
        OPENING_TEACHING_LOOP: "0",
        NEXT_PUBLIC_OPENING_TEACHING_LOOP: "1",
      }),
    ).toBe(false);
  });
});
