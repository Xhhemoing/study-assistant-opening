import type { CourseRequirement } from "@aistudy/contracts";
import * as course from "@aistudy/domain/opening/course-shared-skill";
import * as dataset from "@aistudy/domain/opening/deidentified-dataset";
import * as forecast from "@aistudy/domain/opening/exam-sprint/score-forecast-bridge";
import { issueReviewQueueOfflineLease, reconcileReviewQueueOfflineOutbox } from "@aistudy/domain/srs/offline-lease-bridge";
import { describe, expect, it } from "vitest";
import { isIndependentExamEvidence } from "../exam-forecast/simulator";
import { issueSpeechTimingReceipt } from "../multimodal-evidence";
import { createInitialOfflineFsrsSnapshot } from "../offline-companion-bridge";
import type { CryptoShredTombstoneReceipt } from "../resilience-canary-shredding";
import * as srs from "../srs/eligibility";
import type { CourseRouteObservation } from "./course-route";

const issuedAtMs = 10_000;
const time = new Date(issuedAtMs).toISOString();
const scope = { workspaceId: "workspace", ownerUserId: "learner" };
const shreddedSourceId = "abcdef12-3456-4789-abcd-ef1234567895";
const existingChunkId = "abcdef12-3456-4789-abcd-ef1234567896";
const absentChunkId = "abcdef12-3456-4789-abcd-ef1234567897";
const foreignChunkId = "abcdef12-3456-4789-abcd-ef1234567898";
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
  opening_sources: ["keep", "shred", "explicit", shreddedSourceId].map(id => ({ ...owner, id })),
  opening_conversations: [{ ...owner, id: "conversation" }],
  opening_turns: [
    { ...owner, id: "turn-good", conversation_id: "conversation", source_ids: ["keep"], role: "user" },
    { ...owner, id: "turn-shred", conversation_id: "conversation", source_ids: ["shred"], role: "user" },
    { ...owner, id: "turn-citation", conversation_id: "conversation", source_ids: [], role: "assistant", context_source_refs: [],
      citations: [{ sourceId: shreddedSourceId, sourceVersion: 2, chunkId: existingChunkId }] },
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
    { ...owner, id: "attempt-version", activity_id: "activity-good", source_ids: [], source_versions: { [shreddedSourceId.toUpperCase()]: 2 } },
  ],
};
const tombstone = {
  receiptId: "tombstone", workspaceId: scope.workspaceId, target: { kind: "source", sourceId: "shred" },
  issuedAtMs, appendOnlyCompliant: true, immutableAppendOnlyDeletes: [], preservedImmutableTables: [],
  shreddedWorkspaceKeyId: null, shreddedSourceKeyIds: ["key"], shreddedSourceIds: ["shred", shreddedSourceId],
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
      opening_source_chunks: [{ id: existingChunkId, source_id: "Shred" }],
      opening_conversations: [{ workspace_id: " WORKSPACE ", owner_user_id: " LEARNER ", id: "conversation" }],
      opening_turns: [
        { ...owner, id: "turn-keep", conversation_id: "conversation", source_ids: [" KEEP "], role: "user" },
        { ...owner, id: "turn-shred", conversation_id: "conversation", source_ids: ["SHRED"], role: "user" },
        { ...owner, id: "turn-chunk", conversation_id: "conversation", chunk_id: ` ${existingChunkId.toUpperCase()} `, source_ids: [], role: "user" },
      ],
      opening_learning_item_versions: [{ ...owner, workspace_id: " WORKSPACE ", id: "item", chunk_id: ` ${existingChunkId.toUpperCase()} ` }],
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
        sourceFreeTurn("abcdef12-3456-4789-abcd-ef1234567918", { context_anchor: { sessionId: "session-shred" } }),
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
        { ...owner, id: "observation-derived", source_turn_ids: ["abcdef12-3456-4789-abcd-ef1234567918"], outcome: "correct" }],
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

