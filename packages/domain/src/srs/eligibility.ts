import type { ReviewCard, ReviewQueueMode, ReviewState } from "@aistudy/contracts";
import { computeCardRetrievability } from "./scheduler";

export const DEFAULT_RECOVERY_SESSION_CARD_CAP = 200;
export const RECOVERY_BACKLOG_CARD_THRESHOLD = 200;
export const SALVAGEABLE_RETRIEVABILITY_MIN = 0.35;
export const SALVAGEABLE_RETRIEVABILITY_MAX = 0.75;
export const WORKSPACE_RECOVERY_CAP_RATIO = 0.3;

export type ReviewQueueItem = {
  card: ReviewCard;
  state: ReviewState;
  goalPriority: number;
  /**
   * Optional explicit syllabus/exam weight for recovery triage.
   * If historical exam `meanPoints` is supplied here, it already reflects
   * unconditional expected points and MUST NOT be multiplied by `appearanceProbability` again.
   */
  syllabusWeight?: number;
  /** Canonical knowledge unit key, e.g. `(courseId, requirementKey, skillNodeId, dimension)`. */
  knowledgeUnitKey?: string;
  /** Optional question/skill family key so Band 1 selects primary representatives across families first. */
  familyKey?: string;
  /** True when an active delayed check already covers this card's knowledge unit. */
  delayedCheckCovered?: boolean;
};

export type ReviewEligibility = {
  eligible: boolean;
  excludeFromAssessment: boolean;
};

export type RecoveryTriageBand = 1 | 2 | 3 | 4 | 5;

export type RecoveryDemotionReason =
  | "duplicate_knowledge_unit"
  | "duplicate_family"
  | "delayed_check_covered"
  | null;

export type RecoveryTriageOptions = {
  /**
   * Threshold separating high-weight from low/zero-weight items.
   * Default `0` treats `effectiveWeight > 0` as high weight; positive values use `effectiveWeight >= highWeightThreshold`.
   */
  highWeightThreshold?: number;
  /** Optional session card cap applied strictly AFTER global 5-band triage. */
  maxSessionCards?: number;
  /** Force global 5-band FSRS-6.0 recovery triage even below `RECOVERY_BACKLOG_CARD_THRESHOLD`. */
  recoveryTriage?: boolean;
};

export type TriagedReviewQueueItem = {
  item: ReviewQueueItem;
  band: RecoveryTriageBand;
  effectiveWeight: number;
  retrievabilityStatus: "known" | "unseen_or_unknown";
  retrievability: number | null;
  elapsedDaysSinceLastReview: number | null;
  isPrimaryRepresentative: boolean;
  demotedReason: RecoveryDemotionReason;
};

export type BacklogRehabilitationPlan = {
  triaged: TriagedReviewQueueItem[];
  sessionItems: TriagedReviewQueueItem[];
  deferredItems: TriagedReviewQueueItem[];
  countsByBand: Record<RecoveryTriageBand, number>;
};

export type SyllabusWeightInput = {
  syllabusWeight?: number | null;
  /** Historical exam mean points (unconditional expected score; NEVER multiplied by appearanceProbability). */
  meanPoints?: number | null;
  /** Retained for caller clarity only; ignored when `meanPoints` is provided so probability is never double-counted. */
  appearanceProbability?: number | null;
  goalPriority?: number;
};

export type WorkspaceRecoveryBudgetInput = {
  dailyBudgetMinutes: number;
  freeUnreservedMinutes: number;
  usedOrReservedRecoveryMinutes: number;
};

export type RecoveryTaskWindowInput = {
  cardDueAt: string;
  planDayStartIso: string;
  planDayEndIso: string;
};

export type RecoveryTaskWindow = {
  /** Original card dueAt — strictly eligibility timestamp, never a planner hard deadline. */
  eligibleSince: string;
  /** Earliest scheduling instant inside `[planDayStartIso, planDayEndIso]`. */
  scheduledWindowStart: string;
  /** Soft end of the planning day window. */
  softEnd: string;
  /** Always `null` so overdue cards are never rejected as `deadline_passed` by `day-planner`. */
  hardDeadlineAt: null;
  isOverdueBeforePlanDay: boolean;
  eligibleWithinPlanDay: boolean;
};

/**
 * Resolves effective triage weight. Historical exam `meanPoints` is used directly
 * and is never multiplied by `appearanceProbability` a second time.
 */
