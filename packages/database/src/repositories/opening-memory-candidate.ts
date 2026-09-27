import type { Sql, TransactionSql } from "postgres";
import { assistantCandidateSchema, type MemoryItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { assertCourseInWorkspace, lockOwnedWorkspace } from "./opening-memory-admission";
import { listMemoriesForContext } from "./opening-memory-context";
import { OpeningMemoryError, mapMemoryRow } from "./opening-memory-types";
import { createOpeningPrivacyRepository } from "./opening-privacy";

type Db = Sql | TransactionSql;

export type MemoryCandidateDecisionInput = {
  id: string;
  expectedVersion: number;
  clientKey: string;
  action: "confirm" | "reject";
  expiresAt: string | null;
};

type LockedCandidate = {
  conversationId: string;
  courseId: string | null;
  sourceTurnId: string;
  sourceIds: string[];
  text: string;
  temporary: boolean;
  status: "pending" | "accepted" | "discarded";
};

function sameSources(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, index) => id === right[index]);
}

function sameInstant(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return Date.parse(left) === Date.parse(right);
}

async function lockCandidate(tx: Db, scope: OpeningScope, id: string): Promise<LockedCandidate> {
  const rows = await tx`
    SELECT c.conversation_id, c.source_turn_id, c.source_ids, c.payload, c.status, conv.course_id
    FROM opening_assistant_candidates c
    INNER JOIN opening_conversations conv
      ON conv.id = c.conversation_id
     AND conv.workspace_id = c.workspace_id
     AND conv.owner_user_id = ${scope.ownerUserId}
    INNER JOIN opening_turns t
      ON t.id = c.source_turn_id
     AND t.conversation_id = c.conversation_id
     AND t.workspace_id = c.workspace_id
     AND t.status = 'complete'
    WHERE c.id = ${id} AND c.workspace_id = ${scope.workspaceId}
    FOR UPDATE OF c`;
  if (!rows.length) throw new OpeningMemoryError("NOT_FOUND", "memory candidate not found");
  const row = rows[0] as Record<string, unknown>;
  const parsed = assistantCandidateSchema.safeParse(row.payload);
  if (!parsed.success || parsed.data.kind !== "memory") {
    throw new OpeningMemoryError("VALIDATION", "candidate payload is not a memory");
  }
  return {
    conversationId: row.conversation_id as string,
    courseId: (row.course_id as string | null) ?? null,
    sourceTurnId: row.source_turn_id as string,
    sourceIds: (row.source_ids as string[]) ?? [],
    text: parsed.data.text.trim(),
    temporary: parsed.data.temporary,
    status: row.status as LockedCandidate["status"],
  };
}

function replayMatches(
  row: Record<string, unknown>,
  input: MemoryCandidateDecisionInput,
  candidate: LockedCandidate,
): boolean {
  const memory = mapMemoryRow(row);
  const sameKey = row.last_decision_client_key === input.clientKey;
  const sameVersion = input.expectedVersion === 0 && memory.version === 1;
  const sameText = memory.text === candidate.text;
  const sameSource = sameSources(memory.sourceTurnIds, [candidate.sourceTurnId]);
  const action = memory.status === "rejected" ? "reject" : memory.status === "active" ? "confirm" : null;
  const candidateStatus = action === "confirm" ? "accepted" : action === "reject" ? "discarded" : null;
  if (action !== input.action || candidate.status !== candidateStatus) return false;
  if (input.action === "reject") {
    return sameKey && sameVersion && sameText && sameSource
      && memory.kind === "candidate" && memory.expiresAt === null && input.expiresAt === null;
  }
  const kind = candidate.temporary ? "temporary" : "confirmed";
  return sameKey && sameVersion && sameText && sameSource
    && memory.kind === kind
    && sameInstant(memory.expiresAt, input.expiresAt);
}

async function assertNotSuppressed(tx: Db, scope: OpeningScope, candidate: LockedCandidate): Promise<void> {
  const rejected = await tx`
    SELECT text, source_turn_ids FROM opening_memories
    WHERE workspace_id = ${scope.workspaceId} AND status = 'rejected'`;
  for (const row of rejected) {
    const sources = (row.source_turn_ids as string[]) ?? [];
    if (row.text === candidate.text && sameSources(sources, [candidate.sourceTurnId])) {
      throw new OpeningMemoryError("CONFLICT", "equivalent proposal was rejected");
    }
  }
}

