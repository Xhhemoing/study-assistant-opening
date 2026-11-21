import { describe, expect, it, vi } from "vitest";
import { createMinEntropyBudget } from "./min-entropy-budget";
import { runTutorGraph } from "./graph";

describe("TutorGraph fast path", () => {
  it("keeps answer probes pure with populated releasedText and does not call verification", () => {
    const verify = vi.fn(() => ({ steps: [] }));
    const result = runTutorGraph({
      questionStem: "问题",
      submission: { probe: true },
      answerProbe: true,
      verifyCaps: { verify, assertCurrent: () => undefined },
      releaseCaps: { assertCurrent: () => undefined },
    });
    expect(result.state).toBe("released");
    expect(result.releasedText).toBeTruthy();
    expect(result.providerCalls).toBe(0);
    expect(result.leakageBits).toBe(0);
    expect(result.helpState).toBe("pure");
    expect(verify).not.toHaveBeenCalled();
  });

  it("marks only the first error invalid and downstream steps dependent", () => {
    const result = runTutorGraph({
      questionStem: "因式分解",
      submission: {},
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
    expect(result.providerCalls).toBe(0);
    expect(result.publicTeaching?.learnerSteps.map((step) => step.status)).toEqual(["valid", "invalid", "dependent"]);
    expect(result.publicTeaching?.movePlan.move).toBe("local_counterexample");
  });

  it("transitions the min-entropy budget irreversibly without extending cooldown once contaminated", () => {
    let nowMs = 1000;
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 1, now: () => nowMs });
    expect(budget.state).toBe("pure");
    budget.beforeRelease(1);
    expect(budget.state).toBe("scaffolded");
    budget.beforeRelease(1);
    expect(budget.state).toBe("contaminated");
    const firstCooldown = 1000 + 72 * 60 * 60 * 1000;
    expect(budget.cooldownUntil).toBe(firstCooldown);

    nowMs = 5000;
    const verify = vi.fn(() => ({
      steps: [{ id: "s1", text: "一步", status: "invalid" as const }],
      firstError: { stepId: "s1", kind: "domain", message: "leaked" },
    }));
    const duringCooldown = runTutorGraph({
      questionStem: "导数",
      submission: {},
      budget,
      verifyCaps: { verify, assertCurrent: () => undefined },
      releaseCaps: { assertCurrent: () => undefined },
    });
    expect(duringCooldown.state).toBe("cooldown");
    expect(duringCooldown.releasedText).toBeTruthy();
    expect(duringCooldown.publicTeaching).toBeUndefined();
    expect(duringCooldown.providerCalls).toBe(0);
    expect(verify).not.toHaveBeenCalled();
    expect(budget.cooldownUntil).toBe(firstCooldown);

    nowMs = firstCooldown + 1;
    const afterCooldown = runTutorGraph({
      questionStem: "导数",
      submission: {},
      budget,
      verifyCaps: { verify, assertCurrent: () => undefined },
      releaseCaps: { assertCurrent: () => undefined },
    });
    expect(afterCooldown.state).toBe("budget_contaminated");
    expect(afterCooldown.releasedText).toBeTruthy();
    expect(afterCooldown.publicTeaching).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it("does not consume budget or leak publicTeaching when aborted or blocked by release guard", () => {
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 1, now: () => 1000 });
    const controller = new AbortController();

    const blocked = runTutorGraph({
      questionStem: "积分",
      submission: {},
      budget,
      verifyCaps: {
        verify: () => ({
          steps: [{ id: "s1", text: "一步", status: "invalid" }],
          firstError: { stepId: "s1", kind: "domain", message: "秘密" },
        }),
        assertCurrent: () => undefined,
      },
      releaseCaps: {
        assertCurrent: () => undefined,
        answerLeakageBlocker: () => true,
      },
    });
    expect(blocked.state).toBe("unverified");
    expect(blocked.publicTeaching).toBeUndefined();
    expect(blocked.releasedText).toBeUndefined();
    expect(budget.leakageBits).toBe(0);
    expect(budget.state).toBe("pure");

    const aborted = runTutorGraph({
      questionStem: "积分",
      submission: {},
      budget,
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
    expect(budget.leakageBits).toBe(0);
    expect(budget.state).toBe("pure");
  });

  it("blocks hint release when canRelease denies exceeding scaffoldBitBudget", () => {
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 1, now: () => 1000 });
    const first = runTutorGraph({
      questionStem: "极限",
      submission: {},
      budget,
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
  });
});
