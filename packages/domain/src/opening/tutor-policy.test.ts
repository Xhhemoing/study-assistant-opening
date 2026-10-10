import { describe, expect, it } from "vitest";
import { resolveAssistance } from "./assistance";
import {
  assertCitationsForPage,
  preferCitationsForPage,
  assertNoMasteryPercentage,
  assistedItemBlocksIndependent,
  exposureLevelForMode,
  freshRetestExposure,
  makeTutorInstruction,
  marksReveal,
  recommendTutorAction,
  variantProblemRef,
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

  it("page citation soft: empty cites OK; prefer on-page when any match", () => {
    // Soft guard never throws for empty or off-page cites.
    expect(() => assertCitationsForPage([], 2)).not.toThrow();
    expect(() => assertCitationsForPage([{ page: 1 }], 3)).not.toThrow();
    expect(() => assertCitationsForPage([{ page: 3 }, { page: 3 }], 3)).not.toThrow();

    expect(preferCitationsForPage([], 2)).toEqual([]);
    expect(preferCitationsForPage([{ page: 3 }, { page: 1 }, { page: 3 }], 3)).toEqual([
      { page: 3 },
      { page: 3 },
    ]);
    // No on-page match → keep original (do not fail turn).
    expect(preferCitationsForPage([{ page: 1 }, { page: 2 }], 3)).toEqual([
      { page: 1 },
      { page: 2 },
    ]);
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

describe("K02 adaptive tutor-policy (nodeId path)", () => {
  it("asks for independent transfer after assisted success", () => {
    expect(
      recommendTutorAction({
        nodeId: "n",
        hasCheckedIndependent: false,
        hasAssistance: true,
        retestDue: false,
      }),
    ).toBe("independent_variant");
  });

  it("prioritizes delayed retest when due", () => {
    expect(
      recommendTutorAction({
        nodeId: "n",
        hasCheckedIndependent: false,
        hasAssistance: true,
        retestDue: true,
      }),
    ).toBe("delayed_retest");
  });

  it("asks to clarify when there is no reliable evidence", () => {
    expect(
      recommendTutorAction({
        nodeId: "n",
        hasCheckedIndependent: false,
        hasAssistance: false,
        retestDue: false,
      }),
    ).toBe("clarify");
  });

  it("asks for a new independent context after checked independent evidence", () => {
    expect(
      recommendTutorAction({
        nodeId: "n",
        hasCheckedIndependent: true,
        hasAssistance: false,
        retestDue: false,
      }),
    ).toBe("independent_variant");
  });
});