export function resolveSyllabusWeight(input: SyllabusWeightInput): number {
  if (typeof input.syllabusWeight === "number" && Number.isFinite(input.syllabusWeight)) {
    return Math.max(0, input.syllabusWeight);
  }
  if (typeof input.meanPoints === "number" && Number.isFinite(input.meanPoints)) {
    return Math.max(0, input.meanPoints);
  }
  return typeof input.goalPriority === "number" && Number.isFinite(input.goalPriority)
    ? Math.max(0, input.goalPriority)
    : 0;
}

export function buildKnowledgeUnitKey(parts: {
  courseId?: string | null;
  requirementKey?: string | null;
  skillNodeId?: string | null;
  dimension?: string | null;
}): string | undefined {
  const courseId = parts.courseId?.trim() || "";
  const requirementKey = parts.requirementKey?.trim() || "";
  const skillNodeId = parts.skillNodeId?.trim() || "";
  const dimension = parts.dimension?.trim() || "";
  if (!requirementKey && !skillNodeId) return undefined;
  return `${courseId || "workspace"}:${requirementKey}:${skillNodeId}:${dimension || "general"}`;
}

/**
 * Deterministically derives a canonical knowledge-unit key from card metadata when
 * callers omit `ReviewQueueItem.knowledgeUnitKey`, ensuring identical server/client dedup.
 */
export function deriveCardKnowledgeUnitKey(
  card: Pick<ReviewCard, "courseId" | "syllabusPointId" | "skillLabel" | "originObservationRootId" | "tags">,
): string | undefined {
  const syllabusPointId = card.syllabusPointId?.trim() || "";
  const skillLabel = card.skillLabel?.trim().toLowerCase() || "";
  if (!syllabusPointId && !skillLabel) return undefined;
  const scope = card.courseId?.trim() || "workspace";
  const unit = syllabusPointId ? `sp:${syllabusPointId}` : `sk:${skillLabel}`;
  const tags = Array.isArray(card.tags) ? card.tags : [];
  const dimension = card.originObservationRootId || tags.includes("review:question")
    ? "question"
    : tags.includes("review:concept")
      ? "concept"
      : "general";
  return `${scope}:${unit}:${dimension}`;
}

/**
 * Deterministically derives a question/skill family key from card metadata when
 * callers omit `ReviewQueueItem.familyKey`.
 */
export function deriveCardFamilyKey(
  card: Pick<ReviewCard, "courseId" | "syllabusPointId" | "skillLabel" | "originObservationRootId">,
): string | undefined {
  const originRoot = card.originObservationRootId?.trim() || "";
  if (originRoot) return `obs:${originRoot}`;
  const skillLabel = card.skillLabel?.trim().toLowerCase() || "";
  if (skillLabel) return `${card.courseId?.trim() || "workspace"}:skill:${skillLabel}`;
  const syllabusPointId = card.syllabusPointId?.trim() || "";
  if (syllabusPointId) return `${card.courseId?.trim() || "workspace"}:sp:${syllabusPointId}`;
  return undefined;
}

/**
 * Workspace-wide 30% daily recovery cap shared across all courses in a workspace:
 * `max(0, min(freeUnreservedMinutes, floor(0.30 * dailyBudgetMinutes) - usedOrReservedRecoveryMinutes))`.
 * Fails closed (`0`) if any budget input is non-finite.
 */
export function computeWorkspaceRecoveryBudgetMinutes(
  input: WorkspaceRecoveryBudgetInput,
): number {
  if (
    !Number.isFinite(input.dailyBudgetMinutes)
    || !Number.isFinite(input.freeUnreservedMinutes)
    || !Number.isFinite(input.usedOrReservedRecoveryMinutes)
  ) {
    return 0;
  }
  const daily = Math.max(0, input.dailyBudgetMinutes);
  const free = Math.max(0, input.freeUnreservedMinutes);
  const used = Math.max(0, input.usedOrReservedRecoveryMinutes);
  // Use exact rational arithmetic (3 / 10) to avoid IEEE-754 floor drift (e.g. 0.30 * 230 = 68.99999999999999).
  const dailyCap = Math.floor((daily * 3) / 10);
  return Math.max(0, Math.min(free, dailyCap - used));
}

/**
 * Decouples card FSRS `dueAt` from `day-planner` hard deadlines:
 * maps `cardDueAt` strictly to `eligibleSince` while placing the scheduling window
 * `[scheduledWindowStart, softEnd]` inside `planDay` with `hardDeadlineAt: null`.
 */
