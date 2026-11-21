import { describe, expect, it, vi } from "vitest";
import { createMinEntropyBudget } from "./min-entropy-budget";
import { runTutorGraph, runTutorGraphTurn } from "./graph";

describe("TutorGraph fast path", () => {
  it("fails closed when explicit MinEntropyBudget is omitted on pure/graded items", () => {
    const verify = vi.fn(() => ({ steps: [] }));
    const missingBudget = runTutorGraph({
      questionStem: "问题",
      submission: {},
      attemptSubmitted: true,
      verifyCaps: { verify, assertCurrent: () => undefined },
      releaseCaps: { assertCurrent: () => undefined },
    });
    expect(missingBudget.state).toBe("unverified");
    expect(missingBudget.reason).toBe("missing_entropy_budget");
    expect(missingBudget.releaseApproved).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  it("unconditionally blocks answer-dependent verification on unsubmitted pure turns even without answerProbe", () => {
    const verify = vi.fn(() => ({ steps: [] }));
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });

    const unsubmittedDefault = runTutorGraphTurn({
      questionStem: "求导",
      submission: { draft: "x" },
      budget,
      verifyCaps: { verify, assertCurrent: () => undefined },
      releaseCaps: { assertCurrent: () => undefined },
    });
    expect(unsubmittedDefault.state).toBe("released");
    expect(unsubmittedDefault.releasedText).toBeTruthy();
    expect(unsubmittedDefault.providerCalls).toBe(0);
    expect(unsubmittedDefault.leakageBits).toBe(0);
    expect(unsubmittedDefault.helpState).toBe("pure");
    expect(unsubmittedDefault.reason).toBe("unsubmitted_pure_attempt");
    expect(verify).not.toHaveBeenCalled();

    const probeResult = runTutorGraph({
      questionStem: "问题",
      submission: { probe: true },
      budget,
      answerProbe: true,
      attemptSubmitted: true,
      verifyCaps: { verify, assertCurrent: () => undefined },
      releaseCaps: { assertCurrent: () => undefined },
    });
    expect(probeResult.state).toBe("released");
    expect(probeResult.helpState).toBe("pure");
    expect(probeResult.reason).toBe("unsubmitted_answer_probe");
    expect(verify).not.toHaveBeenCalled();
  });

  it("marks only the first error invalid and downstream steps dependent on submitted attempts", () => {
    const budget = createMinEntropyBudget({ assessmentMode: "practice", scaffoldBitBudget: 4, now: () => 1000 });
    const result = runTutorGraph({
      questionStem: "因式分解",
      submission: {},
      budget,
      assessmentMode: "practice",
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => ({
          deterministic: true,
          steps: [
            { id: "s1", text: "一步", status: "valid" },
            { id: "s2", text: "二步", status: "invalid" },
            { id: "s3", text: "三步", status: "invalid" },
          ],
          firstError: { stepId: "s2", kind: "domain", message: "缺少定义域" },
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: (text) => text.includes("SECRET_42") },
    });
    expect(result.state).toBe("released");
    expect(result.releaseApproved).toBe(true);
    expect(result.providerCalls).toBe(0);
    expect(result.leakageBits).toBe(2);
    expect(result.publicTeaching?.learnerSteps.map((step) => step.status)).toEqual(["valid", "invalid", "dependent"]);
    expect(result.publicTeaching?.movePlan.move).toBe("local_counterexample");
  });

  it("enforces 1.5-bit cap, atomic 72h cooldown, and distinct SeededRecipe reset", () => {
    let nowMs = 1000;
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 8, now: () => nowMs, initialSeed: "seed-a" });
    expect(budget.state).toBe("pure");
    budget.beforeRelease(1);
    expect(budget.state).toBe("scaffolded");
    const checkOver = budget.canRelease(0.5, nowMs);
    expect(checkOver.allowed).toBe(false);
    expect(budget.state).toBe("contaminated");
    const firstCooldown = 1000 + 72 * 60 * 60 * 1000;
    expect(budget.cooldownUntil).toBe(firstCooldown);
    expect(budget.cooldownUntilMs).toBe(firstCooldown);

    expect(() => budget.resetForFreshVariant("seed-b", firstCooldown - 1)).toThrow(/cooldown_active/);

    nowMs = 5000;
    const verify = vi.fn(() => ({
      steps: [{ id: "s1", text: "一步", status: "invalid" as const }],
      firstError: { stepId: "s1", kind: "domain", message: "leaked" },
    }));
    const duringCooldown = runTutorGraph({
      questionStem: "导数",
      submission: {},
      budget,
      attemptSubmitted: true,
      verifyCaps: { verify, assertCurrent: () => undefined },
      releaseCaps: { assertCurrent: () => undefined },
    });
    expect(duringCooldown.state).toBe("cooldown");
    expect(duringCooldown.releaseApproved).toBe(false);
    expect(duringCooldown.releasedText).toBeTruthy();
    expect(duringCooldown.publicTeaching).toBeUndefined();
    expect(duringCooldown.verification).toEqual({ steps: [] });
    expect(duringCooldown.providerCalls).toBe(0);
    expect(verify).not.toHaveBeenCalled();
    expect(budget.cooldownUntil).toBe(firstCooldown);

    nowMs = firstCooldown + 1;
    const afterCooldown = runTutorGraph({
      questionStem: "导数",
      submission: {},
      budget,
      attemptSubmitted: true,
      verifyCaps: { verify, assertCurrent: () => undefined },
      releaseCaps: { assertCurrent: () => undefined },
    });
    expect(afterCooldown.state).toBe("budget_contaminated");
    expect(afterCooldown.releaseApproved).toBe(false);
    expect(afterCooldown.releasedText).toBeTruthy();
    expect(afterCooldown.publicTeaching).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();

    expect(() => budget.resetForFreshVariant("seed-a", nowMs)).toThrow(/duplicate_seeded_recipe/);
    budget.resetForFreshVariant("seed-b", nowMs);
    expect(budget.state).toBe("pure");
    expect(budget.leakageBits).toBe(0);
    expect(budget.cooldownUntilMs).toBeUndefined();
    expect(() => budget.resetForFreshVariant("seed-a", nowMs)).toThrow(/duplicate_seeded_recipe/);
    expect(() => budget.resetForFreshVariant("seed-b", nowMs)).toThrow(/duplicate_seeded_recipe/);

    const directHit = budget.commitRelease(1.5, nowMs);
    expect(directHit.state).toBe("contaminated");
    expect(directHit.cooldownUntilMs).toBe(nowMs + 72 * 3_600_000);
  });

  it("scans structured witness params/stepErrors and scrubs raw verification on rejection or abort", () => {
    const budget = createMinEntropyBudget({ assessmentMode: "practice", scaffoldBitBudget: 4, now: () => 1000 });
    const controller = new AbortController();

    const blockedStructured = runTutorGraph({
      questionStem: "积分",
      submission: {},
      budget,
      assessmentMode: "practice",
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => ({
          steps: [{ id: "s1", text: "一步", status: "invalid" }],
          firstError: {
            stepId: "s1",
            kind: "domain",
            message: "检查定义域",
            witness: { counterexample: { secretAnswer: "SECRET_42" } },
          },
          ruleWitness: {
            capability: "function-diff-plot@1",
            params: { origin: "rules", title: "差异", points: [{ x: "1", reference: "SECRET_42", kind: "discontinuity" }], explanation: "注意" },
          },
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: {
        assertCurrent: () => undefined,
        answerLeakageBlocker: (text) => text.includes("SECRET_42"),
      },
    });
    expect(blockedStructured.state).toBe("unverified");
    expect(blockedStructured.reason).toBe("release_guard_rejected");
    expect(blockedStructured.releaseApproved).toBe(false);
    expect(blockedStructured.publicTeaching).toBeUndefined();
    expect(blockedStructured.releasedText).toBeUndefined();
    expect(blockedStructured.verification).toEqual({ steps: [] });
    expect(JSON.stringify(blockedStructured)).not.toContain("SECRET_42");
    expect(budget.leakageBits).toBe(0);
    expect(budget.state).toBe("pure");

    const aborted = runTutorGraph({
      questionStem: "积分",
      submission: {},
      budget,
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => {
          controller.abort();
          return {
            steps: [{ id: "s1", text: "一步", status: "invalid" }],
            firstError: { stepId: "s1", kind: "domain", message: "秘密" },
          };
        },
        assertCurrent: () => undefined,
      },
      releaseCaps: {
        stopSignal: controller.signal,
        assertCurrent: () => undefined,
        answerLeakageBlocker: () => false,
      },
    });
    expect(aborted.state).toBe("stopped");
    expect(aborted.publicTeaching).toBeUndefined();
    expect(aborted.verification).toEqual({ steps: [] });
    expect(budget.leakageBits).toBe(0);
    expect(budget.state).toBe("pure");
  });

  it("blocks hint release when canRelease denies exceeding scaffoldBitBudget and records cooldown", () => {
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 1, now: () => 1000 });
    const first = runTutorGraph({
      questionStem: "极限",
      submission: {},
      budget,
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => ({
          steps: [{ id: "s1", text: "一步", status: "invalid" }],
          firstError: { stepId: "s1", kind: "notation", message: "记号" },
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: (text) => text.includes("SECRET_42") },
    });
    expect(first.state).toBe("released");
    expect(budget.leakageBits).toBe(1);

    const second = runTutorGraph({
      questionStem: "极限",
      submission: {},
      budget,
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => ({
          steps: [{ id: "s1", text: "一步", status: "invalid" }],
          firstError: { stepId: "s1", kind: "notation", message: "记号" },
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: (text) => text.includes("SECRET_42") },
    });
    expect(second.state).toBe("budget_contaminated");
    expect(second.publicTeaching).toBeUndefined();
    expect(second.releasedText).toBeTruthy();
    expect(budget.leakageBits).toBe(1);
    expect(budget.state).toBe("contaminated");
    expect(budget.cooldownUntilMs).toBe(1000 + 72 * 3_600_000);
  });

  it("rejects structured release payloads with blocked keys or nesting past depth 16, and rejects non-finite budget inputs", () => {
    let deepNested: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < 18; i++) deepNested = { [`layer${i}`]: deepNested };

    const deepResult = runTutorGraph({
      questionStem: "极限",
      submission: {},
      budget: createMinEntropyBudget({ assessmentMode: "practice", scaffoldBitBudget: 4, now: () => 1000 }),
      assessmentMode: "practice",
      attemptSubmitted: true,
      verifyCaps: {
        verify: () =>
          ({
            steps: [{ id: "s1", text: "一步", status: "valid" }],
            nestedMeta: deepNested,
          }) as never,
        assertCurrent: () => undefined,
      },
      releaseCaps: {
        assertCurrent: () => undefined,
        answerLeakageBlocker: (text) => text.includes("NEVER_MATCH"),
      },
    });
    expect(deepResult.state).toBe("unverified");
    expect(deepResult.reason).toBe("release_guard_rejected");
    expect(deepResult.releaseApproved).toBe(false);
    expect(deepResult.verification).toEqual({ steps: [] });
    expect(deepResult.publicTeaching).toBeUndefined();
    expect(deepResult.releasedText).toBeUndefined();

    const leakedKeyResult = runTutorGraph({
      questionStem: "极限",
      submission: {},
      budget: createMinEntropyBudget({ assessmentMode: "practice", scaffoldBitBudget: 4, now: () => 1000 }),
      assessmentMode: "practice",
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => ({
          steps: [{ id: "s1", text: "一步", status: "invalid" }],
          firstError: { stepId: "s1", kind: "notation", message: "记号" },
          ruleWitness: { secretAnswerKey: "benign" } as never,
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: {
        assertCurrent: () => undefined,
        answerLeakageBlocker: (text) => text.includes("secretAnswerKey"),
      },
    });
    expect(leakedKeyResult.state).toBe("unverified");
    expect(leakedKeyResult.reason).toBe("release_guard_rejected");
    expect(leakedKeyResult.releaseApproved).toBe(false);
    expect(leakedKeyResult.verification).toEqual({ steps: [] });

    expect(() => createMinEntropyBudget({ cooldownHours: Number.NaN })).toThrow(RangeError);
    expect(() => createMinEntropyBudget({ cooldownHours: -1 })).toThrow(RangeError);
    expect(() => createMinEntropyBudget({ cooldownHours: Number.POSITIVE_INFINITY })).toThrow(RangeError);

    const guardBudget = createMinEntropyBudget({ initialSeed: "seed-1", now: () => 1000 });
    guardBudget.commitRelease(4, 1000);
    expect(() => guardBudget.canRelease(1, Number.NaN)).toThrow(RangeError);
    expect(() => guardBudget.canRelease(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => guardBudget.commitRelease(1, Number.NaN)).toThrow(RangeError);
    expect(() => guardBudget.resetForFreshVariant("seed-2", Number.NaN)).toThrow(RangeError);
    expect(() => guardBudget.resetForFreshVariant("seed-2", Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("fails closed when answerLeakageBlocker is omitted, scrubs raw witnesses, and charges entropy for step verdicts", () => {
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
    const missingBlocker = runTutorGraph({
      questionStem: "求导",
      submission: {},
      budget,
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => ({
          steps: [{ id: "s1", text: "一步", status: "valid" }],
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: { assertCurrent: () => undefined },
    });
    expect(missingBlocker.state).toBe("unverified");
    expect(missingBlocker.reason).toBe("release_guard_rejected");
    expect(missingBlocker.releaseApproved).toBe(false);
    expect(missingBlocker.verification).toEqual({ steps: [] });
    expect(missingBlocker.publicTeaching).toBeUndefined();
    expect(missingBlocker.releasedText).toBeUndefined();
    expect(budget.leakageBits).toBe(0);

    const zeroBudget = createMinEntropyBudget({ scaffoldBitBudget: 0, now: () => 1000 });
    const zeroBlocked = runTutorGraph({
      questionStem: "求导",
      submission: {},
      budget: zeroBudget,
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => ({
          steps: [{ id: "s1", text: "一步", status: "valid" }],
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: {
        assertCurrent: () => undefined,
        answerLeakageBlocker: () => false,
      },
    });
    expect(zeroBlocked.state).toBe("budget_contaminated");
    expect(zeroBlocked.releaseApproved).toBe(false);
    expect(zeroBlocked.verification).toEqual({ steps: [] });
    expect(zeroBlocked.publicTeaching).toBeUndefined();

    const stepBudget = createMinEntropyBudget({ assessmentMode: "practice", scaffoldBitBudget: 1.5, now: () => 1000 });
    const firstValidStep = runTutorGraph({
      questionStem: "求导",
      submission: {},
      budget: stepBudget,
      assessmentMode: "practice",
      attemptSubmitted: true,
      verifyCaps: {
        verify: () =>
          ({
            steps: [{ id: "s1", text: "一步", status: "valid" }],
            firstError: { stepId: "s1", kind: "notation", message: "检查符号", witness: { hiddenAnswer: "x^2" } },
            ruleWitness: { capability: "function-diff-plot@1", params: { origin: "rules", title: "提示", points: [], explanation: "ok" } },
            sealedSolutionRef: "sealed-internal",
          }) as never,
        assertCurrent: () => undefined,
      },
      releaseCaps: {
        assertCurrent: () => undefined,
        answerLeakageBlocker: () => false,
      },
    });
    expect(firstValidStep.state).toBe("released");
    expect(stepBudget.leakageBits).toBe(1);
    expect(firstValidStep.verification.firstError).toEqual({
      stepId: "s1",
      kind: "notation",
      message: "检查符号",
    });
    expect((firstValidStep.verification.firstError as { witness?: unknown }).witness).toBeUndefined();
    expect((firstValidStep.verification as { ruleWitness?: unknown }).ruleWitness).toBeUndefined();
    expect((firstValidStep.verification as { sealedSolutionRef?: unknown }).sealedSolutionRef).toBeUndefined();

    const secondStepTurn = runTutorGraph({
      questionStem: "求导",
      submission: {},
      budget: stepBudget,
      assessmentMode: "practice",
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => ({
          steps: [{ id: "s1", text: "一步", status: "invalid" }],
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: {
        assertCurrent: () => undefined,
        answerLeakageBlocker: () => false,
      },
    });
    expect(secondStepTurn.state).toBe("budget_contaminated");
    expect(secondStepTurn.verification).toEqual({ steps: [] });
  });

  it("strips undeclared verifier fields, hides thrown verifier messages, and enforces log2(outcomes) with pure coarsening", () => {
    const crashBudget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
    const crashed = runTutorGraph({
      questionStem: "积分",
      submission: {},
      budget: crashBudget,
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => {
          throw new Error("INTERNAL_DB_SECRET_SOLUTION_42");
        },
        assertCurrent: () => undefined,
      },
      releaseCaps: {
        assertCurrent: () => undefined,
        answerLeakageBlocker: () => false,
      },
    });
    expect(crashed.state).toBe("unverified");
    expect(crashed.reason).toBe("verifier_execution_failed");
    expect(crashed.releaseApproved).toBe(false);
    expect(JSON.stringify(crashed)).not.toContain("INTERNAL_DB_SECRET_SOLUTION_42");

    const leakBudget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
    const stripped = runTutorGraph({
      questionStem: "极限",
      submission: {},
      budget: leakBudget,
      attemptSubmitted: true,
      verifyCaps: {
        verify: () =>
          ({
            steps: [{ id: "s1", text: "一步", status: "valid", leakedStepSecret: "RAW_STEP_KEY" }],
            ruleWitness: {
              capability: "function-diff-plot@1",
              rawWitnessSecret: "RAW_WITNESS_KEY",
              params: {
                origin: "rules",
                title: "差异",
                points: [{ x: "1", kind: "discontinuity", secretPointKey: "RAW_POINT_KEY" }],
                explanation: "说明",
                extraParamSecret: "RAW_PARAM_KEY",
              },
            },
          }) as never,
        assertCurrent: () => undefined,
      },
      releaseCaps: {
        assertCurrent: () => undefined,
        answerLeakageBlocker: () => false,
      },
    });
    expect(stripped.state).toBe("released");
    const serialized = JSON.stringify(stripped);
    expect(serialized).not.toContain("RAW_STEP_KEY");
    expect(serialized).not.toContain("RAW_WITNESS_KEY");
    expect(serialized).not.toContain("RAW_POINT_KEY");
    expect(serialized).not.toContain("RAW_PARAM_KEY");

    const shapeSet = new Set<string>();
    const variants: Array<Parameters<typeof runTutorGraph>[0]["verifyCaps"]["verify"]> = [
      () => ({
        steps: [
          { id: "s1", text: "a", status: "valid" },
          { id: "s2", text: "b", status: "valid" },
          { id: "s3", text: "c", status: "valid" },
        ],
      }),
      () => ({
        steps: [
          { id: "s1", text: "a", status: "invalid" },
          { id: "s2", text: "b", status: "valid" },
          { id: "s3", text: "c", status: "valid" },
        ],
        firstError: { stepId: "s1", kind: "domain", message: "bad1" },
      }),
      () => ({
        steps: [
          { id: "s1", text: "a", status: "valid" },
          { id: "s2", text: "b", status: "invalid" },
          { id: "s3", text: "c", status: "valid" },
        ],
        firstError: { stepId: "s2", kind: "domain", message: "bad2" },
      }),
      () => ({
        steps: [
          { id: "s1", text: "a", status: "valid" },
          { id: "s2", text: "b", status: "valid" },
          { id: "s3", text: "c", status: "invalid" },
        ],
        firstError: { stepId: "s3", kind: "domain", message: "bad3" },
      }),
    ];
    for (const verifyFn of variants) {
      const pureBudget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
      const res = runTutorGraph({
        questionStem: "微积分",
        submission: {},
        budget: pureBudget,
        attemptSubmitted: true,
        verifyCaps: { verify: verifyFn, assertCurrent: () => undefined },
        releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => false },
      });
      expect(res.state).toBe("released");
      expect(pureBudget.leakageBits).toBe(1);
      expect(res.publicTeaching?.learnerSteps.every((step) => step.status === "unknown")).toBe(true);
      expect(res.verification.firstError).toBeUndefined();
      shapeSet.add(JSON.stringify({ teaching: res.publicTeaching, verification: res.verification }));
    }
    expect(shapeSet.size).toBe(2);

    const practiceBudget = createMinEntropyBudget({ assessmentMode: "practice", scaffoldBitBudget: 4, now: () => 1000 });
    const twoStep = runTutorGraph({
      questionStem: "微积分",
      submission: {},
      budget: practiceBudget,
      assessmentMode: "practice",
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => ({
          steps: [
            { id: "s1", text: "a", status: "valid" },
            { id: "s2", text: "b", status: "valid" },
          ],
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => false },
    });
    expect(twoStep.state).toBe("released");
    expect(twoStep.leakageBits).toBeCloseTo(Math.log2(3), 10);

    // Round-11 P1-1: pure turns always emit <= 2 public outcomes (all-valid vs coarsened unknown/invalid) and charge 1 bit
    const omittedFirstErrorShapes = new Set<string>();
    const partialVerdicts: Array<Parameters<typeof runTutorGraph>[0]["verifyCaps"]["verify"]> = [
      () => ({
        steps: [
          { id: "s1", text: "a", status: "unknown" },
          { id: "s2", text: "b", status: "unknown" },
          { id: "s3", text: "c", status: "unknown" },
        ],
      }),
      () => ({
        steps: [
          { id: "s1", text: "a", status: "invalid" },
          { id: "s2", text: "b", status: "unknown" },
          { id: "s3", text: "c", status: "unknown" },
        ],
      }),
      () => ({
        steps: [
          { id: "s1", text: "a", status: "unknown" },
          { id: "s2", text: "b", status: "invalid" },
          { id: "s3", text: "c", status: "unknown" },
        ],
      }),
      () => ({
        steps: [
          { id: "s1", text: "a", status: "valid" },
          { id: "s2", text: "b", status: "valid" },
          { id: "s3", text: "c", status: "valid" },
        ],
      }),
    ];
    for (const [idx, verifyFn] of partialVerdicts.entries()) {
      const purePartialBudget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
      const res = runTutorGraph({
        questionStem: "微积分",
        submission: {},
        budget: purePartialBudget,
        attemptSubmitted: true,
        verifyCaps: { verify: verifyFn, assertCurrent: () => undefined },
        releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => false },
      });
      expect(res.state).toBe("released");
      expect(purePartialBudget.leakageBits).toBe(1);
      expect(res.publicTeaching?.learnerSteps.every((step) => step.status === "unknown")).toBe(true);
      expect(res.verification.firstError).toBeUndefined();
      const shape = JSON.stringify({ teaching: res.publicTeaching, verification: res.verification });
      omittedFirstErrorShapes.add(shape);
      if (idx > 0 && idx < 3) {
        expect(omittedFirstErrorShapes.size).toBe(1);
      }
    }
    expect(omittedFirstErrorShapes.size).toBe(2);

    const singleStepShapes = new Set<string>();
    const singleStepVerdicts: Array<Parameters<typeof runTutorGraph>[0]["verifyCaps"]["verify"]> = [
      () => ({ steps: [{ id: "s1", text: "a", status: "valid" }] }),
      () => ({ steps: [{ id: "s1", text: "a", status: "unknown" }] }),
      () => ({ steps: [{ id: "s1", text: "a", status: "invalid" }] }),
      () => ({
        steps: [{ id: "s1", text: "a", status: "invalid" }],
        firstError: { stepId: "s1", kind: "domain", message: "bad" },
      }),
    ];
    for (const [idx, verifyFn] of singleStepVerdicts.entries()) {
      const b = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
      const res = runTutorGraph({
        questionStem: "求导",
        submission: {},
        budget: b,
        attemptSubmitted: true,
        verifyCaps: { verify: verifyFn, assertCurrent: () => undefined },
        releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => false },
      });
      expect(res.state).toBe("released");
      expect(b.leakageBits).toBe(1);
      expect(res.verification).toEqual({ steps: [] });
      singleStepShapes.add(JSON.stringify({ teaching: res.publicTeaching, verification: res.verification }));
      if (idx === 1) expect(singleStepShapes.size).toBe(2);
    }
    expect(singleStepShapes.size).toBe(2);

    // Round-13 P1-1: exhaustive 0-bit & 1-bit oracle test across diverse verifier step counts, texts, IDs, dependsOn, and secrets
    let deepVerifierMeta: Record<string, unknown> = { ok: true };
    for (let i = 0; i < 18; i++) deepVerifierMeta = { [`d${i}`]: deepVerifierMeta };
    const candidateSubmission = {
      steps: [
        { id: "c1", text: "x^2", dependsOn: [] },
        { id: "c2", text: "2x", dependsOn: ["c1"] },
      ],
    };
    const diverseVerifierOutputs: Array<Parameters<typeof runTutorGraph>[0]["verifyCaps"]["verify"]> = [
      () =>
        ({
          steps: [
            { id: "v_pass_1", text: "alpha", status: "valid", dependsOn: ["x"] },
            { id: "v_pass_2", text: "SECRET_42", status: "valid", dependsOn: ["v_pass_1", "extra"] },
            { id: "v_pass_3", text: "extra_step", status: "valid" },
          ],
          nestedMeta: deepVerifierMeta,
        }) as never,
      () => ({
        steps: [{ id: "v_pass_only", text: "single", status: "valid" }],
      }),
      () => ({
        steps: [
          { id: "v_f1", text: "different1", status: "invalid", dependsOn: ["z"] },
          { id: "v_f2", text: "SECRET_42", status: "valid" },
        ],
        firstError: { stepId: "v_f1", kind: "domain", message: "SECRET_42" },
      }),
      () => ({
        steps: [
          { id: "v_a", text: "valid_first", status: "valid" },
          { id: "v_b", text: "fail_second", status: "invalid", dependsOn: ["v_a"] },
          { id: "v_c", text: "c", status: "unknown" },
          { id: "v_d", text: "d", status: "invalid" },
        ],
        ruleWitness: { capability: "function-diff-plot@1", params: { origin: "rules", title: "SECRET_42" } },
      }),
      () => ({
        steps: [],
      }),
    ];

    const zeroBitOutcomes = new Set<string>();
    const oneBitOutcomes = new Set<string>();
    for (const verifyFn of diverseVerifierOutputs) {
      const zeroB = createMinEntropyBudget({ scaffoldBitBudget: 0, now: () => 1000 });
      const zeroRes = runTutorGraph({
        questionStem: "积分",
        submission: candidateSubmission,
        budget: zeroB,
        attemptSubmitted: true,
        verifyCaps: { verify: verifyFn, assertCurrent: () => undefined },
        releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: (text) => text.includes("SECRET_42") },
      });
      expect(zeroB.leakageBits).toBe(0);
      expect(JSON.stringify(zeroRes)).not.toContain("SECRET_42");
      zeroBitOutcomes.add(JSON.stringify(zeroRes));

      const oneB = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
      const oneRes = runTutorGraph({
        questionStem: "积分",
        submission: candidateSubmission,
        budget: oneB,
        attemptSubmitted: true,
        verifyCaps: { verify: verifyFn, assertCurrent: () => undefined },
        releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: (text) => text.includes("SECRET_42") },
      });
      expect(oneRes.state).toBe("released");
      expect(oneB.leakageBits).toBe(1);
      expect(JSON.stringify(oneRes)).not.toContain("SECRET_42");
      expect(oneRes.verification.steps).toEqual([
        { id: "c1", text: "x^2", status: "unknown", dependsOn: [] },
        { id: "c2", text: "2x", status: "unknown", dependsOn: ["c1"] },
      ]);
      expect(oneRes.publicTeaching?.learnerSteps).toEqual(oneRes.verification.steps);
      oneBitOutcomes.add(JSON.stringify(oneRes));
    }
    expect(zeroBitOutcomes.size).toBe(1);
    expect(oneBitOutcomes.size).toBe(2);

    // Round-10 P1-2 Bypass 2: pure turn clamped to 1.5-bit ceiling even when passed a practice-configured budget
    const reusedPracticeBudget = createMinEntropyBudget({ assessmentMode: "practice", scaffoldBitBudget: 4, now: () => 1000 });
    const pureOnPractice1 = runTutorGraph({
      questionStem: "求导",
      submission: {},
      budget: reusedPracticeBudget,
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => ({
          steps: [
            { id: "s1", text: "a", status: "valid" },
            { id: "s2", text: "b", status: "invalid" },
            { id: "s3", text: "c", status: "invalid" },
          ],
          firstError: { stepId: "s2", kind: "domain", message: "bad" },
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => false },
    });
    expect(pureOnPractice1.state).toBe("released");
    expect(reusedPracticeBudget.leakageBits).toBe(1);
    expect(pureOnPractice1.publicTeaching?.learnerSteps.every((step) => step.status === "unknown")).toBe(true);

    const pureOnPractice2 = runTutorGraph({
      questionStem: "求导",
      submission: {},
      budget: reusedPracticeBudget,
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => ({
          steps: [{ id: "s1", text: "a", status: "invalid" }],
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => false },
    });
    expect(pureOnPractice2.state).toBe("budget_contaminated");
    expect(pureOnPractice2.releaseApproved).toBe(false);
    expect(reusedPracticeBudget.leakageBits).toBe(1);
  });
});
