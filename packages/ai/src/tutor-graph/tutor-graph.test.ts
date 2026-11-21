import { describe, expect, it, vi } from "vitest";
import { createMinEntropyBudget } from "./min-entropy-budget";
import { runTutorGraph } from "./graph";

describe("TutorGraph fast path", () => {
  it("keeps answer probes pure and does not call verification", () => {
    const verify = vi.fn(() => ({ steps: [] }));
    const result = runTutorGraph({ questionStem: "问题", submission: { probe: true }, answerProbe: true, verifyCaps: { verify, assertCurrent: () => undefined }, releaseCaps: { assertCurrent: () => undefined } });
    expect(result.providerCalls).toBe(0);
    expect(result.leakageBits).toBe(0);
    expect(result.helpState).toBe("pure");
    expect(verify).not.toHaveBeenCalled();
  });
  it("marks only the first error invalid and downstream steps dependent", () => {
    const result = runTutorGraph({ questionStem: "因式分解", submission: {}, verifyCaps: { verify: () => ({ deterministic: true, steps: [{ id: "s1", text: "一步", status: "valid" }, { id: "s2", text: "二步", status: "invalid" }, { id: "s3", text: "三步", status: "invalid" }], firstError: { stepId: "s2", kind: "domain", message: "缺少定义域" } }), assertCurrent: () => undefined }, releaseCaps: { assertCurrent: () => undefined } });
    expect(result.state).toBe("released");
    expect(result.providerCalls).toBe(0);
    expect(result.publicTeaching?.learnerSteps.map((step) => step.status)).toEqual(["valid", "invalid", "dependent"]);
    expect(result.publicTeaching?.movePlan.move).toBe("local_counterexample");
  });
  it("transitions the min-entropy budget irreversibly", () => {
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 1, now: () => 1000 });
    expect(budget.state).toBe("pure");
    budget.beforeRelease(1);
    expect(budget.state).toBe("scaffolded");
    budget.beforeRelease(1);
    expect(budget.state).toBe("contaminated");
    expect(budget.cooldownUntil).toBe(1000 + 72 * 60 * 60 * 1000);
  });
});
