import { describe, expect, it } from "vitest";
import {
  exposureLevelForMode,
  mapPageSelectionToHttp,
} from "./tutor-service";
import { shouldCreateLearningSession } from "@aistudy/contracts";

describe("tutor-service RU-04 / continuity hooks", () => {
  it("maps page selection failures to HTTP 422 codes", () => {
    for (const code of [
      "page_not_in_sources",
      "chunk_not_in_sources",
      "page_chunk_mismatch",
    ] as const) {
      const err = mapPageSelectionToHttp(code);
      expect(err.status).toBe(422);
      expect(err.code).toBe(code);
    }
  });

  it("creates learning sessions only for hint/explain", () => {
    expect(shouldCreateLearningSession("hint")).toBe(true);
    expect(shouldCreateLearningSession("explain")).toBe(true);
    expect(shouldCreateLearningSession("listen")).toBe(false);
    expect(shouldCreateLearningSession("think_together")).toBe(false);
  });

  it("exposureLevelForMode only when delivered", () => {
    expect(exposureLevelForMode("explain", true)).toBe("revealed");
    expect(exposureLevelForMode("hint", true)).toBe("hinted");
    expect(exposureLevelForMode("explain", false)).toBeNull();
    expect(exposureLevelForMode("listen", true)).toBeNull();
  });
});
