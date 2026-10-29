import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import type { SpanLessonCreateInput } from "@aistudy/contracts";
import { createOpeningBackupReader, createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningPlansRepository, createOpeningRetestRepository,
  createOpeningSpanSessionRepository, createOpeningS3RestoreObjectPut, createWorkspacePreferencesRepository,
  executeOpeningRestoreApply, exportOpeningBackup, OPENING_RESTORE_APPLY_ORDER, publishOpeningBackupArchive,
  readLearningPreferences, readOpeningBackupRecords, readOpeningRestoreNamespaceCounts } from "@aistudy/database";
import { getSpanProblem, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";
import { readOpeningBackupArchive } from "../../packages/database/src/storage/opening-backup-archive";
import { createSpanDelayedRetestService } from "../../apps/web/src/features/opening/teaching/span/delayed-retest-service";
import { createSpanHintService } from "../../apps/web/src/features/opening/teaching/span/hint-service";
import { createSpanReservedService } from "../../apps/web/src/features/opening/teaching/span/reserved-service";
import { backupRows, sourceBytes, sourceHash } from "./opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { createOpeningTestStorage } from "./opening-storage-fixture";

let fixture: OpeningFixture;
const storage = createOpeningTestStorage(), objectKeys = new Set<string>();
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => {
  try { for (const key of objectKeys) await storage.deleteObject(key); }
  finally { objectKeys.clear(); await fixture?.close(); }
});
afterAll(() => { if (storage.client instanceof S3Client) storage.client.destroy(); });
const intent: SpanLessonCreateInput["intent"] = {
  purpose: "self_study", timeBudgetMinutes: 15, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown",
};

async function seed() {
  const { sql, scope } = fixture;
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope,
    { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const sourceId = await backupRows(sql, scope).source(), courseId = randomUUID();
  await backupRows(sql, scope).chunk(sourceId);
  const key = storage.finalKey(sourceId, 1); objectKeys.add(key);
  await storage.putObject(key, sourceBytes, { mime: "text/plain" });
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${scope.workspaceId},'Span backup continuity',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const lessons = createOpeningSpanSessionRepository(sql), attempts = createOpeningLearningAttemptRepository(sql);
  const lesson = await lessons.create(scope, { courseId, sourceIds: [sourceId], intent, clientKey: randomUUID() });
  const attempt = await attempts.create(scope, { sessionId: lesson.sessionId, clientKey: randomUUID(),
    spanExercise: { sourceId, problemId: "span-example-2d", version: 1 } });
  await createSpanHintService(sql).read(scope, { attemptId: attempt.id, level: 1 });
  const problem = getSpanProblem("span-example-2d")!;
  const answer = JSON.stringify({ membership: "in_span", coefficients: ["3", "-1/2"],
    equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: ["3", "-1"] });
  const record = await createOpeningLearningRepository(sql).insertObservation(scope, { sessionId: lesson.sessionId,
    courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId], attemptId: attempt.id, problemId: attempt.problemId,
    clientKey: randomUUID(), assistance: "hinted", outcome: "unverified", verdictSource: "self_report", answer });
  expect(record).toMatchObject({ outcome: "correct", assistance: "hinted" });
  const pendingInput = { sessionId: lesson.sessionId, sourceId, clientKey: randomUUID(), mode: "overview" as const };
  const pending = await createSpanReservedService(sql).issue(scope, pendingInput);
  expect(pending.spanExercise?.id).toBe("span-reserved-dependent");
  // Display every remaining fixed item, then leave a generated question unsubmitted.
  for (const p of listSpanReservedProblems()) if (p.id !== pending.spanExercise?.id) await attempts.create(scope,
    { sessionId: lesson.sessionId, clientKey: randomUUID(), spanExercise: { sourceId, problemId: p.id, version: Number(p.version) } });
  const generated = await createSpanReservedService(sql).issue(scope, { ...pendingInput, clientKey: randomUUID() });
  expect(generated.spanExercise?.id).toContain("generated-validation-");
  const paused = await lessons.save(scope, lesson.activityId, { expectedRevision: lesson.revision, intent,
    moveId: "self-independent", status: "paused" });
  const request = { observationId: record.id, clientKey: randomUUID() };
  const scheduled = await createSpanDelayedRetestService(sql).schedule(scope, request);
  const delayed = await lessons.create(scope, { courseId, sourceIds: [sourceId], intent, clientKey: randomUUID(), retestId: scheduled.candidateId });
  return { sourceId, key, courseId, attempt, answer, record, pendingInput, pending, generated, paused, request, scheduled, delayed };
}

