import type { CourseRequirement } from "@aistudy/contracts";
import * as course from "@aistudy/domain/opening/course-shared-skill";
import * as dataset from "@aistudy/domain/opening/deidentified-dataset";
import * as forecast from "@aistudy/domain/opening/exam-sprint/score-forecast-bridge";
import { issueReviewQueueOfflineLease, reconcileReviewQueueOfflineOutbox } from "@aistudy/domain/srs/offline-lease-bridge";
import { describe, expect, it } from "vitest";
import { issueSpeechTimingReceipt } from "../multimodal-evidence";
import { createInitialOfflineFsrsSnapshot } from "../offline-companion-bridge";
import type { CryptoShredTombstoneReceipt } from "../resilience-canary-shredding";
import * as srs from "../srs/eligibility";
import type { CourseRouteObservation } from "./course-route";

const issuedAtMs = 10_000;
const time = new Date(issuedAtMs).toISOString();
const scope = { workspaceId: "workspace", ownerUserId: "learner" };
const queueItem = (id: string, question = false): srs.ReviewQueueItem => ({
  card: {
    id, ownerUserId: scope.ownerUserId, front: "What is this concept?", back: question ? "old protected answer" : "A reusable explanation.",
    sourceDocumentId: null, syllabusPointId: null, tags: question ? ["review:question"] : ["review:concept"], courseId: null, skillLabel: null,
    archived: false, contentVersion: 1, pausedUntil: null, maintainUntil: null, excludeFromAssessment: false, createdAt: time,
  },
  state: { cardId: id, ease: 2.5, intervalDays: 0, dueAt: time, reps: 0, lapses: 0, lastGrade: null, updatedAt: time },
  goalPriority: 1,
});

function leaseInput(items: readonly srs.ReviewQueueItem[]) {
  return {
    workspaceId: scope.workspaceId, learnerId: scope.ownerUserId, leaseId: "lease", issuedAtMs,
    queue: srs.buildReviewQueue(items, "auto", new Date(issuedAtMs), "1970-01-01", { recoveryTriage: true }),
    serverCards: new Map(items.map(({ card }) => [card.id, createInitialOfflineFsrsSnapshot(card.id, issuedAtMs, 2)])),
  };
}

