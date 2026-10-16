import { describe, expect, it } from "vitest";
import { evaluateEvidenceEligibility, resolveEvidenceAssistance } from "./evidence-eligibility";
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

  it("ignores instruction kind for a different problem (no item assistance elevation)", () => {
    const result = evaluateEvidenceEligibility(observation, withHelp([
      {
        ...exposure,
        attemptId: "other-attempt",
        problemId: "other-problem",
        kind: "instruction",
        level: "revealed",
      },
    ]));
    expect(result.independentAttempt).toBe("yes");
    expect(result.reasonCodes).not.toContain("help_before_submission");
    expect(result.reasonCodes).not.toContain("prior_answer_exposure");
  });

  it("ignores same-attempt instruction kind for item assistance", () => {
    const result = evaluateEvidenceEligibility(observation, withHelp([
      { ...exposure, kind: "instruction", level: "revealed" },
    ]));
    expect(result.independentAttempt).toBe("yes");
    expect(result.reasonCodes).not.toContain("help_before_submission");
  });

  it("same-problem prior solution kind survives as prior_answer_exposure (V2-13 T4)", () => {
    const result = evaluateEvidenceEligibility(observation, withHelp([
      {
        ...exposure,
        attemptId: "attempt-1",
        deliveredAt: 100,
        level: "revealed",
        kind: "solution",
      },
    ]));
    expect(result.independentAttempt).toBe("yes");
    expect(result.usableForDelayedCheck).toBe("no");
    expect(result.reasonCodes).toContain("prior_answer_exposure");
  });

describe("resolved evidence assistance", () => {
  it.each(["hinted", "revealed"] as const)("retains delivered %s after the declaration is revised to independent", level => {
    expect(resolveEvidenceAssistance(observation, withHelp([{ ...exposure, level }]))).toBe(level);
    expect(observation.assistance).toBe("independent");
  });

  it("keeps the strongest declared or established delivery regardless of exposure order", () => {
    const history = [{ ...exposure, level: "revealed" as const }, exposure];
    expect(resolveEvidenceAssistance(observation, withHelp(history))).toBe("revealed");
    expect(resolveEvidenceAssistance(observation, withHelp([...history].reverse()))).toBe("revealed");
    expect(resolveEvidenceAssistance({ ...observation, assistance: "revealed" }, withHelp([exposure]))).toBe("revealed");
    expect(resolveEvidenceAssistance({ ...observation, assistance: "hinted" }, context)).toBe("hinted");
  });

  it.each([
    ["post-submission feedback", { deliveredAt: 301 }],
    ["feedback tied with submission", { deliveredAt: 300 }],
    ["help before the attempt", { deliveredAt: 199 }],
    ["another attempt", { attemptId: "other-attempt", deliveredAt: 100, level: "revealed" }],
    ["another problem", { problemId: "other-problem" }],
    ["undelivered help", { delivered: false }],
    ["unknown delivery", { delivered: null }],
    ["unknown delivery time", { deliveredAt: null }],
    ["unknown attempt association", { attemptId: null }],
    ["instruction", { kind: "instruction", level: "revealed" }],
  ] as const)("does not upgrade from %s", (_name, patch) => {
    expect(resolveEvidenceAssistance(observation, withHelp([{ ...exposure, ...patch }]))).toBe("independent");
  });

  it("leaves missing timing and help history unknown rather than reconstructing them", () => {
    expect(resolveEvidenceAssistance({ ...observation, startedAt: null }, withHelp([exposure]))).toBe("independent");
    expect(resolveEvidenceAssistance({ ...observation, submittedAt: null }, withHelp([exposure]))).toBe("independent");
    expect(resolveEvidenceAssistance({ ...observation, assistance: "unknown" }, {})).toBe("unknown");
  });

  it("qualifies help before an actual revised answer while keeping original-answer feedback separate", () => {
    const revisedContext = { ...context, helpHistory: { complete: true, answerRecordedAt: 500, exposures: [{ ...exposure, deliveredAt: 400 }] } };
    expect(resolveEvidenceAssistance(observation, revisedContext)).toBe("hinted");
    expect(resolveEvidenceAssistance(observation, withHelp([{ ...exposure, deliveredAt: 400 }]))).toBe("independent");
  });
});
