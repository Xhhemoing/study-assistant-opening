import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningRetestRepository, createWorkspacePreferencesRepository, readOpeningCourseEvidence } from "@aistudy/database";
import { summarizeObservations } from "@aistudy/domain";
import { createOpeningLearningReadService } from "../../apps/web/src/features/opening/learning/read-service";
import { createRetestCandidateHandler } from "../../apps/worker/src/jobs/retest-candidate";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });

describe("opening course evidence consumers", () => {
  it("reads the persisted facts and shares write/read/worker qualifications", async () => {
    const f = await learningAttemptFixture(fixture);
    const attempt = await f.start();
    const observation = await f.submit(attempt, { verdictSource: "reference_checked", referenceSourceId: f.sourceId,
      referenceCheck: { referenceSourceId: f.sourceId, method: "Compare each answer step", scope: "whole_answer" } });
    const readCourseEvidence = () => readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId);
    const evidence = await readCourseEvidence();
    expect(evidence.observations[0]).toMatchObject({ attemptId: attempt.id, itemVersionId: attempt.itemVersionId, sourceVersions: attempt.sourceVersions, outcome: "correct" });
    const read = createOpeningLearningReadService({ readCourseObservationHeads: async () => [], assertOwnedCourse: (scope, id) => f.learning.assertOwnedCourse(scope, id), readCourseEvidence });
    const summary = await read.summarizeLearning(fixture.scope, f.courseId);
    expect(summary[0]?.evidenceEligibility?.[0]?.eligibility).toEqual(observation.eligibility);
    expect(summary[0]?.status).toBe("observed_independent");
    const worker = createRetestCandidateHandler({ readCourseEvidence, listDueRetests: async () => [], saveCandidates: async (_scope, candidates) => candidates });
    const job = { id: randomUUID(), ...fixture.scope, key: "shared-evidence", kind: "retest", state: "running", privacyEpoch: 0, payload: {}, result: null };
    expect((await worker(job, { courseId: f.courseId, promptsBySkill: { fractions: "Try another fractions problem" } })).candidates).toEqual([]);
    await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
    const changed = await read.summarizeLearning(fixture.scope, f.courseId);
    expect(changed[0]?.status).toBe("needs_check");
    expect(changed[0]?.evidenceIds).toEqual([observation.id]);
    expect(changed[0]?.evidenceEligibility?.[0]?.eligibility.reasonCodes).toContain("version_changed_needs_check");
    expect(changed).toEqual(summarizeObservations((await readCourseEvidence()).observations, new Date().toISOString(), { evidenceContexts: (await readCourseEvidence()).evidenceContexts }));
  });

  it("keeps legacy observations unknown and isolates ownership and courses", async () => {
    const f = await learningAttemptFixture(fixture);
    const legacy = await f.learning.insertObservation(fixture.scope, { sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId], answer: "1", outcome: "correct", assistance: "independent", clientKey: randomUUID(), verdictSource: "reference_checked", referenceSourceId: f.sourceId });
    const evidence = await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId);
    const summary = summarizeObservations(evidence.observations, new Date().toISOString(), { evidenceContexts: evidence.evidenceContexts });
    expect(summary[0]?.evidenceEligibility[0]?.eligibility).toEqual(legacy.eligibility);
    expect(summary[0]?.status).toBe("needs_check");
    expect((await readOpeningCourseEvidence(fixture.sql, fixture.otherScope, f.courseId)).observations).toEqual([]);
    expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, randomUUID())).observations).toEqual([]);
  });

  it("keeps accepted activity identity and ignores malformed historical payloads", async () => {
    await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
    const f = await learningAttemptFixture(fixture);
    const repo = createOpeningRetestRepository(fixture.sql);
    const candidate = { id: randomUUID(), courseId: f.courseId, skillLabel: "fractions", requirementKey: "requirement-a", sourceIds: [f.sourceId], prompt: "Try another fractions problem", accepted: false, dueAt: new Date().toISOString() };
    await repo.saveCandidates(fixture.scope, [candidate]);
    await repo.accept(fixture.scope, candidate.id, "accept-candidate");
    expect(await repo.listAcceptedEvidence(fixture.scope, f.courseId)).toEqual([{ courseId: f.courseId, skillLabel: "fractions", requirementKey: "requirement-a" }]);
    expect(await repo.listAcceptedEvidence(fixture.otherScope, f.courseId)).toEqual([]);
    await fixture.sql`UPDATE opening_jobs SET payload=payload-'requirementKey' WHERE id=${candidate.id}`;
    // The persisted activity owns the identity once the candidate has been
    // proposed. Mutating the legacy job payload must not change it.
    expect(await repo.listAcceptedEvidence(fixture.scope, f.courseId)).toEqual([{ courseId: f.courseId, skillLabel: "fractions", requirementKey: "requirement-a" }]);

    // A pre-activity accepted job remains readable when its payload is valid.
    // It has no activity row, so it exercises the legacy compatibility path.
    const legacyId = randomUUID();
    await fixture.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state, privacy_epoch)
      VALUES (${legacyId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${`retest:${legacyId}`}, 'retest', ${fixture.sql.json({
        id: legacyId, kind: "task", courseId: f.courseId, skillLabel: "ratios", requirementKey: "legacy-requirement",
        sourceIds: [f.sourceId], prompt: "Legacy retest", dueAt: new Date().toISOString(), accepted: true,
      } as never)}, 'succeeded', 0)`;
    expect(await repo.listAcceptedEvidence(fixture.scope, f.courseId)).toEqual(expect.arrayContaining([
      { courseId: f.courseId, skillLabel: "fractions", requirementKey: "requirement-a" },
      { courseId: f.courseId, skillLabel: "ratios", requirementKey: "legacy-requirement" },
    ]));

    // Malformed historical payloads are ignored without affecting the
    // persisted activity identity.
    await fixture.sql`UPDATE opening_jobs SET payload='{"accepted":true,"skillLabel":77}'::jsonb WHERE id=${legacyId}`;
    expect(await repo.listAcceptedEvidence(fixture.scope, f.courseId)).toEqual([
      { courseId: f.courseId, skillLabel: "fractions", requirementKey: "requirement-a" },
    ]);
  });

  it("does not mask evidence query failures as an empty course", async () => {
    const failure = new Error("database unavailable");
    const broken = { begin: vi.fn(async () => { throw failure; }) };
    await expect(readOpeningCourseEvidence(broken as never, fixture.scope, randomUUID())).rejects.toBe(failure);
  });
});

it("excludes privacy-filtered legacy records before summary counts or candidate generation", async () => {
  const f = await learningAttemptFixture(fixture);
  const record = await f.learning.insertObservation(fixture.scope, { sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId], answer: "private answer", outcome: "correct", assistance: "independent", clientKey: randomUUID() });
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${fixture.scope.workspaceId},${f.sourceId})`;
  const evidence = await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId);
  expect(evidence).toEqual({ observations: [], evidenceContexts: {} });
  expect(summarizeObservations(evidence.observations, new Date().toISOString(), { evidenceContexts: evidence.evidenceContexts })).toEqual([]);
  const rows = await fixture.sql`SELECT id FROM opening_learning_observations WHERE id=${record.id}`;
  expect(rows).toHaveLength(1);
});

