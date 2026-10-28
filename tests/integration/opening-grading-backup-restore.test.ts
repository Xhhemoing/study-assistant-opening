/** Native PostgreSQL records round-trip (no model, HTTP or object-storage calls).
 * Uses the guarded integration database and only deletes fixture-owned rows.
 * Legacy cases explicitly omit 0093 columns from a REAL exported snapshot. */
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import type { AiGradingProposal, LearningObservation } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, executeOpeningRestoreApply, readOpeningBackupRecords,
  readLearningPreferences, readOpeningObservationHistory, readOpeningRestoreNamespaceCounts, reviseOpeningLearningObservation } from "@aistudy/database";
import { OPENING_RESTORE_APPLY_ORDER, type OpeningBackup } from "@aistudy/domain";
import { createOpeningAiGradingJobRepository } from "../../packages/database/src/repositories/opening-ai-grading-jobs";
import { createBackupFixture, type BackupFixture } from "./opening-backup-records-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

const fixtures: BackupFixture[] = [];
afterAll(async () => {
  for (const fixture of fixtures) {
    try { await emptyDurableNamespace(fixture); }
    finally { await fixture.dispose(); }
  }
}, 30_000);
const proposal: AiGradingProposal = { outcome: "correct", confidence: .95, questionMatch: true,
  feedback: "逐项核对了保存的作答照片。", criteria: [{ label: "计算", verdict: "correct", feedback: "步骤完整。" }] };
const metadataColumns = ["answer_revision", "grading_work_source", "grading_operation_id", "auto_grade_enqueued_at"] as const;
const paidTables = ["opening_jobs", "opening_outbox", "opening_budget_reservations", "opening_parent_interaction_budgets"] as const;
const legacyKey = (f: BackupFixture, id: string) => `ai-grade:${f.scope.workspaceId}:${id}`;

