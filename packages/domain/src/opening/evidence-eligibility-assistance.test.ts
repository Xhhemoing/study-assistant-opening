import { describe, expect, it } from "vitest";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
import { observation, context, exposure, withHelp } from "./evidence-eligibility-fixtures";

describe("evaluateEvidenceEligibility assistance", () => {
  it.each(["hinted", "revealed"] as const)(
    "lets delivered pre-submission %s override declared independence",
    (level) => {
      const result = evaluateEvidenceEligibility(observation, withHelp([{ ...exposure, level }]));
      expect(result.independentAttempt).toBe("no");
      expect(result.verifiedCorrect).toBe("yes");
      expect(result.usableForDelayedCheck).toBe("no");
      expect(result.reasonCodes).toContain("help_before_submission");
    },
  );

  it("keeps two problems in one session separate", () => {
    const result = evaluateEvidenceEligibility(observation, withHelp([
      { ...exposure, attemptId: "other-attempt", problemId: "other-problem" },
    ]));
    expect(result.independentAttempt).toBe("yes");
    expect(result.usableForDelayedCheck).toBe("yes");
  });

  it("does not count undelivered help or post-submission feedback", () => {
    const result = evaluateEvidenceEligibility(observation, withHelp([
      { ...exposure, delivered: false, deliveredAt: null },
      { ...exposure, deliveredAt: 301, level: "revealed" },
    ]));
    expect(result.independentAttempt).toBe("yes");
    expect(result.usableForDelayedCheck).toBe("yes");
  });

  it.each([
    ["delivery", { delivered: null }],
    ["attempt association", { attemptId: null }],
    ["problem association", { problemId: null }],
    ["delivery time", { deliveredAt: null }],
    ["simultaneous delivery", { deliveredAt: 300 }],
    ["contradictory association", { problemId: "other-problem" }],
  ] as const)("keeps uncertain %s unknown", (_name, patch) => {
    const result = evaluateEvidenceEligibility(observation, withHelp([{ ...exposure, ...patch }]));
    expect(result.independentAttempt).toBe("unknown");
    expect(result.usableForDelayedCheck).toBe("unknown");
  });

  it("does not require the learner to have read server-delivered help", () => {
    expect(evaluateEvidenceEligibility(observation, withHelp([exposure])).independentAttempt).toBe("no");
  });

  it("does not infer absence of help from an incomplete history", () => {
    expect(evaluateEvidenceEligibility(observation, withHelp([], false)).independentAttempt).toBe("unknown");
    expect(evaluateEvidenceEligibility(observation, { ...context, helpHistory: null }).independentAttempt).toBe("unknown");
  });

  it("retains affirmative help even when other help facts are uncertain", () => {
    const result = evaluateEvidenceEligibility(observation, withHelp([
      { ...exposure, deliveredAt: null }, exposure,
    ], false));
    expect(result.independentAttempt).toBe("no");
  });

  it.each(["hinted", "revealed"] as const)("respects declared %s without a recorded exposure", (assistance) => {
    expect(evaluateEvidenceEligibility({ ...observation, assistance }, context).independentAttempt).toBe("no");
  });

  it("keeps an unknown assistance declaration unknown", () => {
    expect(evaluateEvidenceEligibility({ ...observation, assistance: "unknown" }, context).independentAttempt).toBe("unknown");
  });

  it("separates a previous answer exposure from help in this new attempt", () => {
    const result = evaluateEvidenceEligibility(observation, withHelp([
      { ...exposure, attemptId: "attempt-1", deliveredAt: 100, level: "revealed" },
    ]));
    expect(result.independentAttempt).toBe("yes");
    expect(result.usableForDelayedCheck).toBe("no");
    expect(result.reasonCodes).toContain("prior_answer_exposure");
    expect(result.reasonCodes).not.toContain("help_before_submission");
  });

  it("permits a previously exposed question only when the delayed protocol explicitly permits it", () => {
    const ctx = withHelp([{ ...exposure, attemptId: "attempt-1", deliveredAt: 100, level: "revealed" }]);
    ctx.delayedCheck = { ...context.delayedCheck!, priorAnswerPolicy: "allow_repeated_problem" };
    expect(evaluateEvidenceEligibility(observation, ctx).usableForDelayedCheck).toBe("yes");
  });

  it("does not turn prior hints into answer exposure or current-attempt assistance", () => {
    const result = evaluateEvidenceEligibility(observation, withHelp([
      { ...exposure, attemptId: "attempt-1", deliveredAt: 100 },
    ]));
    expect(result.independentAttempt).toBe("yes");
    expect(result.reasonCodes).not.toContain("prior_answer_exposure");
  });

  it("keeps same-problem help during a different concurrent attempt unresolved", () => {
    const result = evaluateEvidenceEligibility(observation, withHelp([
      { ...exposure, attemptId: "attempt-1", deliveredAt: 250, level: "revealed" },
    ]));
    expect(result.independentAttempt).toBe("unknown");
    expect(result.usableForDelayedCheck).toBe("unknown");
  });
});
