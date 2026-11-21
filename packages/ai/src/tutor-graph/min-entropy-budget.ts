import type { TutorGraphResult } from "./types";

export type HelpState = "pure" | "scaffolded" | "contaminated";
export type MinEntropyBudgetOptions = { scaffoldBitBudget: number; cooldownHours?: number; now?: () => number };
export type MinEntropyReleaseCheck = {
  allowed: boolean;
  reason?: "cooldown" | "budget_contaminated" | "budget_exhausted";
  state: HelpState;
  leakageBits: number;
  cooldownUntil?: number;
};
export type MinEntropyBudget = ReturnType<typeof createMinEntropyBudget>;

export const PURE_ANSWER_PROBE_GUIDANCE = "请提交完整解答后再进行核验。";
export const PURE_CONTAMINATED_GUIDANCE = "提示额度已用尽，请先自行检查思路并重新独立作答。";
export const PURE_COOLDOWN_GUIDANCE = "当前处于独立思考冷静期，请先自行检查思路并稍后再试。";

export function createMinEntropyBudget(options: MinEntropyBudgetOptions) {
  let state: HelpState = "pure";
  let leakageBits = 0;
  let cooldownUntil: number | undefined;
  const now = options.now ?? (() => Date.now());
  const cooldownDurationMs = (options.cooldownHours ?? 72) * 60 * 60 * 1000;

  const validateBits = (worstBranchBits: number): void => {
    if (!Number.isFinite(worstBranchBits) || worstBranchBits < 0) {
      throw new RangeError("worstBranchBits must be non-negative");
    }
  };

  const budget = {
    get state() {
      return state;
    },
    get leakageBits() {
      return leakageBits;
    },
    get cooldownUntil() {
      return cooldownUntil;
    },
    nowMs() {
      return now();
    },
    inspectUnsubmittedTurn(kind: "answer_probe" | "procedural" | "sealed_submission") {
      if (state === "pure" && kind === "answer_probe") {
        return { state, leakageBits: 0, guidance: PURE_ANSWER_PROBE_GUIDANCE };
      }
      return { state, leakageBits, guidance: undefined };
    },
    canRelease(worstBranchBits: number, nowMs = now()): MinEntropyReleaseCheck {
      validateBits(worstBranchBits);
      if (cooldownUntil !== undefined && nowMs < cooldownUntil) {
        return { allowed: false, reason: "cooldown", state, leakageBits, cooldownUntil };
      }
      if (state === "contaminated") {
        return { allowed: false, reason: "budget_contaminated", state, leakageBits, cooldownUntil };
      }
      if (leakageBits + worstBranchBits > options.scaffoldBitBudget) {
        return { allowed: false, reason: "budget_exhausted", state, leakageBits, cooldownUntil };
      }
      return { allowed: true, state, leakageBits, cooldownUntil };
    },
    commitRelease(worstBranchBits: number, nowMs = now()) {
      validateBits(worstBranchBits);
      if (state === "contaminated" || (cooldownUntil !== undefined && nowMs < cooldownUntil)) {
        return { state, leakageBits, cooldownUntil };
      }
      if (state === "pure" && worstBranchBits > 0) state = "scaffolded";
      leakageBits += worstBranchBits;
      if (leakageBits > options.scaffoldBitBudget) {
        state = "contaminated";
        if (cooldownUntil === undefined) {
          cooldownUntil = nowMs + cooldownDurationMs;
        }
      }
      return { state, leakageBits, cooldownUntil };
    },
    beforeRelease(worstBranchBits: number, nowMs = now()) {
      return this.commitRelease(worstBranchBits, nowMs);
    },
    recordHint(worstBranchBits: number, nowMs = now()) {
      return this.commitRelease(worstBranchBits, nowMs);
    },
    resetWithSeededRecipe(seed: string) {
      if (!seed.trim()) throw new Error("seeded_recipe_required");
      state = "pure";
      leakageBits = 0;
      cooldownUntil = undefined;
    },
    snapshot() {
      return { state, leakageBits, cooldownUntil };
    },
  };
  return budget;
}

export function fixedPureGuidance(): Pick<
  TutorGraphResult,
  "state" | "providerCalls" | "leakageBits" | "reason" | "releasedText"
> & { text: string; helpState: "pure" } {
  return {
    state: "released",
    providerCalls: 0,
    leakageBits: 0,
    reason: "unsubmitted_answer_probe",
    releasedText: PURE_ANSWER_PROBE_GUIDANCE,
    text: PURE_ANSWER_PROBE_GUIDANCE,
    helpState: "pure",
  };
}
