import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  applyOpeningRestore, createOpeningInterventionSettingsRepository, createOpeningPlansRepository, readOpeningBackupRecords,
} from "@aistudy/database";
import { snapshotOpeningRestoreCurrentFacts } from "../../packages/database/src/repositories/opening-restore-current-facts";
import { createOpeningFixture } from "./opening-fixture";

it("preserves the revision of a cleared legacy timetable through preference edits and backup restore", async () => {
  const { sql, scope, otherScope, close } = await createOpeningFixture();
  const plans = createOpeningPlansRepository(sql), prefs = createOpeningInterventionSettingsRepository(sql);
  try {
    const id = randomUUID();
    await sql`INSERT INTO opening_timetable_sessions
      (id, workspace_id, owner_user_id, course_name, weekday, weeks, start_period, end_period)
      VALUES (${id}, ${scope.workspaceId}, ${scope.ownerUserId}, 'Physics', 2, ARRAY[1], 1, 2)`;
    expect(await plans.timetableSnapshot(scope)).toMatchObject({ revision: id, sessions: [{ courseName: "Physics" }] });
    await plans.replaceTimetable(scope, [], id);
    const cleared = await plans.timetableSnapshot(scope);
    expect(cleared.sessions).toEqual([]);
    expect(cleared.revision).not.toBe(id);
    const { settings } = await prefs.getGlobal(scope);
    await prefs.setGlobal(scope, { ...settings, quietMode: true });
    expect(await prefs.getGlobal(scope)).toMatchObject({ settings: { quietMode: true }, invalidStoredSettings: false });
    expect(await plans.timetableSnapshot(scope)).toEqual(cleared);
    expect(await plans.timetableSnapshot(otherScope)).toEqual({ revision: "empty", sessions: [] });

    const snapshot = await readOpeningBackupRecords(sql, scope);
    await sql`DELETE FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
    const backup = { ...snapshot, format: "opening-backup", version: 1, workspaceId: scope.workspaceId, objects: [] } as const;
    const facts = await snapshotOpeningRestoreCurrentFacts(sql, backup);
    const restored = await applyOpeningRestore({ sql, backup, confirmLocalRestore: true, ...facts });
    expect(restored.ok, restored.ok ? undefined : restored.errors.join(", ")).toBe(true);
    expect(await plans.timetableSnapshot(scope)).toEqual(cleared);
    await expect(plans.replaceTimetable(scope, [], "empty")).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    try {
      await sql`DELETE FROM workspaces WHERE id IN (${scope.workspaceId}, ${otherScope.workspaceId})`;
      await sql`DELETE FROM users WHERE id IN (${scope.ownerUserId}, ${otherScope.ownerUserId})`;
    } finally { await close(); }
  }
});