/** Clear only this guarded fixture workspace, in the production restore dependency order. */
async function emptyWorkspace(sourceId: string) {
  const { sql, scope } = fixture, snapshot = await readOpeningBackupRecords(sql, scope);
  await sql.begin(async tx => {
    await tx`DELETE FROM opening_jobs WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    for (const table of [...OPENING_RESTORE_APPLY_ORDER].reverse()) {
      if (!snapshot.tables[table]?.length) continue;
      if (table === "opening_source_chunks") await tx`DELETE FROM opening_source_chunks WHERE source_id=${sourceId}`;
      else await tx`DELETE FROM ${tx(table)} WHERE workspace_id=${scope.workspaceId}`;
    }
  });
  const counts = await readOpeningRestoreNamespaceCounts(sql, scope.workspaceId);
  expect(Object.values(counts).every(value => value === 0)).toBe(true);
}

it.each(["completed", "cancelled"] as const)("restores a real archive and prevents the %s delayed cycle from being regenerated", async terminalStatus => {
  const f = await seed(), { sql, scope } = fixture;
  const scratch = await mkdtemp(path.join(tmpdir(), "span-backup-restore-"));
  try {
    const backup = await exportOpeningBackup(sql, scope, scratch, createOpeningBackupReader(storage));
    const exported = (backup.tables.opening_retest_activities as Array<Record<string, unknown>>).find(row => row.id === f.scheduled.activityId)!;
    expect(exported).toMatchObject({ candidate_id: null, candidate_reference_id: f.scheduled.candidateId,
      accept_client_key: f.request.clientKey, learning_protocol: { protocolId: "span-delayed-3d-v1",
        baselineObservationId: f.record.id, baselineRootId: f.record.rootObservationId, priorAnswerPolicy: "require_unseen_problem" } });
    for (const table of ["opening_jobs", "opening_tutor_jobs", "opening_outbox", "opening_budget_reservations", "sessions"]) {
      expect(backup.tables).not.toHaveProperty(table);
    }
    const directory = (await readdir(scratch)).find(name => name.startsWith("opening-backup-"));
    expect(directory).toBeTruthy();
    const archivePath = path.join(scratch, "span.opening");
    await publishOpeningBackupArchive(backup, path.join(scratch, directory!), archivePath);
    const archive = await readOpeningBackupArchive(archivePath);
    try {
      const bodies = new Map<string, Uint8Array>();
      for (const object of archive.metadata.objects) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of archive.objectBytes(object.archivePath)) chunks.push(chunk);
        bodies.set(object.archivePath, Buffer.concat(chunks));
      }
      await emptyWorkspace(f.sourceId);
      await storage.deleteObject(f.key);
      const live = await readOpeningBackupRecords(sql, scope);
      const restored = await executeOpeningRestoreApply(sql, { confirmLocalRestore: true, backup: archive.metadata,
        currentDeletionJournal: live.deletionJournal, currentMemoryDeletions: live.memoryDeletions,
        currentLearningState: { workspacePreferences: null, courses: [] }, objectBodies: bodies,
        objectPut: createOpeningS3RestoreObjectPut(storage) });
      expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true, objectApplyDeferred: false, objectsApplied: 1 });
    } finally { await archive.close(); }
    expect((await storage.streamDigest(f.key)).sha256).toBe(sourceHash);
    const lessons = createOpeningSpanSessionRepository(sql);
    expect(await lessons.get(scope, f.paused.activityId)).toEqual(f.paused);
    expect(await lessons.latest(scope, f.courseId, f.scheduled.candidateId)).toMatchObject({ activityId: f.delayed.activityId, sessionId: f.delayed.sessionId });
    expect(await lessons.latest(scope, f.courseId, f.scheduled.activityId)).toMatchObject({ activityId: f.delayed.activityId });
    const [restoredAnswer] = await sql`SELECT id,answer,outcome,verdict_source,server_evaluation FROM opening_learning_observations
      WHERE id=${f.record.id} AND workspace_id=${scope.workspaceId}`;
    // Imported data keeps the answer but never grants itself server grading authority.
    expect(restoredAnswer).toEqual({ id: f.record.id, answer: f.answer, outcome: "unverified", verdict_source: "unknown", server_evaluation: null });
    const attempts = createOpeningLearningAttemptRepository(sql);
    for (const original of [f.attempt, f.pending, f.generated]) {
      expect(await attempts.get(scope, original.id)).toMatchObject({ id: original.id, spanExercise: original.spanExercise,
        spanValidation: { eligible: false, firstFamilyExposure: false, reasonCode: "restored_identity_unverified" } });
      expect(await sql`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${original.itemVersionId}`).toEqual([{ evaluation_spec: null }]);
    }
    expect(await createSpanReservedService(sql).issue(scope, f.pendingInput)).toMatchObject({ id: f.pending.id, submittedAt: null, observationId: null,
      spanExercise: f.pending.spanExercise, spanValidation: { eligible: false, firstFamilyExposure: false } });
    const beforeHelp = await sql`SELECT id,released_at FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
    expect(await lessons.deliveredHintLevels(scope, f.paused.activityId)).toEqual({ [f.attempt.id]: [1] });
    expect(await sql`SELECT id,released_at FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} ORDER BY id`).toEqual(beforeHelp);
    expect(await createSpanDelayedRetestService(sql).schedule(scope, f.request)).toEqual(f.scheduled);
    const [activity] = await sql`SELECT learning_protocol,not_before_at,candidate_id FROM opening_retest_activities WHERE id=${f.scheduled.activityId}`;
    expect(activity!.candidate_id).toBeNull();
    expect(activity!.learning_protocol).toEqual(exported.learning_protocol);
    expect(new Date(activity!.not_before_at).getTime()).toBeGreaterThanOrEqual(Date.parse(f.record.recordedAt!) + 72 * 3600000);
    await expect(createSpanReservedService(sql).issue(scope, { sessionId: f.delayed.sessionId, sourceId: f.sourceId,
      clientKey: randomUUID(), mode: "self_study" })).rejects.toMatchObject({ businessCode: "RETEST_SUBMIT_TOO_EARLY" });
    expect(await sql`SELECT id FROM opening_learning_attempts WHERE session_id=${f.delayed.sessionId}`).toHaveLength(0);
    expect(await sql`SELECT id FROM opening_jobs WHERE workspace_id=${scope.workspaceId}`).toHaveLength(0);
    expect(await sql`SELECT id FROM opening_outbox WHERE workspace_id=${scope.workspaceId}`).toHaveLength(0);
    // A fresh server-issued attempt may be evaluated, but restored prior exposure
    // still prevents calling the repeated question or its family independent.
    const freshLesson = await lessons.create(scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent, clientKey: randomUUID() });
    const repeated = await attempts.create(scope, { sessionId: freshLesson.sessionId, clientKey: randomUUID(),
      spanExercise: { sourceId: f.sourceId, problemId: "span-example-2d", version: 1 } });
    expect(repeated.spanValidation).toMatchObject({ eligible: false, firstFamilyExposure: false });
    const repeatedRecord = await createOpeningLearningRepository(sql).insertObservation(scope, { sessionId: freshLesson.sessionId,
      courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId], attemptId: repeated.id, problemId: repeated.problemId,
      clientKey: randomUUID(), assistance: "independent", outcome: "unverified", verdictSource: "self_report", answer: f.answer });
    expect(repeatedRecord).toMatchObject({ outcome: "correct", assistance: "hinted" });
    const nextReserved = await createSpanReservedService(sql).issue(scope, { sessionId: freshLesson.sessionId,
      sourceId: f.sourceId, clientKey: randomUUID(), mode: "overview" });
    expect(nextReserved.spanExercise?.familyId).toBeTruthy();
    expect(nextReserved.spanExercise?.id).toContain("generated-validation-");
    expect(nextReserved.spanExercise?.id).not.toBe(f.generated.spanExercise?.id);
    expect(nextReserved.spanValidation).toMatchObject({ eligible: false, firstFamilyExposure: false });
    const existingJobs = await sql`SELECT * FROM opening_jobs WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
    const existingOutbox = await sql`SELECT * FROM opening_outbox WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
    expect(existingJobs.some(row => row.id === f.scheduled.candidateId)).toBe(false);
    const [task] = await sql`SELECT version FROM opening_tasks WHERE id=${f.scheduled.taskId} AND workspace_id=${scope.workspaceId}`;
    await createOpeningPlansRepository(sql).updateTaskStatus(scope, f.scheduled.taskId, {
      expectedVersion: Number(task!.version), status: terminalStatus === "completed" ? "done" : "skipped", at: new Date().toISOString(),
    });
    expect((await readLearningPreferences(sql, scope, f.courseId)).retestSuggestionsEnabled).toBe(true);
    const terminal = await sql`SELECT * FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ id: f.scheduled.activityId, status: terminalStatus, candidate_id: null,
      learning_protocol: exported.learning_protocol, accept_client_key: f.request.clientKey });
    const taskIds = await sql`SELECT id FROM opening_tasks WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
    expect(taskIds).toEqual([{ id: f.scheduled.taskId }]);
    // The worker may retry with a different candidate ID. A restored terminal
    // baseline remains negative history even though its transport job is absent.
    const retryCandidateIds = [randomUUID(), randomUUID()];
    for (const id of retryCandidateIds) {
      expect(await createOpeningRetestRepository(sql).saveCandidates(scope, [{ id, courseId: f.courseId,
        skillLabel: SPAN_SKILL_LABEL, requirementKey: SPAN_REQUIREMENT_KEY, prompt: "Repeat scan of the original baseline",
        sourceIds: [f.sourceId], dueAt: f.scheduled.notBeforeAt, accepted: false, kind: "task",
        evidenceObservationIds: [f.record.id], evidenceRootIds: [f.record.rootObservationId ?? f.record.id] }])).toEqual([]);
    }
    // Replaying the immutable acceptance returns the same business identity
    // with its current terminal state, rather than an obsolete pending receipt.
    const terminalReceipt = { ...f.scheduled, taskStatus: terminalStatus === "completed" ? "done" : "skipped", activityStatus: terminalStatus };
    expect(await createSpanDelayedRetestService(sql).schedule(scope, f.request)).toEqual(terminalReceipt);
    expect(await createSpanDelayedRetestService(sql).schedule(scope, f.request)).toEqual(terminalReceipt);
    expect(await sql`SELECT * FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId} ORDER BY id`).toEqual(terminal);
    expect(await sql`SELECT id FROM opening_tasks WHERE workspace_id=${scope.workspaceId} ORDER BY id`).toEqual(taskIds);
    // Preserve legitimate scan jobs emitted by the new practice above.
    expect(await sql`SELECT * FROM opening_jobs WHERE workspace_id=${scope.workspaceId} ORDER BY id`).toEqual(existingJobs);
    expect(await sql`SELECT * FROM opening_outbox WHERE workspace_id=${scope.workspaceId} ORDER BY id`).toEqual(existingOutbox);
    expect(await sql`SELECT id FROM opening_jobs WHERE workspace_id=${scope.workspaceId}
      AND id IN ${sql([f.scheduled.candidateId, ...retryCandidateIds])}`).toHaveLength(0);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