async function seed(photoAtSubmission = true) {
  const fixture = await createBackupFixture(); fixtures.push(fixture);
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const photoId = await fixture.rows.source();
  await fixture.sql`UPDATE opening_sources SET mime='image/png',parse_state='not_started' WHERE id=${photoId}`;
  const photo = { id: photoId, version: 1, physicalPage: 1 };
  const original = await f.learning.insertObservation(fixture.scope, {
    attemptId: attempt.id, sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId],
    answer: "1", outcome: "unverified", assistance: "independent", clientKey: randomUUID(),
  }, { ...(photoAtSubmission ? { workSource: photo } : {}), autoGrade: {
    enabled: true, modelAvailable: true, dailyCap: 50,
    primaryModel: { supportsVision: true, modelSnapshot: { id: "backup", providerId: "fixture", modelName: "fixture", inputCentsPerMillion: 0, outputCentsPerMillion: 0,
      mediaInputTokenUpperBound: 10000, mediaMaxInputBytes: 104857600, mediaInputCentsPerMillion: 0 },
      inputCentsPerMillion: 0, outputCentsPerMillion: 0, billing: "free_tier", dailyRequestCap: 10000 },
    dayStart: new Date(Date.now() - 86400000), dayEnd: new Date(Date.now() + 86400000),
  } });
  // This round-trip begins with an actually admitted photo-capable auto job;
  // changing only modelAvailable cannot bypass media capability/budget checks.
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE workspace_id=${fixture.scope.workspaceId}
    AND kind='grade-observation' AND payload->>'rootObservationId'=${original.id}`).toHaveLength(1);
  const [saved] = await fixture.sql`SELECT auto_grade_enqueued_at FROM opening_learning_observations WHERE id=${original.id}`;
  expect(saved?.auto_grade_enqueued_at).toBeTruthy();
  return { fixture, f, original, photo };
}
async function revise(fixture: BackupFixture, root: LearningObservation, previous: LearningObservation, answer: string) {
  const result = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: root.id, revisesObservationId: previous.id, expectedHead: previous.id,
    revisionKind: "replace", reason: "人工核对保存的答案", clientKey: randomUUID(),
    replacement: { answer, outcome: "incorrect", assistance: previous.assistance },
  });
  expect(result.observation).not.toBeNull();
  return result.observation!;
}
async function exportRecords(fixture: BackupFixture) {
  const records = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  for (const table of paidTables) expect(records.tables).not.toHaveProperty(table);
  // Exercise portable JSON values, not a handcrafted table inventory or the
  // alternate json_populate_recordset restore path used by some older tests.
  const backup = JSON.parse(JSON.stringify({ format: "opening-backup", version: 1,
    workspaceId: fixture.scope.workspaceId, privacyEpoch: records.privacyEpoch,
    deletionJournal: records.deletionJournal, memoryDeletions: records.memoryDeletions,
    tables: records.tables, objects: [],
  })) as OpeningBackup;
  return { records, backup };
}
async function emptyDurableNamespace(fixture: BackupFixture) {
  const { sql, scope } = fixture;
  await sql.begin(async tx => {
    for (const table of [...OPENING_RESTORE_APPLY_ORDER].reverse()) {
      if (table === "opening_source_chunks") {
        await tx`DELETE FROM opening_source_chunks WHERE source_id IN
          (SELECT id FROM opening_sources WHERE workspace_id=${scope.workspaceId})`;
      } else {
        await tx`DELETE FROM ${tx(table)} WHERE workspace_id=${scope.workspaceId}`;
      }
    }
  });
  const counts = await readOpeningRestoreNamespaceCounts(sql, scope.workspaceId);
  expect(Object.values(counts).every(count => count === 0), JSON.stringify(counts)).toBe(true);
}
async function apply(fixture: BackupFixture, backup: OpeningBackup) {
  // Read target facts independently after emptying; never treat archive values
  // as live privacy/preference evidence.
  const current = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  return executeOpeningRestoreApply(fixture.sql, { confirmLocalRestore: true, backup,
    currentDeletionJournal: current.deletionJournal, currentMemoryDeletions: current.memoryDeletions,
    currentLearningState: { workspacePreferences: current.tables.workspace_preferences[0] ?? null, courses: current.tables.courses },
  });
}
async function readRows(fixture: BackupFixture) {
  return fixture.sql`SELECT id,root_observation_id,revises_observation_id,effective_head_id,revision_kind,answer,source_ids,source_versions,
    answer_revision,grading_work_source,grading_operation_id,auto_grade_enqueued_at,ai_evaluation,server_evaluation,verdict_source,outcome,evidence_verdict
    FROM opening_learning_observations WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`;
}
async function reserveUnknown(fixture: BackupFixture, requestId: string) {
  await fixture.sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at)
    VALUES(${fixture.scope.workspaceId},'grading',1,${requestId},'reserved',now(),now())`;
}
async function ledgerRows(fixture: BackupFixture) {
  return fixture.sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY request_id`;
}

it.each(["revision", "legacy"] as const)("round-trips real grading columns and manual inheritance (%s key) without restoring paid execution", async kind => {
  const { fixture, f, original, photo } = await seed();
  const { sql, scope } = fixture, grades = createOpeningAiGradingRepository(sql);
  await sql`INSERT INTO workspace_preferences(workspace_id,auto_grade_on_save) VALUES(${scope.workspaceId},false)
    ON CONFLICT(workspace_id) DO UPDATE SET auto_grade_on_save=false`;
  const originalKey = legacyKey(fixture, original.id) + (kind === "revision" ? ":1" : "");
  // The legacy variant represents a migrated 0083 observation with an existing
  // row-based reservation key, not a new key synthesized in the archive.
  if (kind === "legacy") await sql`UPDATE opening_learning_observations SET grading_operation_id=${originalKey} WHERE id=${original.id}`;
  const graded = await grades.apply(scope, { observationId: original.id }, proposal, "saved-fixture-result");
  const manual = await revise(fixture, original, graded, graded.answer);
  const changed = await revise(fixture, original, manual, "2");
  const changedKey = `${legacyKey(fixture, original.id)}:2`;
  await createOpeningAiGradingJobRepository(sql).enqueue(scope, { observationId: changed.id });
  expect(await sql`SELECT id FROM opening_jobs WHERE workspace_id=${scope.workspaceId} AND kind='grade-observation'`).toHaveLength(2);
  await reserveUnknown(fixture, `${changedKey}:fallback`);
  await sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state)
    VALUES(${scope.workspaceId},'grading',1,${originalKey},'completed')`;

  const { records, backup } = await exportRecords(fixture);
  const exported = records.tables.opening_learning_observations;
  expect(records.tables.workspace_preferences[0]).toMatchObject({ auto_grade_on_save: false });
  expect(exported.find(row => row.id === original.id)?.auto_grade_enqueued_at).not.toBeNull();
  expect(exported.find(row => row.id === changed.id)?.auto_grade_enqueued_at).toBeNull();
  if (kind === "legacy") delete (backup.tables.workspace_preferences[0] as Record<string, unknown>).auto_grade_on_save;
  expect(exported).toHaveLength(4);
  for (const id of [original.id, graded.id, manual.id]) expect(exported.find(row => row.id === id))
    .toMatchObject({ answer_revision: 1, grading_work_source: photo, grading_operation_id: originalKey });
  expect(exported.find(row => row.id === changed.id)).toMatchObject({ answer_revision: 2, grading_operation_id: changedKey });
  expect(exported.find(row => row.id === graded.id)?.ai_evaluation).not.toBeNull();

  await emptyDurableNamespace(fixture);
  await sql`DELETE FROM opening_jobs WHERE workspace_id=${scope.workspaceId}`; // cascades only fixture outbox
  await sql`DELETE FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} AND request_id=${originalKey}`;
  const beforeLedger = await ledgerRows(fixture), pendingId = randomUUID();
  await sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload)
    VALUES(${pendingId},${scope.workspaceId},${scope.ownerUserId},${`preexisting:${pendingId}`},'grade-observation',
      ${sql.json({ observationId: changed.id, rootObservationId: original.id, answerRevision: 2 })})`;
  const result = await apply(fixture, backup);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, code: "APPLY_OK", pendingJobsCancelled: 1 });
  expect(await sql`SELECT auto_grade_on_save FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`)
    .toEqual([{ auto_grade_on_save: kind === "legacy" ? null : false }]);
  expect((await readLearningPreferences(sql, scope, f.courseId)).autoGradeOnSave).toBe(kind === "legacy");

  const restored = await readRows(fixture);
  expect(restored).toHaveLength(exported.length);
  for (const row of exported) {
    const expected = Object.fromEntries(["id", "root_observation_id", "revises_observation_id", "effective_head_id",
      "revision_kind", "answer", "source_ids", "source_versions", ...metadataColumns].map(column => [column, row[column]]));
    expect(restored.find(value => value.id === row.id)).toMatchObject(expected);
  }
  expect(restored.find(row => row.id === graded.id)).toMatchObject({ ai_evaluation: null, server_evaluation: null,
    verdict_source: "unknown", outcome: "unverified", evidence_verdict: "MASTERY_NOT_ESTABLISHED" });
  expect(restored.find(row => row.id === manual.id)).toMatchObject({ verdict_source: "self_report", outcome: "incorrect" });
  const history = await readOpeningObservationHistory(sql, scope, original.id);
  expect(history.headObservationId).toBe(changed.id);
  expect(history.revisions.map(row => row.id)).toEqual([original.id, graded.id, manual.id, changed.id]);
  expect((await f.attempts.get(scope, original.attemptId!))?.observationId).toBe(original.id);
  expect(await sql`SELECT id,state FROM opening_jobs WHERE workspace_id=${scope.workspaceId}`).toEqual([{ id: pendingId, state: "cancelled" }]);
  expect(await sql`SELECT id FROM opening_outbox WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
  expect(await ledgerRows(fixture)).toEqual(beforeLedger);
  const jobs = createOpeningAiGradingJobRepository(sql);
  expect(await jobs.read(scope, { observationId: changed.id })).toMatchObject({ answerRevision: 2, status: "unknown_cost", retryable: false, jobId: null });
  expect(await jobs.enqueue(scope, { observationId: changed.id })).toMatchObject({ status: "unknown_cost", retryable: false, jobId: null });
  expect(await grades.ledger(scope, changedKey)).toBe("unknown");
  expect(await sql`SELECT id FROM opening_jobs WHERE workspace_id=${scope.workspaceId}`).toEqual([{ id: pendingId }]);
  expect(await sql`SELECT id FROM opening_outbox WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
  expect(await ledgerRows(fixture)).toEqual(beforeLedger);
}, 30_000);

it("round-trips an unchanged manual legacy-key head and keeps its unknown reservation without a new job", async () => {
  const { fixture, original, photo } = await seed(), { sql, scope } = fixture;
  const operation = legacyKey(fixture, original.id);
  await sql`UPDATE opening_learning_observations SET grading_operation_id=${operation} WHERE id=${original.id}`;
  const manual = await revise(fixture, original, original, original.answer);
  await reserveUnknown(fixture, operation);
  const { backup } = await exportRecords(fixture);
  await emptyDurableNamespace(fixture);
  await sql`DELETE FROM opening_jobs WHERE workspace_id=${scope.workspaceId}`;
  const beforeLedger = await ledgerRows(fixture);
  const result = await apply(fixture, backup);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, pendingJobsCancelled: 0 });
  expect((await readRows(fixture)).find(row => row.id === manual.id)).toMatchObject({ answer_revision: 1,
    grading_operation_id: operation, grading_work_source: photo, ai_evaluation: null, verdict_source: "self_report", outcome: "incorrect" });
  expect((await readOpeningObservationHistory(sql, scope, original.id)).headObservationId).toBe(manual.id);
  expect(await createOpeningAiGradingJobRepository(sql).enqueue(scope, { observationId: manual.id }))
    .toMatchObject({ answerRevision: 1, status: "unknown_cost", retryable: false, jobId: null });
  expect(await sql`SELECT id FROM opening_jobs WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
  expect(await sql`SELECT id FROM opening_outbox WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
  expect(await ledgerRows(fixture)).toEqual(beforeLedger);
}, 30_000);

it("restores a legacy export with all 0093 fields absent, preserving photo versions, predecessor-paid keys and score downgrades", async () => {
  const { fixture, original, photo } = await seed(false), { sql, scope } = fixture;
  const grades = createOpeningAiGradingRepository(sql);
  const graded = await grades.apply(scope, { observationId: original.id, workSourceId: photo.id,
    workSourceVersion: photo.version, physicalPage: photo.physicalPage }, proposal, "saved-legacy-result");
  const changed = await revise(fixture, original, graded, "2");
  const head = await grades.apply(scope, { observationId: changed.id }, proposal, "saved-legacy-result");
  // A later source version must not rebind the archived answer photo to v2.
  await sql`UPDATE opening_sources SET version=2 WHERE id=${photo.id}`;
  const operation = legacyKey(fixture, changed.id);
  await reserveUnknown(fixture, operation);
  const { records, backup } = await exportRecords(fixture);
  expect(records.tables.opening_learning_observations).toHaveLength(4);
  expect(records.tables.opening_source_versions).toEqual(expect.arrayContaining([
    expect.objectContaining({ source_id: photo.id, version: 1 }), expect.objectContaining({ source_id: photo.id, version: 2 }),
  ]));
  // Deliberate compatibility projection of a real DB export, not a claimed
  // original pre-upgrade archive or a fabricated round-trip input.
  for (const row of backup.tables.opening_learning_observations as Record<string, unknown>[]) {
    for (const column of metadataColumns) delete row[column];
  }
  await emptyDurableNamespace(fixture);
  await sql`DELETE FROM opening_jobs WHERE workspace_id=${scope.workspaceId}`;
  const beforeLedger = await ledgerRows(fixture);
  const result = await apply(fixture, backup);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, pendingJobsCancelled: 0 });
  const restored = await readRows(fixture);
  expect(restored).toHaveLength(4);
  expect(restored.find(row => row.id === original.id)).toMatchObject({ answer_revision: 1, grading_work_source: null,
    grading_operation_id: legacyKey(fixture, original.id), effective_head_id: head.id });
  for (const [id, ordinal, key] of [[graded.id, 1, legacyKey(fixture, original.id)], [changed.id, 2, operation], [head.id, 2, operation]] as const) {
    expect(restored.find(row => row.id === id)).toMatchObject({ answer_revision: ordinal, grading_work_source: photo, grading_operation_id: key,
      source_versions: { [photo.id]: 1 } });
  }
  for (const id of [graded.id, head.id]) expect(restored.find(row => row.id === id)).toMatchObject({ ai_evaluation: null,
    verdict_source: "unknown", outcome: "unverified", evidence_verdict: "MASTERY_NOT_ESTABLISHED" });
  expect(await sql`SELECT version FROM opening_source_versions WHERE source_id=${photo.id} ORDER BY version`).toEqual([{ version: 1 }, { version: 2 }]);
  expect(await sql`SELECT version FROM opening_sources WHERE id=${photo.id}`).toEqual([{ version: 2 }]);
  expect((await readOpeningObservationHistory(sql, scope, original.id)).revisions.map(row => row.id))
    .toEqual([original.id, graded.id, changed.id, head.id]);
  expect(await grades.ledger(scope, operation)).toBe("unknown");
  expect(await createOpeningAiGradingJobRepository(sql).enqueue(scope, { observationId: head.id }))
    .toMatchObject({ status: "unknown_cost", retryable: false, answerRevision: 2, jobId: null });
  expect(await sql`SELECT id FROM opening_jobs WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
  expect(await sql`SELECT id FROM opening_outbox WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
  expect(await ledgerRows(fixture)).toEqual(beforeLedger);
  // A second export retains restored metadata even though AI authority is gone.
  const exportedAgain = await readOpeningBackupRecords(sql, scope);
  expect(exportedAgain.tables.opening_learning_observations.find(row => row.id === head.id))
    .toMatchObject({ answer_revision: 2, grading_work_source: photo, grading_operation_id: operation, ai_evaluation: null });
}, 30_000);

it("rejects altered identity/provenance and paid-table injection atomically without cancelling target jobs", async () => {
  const { fixture, original, photo } = await seed(), { sql, scope } = fixture;
  const operation = legacyKey(fixture, original.id);
  await sql`UPDATE opening_learning_observations SET grading_operation_id=${operation} WHERE id=${original.id}`;
  const manual = await revise(fixture, original, original, original.answer);
  await reserveUnknown(fixture, operation);
  const { backup } = await exportRecords(fixture);
  await emptyDurableNamespace(fixture);
  const beforeLedger = await ledgerRows(fixture);
  const jobsBefore = await sql`SELECT id,state FROM opening_jobs WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
  expect(jobsBefore.some(job => job.state === "queued")).toBe(true);
  const patches = [
    { answer: "different answer under the same revision" },
    { owner_user_id: fixture.otherScope.ownerUserId },
    { root_observation_id: manual.id },
    { grading_operation_id: `${operation}:1` },
    { grading_work_source: { ...photo, version: 2 } },
    { answer_revision: 2, grading_operation_id: `${operation}:2` },
    { effective_head_id: original.id },
  ];
  for (const patch of patches) {
    const damaged = structuredClone(backup);
    const row = (damaged.tables.opening_learning_observations as Record<string, unknown>[]).find(value => value.id === manual.id)!;
    Object.assign(row, patch);
    const result = await apply(fixture, damaged);
    expect(result, JSON.stringify({ patch, result })).toMatchObject({ ok: false, mutated: false });
    expect(await readRows(fixture)).toEqual([]);
    expect(Object.values(await readOpeningRestoreNamespaceCounts(sql, scope.workspaceId)).every(count => count === 0)).toBe(true);
  }
  // A whole internally consistent chain owned by someone else must also fail,
  // not merely a predecessor-to-successor owner mismatch.
  const foreignOwner = structuredClone(backup);
  for (const rows of Object.values(foreignOwner.tables)) for (const row of rows as Record<string, unknown>[]) {
    if ("owner_user_id" in row) row.owner_user_id = fixture.otherScope.ownerUserId;
  }
  expect(await apply(fixture, foreignOwner)).toMatchObject({ ok: false, mutated: false });
  expect(await readRows(fixture)).toEqual([]);
  for (const table of paidTables) {
    const damaged = structuredClone(backup);
    damaged.tables[table] = []; // Even an empty forbidden inventory is refused.
    expect(await apply(fixture, damaged)).toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED", mutated: false });
  }
  expect(await sql`SELECT id,state FROM opening_jobs WHERE workspace_id=${scope.workspaceId} ORDER BY id`).toEqual(jobsBefore);
  expect(await ledgerRows(fixture)).toEqual(beforeLedger);
}, 30_000);
