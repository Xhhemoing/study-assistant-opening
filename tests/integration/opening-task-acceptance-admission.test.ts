import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { acceptInput, taskCandidate } from "./opening-task-acceptance-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_tasks, opening_conversations RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await fixture?.close(); });

for (const replay of [false, true]) {
  it.each(["excluded", "revoked", "version", "turn-version", "missing", "foreign", "candidate-only", "citation-only"])(
    `${replay ? "replay" : "initial accept"} rechecks %s source admission`, async (change) => {
      const candidate = await taskCandidate(fixture, true);
      const input = acceptInput(candidate.id), { sql, scope } = fixture;
      const plans = createOpeningPlansRepository(sql);
      if (replay) await plans.createTask(scope, input);
      if (change === "excluded") await backupRows(sql, scope).exclude(candidate.sourceId!);
      if (change === "revoked") await sql`UPDATE opening_sources SET upload_state = 'rejected' WHERE id = ${candidate.sourceId}`;
      if (change === "version") await sql`UPDATE opening_sources SET version = 2 WHERE id = ${candidate.sourceId}`;
      if (change === "turn-version") {
        await sql`UPDATE opening_assistant_candidates SET source_ids = '[]'::jsonb WHERE id = ${candidate.id}`;
        await sql`UPDATE opening_turns SET source_ids = '{}'::uuid[] WHERE id = ${candidate.sourceTurnId}`;
        await sql`UPDATE opening_sources SET version = 2 WHERE id = ${candidate.sourceId}`;
      }
      if (change === "missing") await sql`DELETE FROM opening_sources WHERE id = ${candidate.sourceId}`;
      if (change === "foreign") await sql`UPDATE opening_sources SET workspace_id = ${fixture.otherScope.workspaceId} WHERE id = ${candidate.sourceId}`;
      if (change === "candidate-only") {
        await sql`UPDATE opening_turns SET source_ids = '{}'::uuid[], source_versions = '{}'::jsonb WHERE id = ${candidate.sourceTurnId}`;
        await backupRows(sql, scope).exclude(candidate.sourceId!);
      }
      if (change === "citation-only") {
        await sql`UPDATE opening_assistant_candidates SET source_ids = '[]'::jsonb WHERE id = ${candidate.id}`;
        await sql`UPDATE opening_turns SET source_ids = '{}'::uuid[], source_versions = '{}'::jsonb,
          citations = ${sql.json([{ sourceId: candidate.sourceId, sourceVersion: 1 }])} WHERE id = ${candidate.sourceTurnId}`;
        await sql`UPDATE opening_sources SET version = 2 WHERE id = ${candidate.sourceId}`;
      }
      await expect(plans.createTask(scope, input)).rejects.toMatchObject({ code: "VALIDATION" });
      expect(await sql`SELECT id FROM opening_tasks`).toHaveLength(replay ? 1 : 0);
    },
  );
}

it.each(["workspace-owner", "conversation-owner", "turn-incomplete", "wrong-kind"])("checks %s before returning any receipt", async (change) => {
  const { id, sourceTurnId, conversationId } = await taskCandidate(fixture);
  const { sql, scope, otherScope } = fixture, input = acceptInput(id);
  const plans = createOpeningPlansRepository(sql);
  await plans.createTask(scope, input);
  const newOwner = randomUUID();
  if (change === "workspace-owner") {
    await sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${newOwner}, ${`${newOwner}@example.com`}, 'transferred owner', 'test')`;
    await sql`UPDATE workspaces SET owner_user_id = ${newOwner} WHERE id = ${scope.workspaceId}`;
  }
  if (change === "conversation-owner") await sql`UPDATE opening_conversations SET owner_user_id = ${otherScope.ownerUserId} WHERE id = ${conversationId}`;
  if (change === "turn-incomplete") await sql`UPDATE opening_turns SET status = 'failed' WHERE id = ${sourceTurnId}`;
  if (change === "wrong-kind") await sql`UPDATE opening_assistant_candidates SET payload = ${sql.json({ kind: "memory", text: "private", temporary: false })} WHERE id = ${id}`;
  try { await expect(plans.createTask(scope, input)).rejects.toMatchObject({ code: "CONFLICT" }); }
  finally {
    if (change === "workspace-owner") {
      await sql`UPDATE workspaces SET owner_user_id = ${scope.ownerUserId} WHERE id = ${scope.workspaceId}`;
      await sql`DELETE FROM users WHERE id = ${newOwner}`;
    }
  }
});
