import { createOpeningAiSettingsRepository } from "@aistudy/database";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readOpeningBackupArchive, writeOpeningBackupArchive } from "../../packages/database/src/storage/opening-backup-archive";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { planOpeningRestoreApply } from "../../packages/domain/src/opening/backup-apply-plan";
import { validateOpeningRestore, type OpeningBackup } from "../../packages/domain/src/opening/backup-policy";
import { createBackupFixture, backupRows, sourceBytes, sourceHash, type BackupFixture } from "./opening-backup-records-fixture";

let fixture: BackupFixture;
beforeAll(async () => { fixture = await createBackupFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`DELETE FROM courses WHERE workspace_id IN (${fixture.scope.workspaceId}, ${fixture.otherScope.workspaceId})`;
  await fixture.sql`DELETE FROM workspace_preferences WHERE workspace_id IN (${fixture.scope.workspaceId}, ${fixture.otherScope.workspaceId})`;
});
afterAll(async () => { await fixture?.dispose(); });

async function seedCourse(workspaceId = fixture.scope.workspaceId, archived = false) {
  const id = randomUUID();
  await fixture.sql`INSERT INTO courses (id,workspace_id,title,slug,archived_at,assessment_enabled,retest_suggestions_enabled,automatic_reminders_enabled)
    VALUES (${id},${workspaceId},'Backup course',${id},${archived ? new Date("2026-09-28T00:00:00Z") : null},false,NULL,false)`;
  return id;
}
function archive(snapshot: Awaited<ReturnType<typeof readOpeningBackupRecords>>): OpeningBackup {
  return JSON.parse(JSON.stringify({ format: "opening-backup", version: 1, workspaceId: fixture.scope.workspaceId, ...snapshot, objects: [] })) as OpeningBackup;
}

