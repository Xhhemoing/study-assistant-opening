import { describe, expect, it } from "vitest";
import { resolveAssistance } from "./assistance";
import {
  assertCitationsForPage,
  assertNoMasteryPercentage,
  assistedItemBlocksIndependent,
  exposureLevelForMode,
  freshRetestExposure,
  makeTutorInstruction,
  marksReveal,
  recommendTutorAction,
  variantProblemRef,
  PageCitationError,
} from "./tutor-policy";

describe("K02a tutor-policy", () => {
  it("mode policy: hint forbids full answer; explain allows reveal", () => {
    const hint = makeTutorInstruction("hint");
    const guided = makeTutorInstruction("guided");
    expect(hint).toMatch(/next-step|下一步/i);
    expect(hint).toMatch(/禁止|forbid|完整答案/i);
    expect(guided).toBe(hint);
    const explain = makeTutorInstruction("explain");
    const worked = makeTutorInstruction("worked_example");
    expect(explain).toMatch(/完整|worked example/i);
    expect(worked).toBe(explain);
    expect(marksReveal("explain")).toBe(true);
    expect(marksReveal("worked_example")).toBe(true);
    expect(exposureLevelForMode("hint")).toBe("hinted");
    expect(exposureLevelForMode("guided")).toBe("hinted");
  });

  it("exposure wash: client independent stays hinted/revealed; retest empty", () => {
    expect(resolveAssistance("independent", ["hinted"])).toBe("hinted");
    expect(resolveAssistance("independent", ["revealed"])).toBe("revealed");
    expect(freshRetestExposure()).toEqual([]);
    expect(resolveAssistance("independent", freshRetestExposure())).toBe(
      "independent",
    );
  });

  it("page citation: currentPage=N must match; invented page throws", () => {
    assertCitationsForPage([{ page: 3 }, { page: 3 }], 3);
    expect(() => assertCitationsForPage([{ page: 1 }], 3)).toThrow(
      PageCitationError,
    );
    try {
      assertCitationsForPage([], 2);
    } catch (error) {
      expect(error).toBeInstanceOf(PageCitationError);
      expect((error as PageCitationError).code).toBe("page_not_in_sources");
    }
  });

  it("variant identity: assisted item A cannot become observed_independent", () => {
    const next = variantProblemRef("problem-A");
    expect(next).not.toBe("problem-A");
    expect(
      assistedItemBlocksIndependent({
        assistedProblemRef: "problem-A",
        answerProblemRef: "problem-A",
        assistance: "independent",
        outcome: "correct",
      }),
    ).toBe(true);
    const action = recommendTutorAction({
      skillLabel: "chain rule",
      currentPage: 2,
      sourceIds: [],
      problemRef: "problem-A",
      sessionExposures: ["revealed"],
      assistedSuccessOnCurrentItem: true,
      retestDue: false,
    });
    expect(action.kind).toBe("independent_variant");
    expect(action.problemRef).not.toBe("problem-A");
  });

  it("retest close: delayed_retest has no mastery percentage fields", () => {
    const action = recommendTutorAction({
      skillLabel: "chain rule",
      currentPage: 2,
      sourceIds: [],
      sessionExposures: [],
      assistedSuccessOnCurrentItem: false,
      retestDue: true,
    });
    expect(action.kind).toBe("delayed_retest");
    assertNoMasteryPercentage({ ...action } as Record<string, unknown>);
    expect(() =>
      assertNoMasteryPercentage({ masteryPercent: 80 }),
    ).toThrow(/mastery/i);
  });

  it("no K01 required: empty evidence still recommends actions", () => {
    const action = recommendTutorAction({
      skillLabel: "limits",
      currentPage: 4,
      sourceIds: ["src-1"],
      nodeId: null,
      sessionExposures: [],
      assistedSuccessOnCurrentItem: false,
      retestDue: false,
      evidenceIds: [],
    });
    expect(["clarify", "guided", "worked_example", "independent_variant"]).toContain(
      action.kind,
    );
    expect(action.kind).toBe("guided");
    expect(action.nodeId).toBeNull();
    expect(action.evidenceIds).toEqual([]);
  });
});
