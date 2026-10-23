import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository, readOpeningLearningEvidenceContext, readOpeningBackupRecords, executeOpeningRestoreApply, OPENING_RESTORE_APPLY_ORDER } from "@aistudy/database";
import { learningAttemptContextReadSchema } from "@aistudy/contracts";
import { readOpeningAiGradingContext } from "../../packages/database/src/repositories/opening-ai-grading-context";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });

async function setup(scope = fixture.scope) {
  const courseId = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Text questions',${courseId})`;
  const learning = createOpeningLearningRepository(fixture.sql), attempts = createOpeningLearningAttemptRepository(fixture.sql);
  const session = await learning.createSession(scope, { courseId, skillLabel: "arithmetic", sourceIds: [] });
  const input = { sessionId: session.id, clientKey: randomUUID(), problem: { stemSnapshot: "计算 17 × 23", artifactKind: "reference_item" as const } };
  return { learning, attempts, session, input, courseId };
}

it("seals, reloads, submits and resolves grading only from the saved pasted question", async () => {
  const f = await setup(), attempt = await f.attempts.create(fixture.scope, f.input);
  expect(attempt).toMatchObject({ sourceIds: [], sourceVersions: {}, stemSnapshot: f.input.problem.stemSnapshot });
  expect(attempt.problemId).toBeTruthy(); expect(attempt.itemVersionId).toBeTruthy();
  expect(learningAttemptContextReadSchema.safeParse({ attempt, deliveredAssistance: "none" }).success).toBe(true);
  expect(await f.attempts.get(fixture.scope, attempt.id)).toEqual(attempt);
  expect((await f.attempts.create(fixture.scope, f.input)).id).toBe(attempt.id);
  await expect(f.attempts.create(fixture.scope, { ...f.input, problem: { ...f.input.problem, stemSnapshot: "changed client question" } })).rejects.toMatchObject({ code: "CONFLICT" });
  const observation = await f.learning.insertObservation(fixture.scope, {
    attemptId: attempt.id, sessionId: f.session.id, courseId: f.courseId, skillLabel: "arithmetic", sourceIds: [], problemId: attempt.problemId,
    answer: "391", outcome: "unverified", assistance: "independent", clientKey: randomUUID(),
  });
  expect(observation.eligibility).toMatchObject({ usableForCurrentVersion: "yes", verifiedCorrect: "unknown" });
  const grading = await fixture.sql.begin(tx => readOpeningAiGradingContext(tx, fixture.scope, { observationId: observation.id }));
  expect(grading).toMatchObject({ stem: f.input.problem.stemSnapshot, sourceIds: [], sourceVersions: {}, referenceText: "" });
  // Local text is not an update endpoint; changing the original ref invalidates
  // eligibility and cannot silently replace the captured grading question.
  await fixture.sql`UPDATE opening_problem_refs SET stem_snapshot='mutated original' WHERE problem_id=${attempt.problemId!}`;
  expect((await f.attempts.get(fixture.scope, attempt.id))?.stemSnapshot).toBe(f.input.problem.stemSnapshot);
  const context = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, observation);
  expect(context.context.version?.applicability).toBe("changed_needs_check");
  await expect(fixture.sql.begin(tx => readOpeningAiGradingContext(tx, fixture.scope, { observationId: observation.id }))).rejects.toMatchObject({ code: "CONFLICT" });
});

