import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository } from "@aistudy/database";
import type { OpeningBackup } from "@aistudy/domain";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { readOpeningBackupArchive, writeOpeningBackupArchive } from "../../packages/database/src/storage/opening-backup-archive";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { acceptInput, taskCandidate } from "./opening-task-acceptance-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_tasks, opening_conversations RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await fixture?.close(); });

it.each([false, true])("restores an accepted task and its receipt from an archive (legacy=%s)", async (legacy) => {
  const { id } = await taskCandidate(fixture);
  const { sql, scope } = fixture, input = acceptInput(id);
  const plans = createOpeningPlansRepository(sql);
  const task = await plans.createTask(scope, input);
  const snapshot = await readOpeningBackupRecords(sql, scope);
  const receipt = snapshot.tables.opening_assistant_candidates[0]!;
  expect(receipt).toMatchObject({ task_accept_client_key: input.clientKey,
    task_accept_intent: { origin: "assistant", kind: "task", id, action: "accept", expectedVersion: 0 },
    task_result_ref: { kind: "task", id: task.id } });
  if (legacy) {
    delete receipt.task_accept_client_key;
    delete receipt.task_accept_intent;
    delete receipt.task_result_ref;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "assistant-receipt-"));
  try {
    const backup: OpeningBackup = { format: "opening-backup", version: 1, workspaceId: scope.workspaceId,
      privacyEpoch: snapshot.privacyEpoch, deletionJournal: snapshot.deletionJournal, tables: snapshot.tables, objects: [] };
    const destination = path.join(directory, "receipt.opening");
    await writeOpeningBackupArchive(backup, directory, destination);
    const archive = await readOpeningBackupArchive(destination);
    const { tables } = archive.metadata;
    await archive.close();
    // Restore the durable dependency slice into emptied tables in the guarded test DB.
    await sql.begin(async (tx) => {
      await tx`DELETE FROM opening_tasks WHERE workspace_id = ${scope.workspaceId}`;
      await tx`DELETE FROM opening_conversations WHERE workspace_id = ${scope.workspaceId}`;
      await tx`INSERT INTO opening_conversations SELECT * FROM json_populate_recordset(NULL::opening_conversations, ${JSON.stringify(tables.opening_conversations)}::text::json)`;
      await tx`INSERT INTO opening_turns (id, workspace_id, conversation_id, role, text, mode, status, client_key, learning_session_id, current_page, chunk_id, source_ids, citations, created_at, intent_hash, source_versions, context_source_refs, attempt_id)
        SELECT id, workspace_id, conversation_id, role, text, mode, status, client_key, learning_session_id, current_page, chunk_id, source_ids, citations, created_at, intent_hash, source_versions, context_source_refs, attempt_id FROM json_populate_recordset(NULL::opening_turns, ${JSON.stringify(tables.opening_turns)}::text::json)`;
      await tx`INSERT INTO opening_assistant_candidates SELECT * FROM json_populate_recordset(NULL::opening_assistant_candidates, ${JSON.stringify(tables.opening_assistant_candidates)}::text::json)`;
      await tx`INSERT INTO opening_tasks SELECT * FROM json_populate_recordset(NULL::opening_tasks, ${JSON.stringify(tables.opening_tasks)}::text::json)`;
    });
    const restored = await plans.createTask(scope, input);
    expect(restored).toMatchObject({ id: task.id,
      reviewResult: { disposition: legacy ? "already_processed" : "replayed", resultRef: { kind: "task", id: task.id } } });
    expect(await sql`SELECT id FROM opening_tasks`).toHaveLength(1);
    expect(await sql`SELECT id FROM opening_jobs`).toHaveLength(0);
    expect(await sql`SELECT id FROM opening_outbox`).toHaveLength(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
