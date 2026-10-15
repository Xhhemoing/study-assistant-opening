import { describe, expect, it } from "vitest";
import { safeSenseWeaveMessageId, shouldShowSenseWeavePilot } from "./senseweave-pilot";

describe("SenseWeave pilot boundary", () => {
  it("keeps ids stable and valid for the SDK", () => {
    expect(safeSenseWeaveMessageId("assistant:数学/1")).toBe("assistant-数学-1");
    expect(safeSenseWeaveMessageId("***")).toBe("opening-message");
  });

  it("does not create a presentation for empty answers", () => {
    expect(shouldShowSenseWeavePilot("")).toBe(false);
    expect(shouldShowSenseWeavePilot("  ")).toBe(false);
  });
});
