import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { LearningObservation, ObservationRevisionInput, RetestCandidate } from "@aistudy/contracts";
import { createOpeningPlansRepository, createOpeningRetestRepository, createWorkspacePreferencesRepository, readOpeningCourseEvidence, readOpeningCourseObservationHeads, readOpeningObservationHistory, reviseOpeningLearningObservation } from "@aistudy/database";
import { summarizeObservations } from "@aistudy/domain";
import { insertOpeningTask } from "../../packages/database/src/repositories/opening-retest-task";
import { readOpeningRetestReviewCandidates } from "../../packages/database/src/repositories/opening-review-candidates";
import { createRetestCandidateHandler } from "../../apps/worker/src/jobs/retest-candidate";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });

function command(record: LearningObservation, replacement?: Extract<ObservationRevisionInput, { revisionKind: "replace" }>["replacement"]): ObservationRevisionInput {
  const common = { rootObservationId: record.rootObservationId ?? record.id, revisesObservationId: record.id, expectedHead: record.id, reason: "Correct the saved observation", clientKey: randomUUID() };
  return replacement ? { ...common, revisionKind: "replace", replacement } : { ...common, revisionKind: "retract" };
}
const candidate = (record: LearningObservation, overrides: Partial<RetestCandidate> = {}): RetestCandidate => ({
  id: randomUUID(), courseId: record.courseId, skillLabel: record.skillLabel, requirementKey: record.requirementKey ?? null,
  sourceIds: record.sourceIds, prompt: "Try a fresh fraction problem", dueAt: new Date().toISOString(), accepted: false,
  evidenceObservationIds: [record.id], evidenceRootIds: [record.rootObservationId ?? record.id], ...overrides,
});

it("counts only the corrected head and preserves the retracted root in history", async () => {
  const f = await learningAttemptFixture(fixture);
  const initial = await f.submit(await f.start(), { outcome: "incorrect" });
  const corrected = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, command(initial, { answer: "1", outcome: "correct", assistance: "independent", verdictSource: "reference_checked", referenceSourceId: f.sourceId, referenceCheck: { referenceSourceId: f.sourceId, method: "Compare each answer step", scope: "whole_answer" } }));
  const evidence = await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId);
  expect(evidence.observations.map((row) => row.id)).toEqual([corrected.headObservationId]);
  expect(evidence.observations[0]).toMatchObject({ attemptId: initial.attemptId, itemVersionId: initial.itemVersionId, occurredAt: initial.occurredAt, startedAt: initial.startedAt, submittedAt: initial.submittedAt });
  expect(summarizeObservations(evidence.observations, new Date().toISOString(), { evidenceContexts: evidence.evidenceContexts })[0]).toMatchObject({ status: "observed_independent", sampleCount: 1, evidenceIds: [corrected.headObservationId] });
  const retracted = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, command(corrected.observation!));
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId)).observations).toEqual([]);
  expect(await readOpeningCourseObservationHeads(fixture.sql, fixture.scope, f.courseId)).toEqual([expect.objectContaining({ id: retracted.headObservationId, rootObservationId: initial.id, revisionKind: "retract" })]);
  const history = await readOpeningObservationHistory(fixture.sql, fixture.scope, corrected.headObservationId);
  expect(history.revisions.map((row) => row.id)).toEqual([initial.id, corrected.headObservationId, retracted.headObservationId]);
  expect(history.revisions[0]?.outcome).toBe("incorrect");
});