it("exports owned preference and course state and only memberships to included Opening sources", async () => {
  const w = fixture.scope.workspaceId, other = fixture.otherScope.workspaceId;
  const courseId = await seedCourse(w, true), foreignCourse = await seedCourse(other);
  await fixture.sql`INSERT INTO workspace_preferences(workspace_id,default_entry,assessment_enabled,retest_suggestions_enabled,automatic_reminders_enabled)
    VALUES (${w},'library',true,false,true),(${other},'learn',true,true,true)`;
  const included = await fixture.rows.source(), excluded = await fixture.rows.source(), pending = await fixture.rows.source("pending");
  const foreignSource = await backupRows(fixture.sql, fixture.otherScope).source();
  await fixture.rows.exclude(excluded);
  for (const [course, workspace, type, asset] of [
    [courseId,w,"source",included], [courseId,w,"source",excluded], [courseId,w,"source",pending],
    [courseId,w,"source",foreignSource], [courseId,w,"document",randomUUID()],
    [courseId,w,"block",randomUUID()], [courseId,w,"card",randomUUID()], [foreignCourse,other,"source",foreignSource],
  ]) await fixture.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
    VALUES (${workspace!},${course!},${type!},${asset!},'reference',3,'private')`;
  const snapshot = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(snapshot.tables.workspace_preferences).toMatchObject([{ workspace_id: w, default_entry: "library",
    assessment_enabled: true, retest_suggestions_enabled: false, automatic_reminders_enabled: true,
    retest_suggestions_enabled_at: null, automatic_reminders_enabled_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/) }]);
  expect(snapshot.tables.courses).toMatchObject([{ id: courseId, archived_at: new Date("2026-09-28T00:00:00Z"), assessment_enabled: false,
    retest_suggestions_enabled: null, automatic_reminders_enabled: false }]);
  expect(snapshot.tables.course_asset_memberships).toMatchObject([{ course_id: courseId, asset_type: "source", asset_id: included, role: "reference", sort_order: 3 }]);
  expect(snapshot.tables.course_asset_memberships).toHaveLength(1);
  expect(snapshot.deletionJournal).toContainEqual({ sourceId: excluded, deletedAt: "2026-09-25T00:00:00.000Z" });
  const value = archive(snapshot);
  expect(validateOpeningRestore(value, snapshot.deletionJournal, snapshot.memoryDeletions).allowed).toBe(true);
  expect(planOpeningRestoreApply(value, snapshot.deletionJournal, { confirmLocalRestore: true, currentMemoryDeletions: snapshot.memoryDeletions,
    currentLearningState: { workspacePreferences: null, courses: [] } }).ok).toBe(true);
  const directory = await mkdtemp(path.join(tmpdir(), "learning-state-backup-"));
  try {
    const archivePath = `objects/${included}/v1.bin`, destination = path.join(directory, "state.opening");
    await mkdir(path.join(directory, "objects", included), { recursive: true });
    await writeFile(path.join(directory, archivePath), sourceBytes);
    value.objects = [{ sourceId: included, sha256: sourceHash, bytes: sourceBytes.length, archivePath }];
    await writeOpeningBackupArchive(value, directory, destination);
    const reopened = await readOpeningBackupArchive(destination);
    try {
      expect(reopened.metadata.tables.workspace_preferences).toEqual(value.tables.workspace_preferences);
      expect(reopened.metadata.tables.courses).toEqual(value.tables.courses);
      expect(reopened.metadata.tables.course_asset_memberships).toEqual(value.tables.course_asset_memberships);
      expect(planOpeningRestoreApply(reopened.metadata, snapshot.deletionJournal, { confirmLocalRestore: true, currentMemoryDeletions: snapshot.memoryDeletions,
        currentLearningState: { workspacePreferences: null, courses: [] } }).ok).toBe(true);
    } finally { await reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
  await expect(readOpeningBackupRecords(fixture.sql, { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId })).rejects.toThrow();
});

it("rejects an older active backup after current account closure or course archival", async () => {
  const w = fixture.scope.workspaceId, courseId = await seedCourse();
  await fixture.sql`UPDATE courses SET assessment_enabled=NULL,automatic_reminders_enabled=NULL WHERE id=${courseId}`;
  await fixture.sql`INSERT INTO workspace_preferences(workspace_id,assessment_enabled,retest_suggestions_enabled,automatic_reminders_enabled)
    VALUES (${w},true,true,true)`;
  const exported = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(exported.tables.workspace_preferences).toHaveLength(1);
  const old = archive(exported);
  await fixture.sql`UPDATE workspace_preferences SET assessment_enabled=false WHERE workspace_id=${w}`;
  await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
  const current = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  const result = planOpeningRestoreApply(old, [], { confirmLocalRestore: true, currentMemoryDeletions: current.memoryDeletions,
    currentLearningState: { workspacePreferences: current.tables.workspace_preferences[0]!, courses: current.tables.courses } });
  expect(result).toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED" });
  if (!result.ok) {
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("closed learning preference"), expect.stringContaining("archived course")]));
  }
  expect((await readOpeningBackupRecords(fixture.sql, fixture.scope)).tables.courses[0]?.archived_at).toEqual(expect.any(Date));
});

it("rejects rewinding the actual activation timestamp after disable then enable", async () => {
  const w = fixture.scope.workspaceId;
  await fixture.sql`INSERT INTO workspace_preferences(workspace_id,assessment_enabled,retest_suggestions_enabled,automatic_reminders_enabled)
    VALUES (${w},true,true,true)`;
  const exported = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(exported.tables.workspace_preferences).toHaveLength(1);
  const old = archive(exported);
  await fixture.sql`UPDATE workspace_preferences SET assessment_enabled=false WHERE workspace_id=${w}`;
  await fixture.sql`UPDATE workspace_preferences SET assessment_enabled=true WHERE workspace_id=${w}`;
  const current = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  const result = planOpeningRestoreApply(old, [], { confirmLocalRestore: true, currentMemoryDeletions: current.memoryDeletions,
    currentLearningState: { workspacePreferences: current.tables.workspace_preferences[0]!, courses: current.tables.courses } });
  expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining("activation time")]) });
});

it("preserves PostgreSQL activation microseconds in snapshots and archives and rejects a one-microsecond rewind", async () => {
  const w = fixture.scope.workspaceId, courseId = await seedCourse();
  await fixture.sql`UPDATE courses SET assessment_enabled=NULL,automatic_reminders_enabled=NULL WHERE id=${courseId}`;
  await fixture.sql`INSERT INTO workspace_preferences(workspace_id,assessment_enabled,retest_suggestions_enabled,automatic_reminders_enabled)
    VALUES (${w},true,true,true)`;
  const actual = await fixture.sql`
    SELECT 'workspace_preferences' AS table_name,
      to_char(retest_suggestions_enabled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retest,
      to_char(automatic_reminders_enabled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reminders,
      to_char((retest_suggestions_enabled_at - interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS older_retest,
      to_char((automatic_reminders_enabled_at - interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS older_reminders
    FROM workspace_preferences WHERE workspace_id=${w}
    UNION ALL SELECT 'courses',
      to_char(retest_suggestions_enabled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      to_char(automatic_reminders_enabled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      to_char((retest_suggestions_enabled_at - interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      to_char((automatic_reminders_enabled_at - interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    FROM courses WHERE id=${courseId}`;
  const current = await readOpeningBackupRecords(fixture.sql, fixture.scope), old = archive(current);
  for (const row of actual) {
    const table = row.table_name as "workspace_preferences" | "courses";
    expect(current.tables[table][0]).toMatchObject({ retest_suggestions_enabled_at: row.retest, automatic_reminders_enabled_at: row.reminders });
    Object.assign(old.tables[table][0] as Record<string, unknown>, {
      retest_suggestions_enabled_at: row.older_retest, automatic_reminders_enabled_at: row.older_reminders,
    });
  }
  const directory = await mkdtemp(path.join(tmpdir(), "learning-activation-"));
  try {
    const destination = path.join(directory, "state.opening");
    await writeOpeningBackupArchive(old, directory, destination);
    const reopened = await readOpeningBackupArchive(destination);
    try {
      expect(reopened.metadata.tables.workspace_preferences).toEqual(old.tables.workspace_preferences);
      expect(reopened.metadata.tables.courses).toEqual(old.tables.courses);
      const result = planOpeningRestoreApply(reopened.metadata, [], { confirmLocalRestore: true, currentMemoryDeletions: current.memoryDeletions,
        currentLearningState: { workspacePreferences: current.tables.workspace_preferences[0]!, courses: current.tables.courses } });
      expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining("activation time")]) });
    } finally { await reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("round-trips only saved model ids and routing choices in an Opening archive", async () => {
  const settings = {
    mode: "manual" as const, manualModelId: "manual-model", defaultModelId: null,
    routes: { listen: "daily-model", hint: null, explain: "reasoning-model", think_together: null },
  };
  await createOpeningAiSettingsRepository(fixture.sql).set(fixture.scope, settings);
  const snapshot = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(snapshot.tables.workspace_preferences).toHaveLength(1);
  expect(snapshot.tables.workspace_preferences[0]!.ai_settings).toEqual(settings);
  const directory = await mkdtemp(path.join(tmpdir(), "ai-settings-backup-"));
  try {
    const destination = path.join(directory, "settings.opening");
    await writeOpeningBackupArchive(archive(snapshot), directory, destination);
    const reopened = await readOpeningBackupArchive(destination);
    try {
      const restored = reopened.metadata.tables.workspace_preferences[0] as Record<string, unknown>;
      expect(restored.ai_settings).toEqual(settings);
      expect(Object.keys(restored.ai_settings as Record<string, unknown>).sort()).toEqual(["defaultModelId", "manualModelId", "mode", "routes"]);
      expect(JSON.stringify(reopened.metadata)).not.toContain("apiKey");
      expect(JSON.stringify(reopened.metadata)).not.toContain("baseUrl");
    } finally { await reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("rejects a stored credential-bearing AI setting before it enters a backup snapshot", async () => {
  const contaminated = { mode: "automatic", manualModelId: null, defaultModelId: null,
    routes: { listen: null, hint: null, explain: null, think_together: null }, apiKey: "must-not-export" };
  await fixture.sql`INSERT INTO workspace_preferences(workspace_id,ai_settings)
    VALUES (${fixture.scope.workspaceId},${fixture.sql.json(contaminated)})`;
  await expect(readOpeningBackupRecords(fixture.sql, fixture.scope)).rejects.toThrow();
});
