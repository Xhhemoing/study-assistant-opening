import type { TutorGraphResult } from "./types";

export type HelpState = "pure" | "scaffolded" | "contaminated";
export type MinEntropyBudgetOptions = { scaffoldBitBudget: number; cooldownHours?: number; now?: () => number };
export type MinEntropyBudget = ReturnType<typeof createMinEntropyBudget>;

export function createMinEntropyBudget(options: MinEntropyBudgetOptions) {
  let state: HelpState = "pure"; let leakageBits = 0; let cooldownUntil: number | undefined; const now = options.now ?? (() => Date.now());
  const budget = {
    get state() { return state; },
    get leakageBits() { return leakageBits; },
    get cooldownUntil() { return cooldownUntil; },
    inspectUnsubmittedTurn(kind: "answer_probe" | "procedural" | "sealed_submission") {
      if (state === "pure" && kind === "answer_probe") return { state, leakageBits: 0, guidance: "请提交完整解答后再进行核验。" };
      return { state, leakageBits, guidance: undefined };
    },
    beforeRelease(worstBranchBits: number) {
      if (!Number.isFinite(worstBranchBits) || worstBranchBits < 0) throw new RangeError("worstBranchBits must be non-negative");
      if (state === "pure") state = "scaffolded";
      leakageBits += worstBranchBits;
      if (leakageBits > options.scaffoldBitBudget) { state = "contaminated"; cooldownUntil = now() + (options.cooldownHours ?? 72) * 60 * 60 * 1000; }
      return { state, leakageBits, cooldownUntil };
    },
    recordHint(worstBranchBits: number) { return this.beforeRelease(worstBranchBits); },
    resetWithSeededRecipe(seed: string) { if (!seed.trim()) throw new Error("seeded_recipe_required"); state = "pure"; leakageBits = 0; cooldownUntil = undefined; },
    snapshot() { return { state, leakageBits, cooldownUntil }; },
  };
  return budget;
}

export function fixedPureGuidance(): Pick<TutorGraphResult, "state" | "providerCalls" | "leakageBits" | "reason"> & { text: string; helpState: "pure" } {
  return { state: "released", providerCalls: 0, leakageBits: 0, reason: "unsubmitted_answer_probe", text: "请提交完整解答后再进行核验。", helpState: "pure" };
}