export function toRecoveryTaskWindow(input: RecoveryTaskWindowInput): RecoveryTaskWindow {
  const cardDueMs = Date.parse(input.cardDueAt);
  const dayStartMs = Date.parse(input.planDayStartIso);
  const dayEndMs = Date.parse(input.planDayEndIso);
  if (!Number.isFinite(cardDueMs)) throw new RangeError(`Invalid cardDueAt: ${input.cardDueAt}`);
  if (!Number.isFinite(dayStartMs)) throw new RangeError(`Invalid planDayStartIso: ${input.planDayStartIso}`);
  if (!Number.isFinite(dayEndMs)) throw new RangeError(`Invalid planDayEndIso: ${input.planDayEndIso}`);
  if (dayEndMs <= dayStartMs) throw new RangeError("planDayEndIso must be after planDayStartIso");
  const windowStartMs = Math.min(dayEndMs, Math.max(dayStartMs, cardDueMs));
  return {
    eligibleSince: new Date(cardDueMs).toISOString(),
    scheduledWindowStart: new Date(windowStartMs).toISOString(),
    softEnd: new Date(dayEndMs).toISOString(),
    hardDeadlineAt: null,
    isOverdueBeforePlanDay: cardDueMs < dayStartMs,
    eligibleWithinPlanDay: cardDueMs < dayEndMs,
  };
}

function isPaused(card: ReviewCard, now: Date): boolean {
  if (!card.pausedUntil) return false;
  return Date.parse(card.pausedUntil) > now.getTime();
}

function isMaintainExpiredForAuto(card: ReviewCard, today: string): boolean {
  if (!card.maintainUntil) return false;
  return card.maintainUntil < today;
}

function isDue(state: ReviewState, now: Date): boolean {
  return Date.parse(state.dueAt) <= now.getTime();
}

export function reviewEligibilityForMode(
  card: ReviewCard,
  state: ReviewState,
  mode: ReviewQueueMode,
  now: Date,
  today: string,
): ReviewEligibility {
  if (card.archived || card.autoPaused || isPaused(card, now)) {
    return { eligible: false, excludeFromAssessment: card.excludeFromAssessment };
  }
  if (mode === "auto") {
    if (isMaintainExpiredForAuto(card, today) || !isDue(state, now)) {
      return { eligible: false, excludeFromAssessment: card.excludeFromAssessment };
    }
  }
  return { eligible: true, excludeFromAssessment: card.excludeFromAssessment };
}

export function isCardEligibleForMode(
  card: ReviewCard,
  state: ReviewState,
  mode: ReviewQueueMode,
  now: Date,
  today: string,
): boolean {
  return reviewEligibilityForMode(card, state, mode, now, today).eligible;
}

function normalizeOptionalKey(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isHighWeightValue(weight: number, threshold: number): boolean {
  return threshold <= 0 ? weight > 0 : weight >= threshold;
}

function compareDueAt(a: ReviewQueueItem, b: ReviewQueueItem): number {
  const aMs = Date.parse(a.state.dueAt);
  const bMs = Date.parse(b.state.dueAt);
  if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
    return aMs - bMs;
  }
  return a.state.dueAt.localeCompare(b.state.dueAt);
}

type TriageCandidate = {
  item: ReviewQueueItem;
  baseBand: RecoveryTriageBand;
  effectiveWeight: number;
  retrievabilityStatus: "known" | "unseen_or_unknown";
  retrievability: number | null;
  elapsedDaysSinceLastReview: number | null;
  knowledgeUnitKey: string | null;
  familyKey: string | null;
  delayedCheckCovered: boolean;
};

function bandFiveSubTier(entry: Pick<TriagedReviewQueueItem, "retrievabilityStatus" | "retrievability">): number {
  if (entry.retrievabilityStatus === "known" && entry.retrievability !== null) {
    if (
      entry.retrievability >= SALVAGEABLE_RETRIEVABILITY_MIN
      && entry.retrievability <= SALVAGEABLE_RETRIEVABILITY_MAX
    ) {
      return 0;
    }
    if (entry.retrievability < SALVAGEABLE_RETRIEVABILITY_MIN) {
      return 1;
    }
    return 3;
  }
  return 2;
}