async function assertAdmitted(
  tx: Db,
  scope: OpeningScope,
  id: string,
  courseId: string | null,
  excluded: readonly string[],
): Promise<void> {
  const visible = await listMemoriesForContext(tx, scope, courseId, excluded);
  if (!visible.some((item) => item.id === id)) {
    throw new OpeningMemoryError("VALIDATION", "candidate source is excluded or not owned");
  }
}

export async function decideOwnedMemoryCandidate(
  sql: Sql,
  scope: OpeningScope,
  input: MemoryCandidateDecisionInput,
  now: () => Date = () => new Date(),
): Promise<MemoryItem> {
  if (input.expectedVersion !== 0) throw new OpeningMemoryError("CONFLICT", "stale memory version");
  if (input.clientKey.length < 8) throw new OpeningMemoryError("VALIDATION", "clientKey is too short");
  if (input.action === "reject" && input.expiresAt !== null) {
    throw new OpeningMemoryError("VALIDATION", "rejected memory cannot expire");
  }
  return sql.begin(async (tx) => {
    await lockOwnedWorkspace(tx, scope);
    const candidate = await lockCandidate(tx, scope, input.id);
    const existing = await tx`
      SELECT * FROM opening_memories
      WHERE id = ${input.id} AND workspace_id = ${scope.workspaceId}
      FOR UPDATE`;
    if (existing.length) {
      const row = existing[0] as Record<string, unknown>;
      if (replayMatches(row, input, candidate)) return mapMemoryRow(row);
      throw new OpeningMemoryError("CONFLICT", "memory candidate decision conflicts");
    }
    if (candidate.status !== "pending") {
      throw new OpeningMemoryError("CONFLICT", "memory candidate is already decided");
    }
    if (input.action === "confirm") {
      if (candidate.temporary && (input.expiresAt === null || Date.parse(input.expiresAt) <= now().getTime())) {
        throw new OpeningMemoryError("VALIDATION", "temporary memory requires a future expiresAt");
      }
      if (!candidate.temporary && input.expiresAt !== null) {
        throw new OpeningMemoryError("VALIDATION", "permanent memory cannot expire");
      }
      await assertNotSuppressed(tx, scope, candidate);
    }
    const excludedIds = await createOpeningPrivacyRepository(tx).listExcludedSourceIds(scope);
    if (candidate.sourceIds.some((sourceId) => excludedIds.includes(sourceId))) {
      throw new OpeningMemoryError("VALIDATION", "candidate source is excluded");
    }
    await assertCourseInWorkspace(tx, scope, candidate.courseId);
    const kind = input.action === "reject" ? "candidate" : candidate.temporary ? "temporary" : "confirmed";
    const status = input.action === "reject" ? "rejected" : "active";
    const storedExpiry = input.action === "reject" ? null : candidate.temporary ? input.expiresAt : null;
    const inserted = await tx`
      INSERT INTO opening_memories (
        id, workspace_id, course_id, kind, text, source_turn_ids, version, expires_at, status,
        last_decision_client_key
      ) VALUES (
        ${input.id}, ${scope.workspaceId}, ${candidate.courseId}, ${kind}, ${candidate.text},
        ${tx.json([candidate.sourceTurnId] as never)}, 1, ${storedExpiry}, ${status}, ${input.clientKey}
      ) RETURNING *`;
    const candidateStatus = input.action === "confirm" ? "accepted" : "discarded";
    const updated = await tx`
      UPDATE opening_assistant_candidates
      SET status = ${candidateStatus}, updated_at = now()
      WHERE id = ${input.id} AND workspace_id = ${scope.workspaceId} AND status = 'pending'
      RETURNING id`;
    if (!updated.length) throw new OpeningMemoryError("CONFLICT", "memory candidate decision raced");
    if (input.action === "confirm") await assertAdmitted(tx, scope, input.id, candidate.courseId, excludedIds);
    return mapMemoryRow(inserted[0] as Record<string, unknown>);
  });
}
