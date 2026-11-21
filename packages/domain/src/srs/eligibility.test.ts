import { describe, expect, it } from "vitest";
import type { ReviewCard, ReviewState, TaskItem, TimeBlock } from "@aistudy/contracts";
import { planDay } from "../opening/day-planner";
import {
  buildBacklogRehabilitationPlan,
  buildKnowledgeUnitKey,
  buildReviewQueue,
  computeWorkspaceRecoveryBudgetMinutes,
  deriveCardFamilyKey,
  deriveCardKnowledgeUnitKey,
  isCardEligibleForMode,
  resolveSyllabusWeight,
  reviewEligibilityForMode,
  toRecoveryTaskWindow,
  type ReviewQueueItem,
} from "./eligibility";
import {
  canFitPersonalFsrsParameters,
  computeCardRetrievability,
  createInitialState,
  isIndependentCardMasteryEvidence,
  scheduleReview,
  SRS_VERSION,
} from "./scheduler";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const TODAY = "2026-08-15";

function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "22222222-2222-4222-8222-222222222222",
    front: "front",
    back: "back",
    sourceDocumentId: null,
    syllabusPointId: null,
    tags: ["t"],
    archived: false,
    contentVersion: 1,
    pausedUntil: null,
    maintainUntil: null,
    excludeFromAssessment: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    cardId: "11111111-1111-4111-8111-111111111111",
    ease: 2.5,
    intervalDays: 1,
    dueAt: "2026-08-14T12:00:00.000Z",
    reps: 1,
    lapses: 0,
    lastGrade: "good",
    updatedAt: "2026-08-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("review eligibility and queue", () => {
  it("excludes archived cards in every mode", () => {
    const archived = card({ archived: true });
    for (const mode of ["auto", "self-selected", "free"] as const) {
      expect(isCardEligibleForMode(archived, state(), mode, NOW, TODAY)).toBe(false);
    }
  });

  it("excludes paused cards while pausedUntil is in the future", () => {
    const paused = card({ pausedUntil: "2026-08-20T00:00:00.000Z" });
    for (const mode of ["auto", "self-selected", "free"] as const) {
      expect(isCardEligibleForMode(paused, state(), mode, NOW, TODAY)).toBe(false);
    }
    expect(
      isCardEligibleForMode(
        card({ pausedUntil: "2026-08-15T11:00:00.000Z" }),
        state(),
        "auto",
        NOW,
        TODAY,
      ),
    ).toBe(true);
  });

  it("treats maintainUntil as auto-only maintain deadline", () => {
    const maintained = card({ maintainUntil: "2026-08-15" });
    const expired = card({ maintainUntil: "2026-08-14" });
    expect(isCardEligibleForMode(maintained, state(), "auto", NOW, TODAY)).toBe(true);
    expect(isCardEligibleForMode(expired, state(), "auto", NOW, TODAY)).toBe(false);
    expect(isCardEligibleForMode(expired, state(), "self-selected", NOW, TODAY)).toBe(true);
    expect(isCardEligibleForMode(expired, state(), "free", NOW, TODAY)).toBe(true);
  });

  it("lets excludeFromAssessment mark results without blocking review", () => {
    const excluded = card({ excludeFromAssessment: true });
    const result = reviewEligibilityForMode(excluded, state(), "auto", NOW, TODAY);
    expect(result.eligible).toBe(true);
    expect(result.excludeFromAssessment).toBe(true);
  });

  it("applies dueAt only in auto mode", () => {
    const future = state({ dueAt: "2026-08-16T12:00:00.000Z" });
    expect(isCardEligibleForMode(card(), future, "auto", NOW, TODAY)).toBe(false);
    expect(isCardEligibleForMode(card(), future, "self-selected", NOW, TODAY)).toBe(true);
    expect(isCardEligibleForMode(card(), future, "free", NOW, TODAY)).toBe(true);
  });

  it("sorts queue by dueAt, goal priority desc, then card id", () => {
    const a = {
      card: card({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      state: state({
        cardId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        dueAt: "2026-08-14T10:00:00.000Z",
      }),
      goalPriority: 1,
    };
    const b = {
      card: card({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      state: state({
        cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        dueAt: "2026-08-14T10:00:00.000Z",
      }),
      goalPriority: 5,
    };
    const c = {
      card: card({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
      state: state({
        cardId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        dueAt: "2026-08-13T10:00:00.000Z",
      }),
      goalPriority: 9,
    };
    const queue = buildReviewQueue([a, b, c], "auto", NOW, TODAY);
    expect(queue.map((item) => item.card.id)).toEqual([
      c.card.id,
      b.card.id,
      a.card.id,
    ]);
    expect(queue[0]?.state).toEqual(c.state);
  });

  it("preserves ordinary dueAt ASC order below the 200-card backlog threshold unless recoveryTriage is enabled", () => {
    const earlierLowPriority = {
      card: card({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      state: fsrsState("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        stability: 30,
        daysAgo: 1,
        dueAt: "2026-08-12T10:00:00.000Z",
      }),
      goalPriority: 0,
    };
    const laterHighPrioritySalvage = {
      card: card({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      state: fsrsState("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
        stability: 1.5,
        daysAgo: 10,
        dueAt: "2026-08-14T10:00:00.000Z",
      }),
      goalPriority: 8,
    };
    // Ordinary small queue (< 200 cards): keeps dueAt ASC order.
    const ordinary = buildReviewQueue([laterHighPrioritySalvage, earlierLowPriority], "auto", NOW, TODAY);
    expect(ordinary.map((item) => item.card.id)).toEqual([
      earlierLowPriority.card.id,
      laterHighPrioritySalvage.card.id,
    ]);
    // Explicit recoveryTriage: promotes Band-1 high-weight salvageable card ahead of Band-5 card.
    const triaged = buildReviewQueue([laterHighPrioritySalvage, earlierLowPriority], "auto", NOW, TODAY, {
      recoveryTriage: true,
    });
    expect(triaged.map((item) => item.card.id)).toEqual([
      laterHighPrioritySalvage.card.id,
      earlierLowPriority.card.id,
    ]);
  });
});

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function fsrsState(
  cardId: string,
  options: {
    stability: number;
    daysAgo: number;
    dueAt?: string;
    reps?: number;
    state?: number;
  },
): ReviewState {
  const lastReview = new Date(NOW.getTime() - options.daysAgo * 86_400_000).toISOString();
  return {
    cardId,
    ease: 2.5,
    intervalDays: Math.max(0, Math.floor(options.stability)),
    dueAt: options.dueAt ?? "2026-08-14T12:00:00.000Z",
    reps: options.reps ?? 2,
    lapses: 0,
    lastGrade: "good",
    updatedAt: lastReview,
    srsVersion: SRS_VERSION,
    fsrs: {
      stability: options.stability,
      difficulty: 5,
      elapsedDays: 1,
      scheduledDays: Math.max(1, Math.round(options.stability)),
      learningSteps: 0,
      reps: options.reps ?? 2,
      lapses: 0,
      state: options.state ?? 2,
      lastReview,
    },
  };
}

describe("FSRS-6.0 retrievability, parameter gate, and mastery evidence boundary", () => {
  it("computes true FSRS-6.0 retrievability from lastReview and stability, ignoring exam-compressed dueAt", () => {
    const reviewedAt = new Date("2026-08-14T08:00:00.000Z");
    const initial = createInitialState(uuidFor(1), reviewedAt);
    const compressed = scheduleReview(initial, "easy", reviewedAt, {
      targetDate: "2026-08-16",
      today: "2026-08-14",
      timeZone: "UTC",
    });
    // Pre-exam compression pulled dueAt to 2026-08-15T04:00:00Z (overdue at NOW = 2026-08-15T12:00:00Z)
    // and set intervalDays = 0, yet true FSRS-6.0 stability is ~8.3d -> R remains high (> 0.90).
    expect(Date.parse(compressed.dueAt)).toBeLessThan(NOW.getTime());
    expect(compressed.intervalDays).toBe(0);

    const evaluated = computeCardRetrievability(compressed, NOW);
    expect(evaluated.retrievabilityStatus).toBe("known");
    if (evaluated.retrievabilityStatus !== "known") throw new Error("expected known");
    expect(evaluated.elapsedDaysSinceLastReview).toBeCloseTo(28 / 24, 6);
    expect(evaluated.retrievability).toBeGreaterThan(0.9);
  });

  it("clamps negative clock drift to elapsedDays = 0 and R = 1", () => {
    const futureReview = fsrsState(uuidFor(2), { stability: 5, daysAgo: -2 });
    const evaluated = computeCardRetrievability(futureReview, NOW);
    expect(evaluated).toEqual({
      retrievabilityStatus: "known",
      retrievability: 1,
      elapsedDaysSinceLastReview: 0,
    });
  });

  it("reports honest unseen_or_unknown for unseen, legacy srs-1, null/invalid FSRS, and State.New", () => {
    const unseen = createInitialState(uuidFor(3), NOW);
    const legacy = state({ cardId: uuidFor(4), reps: 5, srsVersion: "srs-1", fsrs: null });
    const missingLastReview = {
      ...fsrsState(uuidFor(5), { stability: 4, daysAgo: 3 }),
      fsrs: { ...fsrsState(uuidFor(5), { stability: 4, daysAgo: 3 }).fsrs!, lastReview: null },
    };
    const zeroStability = fsrsState(uuidFor(6), { stability: 0, daysAgo: 5 });
    const stateNew = fsrsState(uuidFor(7), { stability: 4, daysAgo: 5, state: 0 });

    for (const candidate of [unseen, legacy, missingLastReview, zeroStability, stateNew]) {
      expect(computeCardRetrievability(candidate, NOW)).toEqual({
        retrievabilityStatus: "unseen_or_unknown",
        retrievability: null,
        elapsedDaysSinceLastReview: null,
      });
    }
  });

  it("locks personal FSRS weight fitting below 400 deduplicated independent reviews", () => {
    expect(canFitPersonalFsrsParameters(0)).toBe(false);
    expect(canFitPersonalFsrsParameters(399)).toBe(false);
    expect(canFitPersonalFsrsParameters(-10)).toBe(false);
    expect(canFitPersonalFsrsParameters(Number.NaN)).toBe(false);
    expect(canFitPersonalFsrsParameters(400)).toBe(true);
    expect(canFitPersonalFsrsParameters(650)).toBe(true);
  });

  it("excludes plain flashcard self-ratings from SkillBeliefV1 and deduplicates variant-backed reviews by variantObservationId", () => {
    expect(isIndependentCardMasteryEvidence({})).toEqual({
      countsTowardSkillBelief: false,
      canonicalObservationId: null,
    });
    expect(isIndependentCardMasteryEvidence({ variantObservationId: null })).toEqual({
      countsTowardSkillBelief: false,
      canonicalObservationId: null,
    });
    expect(isIndependentCardMasteryEvidence({ variantObservationId: "   " })).toEqual({
      countsTowardSkillBelief: false,
      canonicalObservationId: null,
    });
    const obsId = uuidFor(99);
    expect(isIndependentCardMasteryEvidence({ variantObservationId: ` ${obsId} ` })).toEqual({
      countsTowardSkillBelief: true,
      canonicalObservationId: obsId,
    });
  });
});

describe("pre-200-cap 5-band recovery triage, dedup, 30% cap, and eligibleSince decoupling", () => {
  it("promotes item #201 (high syllabusWeight & 0.35 <= R <= 0.75) ahead of 200 older low-priority or R > 0.88 cards before slicing to 200", () => {
    const items: ReviewQueueItem[] = [];
    // 100 older low-priority forgotten cards (Band 5)
    for (let i = 1; i <= 100; i += 1) {
      const id = uuidFor(i);
      items.push({
        card: card({ id }),
        state: fsrsState(id, { stability: 0.4, daysAgo: 200, dueAt: "2026-07-01T00:00:00.000Z" }),
        goalPriority: 0,
      });
    }
    // 100 older high-retention (R > 0.88) cards (Band 4)
    for (let i = 101; i <= 200; i += 1) {
      const id = uuidFor(i);
      items.push({
        card: card({ id }),
        state: fsrsState(id, { stability: 30, daysAgo: 1, dueAt: "2026-07-02T00:00:00.000Z" }),
        goalPriority: 5,
      });
    }
    // Item #201: newer dueAt, high syllabusWeight, salvageable sweet spot (0.35 <= R <= 0.75) -> Band 1
    const criticalId = uuidFor(201);
    const criticalState = fsrsState(criticalId, { stability: 1.5, daysAgo: 10, dueAt: "2026-08-14T23:00:00.000Z" });
    const criticalR = computeCardRetrievability(criticalState, NOW);
    expect(criticalR.retrievabilityStatus).toBe("known");
    if (criticalR.retrievabilityStatus === "known") {
      expect(criticalR.retrievability).toBeGreaterThanOrEqual(0.35);
      expect(criticalR.retrievability).toBeLessThanOrEqual(0.75);
    }
    items.push({
      card: card({ id: criticalId }),
      state: criticalState,
      goalPriority: 1,
      syllabusWeight: 12,
    });

    const plan = buildBacklogRehabilitationPlan(items, "auto", NOW, TODAY, { maxSessionCards: 200 });
    expect(plan.sessionItems).toHaveLength(200);
    expect(plan.deferredItems).toHaveLength(1);
    expect(plan.sessionItems[0]?.item.card.id).toBe(criticalId);
    expect(plan.sessionItems[0]?.band).toBe(1);
    expect(plan.countsByBand).toEqual({ 1: 1, 2: 0, 3: 0, 4: 100, 5: 100 });

    const cappedQueue = buildReviewQueue(items, "auto", NOW, TODAY, { maxSessionCards: 200 });
    expect(cappedQueue).toHaveLength(200);
    expect(cappedQueue[0]?.card.id).toBe(criticalId);
  });

  it("orders all 5 bands strictly and deduplicates knowledgeUnitKey / familyKey / delayedCheckCovered", () => {
    const band1FamAPrimary = uuidFor(11);
    const band1FamADupKu = uuidFor(12);
    const band1FamASecondKu = uuidFor(13);
    const band1FamBPrimary = uuidFor(14);
    const band1DelayedCovered = uuidFor(15);
    const band2CoreRebuild = uuidFor(16);
    const band3UnseenLinked = uuidFor(17);
    const band4HighRetention = uuidFor(18);
    const band5LowWeightForgotten = uuidFor(19);

    const kuA1 = buildKnowledgeUnitKey({ courseId: "c1", requirementKey: "r1", skillNodeId: "n1", dimension: "recall" });
    const kuA2 = buildKnowledgeUnitKey({ courseId: "c1", requirementKey: "r1", skillNodeId: "n1", dimension: "apply" });
    const kuB1 = buildKnowledgeUnitKey({ courseId: "c1", requirementKey: "r2", skillNodeId: "n2", dimension: "recall" });

    // Confirm our test states land in exact target R windows under FSRS-6.0 (w[20] = 0.1542).
    const salvageLowerR = fsrsState(band1FamAPrimary, { stability: 1.0, daysAgo: 20 }); // R ≈ 0.627 in [0.35, 0.75]
    const salvageHigherR = fsrsState(band1FamADupKu, { stability: 2.0, daysAgo: 12 }); // R ≈ 0.743 in [0.35, 0.75]
    const forgottenState = fsrsState(band2CoreRebuild, { stability: 0.2, daysAgo: 365 }); // R ≈ 0.315 < 0.35
    const highRetState = fsrsState(band4HighRetention, { stability: 30, daysAgo: 1 }); // R > 0.75

    const rLow = computeCardRetrievability(salvageLowerR, NOW);
    const rHigh = computeCardRetrievability(salvageHigherR, NOW);
    const rForgotten = computeCardRetrievability(forgottenState, NOW);
    const rRetained = computeCardRetrievability(highRetState, NOW);
    expect(rLow.retrievabilityStatus === "known" && rLow.retrievability >= 0.35 && rLow.retrievability <= 0.75).toBe(true);
    expect(rHigh.retrievabilityStatus === "known" && rHigh.retrievability >= 0.35 && rHigh.retrievability <= 0.75).toBe(true);
    expect(rLow.retrievability! < rHigh.retrievability!).toBe(true);
    expect(rForgotten.retrievabilityStatus === "known" && rForgotten.retrievability < 0.35).toBe(true);
    expect(rRetained.retrievabilityStatus === "known" && rRetained.retrievability > 0.75).toBe(true);

    const items: ReviewQueueItem[] = [
      { card: card({ id: band5LowWeightForgotten }), state: { ...forgottenState, cardId: band5LowWeightForgotten }, goalPriority: 0 },
      { card: card({ id: band4HighRetention }), state: highRetState, goalPriority: 5, syllabusWeight: 10 },
      { card: card({ id: band3UnseenLinked }), state: state({ cardId: band3UnseenLinked }), goalPriority: 5, syllabusWeight: 8 },
      { card: card({ id: band2CoreRebuild }), state: forgottenState, goalPriority: 5, syllabusWeight: 10 },
      {
        card: card({ id: band1DelayedCovered }),
        state: { ...salvageLowerR, cardId: band1DelayedCovered },
        goalPriority: 5,
        syllabusWeight: 20,
        delayedCheckCovered: true,
      },
      {
        card: card({ id: band1FamADupKu }),
        state: salvageHigherR,
        goalPriority: 5,
        syllabusWeight: 10,
        knowledgeUnitKey: kuA1,
        familyKey: "fam-a",
      },
      {
        card: card({ id: band1FamASecondKu }),
        state: { ...salvageHigherR, cardId: band1FamASecondKu },
        goalPriority: 5,
        syllabusWeight: 10,
        knowledgeUnitKey: kuA2,
        familyKey: "fam-a",
      },
      {
        card: card({ id: band1FamBPrimary }),
        state: { ...salvageHigherR, cardId: band1FamBPrimary },
        goalPriority: 5,
        syllabusWeight: 4,
        knowledgeUnitKey: kuB1,
        familyKey: "fam-b",
      },
      {
        card: card({ id: band1FamAPrimary }),
        state: salvageLowerR,
        goalPriority: 5,
        syllabusWeight: 10,
        knowledgeUnitKey: kuA1,
        familyKey: "fam-a",
      },
    ];

    const plan = buildBacklogRehabilitationPlan(items, "auto", NOW, TODAY);
    expect(plan.triaged.map((entry) => [entry.item.card.id, entry.band, entry.demotedReason])).toEqual([
      [band1FamAPrimary, 1, null], // Band 1 primary for fam-a (lower R wins over band1FamADupKu on kuA1)
      [band1FamBPrimary, 1, null], // Band 1 primary for fam-b beats secondary fam-a card
      [band1FamASecondKu, 1, null], // Band 1 secondary (distinct knowledgeUnitKey kuA2 in fam-a)
      [band2CoreRebuild, 2, null],
      [band3UnseenLinked, 3, null],
      [band4HighRetention, 4, null],
      [band5LowWeightForgotten, 5, null],
      [band1DelayedCovered, 5, "delayed_check_covered"],
      [band1FamADupKu, 5, "duplicate_knowledge_unit"],
    ]);
  });

  it("never double-multiplies historical exam meanPoints by appearanceProbability", () => {
    expect(resolveSyllabusWeight({ meanPoints: 12, appearanceProbability: 0.5, goalPriority: 1 })).toBe(12);
    expect(resolveSyllabusWeight({ syllabusWeight: 7.5, meanPoints: 12, appearanceProbability: 0.2, goalPriority: 1 })).toBe(7.5);
    expect(resolveSyllabusWeight({ goalPriority: 3 })).toBe(3);
  });

  it("supports configurable highWeightThreshold, routes all low-weight cards to Band 5, and demotes familyKey duplicates", () => {
    const idHigh = uuidFor(21);
    const idDupFamily = uuidFor(22);
    const idLowSalvage = uuidFor(23);
    const idZeroHighRetention = uuidFor(24);
    const idLowUnseen = uuidFor(25);
    const idZeroForgotten = uuidFor(26);
    const idZeroSalvage = uuidFor(27);
    const salvage = fsrsState(idHigh, { stability: 1.0, daysAgo: 20 });
    const highRet = fsrsState(idZeroHighRetention, { stability: 30, daysAgo: 1 });
    const forgotten = fsrsState(idZeroForgotten, { stability: 0.2, daysAgo: 365 });

    const plan = buildBacklogRehabilitationPlan(
      [
        { card: card({ id: idZeroHighRetention }), state: highRet, goalPriority: 0, syllabusWeight: 0 },
        { card: card({ id: idZeroForgotten }), state: forgotten, goalPriority: 0, syllabusWeight: 0 },
        { card: card({ id: idZeroSalvage }), state: { ...salvage, cardId: idZeroSalvage }, goalPriority: 0, syllabusWeight: 0 },
        { card: card({ id: idLowUnseen }), state: state({ cardId: idLowUnseen }), goalPriority: 2, syllabusWeight: 2 },
        { card: card({ id: idLowSalvage }), state: { ...salvage, cardId: idLowSalvage }, goalPriority: 1, syllabusWeight: 4 },
        { card: card({ id: idDupFamily }), state: { ...salvage, cardId: idDupFamily }, goalPriority: 1, syllabusWeight: 6, familyKey: "fam-only" },
        { card: card({ id: idHigh }), state: salvage, goalPriority: 1, syllabusWeight: 8, familyKey: "fam-only" },
      ],
      "auto",
      NOW,
      TODAY,
      { highWeightThreshold: 5 },
    );
    expect(plan.triaged.map((entry) => [entry.item.card.id, entry.band, entry.demotedReason])).toEqual([
      [idHigh, 1, null],
      [idLowSalvage, 5, null], // syllabusWeight 4, R in [0.35, 0.75] stays ahead of syllabusWeight 0 R=0.99
      [idLowUnseen, 5, null], // syllabusWeight 2, unseen stays in Band 5 under threshold 5
      [idZeroSalvage, 5, null], // equal weight 0: [0.35, 0.75] first
      [idZeroForgotten, 5, null], // equal weight 0: < 0.35 second
      [idZeroHighRetention, 5, null], // equal weight 0: > 0.75 last among non-demoted
      [idDupFamily, 5, "duplicate_family"],
    ]);
  });

  it("auto-derives canonical knowledgeUnitKey and familyKey from card metadata when omitted", () => {
    const courseId = "aaaaaaaa-0000-4000-8000-000000000001";
    const limitCard1 = card({ id: uuidFor(31), courseId, skillLabel: " 极限 ", tags: ["review:concept"] });
    const limitCard2 = card({ id: uuidFor(32), courseId, skillLabel: "极限", tags: ["review:concept"] });
    const otherCard = card({ id: uuidFor(33), courseId, skillLabel: "导数", tags: ["review:concept"] });

    expect(deriveCardKnowledgeUnitKey(limitCard1)).toBe(`${courseId}:sk:极限:concept`);
    expect(deriveCardKnowledgeUnitKey(limitCard2)).toBe(deriveCardKnowledgeUnitKey(limitCard1));
    expect(deriveCardFamilyKey(limitCard1)).toBe(`${courseId}:skill:极限`);

    const salvage = fsrsState(limitCard1.id, { stability: 1.0, daysAgo: 20 });
    const plan = buildBacklogRehabilitationPlan(
      [
        { card: limitCard1, state: salvage, goalPriority: 5 },
        { card: limitCard2, state: { ...salvage, cardId: limitCard2.id }, goalPriority: 5 },
        { card: otherCard, state: { ...salvage, cardId: otherCard.id }, goalPriority: 5 },
      ],
      "auto",
      NOW,
      TODAY,
    );
    expect(plan.triaged.map((entry) => [entry.item.card.id, entry.band, entry.demotedReason])).toEqual([
      [limitCard1.id, 1, null],
      [otherCard.id, 1, null],
      [limitCard2.id, 5, "duplicate_knowledge_unit"],
    ]);
  });

  it("enforces workspace-wide 30% daily recovery cap shared across courses and fails closed on non-finite usage", () => {
    // 60m day -> max 18m workspace-wide recovery cap
    expect(computeWorkspaceRecoveryBudgetMinutes({
      dailyBudgetMinutes: 60,
      freeUnreservedMinutes: 45,
      usedOrReservedRecoveryMinutes: 0,
    })).toBe(18);
    // Course A reserved 12m -> Course B can claim at most 6m
    expect(computeWorkspaceRecoveryBudgetMinutes({
      dailyBudgetMinutes: 60,
      freeUnreservedMinutes: 45,
      usedOrReservedRecoveryMinutes: 12,
    })).toBe(6);
    // Bounded by freeUnreservedMinutes when tighter than remaining 30% cap
    expect(computeWorkspaceRecoveryBudgetMinutes({
      dailyBudgetMinutes: 60,
      freeUnreservedMinutes: 4,
      usedOrReservedRecoveryMinutes: 12,
    })).toBe(4);
    // Never negative when already exceeded
    expect(computeWorkspaceRecoveryBudgetMinutes({
      dailyBudgetMinutes: 60,
      freeUnreservedMinutes: 30,
      usedOrReservedRecoveryMinutes: 20,
    })).toBe(0);
    // Exact integer rational floor (no IEEE-754 0.3 * 230 = 68.9999... drift)
    expect(computeWorkspaceRecoveryBudgetMinutes({
      dailyBudgetMinutes: 230,
      freeUnreservedMinutes: 100,
      usedOrReservedRecoveryMinutes: 0,
    })).toBe(69);
    // Fail-closed on NaN / Infinity inputs (never treat corrupted usage as 0)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(computeWorkspaceRecoveryBudgetMinutes({
        dailyBudgetMinutes: 60,
        freeUnreservedMinutes: 45,
        usedOrReservedRecoveryMinutes: bad,
      })).toBe(0);
    }
    expect(computeWorkspaceRecoveryBudgetMinutes({
      dailyBudgetMinutes: Number.NaN,
      freeUnreservedMinutes: 45,
      usedOrReservedRecoveryMinutes: 0,
    })).toBe(0);
    expect(computeWorkspaceRecoveryBudgetMinutes({
      dailyBudgetMinutes: 60,
      freeUnreservedMinutes: Number.POSITIVE_INFINITY,
      usedOrReservedRecoveryMinutes: 0,
    })).toBe(0);
  });

  it("decouples overdue card dueAt into eligibleSince with hardDeadlineAt: null so day-planner schedules instead of deadline_passed", () => {
    const planDayStartIso = "2026-08-15T00:00:00.000Z";
    const planDayEndIso = "2026-08-16T00:00:00.000Z";
    const overdueCardDueAt = "2026-08-01T08:00:00.000Z";

    const window = toRecoveryTaskWindow({
      cardDueAt: overdueCardDueAt,
      planDayStartIso,
      planDayEndIso,
    });
    expect(window).toEqual({
      eligibleSince: overdueCardDueAt,
      scheduledWindowStart: planDayStartIso,
      softEnd: planDayEndIso,
      hardDeadlineAt: null,
      isOverdueBeforePlanDay: true,
      eligibleWithinPlanDay: true,
    });

    const recoveryTask: TaskItem = {
      id: uuidFor(501),
      version: 1,
      title: "有界恢复复习",
      minutes: 15,
      dueAt: window.hardDeadlineAt,
      notBefore: window.scheduledWindowStart,
      priority: 5,
      status: "pending",
    };
    const freeBlocks: TimeBlock[] = [
      { kind: "free", start: "2026-08-15T09:00:00.000Z", end: "2026-08-15T10:00:00.000Z" },
    ];
    const planned = planDay([recoveryTask], freeBlocks, {
      localDate: "2026-08-15",
      timeZone: "UTC",
      planningNow: "2026-08-15T08:30:00.000Z",
    });
    expect(planned.unscheduled).toEqual([]);
    expect(planned.blocks).toHaveLength(1);
    expect(planned.blocks[0]?.taskId).toBe(recoveryTask.id);
    expect(planned.blocks[0]?.start).toBe("2026-08-15T09:00:00.000Z");

    // Contrast: mid-day eligible card respects scheduledWindowStart inside planDay
    const midday = toRecoveryTaskWindow({
      cardDueAt: "2026-08-15T14:30:00.000Z",
      planDayStartIso,
      planDayEndIso,
    });
    expect(midday.scheduledWindowStart).toBe("2026-08-15T14:30:00.000Z");
    expect(midday.isOverdueBeforePlanDay).toBe(false);
    expect(midday.hardDeadlineAt).toBeNull();
  });
});
