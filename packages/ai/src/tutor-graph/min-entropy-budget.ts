import type { TutorGraphResult } from "./types";
import { registerBudgetControl } from "./budget-isolation";

export type HelpState = "pure" | "scaffolded" | "contaminated";
export const PURE_MAX_LEAKAGE_BITS = 1.5;
export const PURE_COOLDOWN_HOURS = 72;
export const PURE_COOLDOWN_MS = PURE_COOLDOWN_HOURS * 3_600_000;

export type MinEntropyBudgetOptions = {
  scaffoldBitBudget?: number;
  cooldownHours?: number;
  assessmentMode?: "pure" | "practice";
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

function createBudgetPair(options: MinEntropyBudgetOptions) {
  let state: HelpState = "pure";
  let leakageBits = 0;
  let cooldownUntilMs: number | undefined;
  const now = options.now ?? (() => Date.now());
  const configuredBudget = options.scaffoldBitBudget ?? PURE_MAX_LEAKAGE_BITS;
  if (!Number.isFinite(configuredBudget) || configuredBudget < 0) {
    throw new RangeError("scaffoldBitBudget must be non-negative");
  }
  const isPractice = options.assessmentMode === "practice";
  const effectiveCap = isPractice ? configuredBudget : Math.min(configuredBudget, PURE_MAX_LEAKAGE_BITS);
  if (options.cooldownHours !== undefined && (!Number.isFinite(options.cooldownHours) || options.cooldownHours < 0)) {
    throw new RangeError(`cooldownHours must be a finite non-negative number; got ${String(options.cooldownHours)}.`);
  }
  const validateNowMs = (nowMs: number) => {
    if (!Number.isFinite(nowMs)) {
      throw new RangeError(`nowMs must be a finite number; got ${String(nowMs)}.`);
    }
  };
  const cooldownDurationMs = Math.max(options.cooldownHours ?? PURE_COOLDOWN_HOURS, PURE_COOLDOWN_HOURS) * 3_600_000;
  let currentSeed = options.initialSeed?.trim() || "__initial_seed__";
  const usedSeeds = new Set<string>([
    currentSeed,
    ...(options.usedSeeds ?? []).map((seed) => seed.trim()).filter((seed) => seed.length > 0),
  ]);
  let pureScope: { touched: boolean } | undefined;
  let pureBound = false;

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

  const internal = {
    get state() {
      return state;
    },
    get leakageBits() {
      return leakageBits;
    },
    get maxBitsPerTurn() {
      return effectiveCap;
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
      if (pureScope) {
        pureScope.touched = true;
        return { allowed: false, reason: "budget_exhausted", state, leakageBits, cooldownUntil: cooldownUntilMs, cooldownUntilMs };
      }
      validateBits(worstBranchBits);
      validateNowMs(nowMs);
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
      if (!isPractice && leakageBits >= PURE_MAX_LEAKAGE_BITS) {
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
      if (nextBits > effectiveCap || (!isPractice && worstBranchBits > 0 && nextBits >= PURE_MAX_LEAKAGE_BITS)) {
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
      if (pureScope) {
        pureScope.touched = true;
        throw new Error("pure_budget_in_use");
      }
      validateBits(worstBranchBits);
      validateNowMs(nowMs);
      if (state === "contaminated" || (cooldownUntilMs !== undefined && nowMs < cooldownUntilMs)) {
        if (state === "contaminated" && cooldownUntilMs === undefined) {
          cooldownUntilMs = nowMs + cooldownDurationMs;
        }
        return { state, leakageBits, cooldownUntil: cooldownUntilMs, cooldownUntilMs };
      }
      if (state === "pure" && worstBranchBits > 0) state = "scaffolded";
      leakageBits += worstBranchBits;
      if ((!isPractice && leakageBits >= PURE_MAX_LEAKAGE_BITS) || leakageBits > effectiveCap) {
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
      if (pureScope) {
        pureScope.touched = true;
        throw new Error("pure_budget_in_use");
      }
      validateNowMs(nowMs);
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
    runPure<T>(run: (wasTouched: () => boolean) => T): T {
      if (pureScope) {
        pureScope.touched = true;
        throw new Error("pure_budget_in_use");
      }
      const scope = { touched: false };
      pureScope = scope;
      try {
        return run(() => scope.touched);
      } finally {
        pureScope = undefined;
      }
    },
  };

  const budget = Object.freeze({
    get state() { return internal.state; },
    get leakageBits() { return internal.leakageBits; },
    get maxBitsPerTurn() { return internal.maxBitsPerTurn; },
    get cooldownUntil() { return internal.cooldownUntil; },
    get cooldownUntilMs() { return internal.cooldownUntilMs; },
    get currentSeed() { return internal.currentSeed; },
    get usedSeeds() { return internal.usedSeeds; },
    nowMs: () => internal.nowMs(),
    inspectUnsubmittedTurn: (kind: "answer_probe" | "procedural" | "sealed_submission") =>
      internal.inspectUnsubmittedTurn(kind),
    canRelease(bits: number, nowMs?: number): MinEntropyReleaseCheck {
      if (pureBound) {
        if (pureScope) pureScope.touched = true;
        return {
          allowed: false,
          reason: "budget_exhausted",
          state,
          leakageBits,
          cooldownUntil: cooldownUntilMs,
          cooldownUntilMs,
        };
      }
      return internal.canRelease(bits, nowMs);
    },
    commitRelease(bits: number, nowMs?: number) {
      if (pureBound) {
        if (pureScope) pureScope.touched = true;
        throw new Error("pure_budget_sealed");
      }
      return internal.commitRelease(bits, nowMs);
    },
    beforeRelease(bits: number, nowMs?: number) {
      return budget.commitRelease(bits, nowMs);
    },
    recordHint(bits: number, nowMs?: number) {
      return budget.commitRelease(bits, nowMs);
    },
    resetForFreshVariant(seed: string, nowMs?: number) {
      if (pureBound) {
        if (pureScope) pureScope.touched = true;
        throw new Error("pure_budget_sealed");
      }
      return internal.resetForFreshVariant(seed, nowMs);
    },
    resetWithSeededRecipe(seed: string, nowMs?: number) {
      return budget.resetForFreshVariant(seed, nowMs);
    },
    snapshot: () => internal.snapshot(),
  });
  registerBudgetControl(budget, {
    sealPure: () => { pureBound = true; },
    isPureBound: () => pureBound,
    canRelease: (bits, nowMs) => internal.canRelease(bits, nowMs),
    commitRelease: (bits, nowMs) => internal.commitRelease(bits, nowMs),
    runPure: (run) => internal.runPure(run),
  });
  const hostControl = Object.freeze({
    resetForFreshVariant: (seed: string, nowMs?: number) => internal.resetForFreshVariant(seed, nowMs),
  });
  return { budget, hostControl };
}

export function createMinEntropyBudget(options: MinEntropyBudgetOptions) {
  return createBudgetPair(options).budget;
}

export function createControlledMinEntropyBudget(options: MinEntropyBudgetOptions) {
  return createBudgetPair(options);
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
