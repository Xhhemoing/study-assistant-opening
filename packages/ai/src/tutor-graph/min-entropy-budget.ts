import type { TutorGraphResult } from "./types";

export type HelpState = "pure" | "scaffolded" | "contaminated";
export const PURE_MAX_LEAKAGE_BITS = 1.5;
export const PURE_COOLDOWN_HOURS = 72;
export const PURE_COOLDOWN_MS = PURE_COOLDOWN_HOURS * 3_600_000;

export type MinEntropyBudgetOptions = {
  scaffoldBitBudget?: number;
  cooldownHours?: number;
  now?: () => number;
  initialSeed?: string;
  usedSeeds?: readonly string[];
};
export type MinEntropyReleaseCheck = {
  allowed: boolean;
  reason?: "cooldown" | "budget_contaminated" | "budget_exhausted";
  state: HelpState;
  leakageBits: number;
  cooldownUntil?: number;
  cooldownUntilMs?: number;
};
export type MinEntropyBudget = ReturnType<typeof createMinEntropyBudget>;

export const PURE_ANSWER_PROBE_GUIDANCE = "请提交完整解答后再进行核验。";
export const PURE_CONTAMINATED_GUIDANCE = "提示额度已用尽，请先自行检查思路并重新独立作答。";
export const PURE_COOLDOWN_GUIDANCE = "当前处于独立思考冷静期，请先自行检查思路并稍后再试。";

export function createMinEntropyBudget(options: MinEntropyBudgetOptions) {
  let state: HelpState = "pure";
  let leakageBits = 0;
  let cooldownUntilMs: number | undefined;
  const now = options.now ?? (() => Date.now());
  const configuredBudget = options.scaffoldBitBudget ?? PURE_MAX_LEAKAGE_BITS;
  if (!Number.isFinite(configuredBudget) || configuredBudget < 0) {
    throw new RangeError("scaffoldBitBudget must be non-negative");
  }
  const effectiveCap = Math.min(configuredBudget, PURE_MAX_LEAKAGE_BITS);
  const cooldownDurationMs = Math.max(options.cooldownHours ?? PURE_COOLDOWN_HOURS, PURE_COOLDOWN_HOURS) * 3_600_000;
  let currentSeed = options.initialSeed?.trim() || "__initial_seed__";
  const usedSeeds = new Set<string>([
    currentSeed,
    ...(options.usedSeeds ?? []).map((seed) => seed.trim()).filter((seed) => seed.length > 0),
  ]);

  const validateBits = (worstBranchBits: number): void => {
    if (!Number.isFinite(worstBranchBits) || worstBranchBits < 0) {
      throw new RangeError("worstBranchBits must be non-negative");
    }
  };

  const contaminate = (nowMs: number): void => {
    state = "contaminated";
    if (cooldownUntilMs === undefined) {
      cooldownUntilMs = nowMs + cooldownDurationMs;
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
      return cooldownUntilMs;
    },
    get cooldownUntilMs() {
      return cooldownUntilMs;
    },
    get currentSeed() {
      return currentSeed;
    },
    get usedSeeds(): readonly string[] {
      return [...usedSeeds];
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
      if (cooldownUntilMs !== undefined && nowMs < cooldownUntilMs) {
        return { allowed: false, reason: "cooldown", state, leakageBits, cooldownUntil: cooldownUntilMs, cooldownUntilMs };
      }
      if (state === "contaminated") {
        if (cooldownUntilMs === undefined) cooldownUntilMs = nowMs + cooldownDurationMs;
        return {
          allowed: false,
          reason: "budget_contaminated",
          state,
          leakageBits,
          cooldownUntil: cooldownUntilMs,
          cooldownUntilMs,
        };
      }
      if (leakageBits >= PURE_MAX_LEAKAGE_BITS) {
        contaminate(nowMs);
        return {
          allowed: false,
          reason: "budget_contaminated",
          state,
          leakageBits,
          cooldownUntil: cooldownUntilMs,
          cooldownUntilMs,
        };
      }
      const nextBits = leakageBits + worstBranchBits;
      if (nextBits > effectiveCap || (worstBranchBits > 0 && nextBits >= PURE_MAX_LEAKAGE_BITS)) {
        contaminate(nowMs);
        return {
          allowed: false,
          reason: "budget_exhausted",
          state,
          leakageBits,
          cooldownUntil: cooldownUntilMs,
          cooldownUntilMs,
        };
      }
      return { allowed: true, state, leakageBits, cooldownUntil: cooldownUntilMs, cooldownUntilMs };
    },
    commitRelease(worstBranchBits: number, nowMs = now()) {
      validateBits(worstBranchBits);
      if (state === "contaminated" || (cooldownUntilMs !== undefined && nowMs < cooldownUntilMs)) {
        if (state === "contaminated" && cooldownUntilMs === undefined) {
          cooldownUntilMs = nowMs + cooldownDurationMs;
        }
        return { state, leakageBits, cooldownUntil: cooldownUntilMs, cooldownUntilMs };
      }
      if (state === "pure" && worstBranchBits > 0) state = "scaffolded";
      leakageBits += worstBranchBits;
      if (leakageBits >= PURE_MAX_LEAKAGE_BITS || leakageBits > effectiveCap) {
        contaminate(nowMs);
      }
      return { state, leakageBits, cooldownUntil: cooldownUntilMs, cooldownUntilMs };
    },
    beforeRelease(worstBranchBits: number, nowMs = now()) {
      return this.commitRelease(worstBranchBits, nowMs);
    },
    recordHint(worstBranchBits: number, nowMs = now()) {
      return this.commitRelease(worstBranchBits, nowMs);
    },
    resetForFreshVariant(newSeed: string, nowMs = now()) {
      const normalized = newSeed.trim();
      if (!normalized) throw new Error("seeded_recipe_required");
      if ((cooldownUntilMs !== undefined && nowMs < cooldownUntilMs) || (state === "contaminated" && cooldownUntilMs === undefined)) {
        throw new Error("cooldown_active");
      }
      if (normalized === currentSeed || usedSeeds.has(normalized)) {
        throw new Error("duplicate_seeded_recipe");
      }
      usedSeeds.add(normalized);
      currentSeed = normalized;
      state = "pure";
      leakageBits = 0;
      cooldownUntilMs = undefined;
    },
    resetWithSeededRecipe(seed: string, nowMs = now()) {
      this.resetForFreshVariant(seed, nowMs);
    },
    snapshot() {
      return {
        state,
        leakageBits,
        cooldownUntil: cooldownUntilMs,
        cooldownUntilMs,
        currentSeed,
        usedSeeds: [...usedSeeds],
      };
    },
  };
  return budget;
}

export function fixedPureGuidance(reason = "unsubmitted_answer_probe"): Pick<
  TutorGraphResult,
  "state" | "providerCalls" | "leakageBits" | "reason" | "releasedText"
> & { text: string; helpState: "pure" } {
  return {
    state: "released",
    providerCalls: 0,
    leakageBits: 0,
    reason,
    releasedText: PURE_ANSWER_PROBE_GUIDANCE,
    text: PURE_ANSWER_PROBE_GUIDANCE,
    helpState: "pure",
  };
}
