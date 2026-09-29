import { randomUUID } from "node:crypto";
import type { OpeningFixture } from "./opening-fixture";
import { insertCandidate, insertOwnedConversation, insertTurn } from "./opening-memory-candidate-fixture";
import { backupRows } from "./opening-backup-records-fixture";

export async function taskCandidate(fixture: OpeningFixture, withSource = false) {
  const { sql, scope } = fixture;
  const sourceId = withSource ? await backupRows(sql, scope).source() : null;
  const conversationId = await insertOwnedConversation(sql, scope);
  const sourceIds = sourceId ? [sourceId] : [];
  const sourceTurnId = await insertTurn(sql, scope, conversationId, { sourceIds });
  if (sourceId) await sql`UPDATE opening_turns SET source_versions = ${sql.json({ [sourceId]: 1 })} WHERE id = ${sourceTurnId}`;
  const id = await insertCandidate(sql, scope, {
    conversationId, sourceTurnId, sourceIds,
    payload: { kind: "task", title: "练习", minutes: 20, dueText: null },
  });
  return { id, sourceId, sourceTurnId, conversationId };
}

export function acceptInput(id: string, clientKey = randomUUID()) {
  return {
    title: "练习", minutes: 20, dueAt: null, priority: 1, candidateId: id, clientKey,
    candidateRef: { origin: "assistant" as const, kind: "task" as const, id },
  };
}