function compareWithinSameBand(
  a: Pick<TriagedReviewQueueItem, "item" | "band" | "effectiveWeight" | "retrievabilityStatus" | "retrievability">,
  b: Pick<TriagedReviewQueueItem, "item" | "band" | "effectiveWeight" | "retrievabilityStatus" | "retrievability">,
): number {
  const weightCmp = b.effectiveWeight - a.effectiveWeight;
  if (weightCmp !== 0) return weightCmp;
  if (a.band === 5) {
    const subCmp = bandFiveSubTier(a) - bandFiveSubTier(b);
    if (subCmp !== 0) return subCmp;
  }
  if (
    a.retrievabilityStatus === "known"
    && b.retrievabilityStatus === "known"
    && a.retrievability !== null
    && b.retrievability !== null
    && a.retrievability !== b.retrievability
  ) {
    return a.retrievability - b.retrievability;
  }
  const dueCmp = compareDueAt(a.item, b.item);
  if (dueCmp !== 0) return dueCmp;
  const priorityCmp = b.item.goalPriority - a.item.goalPriority;
  if (priorityCmp !== 0) return priorityCmp;
  return a.item.card.id.localeCompare(b.item.card.id);
}

function classifyBaseBand(
  item: ReviewQueueItem,
  highWeight: boolean,
  retrievabilityStatus: "known" | "unseen_or_unknown",
  retrievability: number | null,
): RecoveryTriageBand {
  if (item.delayedCheckCovered === true || !highWeight) return 5;
  if (retrievabilityStatus === "known" && retrievability !== null) {
    if (
      retrievability >= SALVAGEABLE_RETRIEVABILITY_MIN
      && retrievability <= SALVAGEABLE_RETRIEVABILITY_MAX
    ) {
      return 1;
    }
    if (retrievability < SALVAGEABLE_RETRIEVABILITY_MIN) {
      return 2;
    }
    if (retrievability > SALVAGEABLE_RETRIEVABILITY_MAX) {
      return 4;
    }
    return 5;
  }
  return 3;
}

/**
 * Performs global 5-band FSRS-6.0 recovery triage and knowledge-unit/family deduplication
 * BEFORE any bounded session slice (default 200 cards) so high-weight salvageable items
 * are never truncated behind older low-priority or high-retention backlog cards.
 */