it("keeps unavailable legacy history visible without proposing an unusable reference", async () => {
  const f = await learningAttemptFixture(fixture);
  const record = await f.learning.insertObservation(fixture.scope, { sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId], answer: "1", outcome: "correct", assistance: "independent", clientKey: randomUUID() });
  await fixture.sql`UPDATE opening_sources SET upload_state='pending' WHERE id=${f.sourceId}`;
  const readCourseEvidence = () => readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId);
  const evidence = await readCourseEvidence();
  expect(evidence.observations[0]?.id).toBe(record.id);
  expect(evidence.evidenceContexts[record.id]?.context.version?.applicability).toBe("unavailable");
  const worker = createRetestCandidateHandler({ readCourseEvidence, listDueRetests: async () => [], saveCandidates: async (_scope, candidates) => candidates });
  const job = { id: randomUUID(), ...fixture.scope, key: "unavailable-source", kind: "retest", state: "running", privacyEpoch: 0, payload: {}, result: null };
  expect((await worker(job, { courseId: f.courseId, promptsBySkill: { fractions: "Try another fractions problem" } })).candidates).toEqual([]);
});

it.each([false, true])("hides a legacy reference-only record after privacy exclusion (source deleted: %s)", async (deleteSource) => {
  const f = await learningAttemptFixture(fixture);
  const record = await f.learning.insertObservation(fixture.scope, {
    sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [],
    referenceSourceId: f.sourceId, verdictSource: "reference_checked", answer: "private reference-based answer",
    outcome: "correct", assistance: "independent", clientKey: randomUUID(),
  });
  expect(record.sourceIds).toEqual([]);
  expect(record.referenceSourceId).toBe(f.sourceId);
  expect(record.attemptId).toBeNull();
  const readCourseEvidence = () => readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId);
  expect((await readCourseEvidence()).observations.map((row) => row.id)).toEqual([record.id]);
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${fixture.scope.workspaceId},${f.sourceId})`;
  if (deleteSource) {
    await fixture.sql`DELETE FROM opening_sources WHERE id=${f.sourceId}`;
    expect(await fixture.sql`SELECT id FROM opening_sources WHERE id=${f.sourceId}`).toHaveLength(0);
  }
  expect(await fixture.sql`SELECT source_id FROM opening_privacy_exclusions WHERE workspace_id=${fixture.scope.workspaceId} AND source_id=${f.sourceId}`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE id=${record.id}`).toHaveLength(1);
  expect(await readCourseEvidence()).toEqual({ observations: [], evidenceContexts: {} });
  const read = createOpeningLearningReadService({ readCourseObservationHeads: async () => [], assertOwnedCourse: (scope, id) => f.learning.assertOwnedCourse(scope, id), readCourseEvidence });
  expect(await read.summarizeLearning(fixture.scope, f.courseId)).toEqual([]);
  const worker = createRetestCandidateHandler({ readCourseEvidence, listDueRetests: async () => [], saveCandidates: async (_scope, candidates) => candidates });
  const job = { id: randomUUID(), ...fixture.scope, key: "excluded-reference-source", kind: "retest", state: "running", privacyEpoch: 0, payload: {}, result: null };
  expect((await worker(job, { courseId: f.courseId, promptsBySkill: { fractions: "Try another fractions problem" }, sourceIdsBySkill: { fractions: [f.sourceId] } })).candidates).toEqual([]);
});
