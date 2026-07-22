import { describe, expect, it } from "vitest";
import { PLATFORM_NAME, isSummaryBand } from "./index";

describe("@aistudy/domain workspace smoke", () => {
  it("exports the platform name through workspace resolution", () => {
    expect(PLATFORM_NAME).toBe("AIstudy");
  });

  it("recognizes summary bands used by the concise result UI", () => {
    expect(isSummaryBand("stable")).toBe(true);
    expect(isSummaryBand("unknown")).toBe(false);
  });
});
