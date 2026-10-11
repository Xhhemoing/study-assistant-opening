import { describe, expect, it } from "vitest";
import { isOpeningTeachingWorkspaceEnabled } from "./teaching-workspace-flag";

describe("isOpeningTeachingWorkspaceEnabled", () => {
  it("defaults off", () => {
    expect(isOpeningTeachingWorkspaceEnabled({})).toBe(false);
    expect(isOpeningTeachingWorkspaceEnabled({ OPENING_TEACHING_WORKSPACE: "0" })).toBe(false);
  });

  it("truthy parse mirrors isOpeningRelease", () => {
    expect(isOpeningTeachingWorkspaceEnabled({ OPENING_TEACHING_WORKSPACE: "1" })).toBe(true);
    expect(isOpeningTeachingWorkspaceEnabled({ OPENING_TEACHING_WORKSPACE: "true" })).toBe(true);
    expect(isOpeningTeachingWorkspaceEnabled({ OPENING_TEACHING_WORKSPACE: "yes" })).toBe(true);
    expect(
      isOpeningTeachingWorkspaceEnabled({ NEXT_PUBLIC_OPENING_TEACHING_WORKSPACE: "1" }),
    ).toBe(true);
  });
});