export function buildBacklogRehabilitationPlan(
  items: readonly ReviewQueueItem[],
  mode: ReviewQueueMode,
  now: Date,
  today: string,
  options: RecoveryTriageOptions = {},
): BacklogRehabilitationPlan {
  const threshold = typeof options.highWeightThreshold === "number" && Number.isFinite(options.highWeightThreshold)
    ? Math.max(0, options.highWeightThreshold)
    : 0;

  const candidates: TriageCandidate[] = items
    .filter((item) => isCardEligibleForMode(item.card, item.state, mode, now, today))
    .map((item) => {
      const evaluated = computeCardRetrievability(item.state, now);
      const effectiveWeight = resolveSyllabusWeight({
        syllabusWeight: item.syllabusWeight,
        goalPriority: item.goalPriority,
      });
      const highWeight = isHighWeightValue(effectiveWeight, threshold);
      const baseBand = classifyBaseBand(
        item,
        highWeight,
        evaluated.retrievabilityStatus,
        evaluated.retrievability,
      );
      const resolvedKnowledgeUnitKey = item.knowledgeUnitKey !== undefined
        ? normalizeOptionalKey(item.knowledgeUnitKey)
        : normalizeOptionalKey(deriveCardKnowledgeUnitKey(item.card));
      const resolvedFamilyKey = item.familyKey !== undefined
        ? normalizeOptionalKey(item.familyKey)
        : normalizeOptionalKey(deriveCardFamilyKey(item.card));
      return {
        item,
        baseBand,
        effectiveWeight,
        retrievabilityStatus: evaluated.retrievabilityStatus,
        retrievability: evaluated.retrievability,
        elapsedDaysSinceLastReview: evaluated.elapsedDaysSinceLastReview,
        knowledgeUnitKey: resolvedKnowledgeUnitKey,
        familyKey: resolvedFamilyKey,
        delayedCheckCovered: item.delayedCheckCovered === true,
      };
    });

  // Sort by intrinsic value first so the strongest card wins primary status per knowledge unit / family.
  candidates.sort((a, b) => {
    if (a.baseBand !== b.baseBand) return a.baseBand - b.baseBand;
    if (a.delayedCheckCovered !== b.delayedCheckCovered) return a.delayedCheckCovered ? 1 : -1;
    return compareWithinSameBand(
      { ...a, band: a.baseBand },
      { ...b, band: b.baseBand },
    );
  });

  const seenKnowledgeUnits = new Set<string>();
  const seenFamilies = new Set<string>();

  const triaged: TriagedReviewQueueItem[] = candidates.map((candidate) => {
    if (candidate.delayedCheckCovered) {
      return {
        item: candidate.item,
        band: 5,
        effectiveWeight: candidate.effectiveWeight,
        retrievabilityStatus: candidate.retrievabilityStatus,
        retrievability: candidate.retrievability,
        elapsedDaysSinceLastReview: candidate.elapsedDaysSinceLastReview,
        isPrimaryRepresentative: false,
        demotedReason: "delayed_check_covered",
      };
    }

    if (candidate.knowledgeUnitKey !== null && seenKnowledgeUnits.has(candidate.knowledgeUnitKey)) {
      return {
        item: candidate.item,
        band: 5,
        effectiveWeight: candidate.effectiveWeight,
        retrievabilityStatus: candidate.retrievabilityStatus,
        retrievability: candidate.retrievability,
        elapsedDaysSinceLastReview: candidate.elapsedDaysSinceLastReview,
        isPrimaryRepresentative: false,
        demotedReason: "duplicate_knowledge_unit",
      };
    }

    if (
      candidate.knowledgeUnitKey === null
      && candidate.familyKey !== null
      && seenFamilies.has(candidate.familyKey)
    ) {
      return {
        item: candidate.item,
        band: 5,
        effectiveWeight: candidate.effectiveWeight,
        retrievabilityStatus: candidate.retrievabilityStatus,
        retrievability: candidate.retrievability,
        elapsedDaysSinceLastReview: candidate.elapsedDaysSinceLastReview,
        isPrimaryRepresentative: false,
        demotedReason: "duplicate_family",
      };
    }

    const familyAlreadySeen = candidate.familyKey !== null && seenFamilies.has(candidate.familyKey);
    if (candidate.knowledgeUnitKey !== null) seenKnowledgeUnits.add(candidate.knowledgeUnitKey);
    if (candidate.familyKey !== null) seenFamilies.add(candidate.familyKey);

    return {
      item: candidate.item,
      band: candidate.baseBand,
      effectiveWeight: candidate.effectiveWeight,
      retrievabilityStatus: candidate.retrievabilityStatus,
      retrievability: candidate.retrievability,
      elapsedDaysSinceLastReview: candidate.elapsedDaysSinceLastReview,
      isPrimaryRepresentative: !familyAlreadySeen,
      demotedReason: null,
    };
  });

  triaged.sort((a, b) => {
    if (a.band !== b.band) return a.band - b.band;
    if (a.band < 5 && a.isPrimaryRepresentative !== b.isPrimaryRepresentative) {
      return a.isPrimaryRepresentative ? -1 : 1;
    }
    if (a.band === 5) {
      const aDemoted = a.demotedReason !== null;
      const bDemoted = b.demotedReason !== null;
      if (aDemoted !== bDemoted) return aDemoted ? 1 : -1;
    }
    return compareWithinSameBand(a, b);
  });

  const countsByBand: Record<RecoveryTriageBand, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const entry of triaged) {
    countsByBand[entry.band] += 1;
  }

  const cap = typeof options.maxSessionCards === "number" && Number.isFinite(options.maxSessionCards)
    ? Math.max(0, Math.floor(options.maxSessionCards))
    : DEFAULT_RECOVERY_SESSION_CARD_CAP;

  return {
    triaged,
    sessionItems: triaged.slice(0, cap),
    deferredItems: triaged.slice(cap),
    countsByBand,
  };
}

function compareQueueItems(a: ReviewQueueItem, b: ReviewQueueItem): number {
  const dueCmp = compareDueAt(a, b);
  if (dueCmp !== 0) return dueCmp;
  const priorityCmp = b.goalPriority - a.goalPriority;
  if (priorityCmp !== 0) return priorityCmp;
  return a.card.id.localeCompare(b.card.id);
}

export function buildReviewQueue(
  items: readonly ReviewQueueItem[],
  mode: ReviewQueueMode,
  now: Date,
  today: string,
  options?: RecoveryTriageOptions,
): ReviewQueueItem[] {
  const eligible = items.filter((item) => isCardEligibleForMode(item.card, item.state, mode, now, today));
  if (
    eligible.length < RECOVERY_BACKLOG_CARD_THRESHOLD
    && options?.recoveryTriage !== true
    && options?.maxSessionCards === undefined
  ) {
    return eligible.slice().sort(compareQueueItems);
  }
  const plan = buildBacklogRehabilitationPlan(eligible, mode, now, today, options);
  const selected = options?.maxSessionCards !== undefined ? plan.sessionItems : plan.triaged;
  return selected.map((entry) => entry.item);
}
