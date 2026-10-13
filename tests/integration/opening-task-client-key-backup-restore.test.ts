/**
 * PR-K: opening_tasks.client_key survives backup → empty-namespace restore →
 * quick-add replay (idempotent). Gated by OPENING_TEST_DB=1 + loopback
 * aistudy_opening_test (scripts/opening-test-db.mjs globalSetup migrates).
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { assertOpeningTestDatabase } from "@aistudy/config";
import type { OpeningBackup } from "@aistudy/domain";
import {
  applyOpeningRestore,
  createOpeningPlansRepository,
  createSqlClient,
  OPENING_BACKUP_TABLES,
  readOpeningBackupRecords,
  readOpeningRestoreNamespaceCounts,
} from "@aistudy/database";

const enabled =
  process.env.OPENING_TEST_DB === "1" && Boolean(process.env.OPENING_TEST_DATABASE_URL);

describe.skipIf(!enabled)("opening_tasks.client_key backup → empty restore → replay", () => {
  const url = assertOpeningTestDatabase(
    process.env.OPENING_TEST_DATABASE_URL ?? "",
    process.env.OPENING_TEST_DB,
  );
  const sql = createSqlClient(url.toString(), { max: 1 });
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const clientKey = `prk-quick-add-${randomUUID()}`;

  afterAll(async () => {
    try {
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("exports client_key, restores into empty namespace, and replays the same key to the existing task", async () => {
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${userId}, ${`${userId}@prk-client-key.example`}, 'PR-K client_key', 'test')
    `;
    await sql`
      INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${userId})
    `;

    const scope = { workspaceId, ownerUserId: userId };
    const plans = createOpeningPlansRepository(sql);
    const input = {
      title: "PR-K quick-add task",
      minutes: 25,
      dueAt: null,
      priority: 1,
      candidateId: null as null,
      clientKey,
    };
    const created = await plans.createTask(scope, input);
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const [stored] = await sql`
      SELECT id::text AS id, client_key
      FROM opening_tasks
      WHERE workspace_id = ${workspaceId} AND id = ${created.id}
    `;
    expect(stored).toMatchObject({ id: created.id, client_key: clientKey });

    const snapshot = await readOpeningBackupRecords(sql, scope);
    const exportedTasks = snapshot.tables.opening_tasks;
    expect(exportedTasks).toHaveLength(1);
    expect(exportedTasks[0]).toMatchObject({
      id: created.id,
      workspace_id: workspaceId,
      owner_user_id: userId,
      client_key: clientKey,
      title: "PR-K quick-add task",
    });

    const backup: OpeningBackup = {
      format: "opening-backup",
      version: 1,
      workspaceId,
      privacyEpoch: snapshot.privacyEpoch,
      deletionJournal: snapshot.deletionJournal,
      memoryDeletions: snapshot.memoryDeletions,
      tables: snapshot.tables,
      objects: [],
    };

    // Empty the Opening durable namespace (workspace/user rows remain — restore precondition).
    await sql.begin(async (tx) => {
      await tx`DELETE FROM opening_tasks WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_plan_acceptances WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_plan_drafts WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_plan_state WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_hard_blocks WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_timetable_sessions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_retest_activities WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_assistant_candidates WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_turns WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_conversations WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_memories WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_privacy_exclusions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_skill_evidence WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_learning_observations WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_help_exposures WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_learning_attempts WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_learning_item_versions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_problem_refs WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_learning_sessions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_teaching_activity_specs WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_teaching_units WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_teaching_activities WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_learning_history_revisions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_learning_activity_history_revisions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_source_chunks
        WHERE source_id IN (SELECT id FROM opening_sources WHERE workspace_id = ${workspaceId})`;
      await tx`DELETE FROM opening_source_versions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM course_asset_memberships WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM opening_sources WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM courses WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_preferences WHERE workspace_id = ${workspaceId}`;
    });

    const emptyCounts = await readOpeningRestoreNamespaceCounts(sql, workspaceId);
    for (const table of OPENING_BACKUP_TABLES) {
      expect(emptyCounts[table]).toBe(0);
    }

    const result = await applyOpeningRestore({
      confirmLocalRestore: true,
      backup,
      currentDeletionJournal: snapshot.deletionJournal,
      currentMemoryDeletions: snapshot.memoryDeletions,
      sql,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toBe("APPLY_OK");
    expect(result.mutated).toBe(true);
    expect(result.emptyNamespaceVerified).toBe(true);
    expect(result.rowsInserted).toBeGreaterThanOrEqual(1);

    const [restoredRow] = await sql`
      SELECT id::text AS id, client_key, title
      FROM opening_tasks
      WHERE workspace_id = ${workspaceId} AND client_key = ${clientKey}
    `;
    expect(restoredRow).toMatchObject({
      id: created.id,
      client_key: clientKey,
      title: "PR-K quick-add task",
    });

    const replayed = await plans.createTask(scope, input);
    expect(replayed.id).toBe(created.id);
    expect(await sql`SELECT id FROM opening_tasks WHERE workspace_id = ${workspaceId}`).toHaveLength(1);
  });
});