it("moves effective evidence to the corrected course and requirement without cloning practice", async () => {
  const f = await learningAttemptFixture(fixture), courseId = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${fixture.scope.workspaceId},'Corrected course',${courseId})`;
  const initial = await f.submit(await f.start());
  const result = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, command(initial, { answer: "1", outcome: "correct", assistance: "independent", courseId, skillLabel: "ratios", requirementKey: "ratios-a" }));
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId)).observations).toEqual([]);
  expect(await readOpeningCourseObservationHeads(fixture.sql, fixture.scope, f.courseId)).toEqual([]);
  const evidence = await readOpeningCourseEvidence(fixture.sql, fixture.scope, courseId);
  expect(evidence.observations).toEqual([expect.objectContaining({ id: result.headObservationId, courseId, skillLabel: "ratios", requirementKey: "ratios-a", attemptId: initial.attemptId })]);
  expect(summarizeObservations(evidence.observations, new Date().toISOString(), { evidenceContexts: evidence.evidenceContexts })[0]).toMatchObject({ courseId, requirementKey: "ratios-a", skillLabel: "ratios", sampleCount: 1 });
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.otherScope, courseId)).observations).toEqual([]);
});

it("applies whole-chain privacy when only the original revision references the excluded source", async () => {
  const f = await learningAttemptFixture(fixture);
  const initial = await f.learning.insertObservation(fixture.scope, { sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [], referenceSourceId: f.sourceId, verdictSource: "reference_checked", answer: "private reference answer", outcome: "correct", assistance: "independent", clientKey: randomUUID() });
  const result = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, command(initial, { answer: "corrected self report", outcome: "unverified", assistance: "unknown", verdictSource: "self_report", referenceSourceId: null }));
  expect(result.observation).toMatchObject({ sourceIds: [], referenceSourceId: null });
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId)).observations).toHaveLength(1);
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${fixture.scope.workspaceId},${f.sourceId})`;
  expect(await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId)).toEqual({ observations: [], evidenceContexts: {} });
  expect(await readOpeningCourseObservationHeads(fixture.sql, fixture.scope, f.courseId)).toEqual([]);
  await expect(readOpeningObservationHistory(fixture.sql, fixture.scope, result.headObservationId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE COALESCE(root_observation_id,id)=${initial.id}`).toHaveLength(2);
});

it("invalidates linked and exact legacy bases while preserving accepted completed activity", async () => {
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const f = await learningAttemptFixture(fixture), repo = createOpeningRetestRepository(fixture.sql);
  const initial = await f.submit(await f.start());
  const accepted = candidate(initial);
  await repo.saveCandidates(fixture.scope, [accepted]);
  const task = await insertOpeningTask(fixture.sql, fixture.scope, { candidateId: accepted.id, title: "Accepted retest", minutes: 20, dueAt: accepted.dueAt, priority: 1, clientKey: "accept-corrected-evidence", inputSnapshot: { kind: "retest", candidateId: accepted.id, heuristic: true }, baseVersion: 0 });
  // Complete the task through the plans repository so the fixture exercises
  // the same activity/task transition used in production.
  await createOpeningPlansRepository(fixture.sql).updateTaskStatus(fixture.scope, task.id, {
    status: "done", expectedVersion: 1, at: "2026-09-29T12:00:00.000Z",
  });

  // A completed activity releases the active business identity, allowing a
  // new pending proposal for the same course/skill/requirement.
  const pending = candidate(initial);
  const otherRequirement = candidate(initial, { requirementKey: "other", evidenceObservationIds: undefined, evidenceRootIds: undefined });
  await repo.saveCandidates(fixture.scope, [pending, otherRequirement]);

  // Construct one pre-S4 legacy job explicitly. It has no activity row, so
  // the revision reconciler must still invalidate it by business identity.
  const legacyId = randomUUID();
  await fixture.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state, privacy_epoch)
    VALUES (${legacyId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${`retest:${legacyId}`}, 'retest', ${fixture.sql.json({
      id: legacyId, kind: "task", courseId: f.courseId, skillLabel: "fractions", requirementKey: null,
      sourceIds: initial.sourceIds, prompt: "Legacy retest", dueAt: new Date().toISOString(), accepted: false,
    } as never)}, 'succeeded', 0)`;

  await reviseOpeningLearningObservation(fixture.sql, fixture.scope, command(initial, { answer: "corrected", outcome: "unverified", assistance: "independent" }));
  const jobs = await fixture.sql`SELECT id,payload FROM opening_jobs WHERE id IN ${fixture.sql([pending.id, accepted.id, legacyId, otherRequirement.id])}`;
  const records = new Map(jobs.map((row) => [String(row.id), row.payload]));
  expect(records.get(pending.id)).toMatchObject({ accepted: false, invalidated: true, evidenceChanged: true });
  expect(records.get(legacyId)).toMatchObject({ accepted: false, invalidated: true, evidenceChanged: true });
  expect(records.get(otherRequirement.id)).not.toHaveProperty("invalidated");
  expect(records.get(accepted.id)).toMatchObject({ accepted: true, evidenceChanged: true, taskId: task.id });
  expect(records.get(accepted.id)).not.toHaveProperty("invalidated");
  expect(await fixture.sql`SELECT status FROM opening_tasks WHERE id=${task.id}`).toEqual([expect.objectContaining({ status: "done" })]);
  expect((await readOpeningRetestReviewCandidates(fixture.sql, fixture.scope)).map((row) => row.id)).toEqual([otherRequirement.id]);
  await expect(repo.accept(fixture.scope, pending.id, "accept-invalidated")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await repo.saveCandidates(fixture.scope, [pending, accepted])).toEqual([]);
  expect((await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${accepted.id}`)[0]?.payload).toMatchObject({ accepted: true, evidenceChanged: true });
});

it("does not persist candidates read before a correction committed", async () => {
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const f = await learningAttemptFixture(fixture), repo = createOpeningRetestRepository(fixture.sql);
  const initial = await f.submit(await f.start());
  const worker = createRetestCandidateHandler({ readCourseEvidence: () => readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId), listDueRetests: async () => [], saveCandidates: async (_scope, candidates) => candidates });
  const job = { id: randomUUID(), ...fixture.scope, key: "stale-read", kind: "retest", state: "running", privacyEpoch: 0, payload: {}, result: null };
  const stale = (await worker(job, { courseId: f.courseId, promptsBySkill: { fractions: "Try a different fraction problem" } })).candidates;
  expect(stale).toHaveLength(1);
  expect(stale[0]).toMatchObject({ evidenceObservationIds: [initial.id], evidenceRootIds: [initial.id] });
  await reviseOpeningLearningObservation(fixture.sql, fixture.scope, command(initial, { answer: "corrected", outcome: "incorrect", assistance: "independent" }));
  expect(await repo.saveCandidates(fixture.scope, stale)).toEqual([]);
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE id=${stale[0]!.id}`).toEqual([]);
});
