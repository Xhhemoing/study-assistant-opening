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
    expect(budget.leakageBits).toBe(1);
    expect(budget.state).toBe("scaffolded");

    const aborted = runTutorGraph({
      questionStem: "积分",
      submission: {},
      budget,
      assessmentMode: "practice",
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
    expect(budget.leakageBits).toBe(1);
    expect(budget.state).toBe("scaffolded");
  });

  it.each([
    { blocked: "concept_cue", stem: "积分" },
    { blocked: "concept_cue", stem: "题干包含 concept_cue" },
    { blocked: "推导依据", stem: "积分" },
    { blocked: "all", stem: "积分" },
  ])("keeps pure outcomes binary when verification blocks $blocked on invalid attempts with stem $stem", ({ blocked, stem }) => {
    const assertCurrent = () => undefined;
    const outcomes = (["valid", "unknown", "invalid"] as const).map((status) => {
      let deny = false;
      const budget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
      const verify = vi.fn(() => {
        deny = status === "invalid";
        return { steps: [{ id: "s1", text: "attempt", status }] };
      });
      const input = {
        questionStem: stem,
        submission: { steps: [{ id: "s1", text: "attempt" }] },
        attemptSubmitted: true,
        budget,
        verifyCaps: { verify, assertCurrent },
        releaseCaps: { assertCurrent, answerLeakageBlocker: (text: string) => deny && (blocked === "all" || text.includes(blocked)) },
      };
      return { result: runTutorGraph(input), input, verify };
    });

    const [valid, unknown, invalid] = outcomes;
    if (!valid || !unknown || !invalid) throw new Error("missing verification outcome");
    expect(new Set(outcomes.map(({ result }) => JSON.stringify(result))).size).toBeLessThanOrEqual(2);
    expect(valid.result).toEqual(unknown.result);
    expect(valid.result).toMatchObject({
      state: "released",
      releaseApproved: true,
      leakageBits: 1,
      publicTeaching: { questionStem: stem, movePlan: { move: "concept_cue" } },
    });
    expect(invalid.result).toMatchObject({
      state: "unverified", reason: "release_guard_rejected", releaseApproved: false, leakageBits: 1,
    });
    expect(invalid.result.releasedText).toBeUndefined();
    expect(invalid.result.publicTeaching).toBeUndefined();
    expect(invalid.input.budget.leakageBits).toBe(1);
    expect(runTutorGraph(invalid.input).state).toBe("budget_contaminated");
    expect(invalid.verify).toHaveBeenCalledTimes(1);
  });

  it("keeps the preflight fallback when verification loosens the release guard", () => {
    const assertCurrent = () => undefined;
    let blockConservativePrompt = true;
    const result = runTutorGraph({
      questionStem: "积分",
      submission: {},
      attemptSubmitted: true,
      budget: createMinEntropyBudget({ now: () => 1000 }),
      verifyCaps: {
        assertCurrent,
        verify: () => {
          blockConservativePrompt = false;
          return { steps: [{ id: "s1", text: "a", status: "valid" }] };
        },
      },
      releaseCaps: {
        assertCurrent,
        answerLeakageBlocker: (text) => blockConservativePrompt && text.includes("推导依据"),
      },
    });
    expect(result).toMatchObject({
      state: "released",
      releasedText: "Attempt recorded.",
      publicTeaching: { questionStem: "", movePlan: { move: "concept_cue" } },
      leakageBits: 1,
    });
  });

  it("withholds without calling the guard when pure verification contaminates the budget", () => {
    const assertCurrent = () => undefined;
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
    const checkAfterVerify = vi.fn(() => true);
    let verified = false;
    const verify = vi.fn(() => {
      budget.commitRelease(1);
      verified = true;
      return { steps: [] };
    });
    const input = {
      questionStem: "积分",
      submission: {},
      attemptSubmitted: true,
      budget,
      verifyCaps: { assertCurrent, verify },
      releaseCaps: { assertCurrent, answerLeakageBlocker: () => verified && checkAfterVerify() },
    };
    expect(runTutorGraph(input)).toMatchObject({
      state: "unverified", reason: "release_guard_rejected", releaseApproved: false, leakageBits: 1,
    });
    expect(checkAfterVerify).not.toHaveBeenCalled();
    expect(budget.state).toBe("contaminated");
    expect(runTutorGraph(input).state).toBe("cooldown");
    expect(runTutorGraph({ ...input, nowMs: budget.cooldownUntilMs }).state).toBe("budget_contaminated");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("returns only two pure results across release, rejection, abort, and budget mutation", () => {
    const assertCurrent = () => undefined;
    const run = (verdict: "valid" | "invalid" | "unknown" | "throw") => {
      const budget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
      const controller = new AbortController();
      const checkAfterVerify = vi.fn(() => verdict === "invalid");
      let bitsAtVerify: number | undefined;
      const result = runTutorGraph({
        questionStem: "积分",
        submission: { steps: [{ id: "s1", text: "attempt" }] },
        attemptSubmitted: true,
        budget,
        verifyCaps: {
          assertCurrent,
          verify: () => {
            bitsAtVerify = budget.leakageBits;
            if (verdict === "unknown") controller.abort();
            if (verdict === "throw") {
              budget.commitRelease(1);
              throw new Error("Verifier error after budget mutation");
            }
            return { steps: [{ id: "s1", text: "attempt", status: verdict }] };
          },
        },
        releaseCaps: {
          assertCurrent,
          stopSignal: controller.signal,
          answerLeakageBlocker: () => bitsAtVerify !== undefined && checkAfterVerify(),
        },
      });
      return { result, bitsAtVerify, checkAfterVerify, budget };
    };
    const released = run("valid");
    const rejected = run("invalid");
    const aborted = run("unknown");
    const contaminated = run("throw");
    const outcomes = [released, rejected, aborted, contaminated];
    expect(new Set(outcomes.map(({ result }) => JSON.stringify(result))).size).toBe(2);
    expect(released.result).toMatchObject({ state: "released", releaseApproved: true, leakageBits: 1 });
    expect(released.checkAfterVerify).toHaveBeenCalled();
    expect(rejected.checkAfterVerify).toHaveBeenCalled();
    expect(aborted.checkAfterVerify).not.toHaveBeenCalled();
    expect(contaminated.checkAfterVerify).not.toHaveBeenCalled();
    for (const { result } of [rejected, aborted, contaminated]) {
      expect(result).toMatchObject({
        state: "unverified", reason: "release_guard_rejected", releaseApproved: false,
        leakageBits: 1, helpState: "scaffolded",
      });
      expect(result.releasedText).toBeUndefined();
      expect(result.cooldownUntilMs).toBeUndefined();
    }
    expect(outcomes.map(({ bitsAtVerify }) => bitsAtVerify)).toEqual([1, 1, 1, 1]);
    expect(aborted.budget.leakageBits).toBe(1);
    expect(contaminated.budget.state).toBe("contaminated");
  });

  it.each(["abort", "contaminate", "throw"] as const)("withholds when the post-verification guard can %s", (effect) => {
    const assertCurrent = () => undefined;
    const budget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
    const controller = new AbortController();
    let verified = false;
    let applied = false;
    const result = runTutorGraph({
      questionStem: "积分",
      submission: {},
      attemptSubmitted: true,
      budget,
      verifyCaps: {
        assertCurrent,
        verify: () => {
          verified = true;
          return { steps: [] };
        },
      },
      releaseCaps: {
        assertCurrent,
        stopSignal: controller.signal,
        answerLeakageBlocker: () => {
          if (verified && !applied) {
            applied = true;
            if (effect === "abort") controller.abort();
            if (effect === "contaminate") budget.commitRelease(1);
            if (effect === "throw") throw new Error("Post-verification guard error");
          }
          return false;
        },
      },
    });
    expect(result).toMatchObject({
      state: "unverified", reason: "release_guard_rejected", releaseApproved: false,
      leakageBits: 1, helpState: "scaffolded",
    });
    expect(result.releasedText).toBeUndefined();
  });

  it.each([
    { cap: 1.5, bits: 1 },
    { cap: 4, bits: Math.log2(3) },
  ])("charges $bits bits when a post-verification practice release is rejected at cap $cap", ({ cap, bits }) => {
    const assertCurrent = () => undefined;
    const budget = createMinEntropyBudget({ assessmentMode: "practice", scaffoldBitBudget: cap, now: () => 1000 });
    let verified = false;
    const result = runTutorGraph({
      questionStem: "积分",
      submission: {},
      attemptSubmitted: true,
      assessmentMode: "practice",
      budget,
      verifyCaps: {
        assertCurrent,
        verify: () => {
          verified = true;
          return { steps: [{ id: "s1", text: "a", status: "valid" }, { id: "s2", text: "b", status: "invalid" }] };
        },
      },
      releaseCaps: { assertCurrent, answerLeakageBlocker: () => verified },
    });
    expect(result).toMatchObject({ state: "unverified", reason: "release_guard_rejected", releaseApproved: false, leakageBits: bits });
    expect(budget.leakageBits).toBe(bits);
  });

  it.each([
    { status: "valid", move: "invite_next_step" },
    { status: "invalid", move: "concept_cue" },
  ] as const)("keeps $move for a coarsened practice attempt with a $status step", ({ status, move }) => {
    const assertCurrent = () => undefined;
    const budget = createMinEntropyBudget({ assessmentMode: "practice", scaffoldBitBudget: 1.5, now: () => 1000 });
    const steps = [{ id: "s1", text: "a" }, { id: "s2", text: "b" }] as const;
    const result = runTutorGraph({
      questionStem: "积分",
      submission: { steps },
      attemptSubmitted: true,
      assessmentMode: "practice",
      budget,
      verifyCaps: {
        assertCurrent,
        verify: () => ({ steps: [{ ...steps[0], status: "valid" }, { ...steps[1], status }] }),
      },
      releaseCaps: { assertCurrent, answerLeakageBlocker: () => false },
    });
    expect(result).toMatchObject({
      state: "released",
      leakageBits: 1,
      publicTeaching: { movePlan: { move }, learnerSteps: steps.map((step) => ({ ...step, status: "unknown" })) },
    });
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

  it("strips undeclared verifier fields, hides thrown verifier messages, and bounds pure outcomes", () => {
    const crashBudget = createMinEntropyBudget({ assessmentMode: "practice", scaffoldBitBudget: 1.5, now: () => 1000 });
    const crashed = runTutorGraph({
      questionStem: "积分",
      submission: {},
      budget: crashBudget,
      attemptSubmitted: true,
      assessmentMode: "practice",
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

    // With a static guard, a verifier exception has the same public outcome as a verdict.
    const pureOracleOutcomes = new Set<string>();
    for (const verdictFn of [
      () => ({ steps: [{ id: "s1", text: "x", status: "valid" as const }] }),
      () => ({ steps: [{ id: "s1", text: "x", status: "invalid" as const }] }),
      () => ({ steps: [{ id: "s1", text: "x", status: "unknown" as const }] }),
      () => {
        throw new Error("INTERNAL_DB_SECRET_SOLUTION_42");
      },
    ]) {
      const pureB = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
      const res = runTutorGraph({
        questionStem: "积分",
        submission: { steps: [{ id: "s1", text: "x" }] },
        budget: pureB,
        attemptSubmitted: true,
        verifyCaps: { verify: verdictFn, assertCurrent: () => undefined },
        releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => false },
      });
      expect(res.state).toBe("released");
      expect(res.releaseApproved).toBe(true);
      expect(pureB.leakageBits).toBe(1);
      expect(JSON.stringify(res)).not.toContain("INTERNAL_DB_SECRET_SOLUTION_42");
      pureOracleOutcomes.add(JSON.stringify(res));
    }
    expect(pureOracleOutcomes.size).toBe(1);

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
    expect(shapeSet.size).toBe(1);

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

    // Pure turns with a static guard charge one bit and release the same prompt for every verdict.
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
    for (const verifyFn of partialVerdicts) {
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
    }
    expect(omittedFirstErrorShapes.size).toBe(1);

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
    for (const verifyFn of singleStepVerdicts) {
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
    }
    expect(singleStepShapes.size).toBe(1);

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
      expect(oneRes.verification.steps).toEqual([]);
      expect(oneRes.publicTeaching?.learnerSteps).toEqual([]);
      expect(JSON.stringify(oneRes)).not.toContain("x^2");
      oneBitOutcomes.add(JSON.stringify(oneRes));
    }

    // Round-16 P1-1: pure-mode release guard must not create a 0-bit answer-guessing oracle from learner submission text or blocked prompts
    for (const verifierFn of [
      () => ({ steps: [] }),
      () => {
        throw new Error("SECRET_ANSWER_42");
      },
    ]) {
      const guessRightBudget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
      const guessWrongBudget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
      const rightRes = runTutorGraph({
        questionStem: "积分",
        submission: { steps: [{ id: "s1", text: "SECRET_ANSWER_42" }] },
        budget: guessRightBudget,
        attemptSubmitted: true,
        verifyCaps: { verify: verifierFn, assertCurrent: () => undefined },
        releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: (text) => text.includes("SECRET_ANSWER_42") },
      });
      const wrongRes = runTutorGraph({
        questionStem: "积分",
        submission: { steps: [{ id: "s1", text: "completely_wrong_attempt" }] },
        budget: guessWrongBudget,
        attemptSubmitted: true,
        verifyCaps: { verify: verifierFn, assertCurrent: () => undefined },
        releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: (text) => text.includes("SECRET_ANSWER_42") },
      });
      expect(rightRes.state).toBe("released");
      expect(wrongRes.state).toBe("released");
      expect(guessRightBudget.leakageBits).toBe(1);
      expect(guessWrongBudget.leakageBits).toBe(1);
      expect(rightRes).toEqual(wrongRes);
      expect(JSON.stringify(rightRes)).not.toContain("SECRET_ANSWER_42");
    }
    const stemBlockedBudget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
    const stemBlockedPure = runTutorGraph({
      questionStem: "Contains SECRET_ANSWER_42 in stem",
      submission: { steps: [{ id: "s1", text: "any" }] },
      budget: stemBlockedBudget,
      attemptSubmitted: true,
      verifyCaps: { verify: () => ({ steps: [{ id: "s1", text: "a", status: "valid" }] }), assertCurrent: () => undefined },
      releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: (text) => text.includes("SECRET_ANSWER_42") },
    });
    expect(stemBlockedPure.state).toBe("released");
    expect(stemBlockedPure.releaseApproved).toBe(true);
    expect(stemBlockedPure.publicTeaching?.questionStem).toBe("");
    expect(stemBlockedBudget.leakageBits).toBe(1);
    expect(JSON.stringify(stemBlockedPure)).not.toContain("SECRET_ANSWER_42");

    // Round-17 P1-1: preflight pure fallback must pass guardRelease when primary prompt contains blocked key ("推导依据"),
    // and unconditional guard rejection must fail closed with 0 verifier calls and 0 leaked bits.
    const secondaryFallbackBudget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
    const secondaryFallbackRes = runTutorGraph({
      questionStem: "Contains 推导依据 in stem",
      submission: { steps: [{ id: "s1", text: "any" }] },
      budget: secondaryFallbackBudget,
      attemptSubmitted: true,
      verifyCaps: { verify: () => ({ steps: [{ id: "s1", text: "a", status: "invalid" }] }), assertCurrent: () => undefined },
      releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: (text) => text.includes("推导依据") },
    });
    expect(secondaryFallbackRes.state).toBe("released");
    expect(secondaryFallbackRes.releaseApproved).toBe(true);
    expect(secondaryFallbackRes.releasedText).toBe("Attempt recorded.");
    expect(secondaryFallbackBudget.leakageBits).toBe(1);
    expect(JSON.stringify(secondaryFallbackRes)).not.toContain("推导依据");

    let unconditionalVerifyCalls = 0;
    const rejectRightBudget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
    const rejectWrongBudget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
    const rejectRight = runTutorGraph({
      questionStem: "积分",
      submission: { steps: [{ id: "s1", text: "SECRET_42" }] },
      budget: rejectRightBudget,
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => {
          unconditionalVerifyCalls++;
          return { steps: [{ id: "s1", text: "SECRET_42", status: "valid" }] };
        },
        assertCurrent: () => undefined,
      },
      releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => true },
    });
    const rejectWrong = runTutorGraph({
      questionStem: "积分",
      submission: { steps: [{ id: "s1", text: "wrong" }] },
      budget: rejectWrongBudget,
      attemptSubmitted: true,
      verifyCaps: {
        verify: () => {
          unconditionalVerifyCalls++;
          return { steps: [{ id: "s1", text: "wrong", status: "invalid" }] };
        },
        assertCurrent: () => undefined,
      },
      releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => true },
    });
    expect(unconditionalVerifyCalls).toBe(0);
    expect(rejectRight).toMatchObject({ state: "unverified", releaseApproved: false, reason: "release_guard_rejected" });
    expect(rejectRight).toEqual(rejectWrong);
    expect(rejectRightBudget.leakageBits).toBe(0);
    expect(rejectWrongBudget.leakageBits).toBe(0);

    // The guard can withhold the committed prompt after verification.
    const midTurnOutcomes = new Set<string>();
    for (const blocked of [undefined, "推导依据", "Attempt recorded.", "all"]) {
      let verified = false;
      const budget = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
      const result = runTutorGraph({
        questionStem: "积分",
        submission: { steps: [{ id: "s1", text: "attempt" }] },
        budget,
        attemptSubmitted: true,
        verifyCaps: {
          verify: () => {
            verified = true;
            return { steps: [{ id: "s1", text: "a", status: "invalid" }] };
          },
          assertCurrent: () => undefined,
        },
        releaseCaps: {
          assertCurrent: () => undefined,
          answerLeakageBlocker: (text) => verified && blocked !== undefined && (blocked === "all" || text.includes(blocked)),
        },
      });
      const outcome = JSON.stringify(result);
      midTurnOutcomes.add(outcome);
      if (blocked === "推导依据" || blocked === "all") {
        expect(result).toMatchObject({ state: "unverified", reason: "release_guard_rejected", releaseApproved: false, leakageBits: 1 });
        expect(outcome).not.toContain("推导依据");
      } else {
        expect(result).toMatchObject({ state: "released", releaseApproved: true, leakageBits: 1 });
      }
      expect(budget.leakageBits).toBe(1);
    }
    expect(midTurnOutcomes.size).toBeLessThanOrEqual(2);

    const makeMidTurnAllRejectRun = (status: "valid" | "invalid") => {
      let blockEverything = false;
      const b = createMinEntropyBudget({ scaffoldBitBudget: 1.5, now: () => 1000 });
      const res = runTutorGraph({
        questionStem: "积分",
        submission: { steps: [{ id: "s1", text: status }] },
        budget: b,
        attemptSubmitted: true,
        verifyCaps: {
          verify: () => {
            blockEverything = true;
            return { steps: [{ id: "s1", text: "a", status }] };
          },
          assertCurrent: () => undefined,
        },
        releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => blockEverything },
      });
      return { res, leakageBits: b.leakageBits };
    };
    const midRejectRight = makeMidTurnAllRejectRun("valid");
    const midRejectWrong = makeMidTurnAllRejectRun("invalid");
    expect(midRejectRight.res).toMatchObject({ state: "unverified", releaseApproved: false, reason: "release_guard_rejected" });
    expect(midRejectRight.res).toEqual(midRejectWrong.res);
    expect(midRejectRight.leakageBits).toBe(1);
    expect(midRejectWrong.leakageBits).toBe(1);

    expect(zeroBitOutcomes.size).toBe(1);
    expect(oneBitOutcomes.size).toBe(1);

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

    // Round-14 P2-1: practice turns with fractional remaining budget (< 1 bit) must not invoke verifyCaps.verify
    for (const remainingCase of [
      { scaffoldBitBudget: 0.5, preSpend: false },
      { scaffoldBitBudget: 1.5, preSpend: true },
    ]) {
      const fractionalShapes = new Set<string>();
      let verifyInvocations = 0;
      for (const makeOutput of [
        () => ({ steps: [{ id: "s1", text: "a", status: "unknown" as const }] }),
        () => ({ steps: [{ id: "s1", text: "a", status: "valid" as const }] }),
        () => ({
          steps: [{ id: "s1", text: "a", status: "invalid" as const }],
          firstError: { stepId: "s1", kind: "domain" as const, message: "SECRET_42" },
        }),
      ]) {
        const fracBudget = createMinEntropyBudget({
          assessmentMode: "practice",
          scaffoldBitBudget: remainingCase.scaffoldBitBudget,
          now: () => 1000,
        });
        if (remainingCase.preSpend) {
          const warmup = runTutorGraph({
            questionStem: "积分",
            submission: {},
            budget: fracBudget,
            attemptSubmitted: true,
            assessmentMode: "practice",
            verifyCaps: { verify: () => ({ steps: [{ id: "s0", text: "w", status: "valid" }] }), assertCurrent: () => undefined },
            releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => false },
          });
          expect(warmup.state).toBe("released");
          expect(fracBudget.leakageBits).toBe(1);
        }

        const res = runTutorGraph({
          questionStem: "积分",
          submission: {},
          budget: fracBudget,
          attemptSubmitted: true,
          assessmentMode: "practice",
          verifyCaps: {
            verify: () => {
              verifyInvocations += 1;
              return makeOutput();
            },
            assertCurrent: () => undefined,
          },
          releaseCaps: { assertCurrent: () => undefined, answerLeakageBlocker: () => false },
        });
        expect(res.state).toBe("budget_contaminated");
        expect(res.releaseApproved).toBe(false);
        expect(res.reason).toBe("budget_exhausted");
        expect(JSON.stringify(res)).not.toContain("SECRET_42");
        fractionalShapes.add(JSON.stringify(res));
      }
      expect(verifyInvocations).toBe(0);
      expect(fractionalShapes.size).toBe(1);
    }
  });
});
