import { describe, expect, it } from "vitest";
import { materialAnalysisHref, materialAnalysisEntry } from "./material-analysis-link";
describe("material analysis entry", () => {
  it("pins a physical page and starts a fresh material-specific analysis draft", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(materialAnalysisHref(id, 2)).toBe(`/opening/assistant?source=${id}&page=2`);
    expect(materialAnalysisEntry(id, "2")).toMatchObject({ initialSourceIds: [id], initialPage: 2, startFresh: true });
    expect(materialAnalysisEntry(id, "2")?.initialDraft).toContain("练习");
    expect(materialAnalysisEntry("foreign-invalid", "2")).toBeNull();
    expect(materialAnalysisEntry(id, "-2")).toBeNull();
  });
});