it("reuses a pasted problem and version on retry without crossing owner or course", async () => {
  const f = await setup(), first = await f.attempts.create(fixture.scope, f.input);
  const next = await f.attempts.create(fixture.scope, { sessionId: f.session.id, clientKey: randomUUID(), problemId: first.problemId });
  expect(next.id).not.toBe(first.id); expect(next.problemId).toBe(first.problemId); expect(next.itemVersionId).toBe(first.itemVersionId);
  expect(next.stemSnapshot).toBe(first.stemSnapshot);
  expect(await f.attempts.get(fixture.otherScope, first.id)).toBeNull();
  const foreign = await setup(fixture.otherScope);
  await expect(f.attempts.create(fixture.otherScope, { sessionId: foreign.session.id, problemId: first.problemId, clientKey: randomUUID() })).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(f.attempts.assertAccess(fixture.otherScope, first.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const other = await setup();
  await expect(f.attempts.create(fixture.scope, { sessionId: other.session.id, problemId: first.problemId, clientKey: randomUUID() })).rejects.toMatchObject({ code: "VALIDATION" });
});

it("keeps material and teaching origin pairs and material location constraints after migration", async () => {
  const f = await setup(), attempt = await f.attempts.create(fixture.scope, f.input);
  // The valid no-source records above exercise both relaxed checks; each broken
  // pair/location must still fail at the database boundary.
  for (const table of ["opening_problem_refs", "opening_learning_item_versions"]) {
    const idColumn = table === "opening_problem_refs" ? "problem_id" : "id";
    const id = table === "opening_problem_refs" ? attempt.problemId! : attempt.itemVersionId!;
    for (const change of ["source_version=1", "source_id='11111111-1111-4111-8111-111111111111'", "physical_page=1",
      "chunk_id='11111111-1111-4111-8111-111111111111'", "teaching_revision_id='11111111-1111-4111-8111-111111111111'",
      "teaching_block_id='11111111-1111-4111-8111-111111111111'"]) {
      await expect(fixture.sql.unsafe(`UPDATE ${table} SET ${change} WHERE ${idColumn}=$1`, [id])).rejects.toMatchObject({ code: "23514" });
    }
  }
});

it("exports and restores the saved no-source question and attempt without losing the stem", async () => {
  const f = await setup(), attempt = await f.attempts.create(fixture.scope, f.input);
  const observation = await f.learning.insertObservation(fixture.scope, { attemptId: attempt.id, sessionId: f.session.id, courseId: f.courseId,
    skillLabel: "arithmetic", sourceIds: [], problemId: attempt.problemId, answer: "391", outcome: "unverified", assistance: "independent", clientKey: randomUUID() });
  const snapshot = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(snapshot.tables.opening_problem_refs).toEqual(expect.arrayContaining([expect.objectContaining({ problem_id: attempt.problemId, source_id: null, stem_snapshot: attempt.stemSnapshot })]));
  expect(snapshot.tables.opening_learning_item_versions).toEqual(expect.arrayContaining([expect.objectContaining({ id: attempt.itemVersionId, source_id: null, stem_snapshot: attempt.stemSnapshot })]));
  expect(snapshot.tables.opening_learning_attempts).toEqual(expect.arrayContaining([expect.objectContaining({ id: attempt.id, item_version_id: attempt.itemVersionId })]));
  expect(snapshot.tables.opening_learning_observations).toEqual(expect.arrayContaining([expect.objectContaining({ id: observation.id, answer: "391" })]));
  const backup = { format: "opening-backup", version: 1, workspaceId: fixture.scope.workspaceId, ...snapshot, objects: [] };
  // Restore into the now-empty fixture namespace, retaining its owning identity.
  for (const table of [...OPENING_RESTORE_APPLY_ORDER].reverse()) {
    if (snapshot.tables[table as keyof typeof snapshot.tables]?.length) await fixture.sql`DELETE FROM ${fixture.sql(table)} WHERE workspace_id=${fixture.scope.workspaceId}`;
  }
  const current = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  const restored = await executeOpeningRestoreApply(fixture.sql, { confirmLocalRestore: true, backup,
    currentDeletionJournal: current.deletionJournal, currentMemoryDeletions: current.memoryDeletions,
    currentLearningState: { workspacePreferences: current.tables.workspace_preferences[0] ?? null, courses: current.tables.courses } });
  expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
  expect(await f.attempts.get(fixture.scope, attempt.id)).toMatchObject({ problemId: attempt.problemId, itemVersionId: attempt.itemVersionId, stemSnapshot: attempt.stemSnapshot, observationId: observation.id, sourceIds: [] });
  const grading = await fixture.sql.begin(tx => readOpeningAiGradingContext(tx, fixture.scope, { observationId: observation.id }));
  expect(grading.stem).toBe(attempt.stemSnapshot); expect(grading.observation.answer).toBe("391");
});

it("retains prior answer exposure when the same text is pasted again in another session", async () => {
  const f = await setup(), first = await f.attempts.create(fixture.scope, f.input);
  const rows = backupRows(fixture.sql, fixture.scope), conversationId = await rows.conversation(), turnId = await rows.turn(conversationId, []);
  await fixture.sql`UPDATE opening_turns SET learning_session_id=${f.session.id},attempt_id=${first.id} WHERE id=${turnId}`;
  await f.learning.insertHelpExposure(fixture.scope, { id: randomUUID(), sessionId: f.session.id, attemptId: first.id,
    problemId: first.problemId, turnId, kind: "solution", level: "revealed", delivered: true });
  const session = await f.learning.createSession(fixture.scope, { courseId: f.courseId, skillLabel: "arithmetic", sourceIds: [] });
  const second = await f.attempts.create(fixture.scope, { ...f.input, sessionId: session.id, clientKey: randomUUID(), problem: { ...f.input.problem, artifactKind: "unknown" } });
  expect(second.id).not.toBe(first.id); expect(second.problemId).toBe(first.problemId); expect(second.itemVersionId).toBe(first.itemVersionId);
  const record = await f.learning.insertObservation(fixture.scope, { attemptId: second.id, sessionId: session.id, courseId: f.courseId,
    skillLabel: "arithmetic", sourceIds: [], problemId: second.problemId, answer: "391", outcome: "correct", assistance: "independent", clientKey: randomUUID() });
  expect(record.eligibility?.reasonCodes).toContain("prior_answer_exposure");
  expect(record.eligibility?.usableForDelayedCheck).not.toBe("yes");
});
