import { describe, expect, it } from "vitest";
import type { LearningObservation, ServerEvaluation } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import type { Sql } from "postgres";
import { readOpeningLearningEvidenceContext } from "./opening-learning-evidence-context";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) };
const startedAt = "2026-10-18T08:00:00.000Z", submittedAt = "2026-10-18T08:01:00.000Z";
const spec = { kind: "exam_choice", specVersion: "exam-choice-v1", packId: "math", packVersion: "1", questionId: "q1", familyId: "f1" };
const evaluation: ServerEvaluation = {
  observationId: id(10), attemptId: id(11), problemId: id(12), itemVersionId: id(13), requirementKey: "exam-skill:node",
  evaluatorVersion: "exam-choice-exact-v1", specVersion: "exam-choice-v1", decision: "correct", outcome: "correct",
  reasonCodes: ["exam_choice_compared"], evaluatedAt: submittedAt,
};
const observation: LearningObservation = {
  id: id(10), rootObservationId: id(10), sessionId: id(14), courseId: id(15), workspaceId: scope.workspaceId,
  attemptId: id(11), problemId: id(12), itemVersionId: id(13), skillLabel: "limit", requirementKey: "exam-skill:node",
  sourceIds: [id(16)], sourceVersions: { [id(16)]: 1 }, answer: "A", outcome: "correct", assistance: "independent",
  clientKey: "answer-original", startedAt, submittedAt, recordedAt: submittedAt, occurredAt: submittedAt,
  sourceTurnIds: [], verdictSource: "deterministic", referenceSourceId: null, evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
  serverEvaluation: evaluation,
};
const link = {
  exam_link_id: id(17), attempt_id: id(11), session_id: id(14), course_id: id(15), problem_id: id(12), item_version_id: id(13),
  exam_pack_id: "math", exam_pack_version: "1", first_family_exposure: true, delayed_earliest_at: startedAt,
  receipt_id: null, kind: null, delivered_at: null, history_revision: null,
};

function fixture(options: { links?: Record<string, unknown>[]; record?: LearningObservation; sourceVersion?: number; spec?: unknown } = {}) {
  const record = options.record ?? observation;
  const chain = [
    { id: observation.id, root_observation_id: observation.id, revises_observation_id: null, answer: "A", recorded_at: submittedAt, source_ids: [id(16)], source_versions: { [id(16)]: 1 } },
    ...(record.id !== observation.id ? [{ id: record.id, root_observation_id: observation.id, revises_observation_id: observation.id,
      answer: record.answer, recorded_at: record.recordedAt, source_ids: [id(16)], source_versions: { [id(16)]: 1 } }] : []),
  ];
  const db = ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (!query.includes(" FROM ") && !query.includes("\n    FROM ")) return {};
    if (query.includes("FROM opening_exam_attempt_links")) return Promise.resolve(options.links ?? [link]);
    if (query.includes("FROM opening_help_exposures")) return Promise.resolve([]);
    if (query.includes("FROM opening_learning_sessions")) return Promise.resolve([{ id: id(14), course_id: id(15) }]);
    if (query.includes("FROM opening_privacy_exclusions")) return Promise.resolve([]);
    if (query.includes("FROM opening_source_versions")) return Promise.resolve([{ source_id: id(16), version: 1, availability: "available" }]);
    if (query.includes("FROM opening_sources")) return Promise.resolve([{ id: id(16), version: options.sourceVersion ?? 1, upload_state: "uploaded" }]);
    if (query.includes("FROM opening_learning_item_versions")) return Promise.resolve([{ id: id(13), problem_id: id(12), course_id: id(15), evaluation_spec: options.spec ?? spec }]);
    if (query.includes("FROM opening_learning_observations") && query.includes("JOIN opening_learning_observations root")) return Promise.resolve([]);
    if (query.includes("FROM opening_learning_observations")) return Promise.resolve(chain);
    throw new Error(`Unexpected query: ${query}`);
  }) as unknown as Sql;
  return { db, record };
}

