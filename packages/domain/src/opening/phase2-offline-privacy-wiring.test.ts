import type { CourseRequirement } from "@aistudy/contracts";
import { describe, expect, it } from "vitest";
import { issueSpeechTimingReceipt } from "../multimodal-evidence";
import { createInitialOfflineFsrsSnapshot } from "../offline-companion-bridge";
import type { CryptoShredTombstoneReceipt } from "../resilience-canary-shredding";
import * as srs from "../srs/eligibility";
import type { CourseRouteObservation } from "./course-route";
import * as course from "./course-shared-skill";
import * as dataset from "./deidentified-dataset";
import * as forecast from "./exam-sprint/score-forecast-bridge";

const issuedAtMs = 10_000;
const time = new Date(issuedAtMs).toISOString();
const scope = { workspaceId: "workspace", ownerUserId: "learner" };
const queueItem = (id: string, question = false): srs.ReviewQueueItem => ({
  card: {
    id, ownerUserId: scope.ownerUserId, front: "What is this concept?", back: question ? "old protected answer" : "A reusable explanation.",
    sourceDocumentId: null, syllabusPointId: null, tags: question ? ["review:question"] : [], courseId: null, skillLabel: null,
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
    const result = srs.issueReviewQueueOfflineLease(leaseInput(items));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.cards).toHaveLength(30);
    expect(result.lease.cards[0]).toMatchObject({ cardId: "card-218", cardRevision: 2 });
  });

  it("screens fresh variants against private answers before publishing a lease", () => {
    const offline = leaseInput([queueItem("question", true)]);
    const variant = { freshVariantId: "fresh", freshVariantStem: "Solve this new exercise.", answerKey: "controlled answer" };
    const result = srs.issueReviewQueueOfflineLease({ ...offline, freshVariants: new Map([["question", variant]]) });
    expect(result).toMatchObject({ ok: true, lease: { cards: [{
      cardId: "question", cardKind: "miss_variant", freshVariantId: "fresh", freshVariantStem: variant.freshVariantStem,
    }] } });
    if (result.ok) expect(result.lease.cards[0]).not.toHaveProperty("answerKey");
    for (const stem of ["The controlled answer is shown here.", "Try using the old protected answer here."]) {
      expect(srs.issueReviewQueueOfflineLease({
        ...offline, freshVariants: new Map([["question", { ...variant, freshVariantStem: stem }]]),
      })).toMatchObject({ ok: false, code: "miss_variant_answer_leak" });
    }
  });

  it("lets the core inspect hidden answers and refuse accessors without invoking them", () => {
    const offline = leaseInput([queueItem("question", true)]);
    const variant = { freshVariantId: "fresh", freshVariantStem: "Use the privileged token here." };
    const hidden = Object.defineProperty({ ...variant }, "answerKey", { value: "privileged token" });
    let getterRead = false;
    const accessor = Object.defineProperty({ ...variant }, "answerKey", { get() { getterRead = true; return "privileged token"; } });
    for (const value of [hidden, accessor]) {
      expect(srs.issueReviewQueueOfflineLease({ ...offline, freshVariants: new Map([["question", value]]) }))
        .toMatchObject({ ok: false, code: "miss_variant_answer_leak" });
    }
    expect(getterRead).toBe(false);
  });

  it("uses the half-open server clock and never promotes mastery on an offline easy rating", () => {
    const offline = leaseInput([queueItem("card")]);
    const issued = srs.issueReviewQueueOfflineLease(offline);
    if (!issued.ok) throw new Error(issued.message);
    const { lease } = issued;
    const sync = (serverReceiptAtMs: number) => srs.reconcileReviewQueueOfflineOutbox({
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
