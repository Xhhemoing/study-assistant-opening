import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOpeningAdaptivePrefsRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { if (f) await f.close(); });
async function course() {
  const id = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${f.scope.workspaceId},'Tutor grant',${id})`;
  return id;
}
it("persists explicit course consent, preserves it on unrelated patches and rejects stale writes", async () => {
  const courseId = await course(), repo = createOpeningAdaptivePrefsRepository(f.sql);
  const update = { courseId, enabled: true, dailyMinutes: 30, expiresOn: null, expectedRevision: 0 };
  const saved = await repo.patch(f.scope, { spanTutorGrant: update });
  expect(saved.prefs.spanTutorGrants?.[courseId]).toMatchObject({ enabled: true, dailyMinutes: 30, revision: 1 });
  expect(Number.isFinite(Date.parse(saved.prefs.spanTutorGrants![courseId]!.confirmedAt))).toBe(true);
  const other = await repo.patch(f.scope, { coachBudgetMinutes: 40 });
  expect(other.prefs.spanTutorGrants).toEqual(saved.prefs.spanTutorGrants);
  await expect(repo.patch(f.scope, { spanTutorGrant: update })).rejects.toMatchObject({ code: "CONFLICT" });
  const off = await repo.patch(f.scope, { spanTutorGrant: { ...update, enabled: false, expectedRevision: 1 } });
  expect(off.prefs.spanTutorGrants?.[courseId]).toMatchObject({ enabled: false, revision: 2 });
});
it("rejects foreign courses and new consent for archived courses but permits withdrawal", async () => {
  const courseId = await course(), repo = createOpeningAdaptivePrefsRepository(f.sql);
  const update = { courseId, enabled: true, dailyMinutes: 20, expiresOn: null, expectedRevision: 0 };
  await expect(repo.patch(f.otherScope, { spanTutorGrant: update })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await repo.patch(f.scope, { spanTutorGrant: update });
  await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
  await expect(repo.patch(f.scope, { spanTutorGrant: { ...update, expectedRevision: 1 } })).rejects.toMatchObject({ code: "CONFLICT" });
  const off = await repo.patch(f.scope, { spanTutorGrant: { ...update, enabled: false, expectedRevision: 1 } });
  expect(off.prefs.spanTutorGrants?.[courseId]?.enabled).toBe(false);
});
it("serializes concurrent confirmations against a single revision", async () => {
  const courseId = await course(), repo = createOpeningAdaptivePrefsRepository(f.sql);
  const request = { spanTutorGrant: { courseId, enabled: true, dailyMinutes: 30, expiresOn: null, expectedRevision: 0 } };
  const results = await Promise.allSettled([repo.patch(f.scope, request), repo.patch(f.scope, request)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
});
it("shares one revision and withdrawal across UUID letter-case aliases", async () => {
  const courseId = await course(), repo = createOpeningAdaptivePrefsRepository(f.sql);
  await repo.patch(f.scope, { spanTutorGrant: { courseId: courseId.toUpperCase(), enabled: true, dailyMinutes: 30, expiresOn: null, expectedRevision: 0 } });
  const current = await repo.get(f.scope);
  expect(current.prefs.spanTutorGrants?.[courseId]?.revision).toBe(1);
  expect(current.prefs.spanTutorGrants).not.toHaveProperty(courseId.toUpperCase());
  await expect(repo.patch(f.scope, { spanTutorGrant: { courseId, enabled: true, dailyMinutes: 30, expiresOn: null, expectedRevision: 0 } })).rejects.toMatchObject({ code: "CONFLICT" });
  await repo.patch(f.scope, { spanTutorGrant: { courseId, enabled: false, dailyMinutes: 30, expiresOn: null, expectedRevision: 1 } });
  const { readSpanTutorAuthorization } = await import("@aistudy/database");
  expect(await readSpanTutorAuthorization(f.sql, f.scope, courseId.toUpperCase())).toMatchObject({ authorized: false, reason: "not_enabled", grant: { revision: 2, enabled: false } });
});
it("restores a saved course grant as disabled through the real restore executor", async () => {
  const isolated = await createOpeningFixture();
  try {
    const { readOpeningBackupRecords, executeOpeningRestoreApply } = await import("@aistudy/database");
    const courseId = randomUUID();
    await isolated.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${isolated.scope.workspaceId},'Restore consent',${courseId})`;
    const repo = createOpeningAdaptivePrefsRepository(isolated.sql);
    await repo.patch(isolated.scope, { spanTutorGrant: { courseId, enabled: true, dailyMinutes: 30, expiresOn: null, expectedRevision: 0 } });
    const snapshot = await readOpeningBackupRecords(isolated.sql, isolated.scope);
    await isolated.sql`DELETE FROM workspace_preferences WHERE workspace_id=${isolated.scope.workspaceId}`;
    await isolated.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${isolated.scope.workspaceId}`;
    await isolated.sql`DELETE FROM courses WHERE workspace_id=${isolated.scope.workspaceId}`;
    const current = await readOpeningBackupRecords(isolated.sql, isolated.scope);
    const result = await executeOpeningRestoreApply(isolated.sql, { confirmLocalRestore: true, currentMemoryDeletions: current.memoryDeletions,
      currentLearningState: { workspacePreferences: current.tables.workspace_preferences[0] ?? null, courses: current.tables.courses },
      backup: { format: "opening-backup", version: 1, workspaceId: isolated.scope.workspaceId, privacyEpoch: snapshot.privacyEpoch,
        deletionJournal: snapshot.deletionJournal, memoryDeletions: snapshot.memoryDeletions, tables: snapshot.tables, objects: [] } });
    expect(result, JSON.stringify(result.errors)).toMatchObject({ ok: true, code: "APPLY_OK" });
    expect((await repo.get(isolated.scope)).prefs.spanTutorGrants?.[courseId]).toMatchObject({ enabled: false, revision: 1, dailyMinutes: 30 });
  } finally { await isolated.close(); }
});
