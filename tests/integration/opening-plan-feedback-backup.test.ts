import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository, readOpeningPlanFeedbackSummary, readOpeningRestoreNamespaceCounts } from "@aistudy/database";
import type { OpeningBackup } from "@aistudy/domain";
import { executeOpeningRestoreApply } from "../../packages/database/src/repositories/opening-backup-apply";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.sql`DELETE FROM opening_tasks WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}`;
});
afterAll(async () => { await f?.close(); });

it.each([false, true])("roundtrips feedback through the real restore executor without replaying actions (legacy=%s)", async legacy => {
  const plans = createOpeningPlansRepository(f.sql);
  const task = await plans.createTask(f.scope, { title: "Backup feedback", minutes: 20, priority: 1, dueAt: null, candidateId: null });
  const input = { notBefore: "2099-01-01T00:00:00.000Z", expectedVersion: 1, feedback: { reason: "time_short" as const } };
  await plans.deferTask(f.scope, task.id, input);
  const from = new Date(Date.now() - 3_600_000), until = new Date(Date.now() + 3_600_000);
  const before = await readOpeningPlanFeedbackSummary(f.sql, f.scope, from, until);
  const snapshot = await readOpeningBackupRecords(f.sql, f.scope);
  const backup: OpeningBackup = { format: "opening-backup", version: 1, workspaceId: f.scope.workspaceId,
    privacyEpoch: snapshot.privacyEpoch, deletionJournal: snapshot.deletionJournal,
    memoryDeletions: snapshot.memoryDeletions, tables: snapshot.tables, objects: [] };
  expect(backup.tables.opening_plan_feedback).toHaveLength(1);
  if (legacy) delete backup.tables.opening_plan_feedback;
  await f.sql`DELETE FROM opening_tasks WHERE id=${task.id}`;
  expect(await f.sql`SELECT id FROM opening_plan_feedback WHERE task_id=${task.id}`).toHaveLength(0);
  await f.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}`;
  const result = await executeOpeningRestoreApply(f.sql, { confirmLocalRestore: true, backup,
    currentMemoryDeletions: snapshot.memoryDeletions });
  expect(result).toMatchObject({ ok: true, code: "APPLY_OK" });
  const after = await readOpeningPlanFeedbackSummary(f.sql, f.scope, from, until);
  if (legacy) {
    expect(after.actions.deferred).toBe(0);
    expect(after.reasons.coverage).toBeNull();
    expect(after.historicalActions).toBe("unknown");
  } else expect(after).toEqual(before);
  await expect(plans.deferTask(f.scope, task.id, input)).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await readOpeningPlanFeedbackSummary(f.sql, f.scope, from, until)).actions.deferred).toBe(legacy ? 0 : 1);
  expect((await readOpeningRestoreNamespaceCounts(f.sql, f.scope.workspaceId)).opening_plan_feedback).toBe(legacy ? 0 : 1);
});

it("rejects a forged feedback owner before any restore mutation", async () => {
  const plans = createOpeningPlansRepository(f.sql);
  const task = await plans.createTask(f.scope, { title: "Forged feedback", minutes: 20, priority: 1, dueAt: null, candidateId: null });
  await plans.updateTaskStatus(f.scope, task.id, { status: "done", expectedVersion: 1, at: new Date().toISOString() });
  const snapshot = await readOpeningBackupRecords(f.sql, f.scope);
  snapshot.tables.opening_plan_feedback[0]!.owner_user_id = f.otherScope.ownerUserId;
  const result = await executeOpeningRestoreApply(f.sql, { confirmLocalRestore: true,
    backup: { format: "opening-backup", version: 1, workspaceId: f.scope.workspaceId,
      privacyEpoch: snapshot.privacyEpoch, deletionJournal: snapshot.deletionJournal,
      memoryDeletions: snapshot.memoryDeletions, tables: snapshot.tables, objects: [] }, currentMemoryDeletions: snapshot.memoryDeletions });
  expect(result).toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED", mutated: false });
  expect(await f.sql`SELECT id FROM opening_plan_feedback WHERE task_id=${task.id}`).toHaveLength(1);
});

it.each(["workspace", "user"])("deletes feedback with its %s", async kind => {
  const workspaceId = randomUUID(), ownerUserId = randomUUID(), scope = { workspaceId, ownerUserId };
  await f.sql`INSERT INTO users(id, email, display_name, password_hash) VALUES (${ownerUserId}, ${`${ownerUserId}@feedback-test.example`}, 'Feedback test', 'test')`;
  await f.sql`INSERT INTO workspaces(id, owner_user_id) VALUES (${workspaceId}, ${scope.ownerUserId})`;
  try {
    const plans = createOpeningPlansRepository(f.sql);
    const task = await plans.createTask(scope, { title: "Private feedback", minutes: 20, priority: 1, dueAt: null, candidateId: null });
    await plans.updateTaskStatus(scope, task.id, { status: "done", expectedVersion: 1, at: new Date().toISOString() });
    expect(await f.sql`SELECT id FROM opening_plan_feedback WHERE workspace_id=${workspaceId}`).toHaveLength(1);
    if (kind === "workspace") await f.sql`DELETE FROM workspaces WHERE id=${workspaceId}`;
    else await f.sql`DELETE FROM users WHERE id=${ownerUserId}`;
    expect(await f.sql`SELECT id FROM opening_plan_feedback WHERE workspace_id=${workspaceId}`).toHaveLength(0);
  } finally {
    await f.sql`DELETE FROM workspaces WHERE id=${workspaceId}`;
    await f.sql`DELETE FROM users WHERE id=${ownerUserId}`;
  }
});
