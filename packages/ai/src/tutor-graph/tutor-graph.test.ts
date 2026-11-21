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
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
    const result = runTutorGraph({
      questionStem: "因式分解",
      submission: {},
      budget,
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
      releaseCaps: { assertCurrent: () => undefined },
    });
    expect(result.state).toBe("released");
    expect(result.releaseApproved).toBe(true);
    expect(result.providerCalls).toBe(0);
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
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 1, now: () => 1000 });
    const controller = new AbortController();

    const blockedStructured = runTutorGraph({
      questionStem: "积分",
      submission: {},
      budget,
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
      releaseCaps: { assertCurrent: () => undefined },
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
      releaseCaps: { assertCurrent: () => undefined },
    });
    expect(second.state).toBe("budget_contaminated");
    expect(second.publicTeaching).toBeUndefined();
    expect(second.releasedText).toBeTruthy();
    expect(budget.leakageBits).toBe(1);
    expect(budget.state).toBe("contaminated");
    expect(budget.cooldownUntilMs).toBe(1000 + 72 * 3_600_000);
  });
});