describe("SRS offline lease integration", () => {
  it("leases the triaged prefix at the stricter core card cap and excludes another learner's card", () => {
    const items = Array.from({ length: 220 }, (_, index) => ({ ...queueItem(`card-${index}`), goalPriority: index + 1 }));
    items[219]!.card.ownerUserId = "foreign";
    const result = issueReviewQueueOfflineLease(leaseInput(items));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.cards).toHaveLength(30);
    expect(result.lease.cards[0]).toMatchObject({ cardId: "card-218", cardRevision: 2 });
  });

  it("screens fresh variants against private answers before publishing a lease", () => {
    const offline = leaseInput([queueItem("question", true)]);
    const variant = { freshVariantId: "fresh", freshVariantStem: "Solve this new exercise.", answerKey: "controlled answer",
      referenceAnswer: "fresh protected answer", sealedPayload: { solution: "sealed calculation" } };
    const result = issueReviewQueueOfflineLease({ ...offline, freshVariants: new Map([["question", variant]]) });
    expect(result).toMatchObject({ ok: true, lease: { cards: [{
      cardId: "question", cardKind: "miss_variant", freshVariantId: "fresh", freshVariantStem: variant.freshVariantStem,
    }] } });
    if (result.ok) expect(Object.keys(result.lease.cards[0]!)).toEqual([
      "cardId", "cardKind", "cardRevision", "lastServerReviewedAtMs", "freshVariantId", "freshVariantStem",
    ]);
    for (const secret of ["controlled answer", "old protected answer", "fresh protected answer", "sealed calculation"]) {
      expect(issueReviewQueueOfflineLease({
        ...offline, freshVariants: new Map([["question", { ...variant, freshVariantStem: `Try using the ${secret} here.` }]]),
      })).toMatchObject({ ok: false, code: "miss_variant_answer_leak" });
    }
  });

  it("issues a standard flashcard only for a classified concept", () => {
    const concept = queueItem("concept");
    const legacy = queueItem("legacy");
    legacy.card.tags = [];
    legacy.card.back = "Legacy question answer";
    const question = queueItem("question", true);
    const result = issueReviewQueueOfflineLease(leaseInput([legacy, question, concept]));
    expect(result).toMatchObject({ ok: true, lease: { cards: [{ cardId: "concept", cardKind: "flashcard",
      prompt: concept.card.front, backSummary: concept.card.back }] } });
    expect(issueReviewQueueOfflineLease(leaseInput([legacy, question])))
      .toMatchObject({ ok: false, code: "empty_lease_cards" });
  });

  it("lets the core inspect hidden answers and refuse accessors without invoking them", () => {
    const offline = leaseInput([queueItem("question", true)]);
    const variant = { freshVariantId: "fresh", freshVariantStem: "Use the privileged token here." };
    const hidden = Object.defineProperty({ ...variant }, "answerKey", { value: "privileged token" });
    let getterRead = false;
    const accessor = Object.defineProperty({ ...variant }, "answerKey", { get() { getterRead = true; return "privileged token"; } });
    for (const value of [hidden, accessor]) {
      expect(issueReviewQueueOfflineLease({ ...offline, freshVariants: new Map([["question", value]]) }))
        .toMatchObject({ ok: false, code: "miss_variant_answer_leak" });
    }
    expect(getterRead).toBe(false);
  });

  it("uses the half-open server clock and never promotes mastery on an offline easy rating", () => {
    const offline = leaseInput([queueItem("card")]);
    const issued = issueReviewQueueOfflineLease(offline);
    if (!issued.ok) throw new Error(issued.message);
    const { lease } = issued;
    const sync = (serverReceiptAtMs: number) => reconcileReviewQueueOfflineOutbox({
      lease, serverCards: offline.serverCards, serverReceiptAtMs,
      entries: [{ leaseId: lease.leaseId, cardId: "card", seq: 1, expectedCardRevision: 2, rating: "easy",
        clientReviewedAtMs: issuedAtMs, delayedCheck: true, transferVerified: true, promoteMastery: true }],
    });
    expect(sync(issuedAtMs - 1)).toMatchObject({ ok: false, leaseStatus: "invalid_server_clock" });
    expect(sync(lease.expiresAtMs)).toMatchObject({ ok: false, leaseStatus: "lease_expired" });
    for (const instant of [issuedAtMs, lease.expiresAtMs - 1]) {
      expect(sync(instant)).toMatchObject({ ok: true, settledCount: 1, results: [{ receipt: {
        rawRating: "easy", effectiveRating: "good", allowMasteryPromotion: false, delayedCheckMinted: false,
        transferVerified: false, strippedClientFlags: ["delayedCheck", "transferVerified", "promoteMastery"], effectiveReviewedAtMs: instant,
      } }] });
    }
  });
});

const requirement = (id: string): CourseRequirement => ({
  id, courseId: `course-${id}`, stableSkillId: "skill", requirementKey: id, title: id, position: 0, mandatory: true,
  knowledgeNodeId: null, goalIds: [], prerequisiteIds: [], sourceRefs: [{ sourceId: `source-${id}`, sourceVersion: 1 }],
  verification: { kind: "rubric", status: "ready", exerciseKeys: [id], rubric: "Show reasoning", missingReasons: [] },
  revision: 1, lifecycle: "active", origin: "confirmed", approvedAt: time,
  evidenceConditions: { responseFormat: "numeric", timeLimitSeconds: 120, assistance: "independent" },
});
const source = requirement("source");
const target = requirement("target");
const link = { id: "link", sourceRequirementId: source.id, sourceRequirementRevision: 1, targetRequirementId: target.id,
  targetRequirementRevision: 1, stableSkillId: "skill", active: true };
const observation = (id: string, verifiedCorrect: CourseRouteObservation["verifiedCorrect"] = "yes"): CourseRouteObservation => ({
  id, verifiedCorrect, attemptedAt: time, skillLabel: "skill", problemId: id, independentAttempt: "yes",
  assistance: "independent", usableForCurrentVersion: "yes",
  courseRequirement: { id: source.id, revision: 1, stableSkillId: "skill", requirementKey: source.requirementKey },
});
const priorInput = {
  source, target, link, alignmentWeight: 1, edgePrivacyEpoch: 1,
  coursePrivacyEpochs: { [source.courseId]: 1, [target.courseId]: 1 },
  activeCourseSharingEnabled: { [source.courseId]: true, [target.courseId]: true }, revokedSourceIds: new Set<string>(),
};

