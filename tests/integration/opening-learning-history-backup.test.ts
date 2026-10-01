import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningSourceRepository, createOpeningLearningRepository, readOpeningObservationHistory, reviseOpeningLearningObservation, readOpeningCourseEvidence } from "@aistudy/database";
import { composeOpeningBackupDraft } from "@aistudy/domain";
import { planOpeningRestoreApply } from "../../packages/domain/src/opening/backup-apply-plan";
import { normalizeOpeningRestoreHistory } from "../../packages/domain/src/opening/backup-policy";
import { readOpeningCourseLearningHistory } from "../../packages/database/src/repositories/opening-learning-history-read";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { sourceBytes } from "./opening-backup-records-fixture";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { prepareOpeningSourceBackup } from "../../packages/database/src/repositories/opening-backup-prepare";
import { writeOpeningBackupArchive, readOpeningBackupArchive } from "../../packages/database/src/storage/opening-backup-archive";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createOpeningTestStorage } from "./opening-storage-fixture";
import { createOpeningBackupReader } from "../../packages/database/src/storage/opening-backup-reader";
const storage=createOpeningTestStorage(), reader=createOpeningBackupReader(storage);
const objectKeys=new Set<string>();
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions, opening_learning_item_versions, opening_learning_history_revisions, opening_workspace_history_revisions, opening_source_versions, opening_conversations CASCADE`; });
afterAll(async () => {
  try { for(const key of objectKeys) await storage.deleteObject(key); }
  finally { if(storage.client instanceof S3Client) storage.client.destroy(); await fixture?.close(); }
});
it.each(["complete", "completeWithParseJob"])("captures immutable finalized source metadata through %s", async method => {
  const repo = createOpeningSourceRepository(fixture.sql);
  const actual = { bytes: 4, sha256: "ab".repeat(32), mime: "application/pdf" as const };
  const source = await repo.create(fixture.scope, { ...actual, name: "version.pdf" });
  expect(await fixture.sql`SELECT * FROM opening_source_versions WHERE source_id=${source.id}`).toHaveLength(0);
  if (method === "complete") await repo.complete(fixture.scope, source.id, actual);
  else await repo.completeWithParseJob(fixture.scope, source.id, { actual, key: source.id, payload: {}, privacyEpoch: 0 });
  expect(await fixture.sql`SELECT * FROM opening_source_versions WHERE source_id=${source.id}`).toMatchObject([
    { version: 0, bytes: "4", sha256: actual.sha256, availability: "available" },
  ]);
});
it.each([false,true])("restores attempt facts, revision and historical objects in dependency order (missing=%s)", async missing => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const exposure = await f.help(attempt), observation = await f.submit(attempt);
  const revisionInput = { rootObservationId: observation.id, revisesObservationId: observation.id, expectedHead: observation.id,
    revisionKind: "replace" as const, reason: "Correct answer", clientKey: randomUUID(), replacement: { answer: "2", outcome: "incorrect" as const, assistance: "independent" as const } };
  const revised = await reviseOpeningLearningObservation(fixture.sql,fixture.scope,revisionInput);
  const retractInput = { rootObservationId: observation.id, revisesObservationId: revised.headObservationId, expectedHead: revised.headObservationId,
    revisionKind: "retract" as const, reason: "Withdraw duplicate attempt", clientKey: randomUUID() };
  const retracted = await reviseOpeningLearningObservation(fixture.sql,fixture.scope,retractInput);
  const currentBytes = Buffer.from("new source version", "utf8"), currentHash = createHash("sha256").update(currentBytes).digest("hex");
  await fixture.sql`UPDATE opening_sources SET version=2, bytes=${currentBytes.length},sha256=${currentHash} WHERE id=${f.sourceId}`;
  const directory = await mkdtemp(path.join(tmpdir(), "learning-history-"));
  try {
    const records = await readOpeningBackupRecords(fixture.sql, fixture.scope);
    expect(records.tables.opening_learning_attempts).toMatchObject([{ id: attempt.id, item_version_id: attempt.itemVersionId }]);
    expect(records.tables.opening_help_exposures).toMatchObject([{ id: exposure.id, attempt_id: attempt.id }]);
    expect(records.tables.opening_learning_observations).toHaveLength(3);
    // The delivered help exposure is also a learning-semantic fact, so it occupies workspace revision 1
    // and the three observation facts continue at 2–4 (valid gaps are expected in fixed-R history).
    expect(records.tables.opening_learning_observations.map(row => row.workspace_history_revision).sort()).toEqual([2, 3, 4]);
    expect(records.tables.opening_workspace_history_revisions).toEqual([
      { workspace_id: fixture.scope.workspaceId, owner_user_id: fixture.scope.ownerUserId, revision: 4 },
    ]);
    expect(records.tables.opening_learning_observations).toEqual(expect.arrayContaining([expect.objectContaining({ id: observation.id, effective_head_id: retracted.headObservationId, source_versions: { [f.sourceId]: 1 } })]));
    for (const [version,bytes] of [[1,sourceBytes],[2,currentBytes]] as const) {
      if(version===1 && missing) continue;
      const key=storage.finalKey(f.sourceId,version); objectKeys.add(key);
      await storage.client.send(new PutObjectCommand({Bucket:storage.bucket,Key:key,Body:bytes}));
    }
    const staging = await prepareOpeningSourceBackup(fixture.sql, fixture.scope, directory, reader);
    const composed = composeOpeningBackupDraft({ records, staging });
    expect(composed).toMatchObject({ ok: true }); if (!composed.ok) return;
    const destination = path.join(directory, "history.opening");
    await writeOpeningBackupArchive(composed.backup, staging.directory, destination);
    const archive = await readOpeningBackupArchive(destination);
    try {
      const restoredObjects = new Map<string, Buffer>();
      for (const object of archive.metadata.objects) {
        const chunks: Uint8Array[] = []; for await (const chunk of archive.objectBytes(object.archivePath)) chunks.push(chunk);
        restoredObjects.set(object.archivePath, Buffer.concat(chunks));
      }
      expect(restoredObjects.get(`objects/${f.sourceId}/v2.bin`)).toEqual(currentBytes);
      if (!missing) expect(restoredObjects.get(`objects/${f.sourceId}/v1.bin`)).toEqual(sourceBytes);
      else expect(restoredObjects.has(`objects/${f.sourceId}/v1.bin`)).toBe(false);
      const targetCourseRows = await fixture.sql`SELECT id FROM courses WHERE workspace_id=${fixture.scope.workspaceId} AND id=${f.courseId}`;
      const availableCourseIds = targetCourseRows.map(row => row.id as string);
      expect(availableCourseIds).toEqual([f.courseId]);
      const targetSnapshot = await readOpeningBackupRecords(fixture.sql, fixture.scope);
      const currentLearningState = { workspacePreferences: targetSnapshot.tables.workspace_preferences[0] ?? null, courses: targetSnapshot.tables.courses };
      const currentMemoryDeletions = targetSnapshot.memoryDeletions;
      const includedTarget = planOpeningRestoreApply(archive.metadata, [], { confirmLocalRestore: true, availableCourseIds: [], currentLearningState, currentMemoryDeletions });
      expect(includedTarget.ok).toBe(true);
      const foreignCourseId = randomUUID();
      const foreignReferences = structuredClone(archive.metadata);
      const sessionRow = foreignReferences.tables.opening_learning_sessions![0] as Record<string, unknown>;
      sessionRow.course_id = foreignCourseId;
      const foreignTarget = planOpeningRestoreApply(foreignReferences, [], { confirmLocalRestore: true, availableCourseIds, currentLearningState, currentMemoryDeletions });
      expect(foreignTarget).toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED" });
      const plan = planOpeningRestoreApply(archive.metadata, [], { confirmLocalRestore: true, availableCourseIds, currentLearningState, currentMemoryDeletions });
      expect(plan.ok).toBe(true); if (!plan.ok) return;
      await fixture.sql.begin(async tx => {
        for (const { table } of [...plan.plan.batches].reverse()) await tx.unsafe(`DELETE FROM ${table}`);
        for (const { table, rows } of plan.plan.batches) if (rows) {
          await tx.unsafe(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table}, $1::text::json)`, [JSON.stringify(archive.metadata.tables[table])]);
        }
      });
      const history = await readOpeningObservationHistory(fixture.sql,fixture.scope,observation.id);
      expect(history.revisions.map(row => row.revisionKind)).toEqual(["original","replace","retract"]);
      expect(history.headObservationId).toBe(retracted.headObservationId);
      expect((await readOpeningCourseEvidence(fixture.sql,fixture.scope,f.courseId)).observations).toEqual([]);
      expect(await reviseOpeningLearningObservation(fixture.sql,fixture.scope,revisionInput)).toMatchObject({ disposition: "replayed", headObservationId: revised.headObservationId });
      expect(await reviseOpeningLearningObservation(fixture.sql,fixture.scope,retractInput)).toMatchObject({ disposition: "replayed", headObservationId: retracted.headObservationId });
      expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE root_observation_id=${observation.id}`).toHaveLength(3);
      const restored = await f.attempts.get(fixture.scope, attempt.id);
      expect(restored).toMatchObject({ observationId: observation.id, itemVersionId: attempt.itemVersionId, sourceVersions: { [f.sourceId]: 1 } });
      expect(await fixture.sql`SELECT availability FROM opening_source_versions WHERE source_id=${f.sourceId} AND version=1`)
        .toMatchObject([{ availability: missing ? "unavailable" : "available" }]);
      expect(await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${f.courseId}`)
        .toMatchObject([{ revision: String(retracted.historyRevision) }]);
      expect(await fixture.sql`SELECT delivered_at FROM opening_help_exposures WHERE id=${exposure.id}`)
        .toMatchObject([{ delivered_at: expect.any(Date) }]);
    } finally { await archive.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("preserves unknown historical metadata and filters excluded attempt facts", async () => {
  const f=await learningAttemptFixture(fixture), attempt=await f.start();
  await f.submit(attempt);
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  await fixture.sql`DELETE FROM opening_source_versions WHERE source_id=${f.sourceId} AND version=1`;
  const snapshot=await readOpeningBackupRecords(fixture.sql,fixture.scope);
  expect(snapshot.tables.opening_source_versions).toContainEqual(expect.objectContaining({source_id:f.sourceId,version:1,bytes:null,sha256:null,availability:"unknown"}));
  expect(snapshot.tables.opening_learning_attempts).toHaveLength(1);
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${fixture.scope.workspaceId},${f.sourceId})`;
  const filtered=await readOpeningBackupRecords(fixture.sql,fixture.scope);
  expect(filtered.tables.opening_source_versions).toEqual([]);
  expect(filtered.tables.opening_learning_attempts).toEqual([]);
  expect(filtered.tables.opening_learning_item_versions).toEqual([]);
  expect(filtered.tables.opening_learning_observations).toEqual([]);
  expect(filtered.tables.opening_workspace_history_revisions).toEqual(snapshot.tables.opening_workspace_history_revisions);
});


it.each([false, true])("restores interleaved course facts with explicit workspace revisions (legacy=%s)", async legacy => {
  const learning = createOpeningLearningRepository(fixture.sql);
  const courseA = randomUUID(), courseB = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES
    (${courseA},${fixture.scope.workspaceId},'First course',${courseA}),
    (${courseB},${fixture.scope.workspaceId},'Second course',${courseB})`;
  const sessionA = await learning.createSession(fixture.scope, { courseId: courseA, skillLabel: "fractions", sourceIds: [] });
  const sessionB = await learning.createSession(fixture.scope, { courseId: courseB, skillLabel: "fractions", sourceIds: [] });
  const insert = (sessionId: string, courseId: string) => learning.insertObservation(fixture.scope, {
    sessionId, courseId, skillLabel: "fractions", sourceIds: [], answer: "1", outcome: "correct", assistance: "independent", clientKey: randomUUID(),
  });
  const first = await insert(sessionA.id, courseA), second = await insert(sessionB.id, courseB);
  const revised = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: first.id, revisesObservationId: first.id, expectedHead: first.id,
    revisionKind: "replace", reason: "Correct answer", clientKey: randomUUID(),
    replacement: { answer: "2", outcome: "incorrect", assistance: "independent" },
  });
  const records = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  const revisionById = Object.fromEntries(records.tables.opening_learning_observations.map(row => [String(row.id), row.workspace_history_revision]));
  expect(revisionById).toEqual({ [first.id]: 1, [second.id]: 2, [revised.headObservationId]: 3 });
  const composed = composeOpeningBackupDraft({ records, staging: {
    snapshot: { workspaceId: fixture.scope.workspaceId, privacyEpoch: records.privacyEpoch,
      deletionJournal: records.deletionJournal, memoryDeletions: records.memoryDeletions, sources: [] },
    objects: [],
  } });
  expect(composed.ok).toBe(true); if (!composed.ok) return;
  const archived = structuredClone(composed.backup);
  if (legacy) {
    delete archived.tables.opening_workspace_history_revisions;
    for (const row of archived.tables.opening_learning_observations as Record<string, unknown>[]) delete row.workspace_history_revision;
  }
  const restoredBackup = normalizeOpeningRestoreHistory(archived);
  const plan = planOpeningRestoreApply(restoredBackup, records.deletionJournal, { confirmLocalRestore: true,
    currentLearningState: { workspacePreferences: records.tables.workspace_preferences[0] ?? null, courses: records.tables.courses },
    currentMemoryDeletions: records.memoryDeletions,
  });
  expect(plan.ok, JSON.stringify(plan)).toBe(true); if (!plan.ok) return;
  expect(plan.plan.batches.map(batch => batch.table)).not.toContain("opening_jobs");
  expect(plan.plan.batches.map(batch => batch.table)).not.toContain("opening_outbox");
  await fixture.sql.begin(async tx => {
    for (const { table } of [...plan.plan.batches].reverse()) await tx.unsafe(`DELETE FROM ${table}`);
    for (const { table, rows } of plan.plan.batches) if (rows) {
      await tx.unsafe(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table}, $1::text::json)`, [JSON.stringify(restoredBackup.tables[table])]);
    }
  });
  const counter = legacy ? 0 : 3;
  expect(await fixture.sql`SELECT revision FROM opening_workspace_history_revisions
    WHERE workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}`)
    .toEqual([{ revision: String(counter) }]);
  const history = await readOpeningCourseLearningHistory(fixture.sql, fixture.scope, { courseId: courseA, limit: 50 });
  expect(history).toMatchObject({ snapshotRevision: counter, totalCount: 1 });
  expect(history.observations.map(row => row.id)).toEqual([revised.headObservationId]);
  const next = await insert(sessionB.id, courseB);
  expect(await fixture.sql`SELECT workspace_history_revision FROM opening_learning_observations WHERE id=${next.id}`)
    .toEqual([{ workspace_history_revision: String(counter + 1) }]);
});