describe("persisted dataset provenance", () => {
  const memoryId = "abcdef12-3456-4789-abcd-ef1234567890";
  const upstreamId = "abcdef12-3456-4789-abcd-ef1234567891";
  const missingTurnId = "abcdef12-3456-4789-abcd-ef1234567892";
  const knownSourceId = "abcdef12-3456-4789-abcd-ef1234567893";
  const missingSourceId = "abcdef12-3456-4789-abcd-ef1234567894";
  const memoryRefs = [{ memoryDependencyIds: [memoryId.toUpperCase()] }];
  const turn = (id: string, links: Record<string, unknown> = {}) => ({
    ...owner, id, conversation_id: "conversation", source_ids: [], role: "assistant", context_source_refs: [], ...links,
  });
  const activity = (id: string) => ({ ...owner, id, source_ids: [] });
  const project = (
    lineage: dataset.OpeningDatasetProjectionInput["tables"],
    privacy: Pick<dataset.PrivacyGuardedOpeningDatasetInput, "deletedTurnIds" | "tombstoneReceipts"> = {},
  ) => dataset.projectPrivacyGuardedOpeningDataset({
    scope, privacyEpoch: 3, mode: "solo", role: "learner", nowMs: issuedAtMs, ...privacy,
    tables: { opening_conversations: tables.opening_conversations, ...lineage },
  }, pseudonym).dataset;

  const boundBlock = { content: { citationBinding: { sourceId: ` ${shreddedSourceId.toUpperCase()} ` } } };
  it.each([
    { origin: "republished note provenance", lineage: {
      opening_note_provenance: [{ ...owner, document_id: " DOCUMENT ", context_source_refs: [{ sourceId: shreddedSourceId, sourceVersion: 1 }] }],
    } },
    { origin: "library document deletion", lineage: {
      library_documents: [{ ...owner, id: "document", deleted_at: time }],
    } },
    { origin: "live library block citation", lineage: {
      library_blocks: [{ ...owner, document_id: "document", ...boundBlock }],
    } },
    { origin: "saved library block citation", lineage: {
      library_revisions: [{ ...owner, id: "revision", document_id: "document", blocks: [
        { content: { citationBinding: { refs: [{ sourceId: shreddedSourceId, sourceVersion: 1, chunkId: existingChunkId }] } } },
      ] }],
    } },
    { origin: "legacy revision snapshot citation", lineage: {
      library_revisions: [{ id: "revision", document_id: "document", blocks_snapshot: [boundBlock] }],
    } },
  ] satisfies { origin: string; lineage: dataset.OpeningDatasetProjectionInput["tables"] }[])(
    "excludes teaching projections via $origin", ({ origin, lineage }) => {
      const result = project({
        ...lineage,
        opening_teaching_units: [
          { ...owner, id: "unit", document_id: "document" },
          { ...owner, id: "other-unit", document_id: "other-document" },
        ],
        opening_teaching_activity_specs: [
          { ...owner, activity_id: "through-unit", teaching_unit_id: "unit", document_id: "other-document" },
          { ...owner, activity_id: "through-spec", teaching_unit_id: "other-unit", document_id: "document" },
          { ...owner, activity_id: "keep", teaching_unit_id: "other-unit", document_id: "other-document" },
        ],
        opening_teaching_activities: ["through-unit", "through-spec", "keep"].map(activity),
        opening_learning_sessions: ["through-unit", "through-spec"].map(id => ({ ...owner, id, activity_id: id })),
        opening_turns: [turn("through-unit", { learning_session_id: "through-unit" }),
          turn("through-spec", { learning_session_id: "through-spec" }), turn("keep")],
      }, origin === "library document deletion" ? {} : { tombstoneReceipts: [tombstone] });
      expect(result.coursePackageQuality.map(row => row.identity)).toEqual(["activity:keep"]);
      expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
    },
  );

  const published = {
    opening_teaching_units: [{ ...owner, id: "published-unit", document_id: "document" }],
    opening_teaching_activity_specs: [{ ...owner, activity_id: "published", teaching_unit_id: "published-unit" }],
    opening_teaching_activities: [activity("published")],
    opening_learning_sessions: [{ ...owner, id: "published-session", activity_id: "published" }],
    opening_learning_attempts: [{ ...owner, id: "published", activity_id: "published", source_ids: [] }],
  };
  const publishedTurn = turn("published", { learning_session_id: "published-session" });

  it.each([false, true])("excludes card-review variants through unavailable lineage (malformed publication: %s)", malformed => {
    const restoredId = "abcdef12-3456-4789-abcd-ef1234567895";
    const historicalId = "abcdef12-3456-4789-abcd-ef1234567896";
    const observationId = "abcdef12-3456-4789-abcd-ef1234567897";
    const card = (suffix: number, links: Record<string, unknown> = {}) => ({
      ...owner, id: "abcdef12-3456-4789-abcd-ef12345679" + suffix, source_ids: [knownSourceId], ...links,
    });
    const restored = card(10, { source_document_id: restoredId });
    const historical = card(11);
    const deleted = card(12);
    const clean = card(13);
    const automatic = card(14, { origin_observation_root_id: observationId });
    const names = ["restored", "historical", "deleted", "clean", "automatic", "no-card"];
    const cardIds = [restored.id.toUpperCase(), historical.id, deleted.id, clean.id, automatic.id, undefined];
    const result = project({
      cards: [restored, historical, clean, automatic],
      opening_sources: [{ ...owner, id: knownSourceId }],
      library_documents: [{ ...owner, id: restoredId }, { ...owner, id: historicalId }],
      library_revisions: [{ ...owner, document_id: restoredId, revision_number: 1, reason: "save-opening-snippet" }],
      opening_note_provenance: [{ ...owner, document_id: historicalId, context_source_refs: [{
        publicationCardIds: malformed ? [historical.id, "bad"] : [historical.id],
      }] }],
      opening_learning_observations: [{ ...owner, id: observationId, source_ids: [missingSourceId] }],
      opening_teaching_activities: names.map((id, index) => ({
        ...activity(id), create_intent: { kind: "card_review_variant", cardId: cardIds[index] },
      })),
      opening_learning_sessions: names.map(id => ({ ...owner, id, activity_id: id })),
      opening_learning_attempts: names.map(id => ({ ...owner, id, activity_id: id, session_id: id, source_ids: [] })),
      opening_turns: names.map(id => turn(id, { learning_session_id: id })),
    });
    expect(result.coursePackageQuality.map(row => row.identity)).toEqual(["activity:clean"]);
    expect(result.answerSequences.map(row => row.identity)).toEqual(["attempt:clean"]);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:clean"]);
  });

  it.each([
    { inventory: "cards", cardLineage: null },
    { inventory: "documents", cardLineage: { source_document_id: upstreamId } },
    { inventory: "observations", cardLineage: { origin_observation_root_id: upstreamId } },
  ])("withholds a card variant and anchored turn when the $inventory inventory is omitted", ({ cardLineage }) => {
    const cardId = "abcdef12-3456-4789-abcd-ef1234567915";
    const result = project({
      ...(cardLineage && { cards: [{ ...owner, id: cardId, ...cardLineage }] }),
      opening_teaching_activities: [
        { ...activity("variant"), create_intent: { kind: "card_review_variant", cardId } }, activity("keep"),
      ],
      opening_learning_attempts: [{ ...owner, id: "variant", activity_id: "variant", source_ids: [] }],
      opening_turns: [turn("anchored", { context_anchor: { cardId } }), turn("keep")],
    });
    expect(result.coursePackageQuality.map(row => row.identity)).toEqual(["activity:keep"]);
    expect(result.answerSequences).toEqual([]);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
  });

  const variantCardId = "abcdef12-3456-4789-abcd-ef1234567916";
  const publishedDocumentId = "abcdef12-3456-4789-abcd-ef1234567917";
  const variantRows = {
    cards: [{ ...owner, id: variantCardId }],
    opening_teaching_activities: [
      { ...activity("variant"), create_intent: { kind: "card_review_variant", cardId: variantCardId } }, activity("keep"),
    ],
    opening_learning_attempts: [{ ...owner, id: "variant", activity_id: "variant", source_ids: [] }],
    opening_turns: [turn("anchored", { context_anchor: { cardId: variantCardId } }), turn("keep")],
  };
  const expectVariantExcluded = (result: ReturnType<typeof project>) => {
    expect(result.coursePackageQuality.map(row => row.identity)).toEqual(["activity:keep"]);
    expect(result.answerSequences).toEqual([]);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
  };

  it.each([
    { kind: "omitted", docs: undefined },
    { kind: "empty", docs: [] },
    { kind: "deleted", docs: [{ ...owner, id: publishedDocumentId, deleted_at: time }] },
    { kind: "foreign", docs: [{ ...owner, id: publishedDocumentId, owner_user_id: "foreign" }] },
    { kind: "shredded", docs: [{ ...owner, id: publishedDocumentId, source_ids: [shreddedSourceId] }] },
  ])("withholds historical card publications when the document inventory is $kind", ({ docs }) => {
    const lineage = {
      ...variantRows,
      opening_note_provenance: [{ ...owner, document_id: publishedDocumentId, snippet_origin: false,
        context_source_refs: [{ publicationCardIds: [variantCardId] }] }],
    };
    const eligible = project({ ...lineage, library_documents: [{ ...owner, id: publishedDocumentId }] });
    expect(eligible.coursePackageQuality.map(row => row.identity)).toEqual(["activity:variant", "activity:keep"]);
    expect(eligible.answerSequences.map(row => row.identity)).toEqual(["attempt:variant"]);
    expect(eligible.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:anchored", "turn:keep"]);
    expectVariantExcluded(project({ ...lineage, ...(docs && { library_documents: docs }) }, { tombstoneReceipts: [tombstone] }));
  });

  it.each([
    { kind: "scalar", refs: [{ publicationCardIds: variantCardId }] },
    { kind: "mixed array", refs: [{ publicationCardIds: ["bad", { id: variantCardId }] }] },
    { kind: "nested array", refs: [{ publicationCardIds: [[variantCardId]] }] },
    { kind: "non-array provenance", refs: { publicationCardIds: [variantCardId] } },
  ])("withholds cards identified in malformed $kind publication metadata", ({ refs }) => {
    expectVariantExcluded(project({
      ...variantRows,
      library_documents: [{ ...owner, id: publishedDocumentId }],
      opening_note_provenance: [{ ...owner, document_id: publishedDocumentId, snippet_origin: false, context_source_refs: refs }],
    }));
  });

  it.each([undefined, null])("withholds a card whose owner is %s", owner_user_id => {
    expectVariantExcluded(project({ ...variantRows, cards: [{ ...variantRows.cards[0], owner_user_id }] }));
  });

  const observationVariant: dataset.OpeningDatasetProjectionInput["tables"] = {
    ...variantRows,
    cards: [{ ...variantRows.cards[0], origin_observation_root_id: upstreamId }],
  };
  const ownedOrigin = { ...owner, id: upstreamId, source_turn_ids: [] };

  it("withholds a card and all observation dependents when the origin belongs to another owner", () => {
    expectVariantExcluded(project({
      ...observationVariant,
      opening_learning_observations: [{ ...ownedOrigin, owner_user_id: "foreign" }],
      opening_learning_attempts: [...observationVariant.opening_learning_attempts,
        { ...owner, id: "foreign-origin", activity_id: "keep", observation_id: upstreamId, source_ids: [] }],
      opening_turns: [...observationVariant.opening_turns, turn("foreign-origin", { attempt_id: "foreign-origin" })],
    }));
  });

  it.each([
    { field: "root_observation_id", value: missingTurnId },
    { field: "revises_observation_id", value: missingTurnId },
    { field: "effective_head_id", value: missingTurnId },
    { field: "effective_head_id", value: "malformed" },
    { field: "source_turn_ids", value: [missingTurnId] },
    { field: "source_turn_ids", value: [false] },
    { field: "source_turn_ids", value: missingTurnId },
    { field: "source_turn_ids", value: null },
  ])("withholds a card when its origin declares unavailable $field at $value", ({ field, value }) => {
    expectVariantExcluded(project({
      ...observationVariant,
      opening_learning_observations: [{ ...ownedOrigin, [field]: value }],
    }));
  });

  it.each([
    { field: "session_id", table: "opening_learning_sessions" },
    { field: "activity_id", table: "opening_teaching_activities" },
    { field: "item_version_id", table: "opening_learning_item_versions" },
    { field: "attempt_id", table: "opening_learning_attempts" },
    { field: "problem_id", table: "opening_problem_refs" },
    { field: "teaching_revision_id", table: "library_revisions" },
  ])("withholds a card when its origin's $field is missing from the supplied table", ({ field, table }) => {
    expectVariantExcluded(project({
      ...observationVariant,
      [table]: observationVariant[table] ?? [],
      opening_learning_observations: [{ ...ownedOrigin, [field]: missingTurnId }],
    }));
  });

  it("keeps a card backed by a complete owned observation chain", () => {
    const result = project({
      ...observationVariant,
      opening_learning_observations: [
        { ...ownedOrigin, effective_head_id: missingSourceId.toUpperCase() },
        { ...ownedOrigin, id: missingSourceId, root_observation_id: upstreamId, revises_observation_id: upstreamId,
          source_turn_ids: [knownSourceId.toUpperCase()] },
      ],
      opening_turns: [...observationVariant.opening_turns, turn(knownSourceId)],
    });
    expect(result.coursePackageQuality.map(row => row.identity)).toEqual(["activity:variant", "activity:keep"]);
    expect(result.answerSequences.map(row => row.identity)).toEqual(["attempt:variant"]);
    expect(result.dialogueEvaluation.map(row => row.identity)).toContain("turn:anchored");
  });

  it("withholds a root observation and linked card when a revision in the chain loses its turn", () => {
    expectVariantExcluded(project({
      ...observationVariant,
      opening_learning_observations: [
        ownedOrigin,
        { ...ownedOrigin, id: missingSourceId, root_observation_id: upstreamId, revises_observation_id: upstreamId,
          source_turn_ids: [missingTurnId] },
      ],
    }));
  });

  it("withholds an unattributed legacy memory-only turn and its derived records", () => {
    const source = { sourceId: knownSourceId, sourceVersion: 0, memoryOnly: true };
    const result = project({
      ...published,
      opening_sources: [{ ...owner, id: knownSourceId }],
      opening_memories: [{ ...owner, id: memoryId, kind: "temporary", status: "active",
        expires_at: time, source_turn_ids: [upstreamId] }],
      opening_teaching_activities: [{ ...activity("published"), create_intent: { sourceTurnId: missingTurnId } }],
      opening_turns: [turn(upstreamId, { role: "user", source_ids: [knownSourceId] }),
        turn(missingTurnId, { context_source_refs: [source] }), publishedTurn],
    });
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual([`turn:${upstreamId}`]);
    expect(result.coursePackageQuality).toEqual([]);
    expect(result.answerSequences).toEqual([]);
  });

  it("withholds derivatives when the first revision identifies a snippet with missing provenance", () => {
    const result = project({
      ...published,
      library_revisions: [{ ...owner, id: "revision", document_id: "document", revision_number: 1, reason: "save-opening-snippet" }],
      opening_turns: [publishedTurn, turn("keep")],
    });
    expect(result.coursePackageQuality).toEqual([]);
    expect(result.answerSequences).toEqual([]);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
  });

  it.each([true, null])("withholds source-only snippet derivatives when snippet origin is %s", snippet_origin => {
    const result = project({
      ...published,
      opening_sources: [{ ...owner, id: knownSourceId }],
      opening_note_provenance: [{ document_id: "document", snippet_origin,
        context_source_refs: [{ sourceId: knownSourceId, sourceVersion: 0 }] }],
      opening_turns: [publishedTurn],
    });
    expect(result.coursePackageQuality).toEqual([]);
    expect(result.answerSequences).toEqual([]);
    expect(result.dialogueEvaluation).toEqual([]);
  });

  it("exports an ordinary source-free teaching publication with only answer-key metadata", () => {
    const result = project({
      ...published,
      opening_note_provenance: [{ document_id: "document", snippet_origin: false,
        context_source_refs: [{ answerKeyBlockIds: [upstreamId] }] }],
      opening_turns: [publishedTurn],
    });
    expect(result.coursePackageQuality.map(row => row.identity)).toEqual(["activity:published"]);
    expect(result.answerSequences.map(row => row.identity)).toEqual(["attempt:published"]);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:published"]);
  });

  it.each([
    { label: "legacy empty lineage without an origin", originId: null, originRefs: [], visible: false },
    { label: "origin missing from the inventory", originId: missingTurnId, originRefs: [], visible: false },
    { label: "origin using an expired memory", originId: upstreamId, originRefs: memoryRefs, visible: false },
    { label: "origin with explicit empty lineage", originId: upstreamId, originRefs: [], visible: true },
  ])("checks a republished note with $label", ({ originId, originRefs, visible }) => {
    const result = project({
      ...published,
      opening_memories: [{ ...owner, id: memoryId, kind: "temporary", status: "active", expires_at: time, source_turn_ids: [missingSourceId] }],
      opening_note_provenance: [{ document_id: "document", origin_turn_id: originId, context_source_refs: [] }],
      opening_turns: [turn(upstreamId, { context_source_refs: originRefs }), turn(missingSourceId, { role: "user" }), publishedTurn],
    });
    expect(result.coursePackageQuality.map(row => row.identity)).toEqual(visible ? ["activity:published"] : []);
    expect(result.answerSequences.map(row => row.identity)).toEqual(visible ? ["attempt:published"] : []);
    expect(result.dialogueEvaluation.some(row => row.identity === "turn:published")).toBe(visible);
    expect(result.dialogueEvaluation.some(row => row.identity === `turn:${missingSourceId}`)).toBe(true);
  });

  it("checks the origin's paired user and earlier exchanges for legacy note lineage", () => {
    const user = "abcdef12-3456-4789-abcd-ef1234567895";
    const prior = "abcdef12-3456-4789-abcd-ef1234567896";
    const result = project({
      ...published,
      opening_memories: [{ ...owner, id: memoryId, kind: "temporary", status: "active", expires_at: time, source_turn_ids: [missingSourceId] }],
      opening_note_provenance: [{ document_id: "document", origin_turn_id: upstreamId, context_source_refs: [] }],
      opening_turns: [
        turn(missingSourceId, { role: "user", context_source_refs: memoryRefs }), turn(prior),
        turn(user, { role: "user" }), turn(upstreamId), publishedTurn,
      ],
      opening_tutor_jobs: [
        { ...owner, conversation_id: "conversation", user_turn_id: user, assistant_turn_id: upstreamId,
          history_position: 2, consumable_history: true },
        { ...owner, conversation_id: "conversation", user_turn_id: missingSourceId, assistant_turn_id: prior,
          history_position: 1, consumable_history: true },
      ],
    });
    expect(result.coursePackageQuality).toEqual([]);
    expect(result.answerSequences).toEqual([]);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual([`turn:${user}`]);
  });

  it.each([{ chunkId: absentChunkId }, { keyframeChunkId: absentChunkId }])(
    "excludes publication, turn, and attempt selections of absent chunks ($chunkId $keyframeChunkId)", selection => {
      const source = { sourceId: knownSourceId, version: 1 };
      const anchor = { sourceId: knownSourceId, chunkId: absentChunkId };
      const result = project({
        ...published,
        opening_sources: [{ ...owner, id: knownSourceId }],
        opening_source_chunks: [{ id: existingChunkId, source_id: knownSourceId }],
        opening_teaching_activity_specs: [{ ...published.opening_teaching_activity_specs[0], source_refs: [{ ...source, ...selection }] }],
        opening_teaching_activities: [...published.opening_teaching_activities, activity("keep")],
        opening_learning_attempts: [...published.opening_learning_attempts,
          { ...owner, id: "anchored", activity_id: "keep", source_ids: [], context_anchor: anchor },
          { ...owner, id: "keep", activity_id: "keep", source_ids: [], context_anchor: { ...anchor, chunkId: existingChunkId } }],
        opening_turns: [publishedTurn, turn("anchored", { chunk_id: null, context_anchor: anchor }),
          turn("keep", { context_anchor: { ...anchor, chunkId: existingChunkId } })],
      });
      expect(result.coursePackageQuality.map(row => row.identity)).toEqual(["activity:keep"]);
      expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
      expect(result.answerSequences.map(row => row.identity)).toEqual(["attempt:keep"]);
    },
  );

  it.each([
    { reason: "superseded", fields: { status: "superseded" }, visible: false },
    { reason: "rejected", fields: { status: "rejected" }, visible: false },
    { reason: "course-scoped", fields: { course_id: "course" }, visible: false },
    { reason: "expired", fields: { kind: "temporary", expires_at: time }, visible: false },
    { reason: "unexpired", fields: { kind: "temporary", expires_at: new Date(issuedAtMs + 1) }, visible: true },
  ])("checks a $reason memory without excluding its source turn", ({ fields, visible }) => {
    const result = project({
      ...published,
      opening_memories: [{ ...owner, id: memoryId, kind: "confirmed", status: "active", source_turn_ids: [upstreamId], ...fields }],
      opening_note_provenance: [{ document_id: "document", context_source_refs: [...memoryRefs, { snippetLineageVersion: 1 }] }],
      opening_turns: [turn(upstreamId, { role: "user" }), turn("consumer", { context_source_refs: memoryRefs }), publishedTurn],
    });
    expect(result.coursePackageQuality.map(row => row.identity)).toEqual(visible ? ["activity:published"] : []);
    expect(result.answerSequences.map(row => row.identity)).toEqual(visible ? ["attempt:published"] : []);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(visible
      ? [`turn:${upstreamId}`, "turn:consumer", "turn:published"] : [`turn:${upstreamId}`]);
  });

  it("excludes turn source pins outside the inventory and malformed version maps", () => {
    const result = project({
      opening_sources: [{ ...owner, id: knownSourceId }],
      opening_turns: [
        turn("missing-pin", { role: "user", source_versions: { [missingSourceId]: 1 } }),
        turn("missing-anchor", { role: "user", context_anchor: { sourceId: missingSourceId } }),
        turn("array-pin", { role: "user", source_versions: [] }),
        turn("negative-pin", { role: "user", source_versions: { [knownSourceId]: -1 } }),
        turn("malformed-key", { role: "user", source_versions: { "not-a-uuid": 1 } }),
        turn("keep", { role: "user", source_versions: { [knownSourceId.toUpperCase()]: 0 }, context_anchor: { sourceId: knownSourceId } }),
      ],
    });
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
  });

  it.each([
    { label: "live block source", block: { citationBinding: { sourceId: missingSourceId } }, live: true },
    { label: "revision binding source", block: { citationBinding: { refs: [{ sourceId: missingSourceId, sourceVersion: 0, chunkId: existingChunkId }] } }, live: false },
    { label: "malformed block chunk", block: { citedChunkIds: ["not-a-uuid"] }, live: false },
    { label: "missing bound chunk ID", block: { citationBinding: { refs: [{ sourceId: knownSourceId, sourceVersion: 0 }] } }, live: false },
  ])("excludes a publication with $label when the chunk inventory is omitted", ({ block, live }) => {
    const result = project({
      ...published,
      opening_sources: [{ ...owner, id: knownSourceId }],
      ...(live ? { library_blocks: [{ ...owner, document_id: "document", content: block }] }
        : { library_revisions: [{ ...owner, id: "revision", document_id: "document", blocks_snapshot: [{ content: block }] }] }),
      opening_turns: [publishedTurn, turn("keep")],
    });
    expect(result.coursePackageQuality).toEqual([]);
    expect(result.answerSequences).toEqual([]);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
  });

  it("excludes a spec with an unknown source, malformed source ref, or malformed chunk ID", () => {
    const result = project({
      opening_sources: [{ ...owner, id: knownSourceId }],
      opening_teaching_activities: ["missing-source", "malformed-ref", "malformed-chunk", "malformed-keyframe", "keep"].map(activity),
      opening_teaching_activity_specs: [
        { ...owner, activity_id: "missing-source", source_refs: [{ sourceId: missingSourceId }] },
        { ...owner, activity_id: "malformed-ref", source_refs: [null] },
        { ...owner, activity_id: "malformed-chunk", source_refs: [{ sourceId: knownSourceId, chunkId: "not-a-uuid" }] },
        { ...owner, activity_id: "malformed-keyframe", source_refs: [{ sourceId: knownSourceId, keyframeChunkId: "not-a-uuid" }] },
        { ...owner, activity_id: "keep", source_refs: [{ sourceId: knownSourceId, version: "0", chunkId: existingChunkId }] },
      ],
    });
    expect(result.coursePackageQuality.map(row => row.identity)).toEqual(["activity:keep"]);
  });

  it("requires valid turn citation chunks and validates optional chunk selectors without an inventory", () => {
    const citation = { sourceId: knownSourceId, sourceVersion: 0 };
    const result = project({
      opening_sources: [{ ...owner, id: knownSourceId }],
      opening_turns: [
        turn("missing", { citations: [citation] }),
        turn("null", { citations: [{ ...citation, chunkId: null }] }),
        turn("bad-citation", { citations: [{ ...citation, chunkId: "not-a-uuid" }] }),
        turn("bad-keyframe", { citations: [{ ...citation, chunkId: existingChunkId, keyframeChunkId: " " }] }),
        turn("bad-column", { chunk_id: "not-a-uuid" }),
        turn("bad-anchor", { context_anchor: { sourceId: knownSourceId, chunkId: "not-a-uuid" } }),
        turn("keep", { citations: [{ ...citation, chunkId: existingChunkId, keyframeChunkId: "frame-1" }] }),
      ],
    });
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
  });

  it("keeps a media locator with a known source and primary chunk", () => {
    const result = project({
      opening_sources: [{ ...owner, id: knownSourceId }],
      opening_source_chunks: [{ id: existingChunkId, source_id: knownSourceId }],
      opening_turns: [turn("media", { citations: [{
        sourceId: knownSourceId, sourceVersion: 0, chunkId: existingChunkId, keyframeChunkId: "frame-1",
      }] })],
    });
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:media"]);
  });

  it("excludes answers derived from missing problem, item, and observation sources", () => {
    const result = project({
      opening_sources: [{ ...owner, id: knownSourceId }],
      opening_teaching_activities: [activity("keep")],
      opening_problem_refs: [{ ...owner, problem_id: "problem", source_id: missingSourceId }],
      opening_learning_item_versions: [{ ...owner, id: "item", source_id: missingSourceId }],
      opening_learning_observations: [
        { id: "listed", source_ids: [missingSourceId] }, { id: "version", source_versions: { [missingSourceId]: 1 } },
        { id: "reference", reference_source_id: missingSourceId }, { id: "check", reference_check: { referenceId: missingSourceId } },
        { id: "photo", grading_work_source: { id: missingSourceId } },
      ].map(observation => ({ ...owner, source_turn_ids: [], ...observation })),
      opening_learning_attempts: [
        { id: "keep" }, { id: "problem", problem_id: "problem" }, { id: "item", item_version_id: "item" },
        ...["listed", "version", "reference", "check", "photo"].map(id => ({ id, observation_id: id })),
      ].map(attempt => ({ ...owner, activity_id: "keep", source_ids: [], ...attempt })),
    });
    expect(result.answerSequences.map(row => row.identity)).toEqual(["attempt:keep"]);
  });

  it.each(["live", "blocks", "blocks_snapshot"] as const)("follows chunk-only citations from %s", storage => {
    const block = { content: { citedChunkIds: [existingChunkId, ` ${absentChunkId.toUpperCase()} `] } };
    const storageRows = storage === "live"
      ? { library_blocks: [{ ...owner, document_id: "document", ...block }] }
      : { library_revisions: [{ ...owner, id: "revision", document_id: "document", [storage]: [block] }] };
    const result = project({
      ...published, ...storageRows,
      opening_source_chunks: [{ id: existingChunkId, source_id: "keep" }, { id: absentChunkId, source_id: "shred" }],
      opening_turns: [publishedTurn, turn("keep")],
    }, { tombstoneReceipts: [tombstone] });
    expect(result.coursePackageQuality).toEqual([]);
    expect(result.answerSequences).toEqual([]);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
  });

  it.each([
    { reason: "not an array", citedChunkIds: existingChunkId, visible: false },
    { reason: "a null entry", citedChunkIds: [null], visible: false },
    { reason: "an empty entry", citedChunkIds: [" "], visible: false },
    { reason: "a purged chunk", citedChunkIds: [absentChunkId], visible: false },
    { reason: "a chunk in another workspace", citedChunkIds: [foreignChunkId], visible: false },
    { reason: "a workspace chunk", citedChunkIds: [` ${existingChunkId.toUpperCase()} `], visible: true },
    { reason: "an explicitly empty list", citedChunkIds: [], visible: true },
  ])("checks saved block chunk lineage for $reason", ({ citedChunkIds, visible }) => {
    const result = project({
      ...published,
      opening_sources: [{ ...owner, id: "keep" }, { ...owner, workspace_id: "foreign", id: "foreign-source" }],
      opening_source_chunks: [{ id: existingChunkId, source_id: "keep" }, { id: foreignChunkId, source_id: "foreign-source" }],
      library_revisions: [{ id: "revision", document_id: "document", blocks: [{ content: { citedChunkIds } }] }],
      opening_learning_attempts: [...published.opening_learning_attempts,
        { ...owner, id: "revision", activity_id: "keep", teaching_revision_id: "revision", source_ids: [] }],
      opening_teaching_activities: [...published.opening_teaching_activities, activity("keep")],
      opening_turns: [publishedTurn, turn("keep")],
    });
    expect(result.coursePackageQuality.map(row => row.identity)).toEqual(visible ? ["activity:published", "activity:keep"] : ["activity:keep"]);
    expect(result.answerSequences.map(row => row.identity)).toEqual(visible ? ["attempt:published", "attempt:revision"] : []);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(visible ? ["turn:keep", "turn:published"] : ["turn:keep"]);
  });

  it("excludes problem and item dependents when their chunks are the only missing lineage", () => {
    const result = project({
      opening_source_chunks: [],
      opening_problem_refs: [{ ...owner, problem_id: "problem", chunk_id: absentChunkId }],
      opening_learning_item_versions: [{ ...owner, id: "item", chunk_id: absentChunkId }],
      opening_teaching_activities: [activity("keep")],
      opening_learning_attempts: [
        { id: "keep" }, { id: "problem", problem_id: "problem" }, { id: "item", item_version_id: "item" },
      ].map(attempt => ({ ...owner, activity_id: "keep", source_ids: [], ...attempt })),
    });
    expect(result.answerSequences.map(row => row.identity)).toEqual(["attempt:keep"]);
  });

  it("excludes turns with purged direct or citation chunk references in a supplied inventory", () => {
    const result = project({
      opening_sources: [{ ...owner, id: knownSourceId }],
      opening_source_chunks: [{ id: existingChunkId, source_id: knownSourceId }],
      opening_turns: [turn("direct", { chunk_id: absentChunkId }), turn("present", { chunk_id: existingChunkId.toUpperCase() }),
        turn("citation", { citations: [{ sourceId: knownSourceId, sourceVersion: 1, chunkId: absentChunkId }] }),
        turn("media-citation", { citations: [{ sourceId: knownSourceId, sourceVersion: 1, chunkId: existingChunkId, keyframeChunkId: absentChunkId }] })],
    });
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:present"]);
  });

  it.each([
    { reason: "unknown context", refs: null, visible: false },
    { reason: "a non-array context", refs: "[]", visible: false },
    { reason: "a malformed source ref", refs: [{ sourceId: knownSourceId }], visible: false },
    { reason: "a malformed memory list", refs: [{ memoryDependencyIds: memoryId }], visible: false },
    { reason: "a malformed memory ID", refs: [{ memoryDependencyIds: [null] }], visible: false },
    { reason: "a missing memory", refs: memoryRefs, visible: false },
    { reason: "verified lineage with a versioned workspace source", refs: [{ sourceId: knownSourceId, sourceVersion: 0 }, { snippetLineageVersion: 1 }], visible: true },
    { reason: "an unattributed memory-only source", refs: [{ sourceId: knownSourceId, sourceVersion: 0, memoryOnly: true }], visible: false },
    { reason: "an empty context without an origin", refs: [], visible: false },
    { reason: "publication metadata without origin lineage", refs: [{ publicationCardIds: [knownSourceId] }], visible: false },
  ])("checks republished note lineage for $reason", ({ refs, visible }) => {
    const result = project({
      ...published,
      opening_sources: [{ ...owner, id: knownSourceId }],
      opening_note_provenance: [{ ...owner, document_id: "document", context_source_refs: refs }],
      opening_memories: [{ ...owner, workspace_id: "foreign", id: memoryId, source_turn_ids: [upstreamId] }],
      opening_turns: [publishedTurn, turn("keep")],
    });
    expect(result.coursePackageQuality.map(row => row.identity)).toEqual(visible ? ["activity:published"] : []);
    expect(result.answerSequences.map(row => row.identity)).toEqual(visible ? ["attempt:published"] : []);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(visible ? ["turn:keep", "turn:published"] : ["turn:keep"]);
  });

  it("follows a deleted source turn through a documentless memory and a republished note's memory dependencies", () => {
    const result = project({
      opening_memories: [{ ...owner, id: memoryId, kind: "confirmed", status: "active", source_turn_ids: [upstreamId.toUpperCase()] }],
      opening_note_provenance: [{ document_id: "document", context_source_refs: [...memoryRefs, { snippetLineageVersion: 1 }] }],
      opening_teaching_activity_specs: [{ ...owner, activity_id: "published", document_id: "document" }],
      opening_teaching_activities: [activity("published")],
      opening_turns: [turn(upstreamId, { role: "user" }), turn("memory-dependent", { context_source_refs: memoryRefs }), turn("keep")],
    }, { deletedTurnIds: [upstreamId] });
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
    expect(result.coursePackageQuality).toEqual([]);
  });

  it("excludes memory consumers when a user source turn loses its referenced source", () => {
    const result = project({
      opening_sources: [],
      opening_memories: [{ ...owner, id: memoryId, kind: "confirmed", status: "active", source_turn_ids: [upstreamId] }],
      opening_turns: [turn(upstreamId, { role: "user", source_ids: [missingSourceId], context_source_refs: null }),
        turn("consumer", { context_source_refs: memoryRefs }), turn("keep")],
    });
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
  });

  const memory = { ...owner, id: memoryId, kind: "confirmed", status: "active", source_turn_ids: [upstreamId] };

  it.each([
    { reason: "a hard-deleted turn", ids: [upstreamId, missingTurnId], visible: false },
    { reason: "a null turn ID", ids: [upstreamId, null], visible: false },
    { reason: "a numeric turn ID", ids: [1], visible: false },
    { reason: "a non-UUID turn ID", ids: ["keep"], visible: false },
    { reason: "a non-array turn list", ids: upstreamId, visible: false },
    { reason: "no source turns", ids: [], visible: false },
    { reason: "a surviving source turn", ids: [upstreamId.toUpperCase()], visible: true },
  ])("checks memory lineage for $reason", ({ ids, visible }) => {
    const result = project({
      ...published,
      opening_memories: [{ ...memory, source_turn_ids: ids }],
      opening_note_provenance: [{ ...owner, document_id: "document", context_source_refs: [...memoryRefs, { snippetLineageVersion: 1 }] }],
      opening_turns: [turn(upstreamId, { role: "user" }), turn("keep"),
        turn("consumer", { context_source_refs: memoryRefs }), publishedTurn,
        turn(missingTurnId, { workspace_id: "foreign", role: "user" })],
    });
    expect(result.coursePackageQuality.map(row => row.identity)).toEqual(visible ? ["activity:published"] : []);
    expect(result.answerSequences.map(row => row.identity)).toEqual(visible ? ["attempt:published"] : []);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(visible
      ? [`turn:${upstreamId}`, "turn:consumer", "turn:keep", "turn:published"] : [`turn:${upstreamId}`, "turn:keep"]);
  });
  it.each([
    { origin: "a deleted memory", lineage: { opening_memories: [{ ...memory, status: "deleted" }] } },
    { origin: "an explicit memory exclusion", lineage: { opening_privacy_exclusions: [{ ...owner, memory_id: memoryId }] } },
    { origin: "a memory with no source turns", lineage: { opening_memories: [{ ...memory, source_turn_ids: [] }] } },
    { origin: "a missing memory in a supplied inventory", lineage: { opening_memories: [] } },
    { origin: "a memory only present in another workspace", lineage: {
      opening_memories: [{ ...memory, workspace_id: "foreign" }],
    } },
    { origin: "a memory backed by a deleted document", lineage: {
      opening_memories: [{ ...memory, document_id: "document" }],
      library_documents: [{ ...owner, id: "document", deleted_at: time }],
    } },
  ] satisfies { origin: string; lineage: dataset.OpeningDatasetProjectionInput["tables"] }[])(
    "excludes consumers of $origin without excluding the upstream turn", ({ lineage }) => {
      const result = project({
        ...lineage,
        opening_turns: [turn(upstreamId, { role: "user" }), turn("memory-dependent", { context_source_refs: memoryRefs })],
      });
      expect(result.dialogueEvaluation.map(row => row.identity)).toEqual([`turn:${upstreamId}`]);
    },
  );

  it("keeps valid legacy dependencies when the memory inventory is omitted and rejects malformed metadata", () => {
    const result = project({
      opening_privacy_exclusions: [{ ...owner, workspace_id: "foreign", memory_id: memoryId }],
      opening_turns: [
        turn("legacy", { context_source_refs: memoryRefs }),
        turn("malformed", { context_source_refs: [{ memoryDependencyIds: memoryId }] }),
      ],
    });
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:legacy"]);
  });

  it.each([
    { reason: "unknown assistant context", data: { context_source_refs: null } },
    { reason: "omitted assistant context", data: { context_source_refs: undefined } },
    { reason: "a non-array assistant context", data: { context_source_refs: {} } },
    { reason: "non-array citations", data: { citations: {} } },
    { reason: "a citation missing a version", data: { citations: [{ sourceId: knownSourceId }] } },
    { reason: "a citation with an invalid version", data: { citations: [{ sourceId: knownSourceId, sourceVersion: -1 }] } },
    { reason: "a citation with an invalid source ID", data: { citations: [{ sourceId: " ", sourceVersion: 1 }] } },
    { reason: "a citation with an unavailable source", data: { citations: [{ sourceId: missingSourceId, sourceVersion: 1 }] } },
  ])("drops a turn and its dependent records for $reason", ({ data }) => {
    const result = project({
      opening_sources: [{ ...owner, id: knownSourceId }, { ...owner, id: missingSourceId, workspace_id: "foreign" }],
      opening_turns: [turn("affected", data), turn("keep-assistant"), turn("keep-user", { role: "user", context_source_refs: null }),
        turn("keep-citation", { citations: [{ sourceId: knownSourceId.toUpperCase(), sourceVersion: 0, chunkId: existingChunkId }] })],
      opening_teaching_activities: [{ ...activity("derived"), create_intent: { sourceTurnId: "affected" } }],
      opening_learning_attempts: [{ ...owner, id: "derived", activity_id: "derived", source_ids: [] }],
    });
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep-assistant", "turn:keep-citation", "turn:keep-user"]);
    expect(result.coursePackageQuality).toEqual([]);
    expect(result.answerSequences).toEqual([]);
  });

  it.each([
    { origin: "the user snapshot", user: { userTurnId: "user", assistantTurnId: " PAIRED ", tutorMode: "hint", studyIntent: null } },
    { origin: "a legacy user snapshot", user: { assistant_turn_id: "paired" } },
    { origin: "the assistant snapshot", assistant: { userTurnId: " USER " } },
    { origin: "a persisted tutor job", jobs: [{ user_turn_id: "user", assistant_turn_id: "paired" }] },
  ])("excludes only the paired reply via $origin", ({ user, assistant, jobs = [] }) => {
    const result = project({
      opening_turns: [turn("user", { role: "user", help_input_snapshot: user }),
        turn("paired", { help_input_snapshot: assistant }), turn("unrelated")],
      opening_tutor_jobs: [...jobs, { workspace_id: "foreign", user_turn_id: "user", assistant_turn_id: "unrelated" }],
    }, { deletedTurnIds: ["user"] });
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:unrelated"]);
  });

  it("follows problem and library revision links and closes the observation revision chain", () => {
    const rootId = upstreamId, middleId = missingTurnId, headId = knownSourceId, effectiveId = missingSourceId;
    const problemId = "abcdef12-3456-4789-abcd-ef1234567919", revisionId = "abcdef12-3456-4789-abcd-ef1234567920";
    const observation = (id: string, lineage: Record<string, unknown>) => ({
      ...owner, id, source_turn_ids: [], outcome: "correct", ...lineage,
    });
    const result = project({
      opening_teaching_activities: [activity("keep")],
      opening_learning_sessions: [{ ...owner, id: "session", source_ids: ["shred"] }],
      opening_source_chunks: [{ id: existingChunkId, source_id: "shred" }],
      library_documents: [{ id: "document", deleted_at: time }],
      library_revisions: [{ ...owner, id: revisionId, document_id: "document" }],
      opening_problem_refs: [
        { ...owner, problem_id: problemId, chunk_id: existingChunkId },
        { ...owner, problem_id: "revision-problem", teaching_revision_id: revisionId },
        { ...owner, problem_id: "session-problem", session_id: "session" },
      ],
      opening_learning_item_versions: [
        { ...owner, id: "problem-item", problem_id: problemId },
        { ...owner, id: "revision-item", teaching_revision_id: revisionId },
      ],
      opening_learning_observations: [
        observation(rootId, { reference_check: { referenceId: shreddedSourceId } }),
        observation(middleId, { revises_observation_id: rootId }),
        observation(headId, { root_observation_id: rootId }),
        observation(effectiveId, { effective_head_id: headId }),
        observation("problem", { problem_id: problemId }),
        observation("revision", { teaching_revision_id: revisionId }),
      ],
      opening_learning_attempts: [
        { id: "keep" }, { id: "chunk-problem", problem_id: problemId },
        { id: "revision-problem", problem_id: "revision-problem" }, { id: "revision", teaching_revision_id: revisionId },
        { id: "session-problem", problem_id: "session-problem" },
        ...["problem-item", "revision-item"].map(id => ({ id, item_version_id: id })),
        ...[middleId, headId, effectiveId, "problem", "revision"].map(id => ({ id: `observation-${id}`, observation_id: id })),
      ].map(attempt => ({ ...owner, activity_id: "keep", source_ids: [], ...attempt })),
      opening_turns: [turn("downstream", { attempt_id: `observation-${effectiveId}` }), turn("keep")],
    }, { tombstoneReceipts: [tombstone] });
    expect(result.answerSequences.map(row => row.identity)).toEqual(["attempt:keep"]);
    expect(result.dialogueEvaluation.map(row => row.identity)).toEqual(["turn:keep"]);
  });
});

it("admits a verified speech-only receipt for speaking and strips transcript material", () => {
  const receipt = issueSpeechTimingReceipt({
    receiptId: "speaking-receipt", issuedAtMs, totalOriginalDurationMs: 2000,
    voicedSegments: [{ originalStartMs: 200, originalEndMs: 1500, strippedStartMs: 0, strippedEndMs: 1300 }],
    words: [{ word: "private-word", startMs: 0, endMs: 1000 }],
  });
  const input = { blueprint: forecast.IELTS_ACADEMIC_V1_BLUEPRINT, learnerId: scope.ownerUserId, receipt, verified: true, assisted: false };
  const speaking = forecast.toExamSprintSpeechTimingEvidence({ ...input, sectionId: "speaking" });
  expect(speaking).toMatchObject({ evidenceKind: "speech_timing", sectionId: "speaking", countsTowardMastery: true,
    speechTimingReceipt: { receiptId: "speaking-receipt", durationSeconds: 2, speechRateWpm: 30, calibrated: true } });
  if (speaking) expect(isIndependentExamEvidence(speaking)).toBe(true);
  expect(JSON.stringify(speaking)).not.toContain("private-word");
  expect(forecast.toExamSprintSpeechTimingEvidence({ ...input, sectionId: "writing" })).toBeNull();
  expect(forecast.toExamSprintSpeechTimingEvidence({ ...input, sectionId: "reading" })).toBeNull();
  expect(forecast.toExamSprintSpeechTimingEvidence({ ...input, sectionId: "speaking", verified: false })).toBeNull();
});