it("derives a bounded prior from three direct current observations including failed verification", () => {
  const observations = [observation("one"), observation("two"), observation("three", "no")];
  const result = course.deriveSharedCourseWeakPrior({ ...priorInput, observations });
  expect(result).toMatchObject({ isWeakPriorOnly: true, requiresInCourseVerification: true, equivalentObservations: 0.3 });
  expect(result.alpha).toBeCloseTo(1.2);
  expect(result.beta).toBeCloseTo(1.1);
  expect(result.targetInCourseState).toBeUndefined();

  const revoked = course.deriveSharedCourseWeakPrior({ ...priorInput, observations, revokedSourceIds: new Set(["source-source"]) });
  expect(revoked.equivalentObservations).toBe(0);
});

it("does not count already shared, stale, duplicate or assisted observations toward the direct minimum", () => {
  const observations = [
    observation("one"), observation("one"), observation("two", "no"),
    { ...observation("shared"), sharedFor: [{ linkId: "earlier", requirementId: source.id, requirementRevision: 1,
      stableSkillId: "skill", sourceCourseId: "another-course", sourceRequirementId: "earlier" }] },
    { ...observation("stale"), usableForCurrentVersion: "no" as const },
    { ...observation("assisted"), assistance: "hinted" as const },
  ];
  expect(course.deriveSharedCourseWeakPrior({ ...priorInput, observations })).toMatchObject({
    alpha: 1, beta: 1, equivalentObservations: 0, acceptedEdges: [],
  });
});

const owner = { workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId };
const tables = {
  opening_sources: ["keep", "shred", "explicit"].map(id => ({ ...owner, id })),
  opening_conversations: [{ ...owner, id: "conversation" }],
  opening_turns: [
    { ...owner, id: "turn-good", conversation_id: "conversation", source_ids: ["keep"], role: "user" },
    { ...owner, id: "turn-shred", conversation_id: "conversation", source_ids: ["shred"], role: "user" },
    { ...owner, id: "turn-citation", conversation_id: "conversation", source_ids: [], role: "assistant", citations: [{ sourceId: "shred" }] },
  ],
  opening_teaching_activities: [
    { ...owner, id: "activity-good", source_ids: ["keep"] },
    { ...owner, id: "activity-direct", source_ids: ["shred"] },
    { ...owner, id: "activity-turn", source_ids: [], create_intent: { sourceTurnId: "turn-shred" } },
  ],
  opening_learning_observations: [
    { ...owner, id: "observation", source_turn_ids: [], reference_source_id: "shred", outcome: "correct" },
  ],
  opening_learning_attempts: [
    { ...owner, id: "attempt-good", activity_id: "activity-good", source_ids: ["keep"] },
    { ...owner, id: "attempt-direct", activity_id: "activity-good", source_ids: ["explicit"] },
    { ...owner, id: "attempt-activity", activity_id: "activity-direct", source_ids: [] },
    { ...owner, id: "attempt-observation", activity_id: "activity-good", source_ids: [], observation_id: "observation" },
    { ...owner, id: "attempt-version", activity_id: "activity-good", source_ids: [], source_versions: { SHRED: 2 } },
  ],
};
const tombstone = {
  receiptId: "tombstone", workspaceId: scope.workspaceId, target: { kind: "source", sourceId: "shred" },
  issuedAtMs, appendOnlyCompliant: true, immutableAppendOnlyDeletes: [], preservedImmutableTables: [],
  shreddedWorkspaceKeyId: null, shreddedSourceKeyIds: ["key"], shreddedSourceIds: ["shred"],
  preservedWorkspaceKeyId: "workspace-key", preservedSourceKeyIds: [], appliedSubmissionKeys: [], newlyApplied: true,
  privacyEpoch: 7,
} satisfies CryptoShredTombstoneReceipt & { privacyEpoch: number };
const pseudonym = (kind: string, id: string) => `${kind}:${id}`;

