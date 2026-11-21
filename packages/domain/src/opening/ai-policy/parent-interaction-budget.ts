import type { MediaInputCostBound } from "@aistudy/contracts";

/** A durable user intent shared by planning, answers, compilation and fallback. */
export type ParentInteractionBudget = {
  id: string;
  /** Optional tighter limit. The ledger also enforces the current finite parent ceiling. */
  budgetCents?: number;
  /** Includes rejected/released attempts, so zero-priced calls cannot loop forever. */
  maxProviderCalls?: number;
};

/** Runaway-call guard, independent of the experimentally chosen query round count. */
export const DEFAULT_PARENT_INTERACTION_MAX_PROVIDER_CALLS = 12;

export function assertParentInteractionBudget(input: ParentInteractionBudget): void {
  if (!input.id.trim() || input.id.length > 256
    || (input.budgetCents !== undefined && (!Number.isSafeInteger(input.budgetCents) || input.budgetCents < 0))
    || (input.maxProviderCalls !== undefined && (!Number.isSafeInteger(input.maxProviderCalls) || input.maxProviderCalls <= 0))) {
    throw new Error("invalid parent interaction budget");
  }
}

export function mediaInputCostBound(model: Partial<MediaInputCostBound>): MediaInputCostBound | null {
  const { mediaInputTokenUpperBound, mediaMaxInputBytes, mediaInputCentsPerMillion } = model;
  if (!Number.isSafeInteger(mediaInputTokenUpperBound) || mediaInputTokenUpperBound! <= 0
    || !Number.isSafeInteger(mediaMaxInputBytes) || mediaMaxInputBytes! <= 0
    || typeof mediaInputCentsPerMillion !== "number" || !Number.isFinite(mediaInputCentsPerMillion) || mediaInputCentsPerMillion < 0) return null;
  return { mediaInputTokenUpperBound: mediaInputTokenUpperBound!, mediaMaxInputBytes: mediaMaxInputBytes!, mediaInputCentsPerMillion };
}

export function hasMediaInput(input: { imageParts?: unknown[]; audioParts?: unknown[] }): boolean {
  return Boolean(input.imageParts?.length || input.audioParts?.length);
}
