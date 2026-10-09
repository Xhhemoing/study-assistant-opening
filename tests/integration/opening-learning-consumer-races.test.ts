import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { LearningObservation, ObservationRevisionInput, RetestCandidate } from "@aistudy/contracts";
import { createOpeningRetestRepository, createWorkspacePreferencesRepository, readOpeningCourseEvidence, reviseOpeningLearningObservation } from "@aistudy/database";
import { summarizeObservations } from "@aistudy/domain";
import { createRetestCandidateHandler } from "../../apps/worker/src/jobs/retest-candidate";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false }); await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });

function revision(record: LearningObservation, replacement?: Extract<ObservationRevisionInput, { revisionKind: "replace" }>["replacement"]): ObservationRevisionInput {
  const base = { rootObservationId: record.rootObservationId ?? record.id, expectedHead: record.id, revisesObservationId: record.id, reason: "Correct attribution", clientKey: randomUUID() };
  return replacement ? { ...base, revisionKind: "replace", replacement } : { ...base, revisionKind: "retract" };
}
function retest(record: LearningObservation): RetestCandidate {
  return { id: randomUUID(), courseId: record.courseId, skillLabel: record.skillLabel, requirementKey: record.requirementKey ?? null,
    evidenceObservationIds: [record.id], evidenceRootIds: [record.rootObservationId ?? record.id], sourceIds: record.sourceIds,
    prompt: "Try another fraction problem", dueAt: new Date().toISOString(), accepted: false };
}
async function proposals(courseId: string) {
  const repo = createOpeningRetestRepository(fixture.sql);
  const worker = createRetestCandidateHandler({ readCourseEvidence: () => readOpeningCourseEvidence(fixture.sql, fixture.scope, courseId),
    listDueRetests: () => repo.listAcceptedEvidence(fixture.scope, courseId), saveCandidates: async (_scope, candidates) => candidates });
  return (await worker({ id: randomUUID(), ...fixture.scope, key: "racing-consumer", kind: "retest", state: "running", privacyEpoch: 0, payload: {}, result: null }, { courseId, promptsBySkill: { fractions: "Try a fresh fraction problem" } })).candidates;
}

it.each(["course", "skill", "retract"] as const)("does not use revised accepted evidence to mark an unaffected observation due (%s)", async (change) => {
  const f = await learningAttemptFixture(fixture), repo = createOpeningRetestRepository(fixture.sql);
  const checked = { verdictSource: "reference_checked", referenceSourceId: f.sourceId, referenceCheck: { referenceSourceId: f.sourceId, method: "Compare each answer step", scope: "whole_answer" } };
  const initial = await f.submit(await f.start(), checked), unaffected = await f.submit(await f.start(), checked);
  const accepted = retest(initial);
  await repo.saveCandidates(fixture.scope, [accepted]);
  await repo.accept(fixture.scope, accepted.id, "accept-measurement-before-correction");
  expect(await repo.listAcceptedEvidence(fixture.scope, f.courseId)).toHaveLength(1);
  let courseId = f.courseId;
  if (change === "course") {
    courseId = randomUUID();
    await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${fixture.scope.workspaceId},'Corrected course',${courseId})`;
  }
  await reviseOpeningLearningObservation(fixture.sql, fixture.scope, revision(initial, change === "retract" ? undefined : {
    answer: initial.answer, outcome: initial.outcome, assistance: initial.assistance, courseId, skillLabel: change === "skill" ? "ratios" : initial.skillLabel,
  }));
  const dueRetests = await repo.listAcceptedEvidence(fixture.scope, f.courseId);
  expect(dueRetests).toEqual([]);
  expect(await repo.listAcceptedSkillLabels(fixture.scope, f.courseId)).toEqual([]);
  const evidence = await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId);
  expect(summarizeObservations(evidence.observations, new Date().toISOString(), { evidenceContexts: evidence.evidenceContexts, dueRetests }).find((row) => row.skillLabel === "fractions"))
    .toMatchObject({ status: "observed_independent", sampleCount: 1, evidenceIds: [unaffected.id] });
  expect(await proposals(f.courseId)).toEqual([]);
  expect((await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${accepted.id}`)[0]?.payload).toMatchObject({ accepted: true, evidenceChanged: true });
});

it("rejects read-before-exclusion candidates at persistence, including unlinked legacy sources", async () => {
  const f = await learningAttemptFixture(fixture), repo = createOpeningRetestRepository(fixture.sql);
  await f.submit(await f.start());
  const before = await proposals(f.courseId);
  expect(before).toHaveLength(1);
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${fixture.scope.workspaceId},${f.sourceId})`;
  const legacyId = randomUUID();
  expect(await repo.saveCandidates(fixture.scope, before)).toEqual([]);
  expect(await repo.saveCandidates(fixture.scope, [{ ...before[0]!, id: legacyId, evidenceObservationIds: undefined, evidenceRootIds: undefined }])).toEqual([]);
  // Observation insert enqueues kind=retest scan jobs; assert only that rejected candidates were not persisted.
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE id IN ${fixture.sql([before[0]!.id, legacyId])}`).toEqual([]);
});

it("rejects stale evidence whose excluded ancestor reference is absent from current candidate sources", async () => {
  const f = await learningAttemptFixture(fixture), repo = createOpeningRetestRepository(fixture.sql), rows = backupRows(fixture.sql, fixture.scope);
  const oldReference = await rows.source();
  await rows.chunk(oldReference);
  const session = await f.learning.createSession(fixture.scope, { courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId, oldReference] });
  const initial = await f.learning.insertObservation(fixture.scope, { sessionId: session.id, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId],
    referenceSourceId: oldReference, verdictSource: "reference_checked", answer: "original reference", outcome: "correct", assistance: "independent", clientKey: randomUUID() });
  await reviseOpeningLearningObservation(fixture.sql, fixture.scope, revision(initial, { answer: "new self report", outcome: "unverified", assistance: "unknown", verdictSource: "self_report", referenceSourceId: null }));
  const before = await proposals(f.courseId);
  expect(before).toHaveLength(1);
  expect(before[0]?.sourceIds).toEqual([f.sourceId]);
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${fixture.scope.workspaceId},${oldReference})`;
  expect(await repo.saveCandidates(fixture.scope, before)).toEqual([]);
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE id=${before[0]!.id}`).toEqual([]);
});

it("checks the worker privacy epoch inside the candidate transaction and keeps ownership failures observable", async () => {
  const f = await learningAttemptFixture(fixture), repo = createOpeningRetestRepository(fixture.sql);
  const original = await f.submit(await f.start()), pending = retest(original);
  const [workspace] = await fixture.sql`SELECT privacy_epoch FROM workspaces WHERE id=${fixture.scope.workspaceId}`;
  const epoch = Number(workspace!.privacy_epoch);
  await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${fixture.scope.workspaceId}`;
  await expect(repo.saveCandidates(fixture.scope, [pending], epoch)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE id=${pending.id}`).toEqual([]);
  await expect(repo.saveCandidates({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, [pending])).rejects.toMatchObject({ code: "NOT_FOUND" });
});