describe("exam evidence context bridge", () => {
  it("qualifies the captured first-family identity and explicit 24-hour protocol", async () => {
    const { db, record } = fixture();
    const input = await readOpeningLearningEvidenceContext(db, scope, record);
    expect(input.context.examAttempt).toEqual({ firstFamilyExposure: true });
    expect(input.context.delayedCheck).toEqual({ protocolId: "exam-sprint-24h-v1", attemptId: id(11), earliestAt: Date.parse(startedAt), priorAnswerPolicy: "require_unseen_problem" });
    expect(evaluateEvidenceEligibility(input.observation, input.context)).toMatchObject({
      independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "yes",
    });
  });

  it.each(["hint", "solution", "external"])("keeps %s receipts in qualification and dependency revisions", async kind => {
    const { db, record } = fixture({ links: [{ ...link, receipt_id: id(18), kind, delivered_at: "2026-10-18T08:00:30.000Z", history_revision: 7 }] });
    const input = await readOpeningLearningEvidenceContext(db, scope, record);
    expect(input.context.helpHistory!.exposures).toEqual([expect.objectContaining({
      attemptId: id(11), problemId: id(12), delivered: true,
      level: kind === "solution" ? "revealed" : "hinted", kind: kind === "solution" ? "solution" : "hint",
    })]);
    expect(input.dependencies.helpRevision).toBe(7);
    expect(evaluateEvidenceEligibility(input.observation, input.context)).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes", usableForDelayedCheck: "no" });
  });

  it("retains help and first-family exclusion when a reference-check revision claims independence", async () => {
    const revised: LearningObservation = { ...observation, id: id(20), revisesObservationId: observation.id, revisionKind: "replace",
      recordedAt: "2026-10-19T08:00:00.000Z", verdictSource: "reference_checked", serverEvaluation: null,
      referenceSourceId: id(16), referenceCheck: { attemptId: id(11), problemId: id(12), itemVersionId: id(13), referenceId: id(16),
        method: "whole answer checked", scope: "whole_answer", checkerId: scope.ownerUserId, outcome: "correct" } };
    const { db, record } = fixture({ record: revised, links: [{ ...link, first_family_exposure: false,
      receipt_id: id(18), kind: "external", delivered_at: "2026-10-18T08:00:30.000Z", history_revision: 9 }] });
    const input = await readOpeningLearningEvidenceContext(db, scope, record);
    expect(evaluateEvidenceEligibility(input.observation, input.context)).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes",
      reasonCodes: expect.arrayContaining(["help_before_submission", "exam_family_already_seen"]) });
    expect(input.dependencies.helpRevision).toBe(9);
  });

  it.each([
    [], [{ ...link, session_id: id(99) }], [{ ...link, problem_id: id(99) }], [{ ...link, item_version_id: id(99) }],
    [{ ...link, exam_pack_version: "2" }], [{ ...link, first_family_exposure: null }],
  ].map(links => ({ links })))("keeps missing or mismatched captured context unverified: %j", async ({ links }) => {
    const { db, record } = fixture({ links });
    const input = await readOpeningLearningEvidenceContext(db, scope, record);
    expect(evaluateEvidenceEligibility(input.observation, input.context)).toMatchObject({ independentAttempt: "unknown", verifiedCorrect: "unknown", usableForDelayedCheck: "unknown" });
    expect(input.context.delayedCheck).toBeNull();
  });

  it("does not invent a delayed protocol or ignore a changed source version", async () => {
    const { db, record } = fixture({ links: [{ ...link, delayed_earliest_at: null }], sourceVersion: 2 });
    const input = await readOpeningLearningEvidenceContext(db, scope, record);
    expect(input.context.delayedCheck).toBeNull();
    expect(evaluateEvidenceEligibility(input.observation, input.context)).toMatchObject({
      independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "unknown", usableForDelayedCheck: "unknown",
    });
  });
});