it("drops shredded source lineage from all three datasets and advances the owning workspace epoch", () => {
  const result = dataset.projectPrivacyGuardedOpeningDataset({
    scope, tables, privacyEpoch: 3, mode: "solo", role: "instructor", shreddedSourceIds: ["explicit"],
    tombstoneReceipts: [tombstone, { ...tombstone, workspaceId: "foreign", shreddedSourceIds: ["keep"], privacyEpoch: 99 }],
  }, pseudonym);
  expect(result.cohortPolicy.cohortSurfaceVisible).toBe(false);
  expect(result.dataset.privacyEpoch).toBe(7);
  expect(result.dataset.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:turn-good"]);
  expect(result.dataset.coursePackageQuality.map(row => row.identity)).toEqual(["activity:activity-good"]);
  expect(result.dataset.answerSequences.map(row => row.identity)).toEqual(["attempt:attempt-good"]);
});

it("keeps an existing higher privacy epoch and applies the cohort viewer policy", () => {
  const input = { scope, tables, privacyEpoch: 9, mode: "cohort" as const, tombstoneReceipts: [tombstone] };
  expect(dataset.projectPrivacyGuardedOpeningDataset({ ...input, role: "learner" }, pseudonym))
    .toMatchObject({ dataset: { privacyEpoch: 9 }, cohortPolicy: { cohortSurfaceVisible: false } });
  expect(dataset.projectPrivacyGuardedOpeningDataset({ ...input, role: "instructor" }, pseudonym).cohortPolicy.cohortSurfaceVisible).toBe(true);
});

it.each([{ sourceIds: [] }, { sourceIds: ["keep", "shred", "explicit"] }])("empties all projections for a workspace shred with source IDs $sourceIds", ({ sourceIds }) => {
  const result = dataset.projectPrivacyGuardedOpeningDataset({
    scope, privacyEpoch: 3, role: "instructor", mode: "cohort",
    tables: { ...tables, opening_turns: [...tables.opening_turns,
      { ...owner, id: "turn-source-free", conversation_id: "conversation", source_ids: [], role: "assistant" }] },
    tombstoneReceipts: [tombstone, { ...tombstone, target: { kind: "workspace" },
      shreddedSourceIds: sourceIds, shreddedWorkspaceKeyId: "workspace-key", preservedWorkspaceKeyId: null, privacyEpoch: 8 }],
  }, () => { throw new Error("Shredded records cannot reach pseudonymization"); });
  expect(result.dataset).toEqual({ version: 1, privacyEpoch: 8, dialogueEvaluation: [], answerSequences: [], coursePackageQuality: [] });
  expect(result.cohortPolicy.cohortSurfaceVisible).toBe(true);
});

it("applies an uppercase workspace tombstone even without source IDs", () => {
  const workspaceId = "abcdef12-3456-4789-abcd-ef1234567890";
  const workspaceOwner = { ...owner, workspace_id: workspaceId };
  const result = dataset.projectPrivacyGuardedOpeningDataset({
    scope: { ...scope, workspaceId }, privacyEpoch: 3, mode: "solo", role: "learner",
    shreddedSourceIds: [],
    tombstoneReceipts: [{ ...tombstone, workspaceId: workspaceId.toUpperCase(), target: { kind: "workspace" },
      shreddedSourceIds: [], shreddedSourceKeyIds: [], shreddedWorkspaceKeyId: "workspace-key", preservedWorkspaceKeyId: null }],
    tables: {
      opening_conversations: [{ ...workspaceOwner, id: "conversation" }],
      opening_turns: [{ ...workspaceOwner, id: "turn-source-free", conversation_id: "conversation", source_ids: [], role: "user" }],
      opening_teaching_activities: [{ ...workspaceOwner, id: "activity", source_ids: [] }],
      opening_learning_attempts: [{ ...workspaceOwner, id: "attempt", activity_id: "activity", source_ids: [] }],
    },
  }, pseudonym);
  expect(result.dataset).toEqual({ version: 1, privacyEpoch: 7, dialogueEvaluation: [], answerSequences: [], coursePackageQuality: [] });
});

it.each([
  { lineage: "camelCase spec ref", specRefs: [{ sourceId: "shred" }], unitRefs: [] },
  { lineage: "snake_case spec ref", specRefs: [{ source_id: " SHRED " }], unitRefs: [] },
  { lineage: "string spec ref", specRefs: [" SHRED "], unitRefs: [] },
  { lineage: "teaching unit ref", specRefs: [], unitRefs: [{ sourceId: " SHRED " }] },
])("excludes a published activity and its source-free dialogue via a $lineage", ({ specRefs, unitRefs }) => {
  const result = dataset.projectPrivacyGuardedOpeningDataset({
    scope, privacyEpoch: 3, mode: "solo", role: "learner", tombstoneReceipts: [tombstone],
    tables: {
      ...tables,
      opening_teaching_units: [{ ...owner, workspace_id: " WORKSPACE ", id: "unit", source_refs: unitRefs }],
      opening_teaching_activity_specs: [
        { ...owner, workspace_id: " WORKSPACE ", activity_id: " ACTIVITY-PUBLISHED ", teaching_unit_id: " UNIT ", source_refs: specRefs },
        { ...owner, workspace_id: "foreign", activity_id: "activity-good", source_refs: ["shred"] },
      ],
      opening_teaching_activities: [...tables.opening_teaching_activities, { ...owner, id: "activity-published", source_ids: [] }],
      opening_learning_sessions: [{ ...owner, id: "session-published", activity_id: "activity-published" }],
      opening_turns: [...tables.opening_turns, {
        ...owner, id: "turn-published", conversation_id: "conversation", learning_session_id: "session-published", source_ids: [], role: "user",
      }],
    },
  }, pseudonym);
  expect(result.dataset).toMatchObject({
    coursePackageQuality: [{ identity: "activity:activity-good" }],
    dialogueEvaluation: [{ identity: "turn:turn-good" }],
  });
});

it("starts lineage from scoped exclusions and follows chunk links with canonical IDs", () => {
  const result = dataset.projectPrivacyGuardedOpeningDataset({
    scope, privacyEpoch: 3, mode: "solo", role: "learner",
    tables: {
      opening_privacy_exclusions: [{ workspace_id: " WORKSPACE ", source_id: " SHRED " }, { workspace_id: "foreign", source_id: "keep" }],
      opening_sources: [{ ...owner, workspace_id: "WORKSPACE", id: "keep" }, { ...owner, id: "SHRED" }],
      opening_source_chunks: [{ id: "chunk", source_id: "Shred" }],
      opening_conversations: [{ workspace_id: " WORKSPACE ", owner_user_id: " LEARNER ", id: "conversation" }],
      opening_turns: [
        { ...owner, id: "turn-keep", conversation_id: "conversation", source_ids: [" KEEP "], role: "user" },
        { ...owner, id: "turn-shred", conversation_id: "conversation", source_ids: ["SHRED"], role: "user" },
        { ...owner, id: "turn-chunk", conversation_id: "conversation", chunk_id: " CHUNK ", source_ids: [], role: "user" },
      ],
      opening_learning_item_versions: [{ ...owner, workspace_id: " WORKSPACE ", id: "item", chunk_id: " CHUNK " }],
      opening_teaching_activities: [{ ...owner, id: "activity", source_ids: [" KEEP "] }],
      opening_learning_attempts: [
        { ...owner, id: "attempt-keep", activity_id: "activity", source_ids: ["KEEP"] },
        { ...owner, id: "attempt-item", activity_id: "activity", item_version_id: " ITEM ", source_ids: [] },
      ],
    },
  }, pseudonym);
  expect(result.dataset.privacyEpoch).toBe(3);
  expect(result.dataset.dialogueEvaluation).toMatchObject([{ identity: "turn:turn-keep", sources: ["source:keep"] }]);
  expect(result.dataset.coursePackageQuality).toMatchObject([{ identity: "activity:activity", sources: ["source:keep"] }]);
  expect(result.dataset.answerSequences).toMatchObject([{ identity: "attempt:attempt-keep", sources: ["source:keep"] }]);
});

it("excludes a deleted turn and attempts created from it with case-insensitive IDs", () => {
  const result = dataset.projectPrivacyGuardedOpeningDataset({
    scope, privacyEpoch: 3, mode: "solo", role: "learner", deletedTurnIds: [" TURN-DELETED "],
    tables: {
      ...tables,
      opening_turns: [...tables.opening_turns, { ...owner, id: "turn-deleted", conversation_id: "conversation", source_ids: [], role: "user" }],
      opening_learning_attempts: [...tables.opening_learning_attempts, {
        ...owner, id: "attempt-from-turn", activity_id: "activity-good", source_ids: [], create_intent: { sourceTurnId: "TURN-DELETED" },
      }],
    },
  }, pseudonym);
  expect(result.dataset.dialogueEvaluation.map(row => row.identity)).not.toContain("turn:turn-deleted");
  expect(result.dataset.answerSequences.map(row => row.identity)).not.toContain("attempt:attempt-from-turn");
  expect(result.dataset.answerSequences.map(row => row.identity)).toContain("attempt:attempt-good");
});

it("follows source lineage from source-free turns through derived activities, observations, and attempts", () => {
  const sourceFreeTurn = (id: string, refs: object = {}) => ({
    ...owner, id, conversation_id: "conversation", source_ids: [], role: "user", ...refs,
  });
  const result = dataset.projectPrivacyGuardedOpeningDataset({
    scope, privacyEpoch: 3, mode: "solo", role: "learner",
    tombstoneReceipts: [tombstone, { ...tombstone, workspaceId: "foreign", target: { kind: "workspace" }, privacyEpoch: 99 }],
    tables: {
      ...tables,
      opening_learning_sessions: [{ ...owner, id: "session-shred", source_ids: ["shred"] }],
      opening_learning_item_versions: [{ ...owner, id: "item-shred", source_id: "shred" }],
      opening_turns: [
        ...tables.opening_turns, sourceFreeTurn("turn-source-free"),
        sourceFreeTurn("turn-session", { learning_session_id: "SESSION-SHRED" }),
        sourceFreeTurn("turn-session-anchor", { context_anchor: { sessionId: "session-shred" } }),
        sourceFreeTurn("turn-activity", { teaching_activity_id: "activity-direct" }),
        sourceFreeTurn("turn-activity-anchor", { context_anchor: { activityId: "activity-direct" } }),
        sourceFreeTurn("turn-source-anchor", { context_anchor: { sourceId: "shred" } }),
        sourceFreeTurn("turn-attempt", { attempt_id: "attempt-version" }),
        sourceFreeTurn("turn-item-attempt", { context_anchor: { attemptId: "attempt-item" } }),
        sourceFreeTurn("turn-observation-attempt", { attempt_id: "attempt-observation" }),
        sourceFreeTurn("turn-derived-attempt", { attempt_id: "attempt-derived-observation" }),
      ],
      opening_teaching_activities: [...tables.opening_teaching_activities,
        { ...owner, id: "activity-derived", source_ids: [], create_intent: { sourceTurnId: "turn-session" } }],
      opening_learning_observations: [...tables.opening_learning_observations,
        { ...owner, id: "observation-derived", source_turn_ids: ["turn-session-anchor"], outcome: "correct" }],
      opening_learning_attempts: [...tables.opening_learning_attempts,
        { ...owner, id: "attempt-item", activity_id: "activity-good", item_version_id: "item-shred", source_ids: [] },
        { ...owner, id: "attempt-derived-activity", activity_id: "activity-derived", source_ids: [] },
        { ...owner, id: "attempt-derived-observation", activity_id: "activity-good", observation_id: "observation-derived", source_ids: [] }],
    },
  }, pseudonym);
  expect(result.dataset.privacyEpoch).toBe(7);
  expect(result.dataset.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:turn-good", "turn:turn-source-free"]);
  expect(result.dataset.coursePackageQuality.map(row => row.identity)).toEqual(["activity:activity-good"]);
  expect(result.dataset.answerSequences.map(row => row.identity)).toEqual(["attempt:attempt-direct", "attempt:attempt-good"]);
});

it("admits a verified speech receipt only in a configured rubric section and strips transcript material", () => {
  const receipt = issueSpeechTimingReceipt({
    receiptId: "speaking-receipt", issuedAtMs, totalOriginalDurationMs: 2000,
    voicedSegments: [{ originalStartMs: 200, originalEndMs: 1500, strippedStartMs: 0, strippedEndMs: 1300 }],
    words: [{ word: "private-word", startMs: 0, endMs: 1000 }],
  });
  const input = { blueprint: forecast.IELTS_ACADEMIC_V1_BLUEPRINT, learnerId: scope.ownerUserId, receipt, verified: true, assisted: false };
  const speaking = forecast.toExamSprintSpeechTimingEvidence({ ...input, sectionId: "speaking" });
  expect(speaking).toMatchObject({ evidenceKind: "speech_timing", sectionId: "speaking", countsTowardMastery: true,
    speechTimingReceipt: { receiptId: "speaking-receipt", durationSeconds: 2, speechRateWpm: 30, calibrated: true } });
  expect(JSON.stringify(speaking)).not.toContain("private-word");
  expect(forecast.toExamSprintSpeechTimingEvidence({ ...input, sectionId: "reading" })).toBeNull();
  expect(forecast.toExamSprintSpeechTimingEvidence({ ...input, sectionId: "speaking", verified: false })).toBeNull();
});
