/**
 * Durable P04 action-digest accept/reject overlay (migration 0052).
 *
 * Experience swap:
 *   createInMemoryActionCandidateStore()
 *     → createOpeningActionDigestDecisionsRepository(sql)
 *
 * `list` returns stored decisions only (accepted | rejected | superseded) for
 * overlay merge onto extract-study-actions pending rows. Pending is never stored.
 * Rejected-by-dedupeKey rows surface on list so buildActionDigest will not re-prompt.
 */
import {
  actionCandidateSchema,
  type ActionCandidate,
  type Scope,
} from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { OpeningPlanError } from "./opening-plan-error";

export type ActionDigestDecisionStatus = "accepted" | "rejected" | "superseded";

export type ActionCandidateStore = {
  list(scope: Scope): Promise<ActionCandidate[]>;
  upsert(scope: Scope, candidate: ActionCandidate): Promise<ActionCandidate>;
  replaceAll?(scope: Scope, candidates: ActionCandidate[]): Promise<void>;
};

export type RecordActionDigestDecisionInput = {
  decision: "accept" | "reject";
  candidate: ActionCandidate;
  clientKey?: string;
};

const DECISION_STATUSES = new Set<ActionDigestDecisionStatus>([
  "accepted",
  "rejected",
  "superseded",
]);

function mapRow(row: Record<string, unknown>): ActionCandidate {
  return actionCandidateSchema.parse({
    id: String(row.candidate_id ?? row.id),
    dedupeKey: String(row.dedupe_key),
    title: String(row.title),
    minutes: Number(row.minutes),
    dueAt: row.due_at ? new Date(row.due_at as string | Date).toISOString() : null,
    priority: Number(row.priority),
    sourceIds: (row.source_ids as string[]) ?? [],
    status: row.status as ActionCandidate["status"],
    needsConfirmation: Boolean(row.needs_confirmation),
  });
}

function sameDecisionPayload(existing: ActionCandidate, next: ActionCandidate): boolean {
  return (
    existing.dedupeKey === next.dedupeKey &&
    existing.title === next.title &&
    existing.minutes === next.minutes &&
    existing.dueAt === next.dueAt &&
    existing.priority === next.priority &&
    existing.needsConfirmation === next.needsConfirmation &&
    existing.sourceIds.length === next.sourceIds.length &&
    existing.sourceIds.every((id, i) => id === next.sourceIds[i])
  );
}

async function assertOwnedWorkspace(tx: Sql | TransactionSql, scope: Scope): Promise<void> {
  const rows = await tx`
    SELECT id FROM workspaces
    WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
    FOR UPDATE`;
  if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
}

/**
 * Refuse accept when any candidate source was imported via a now-revoked connection.
 * Reject/supersede remain allowed so late noise can still be suppressed.
 */
async function assertAcceptSourcesWritable(
  tx: Sql | TransactionSql,
  scope: Scope,
  sourceIds: readonly string[],
): Promise<void> {
  if (!sourceIds.length) return;
  const revoked = await tx`
    SELECT 1
    FROM opening_import_receipts r
    JOIN opening_connections c
      ON c.id = r.connection_id
     AND c.workspace_id = r.workspace_id
     AND c.owner_user_id = r.owner_user_id
    WHERE r.workspace_id = ${scope.workspaceId}
      AND r.owner_user_id = ${scope.ownerUserId}
      AND r.source_id IN ${tx(sourceIds as string[])}
      AND c.state = 'revoked'
    LIMIT 1`;
  if (revoked.length) {
    throw new OpeningPlanError("CONFLICT", "source connection is revoked");
  }
}

async function findByCandidateId(
  tx: Sql | TransactionSql,
  scope: Scope,
  candidateId: string,
): Promise<ActionCandidate | null> {
  const rows = await tx`
    SELECT * FROM opening_action_digest_decisions
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND candidate_id = ${candidateId}
    LIMIT 1`;
  if (!rows.length) return null;
  return mapRow(rows[0] as Record<string, unknown>);
}

async function findByClientKey(
  tx: Sql | TransactionSql,
  scope: Scope,
  clientKey: string,
): Promise<{ row: ActionCandidate; status: string; candidateId: string } | null> {
  const rows = await tx`
    SELECT * FROM opening_action_digest_decisions
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND client_key = ${clientKey}
    LIMIT 1`;
  if (!rows.length) return null;
  const raw = rows[0] as Record<string, unknown>;
  return {
    row: mapRow(raw),
    status: String(raw.status),
    candidateId: String(raw.candidate_id),
  };
}

async function insertDecision(
  tx: TransactionSql,
  scope: Scope,
  candidate: ActionCandidate,
  clientKey: string | null,
): Promise<ActionCandidate> {
  const dueAt = candidate.dueAt;
  const rows = await tx`
    INSERT INTO opening_action_digest_decisions (
      id, workspace_id, owner_user_id, candidate_id, dedupe_key,
      title, minutes, due_at, priority, source_ids, needs_confirmation,
      status, client_key
    ) VALUES (
      ${candidate.id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${candidate.id},
      ${candidate.dedupeKey}, ${candidate.title}, ${candidate.minutes},
      ${dueAt}, ${candidate.priority}, ${candidate.sourceIds},
      ${candidate.needsConfirmation}, ${candidate.status}, ${clientKey}
    )
    RETURNING *`;
  return mapRow(rows[0] as Record<string, unknown>);
}

/**
 * ActionCandidateStore-compatible durable overlay for Experience wiring.
 */
export function createOpeningActionDigestDecisionsRepository(
  sql: Sql,
): ActionCandidateStore & {
  recordDecision(
    scope: Scope,
    input: RecordActionDigestDecisionInput,
  ): Promise<ActionCandidate>;
} {
  return {
    async list(scope) {
      const rows = await sql`
        SELECT d.*
        FROM opening_action_digest_decisions d
        JOIN workspaces w ON w.id = d.workspace_id AND w.owner_user_id = d.owner_user_id
        WHERE d.workspace_id = ${scope.workspaceId}
          AND d.owner_user_id = ${scope.ownerUserId}
          AND w.owner_user_id = ${scope.ownerUserId}
        ORDER BY d.updated_at ASC, d.candidate_id ASC`;
      return rows.map((row) => mapRow(row as Record<string, unknown>));
    },

    async upsert(scope, candidate) {
      const parsed = actionCandidateSchema.parse(candidate);
      if (!DECISION_STATUSES.has(parsed.status as ActionDigestDecisionStatus)) {
        throw new OpeningPlanError(
          "VALIDATION",
          "action digest overlay stores only accepted|rejected|superseded",
        );
      }

      try {
        return await sql.begin(async (tx) => {
          await assertOwnedWorkspace(tx, scope);
          if (parsed.status === "accepted") {
            await assertAcceptSourcesWritable(tx, scope, parsed.sourceIds);
          }

          const existing = await findByCandidateId(tx, scope, parsed.id);
          if (existing) {
            if (existing.status === parsed.status) {
              if (!sameDecisionPayload(existing, parsed)) {
                throw new OpeningPlanError("CONFLICT", "decision payload differs for same status");
              }
              return existing;
            }
            throw new OpeningPlanError(
              "CONFLICT",
              `decision status conflict: stored ${existing.status}, requested ${parsed.status}`,
            );
          }

          return insertDecision(tx, scope, parsed, null);
        });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "23505"
        ) {
          const raced = await findByCandidateId(sql, scope, parsed.id);
          if (raced && raced.status === parsed.status && sameDecisionPayload(raced, parsed)) {
            return raced;
          }
          throw new OpeningPlanError("CONFLICT", "decision write conflict");
        }
        throw error;
      }
    },

    async replaceAll(scope, candidates) {
      const parsed = candidates.map((c) => actionCandidateSchema.parse(c));
      for (const c of parsed) {
        if (!DECISION_STATUSES.has(c.status as ActionDigestDecisionStatus)) {
          throw new OpeningPlanError(
            "VALIDATION",
            "action digest overlay stores only accepted|rejected|superseded",
          );
        }
      }
      await sql.begin(async (tx) => {
        await assertOwnedWorkspace(tx, scope);
        for (const c of parsed) {
          if (c.status === "accepted") {
            await assertAcceptSourcesWritable(tx, scope, c.sourceIds);
          }
        }
        await tx`
          DELETE FROM opening_action_digest_decisions
          WHERE workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}`;
        for (const c of parsed) {
          await insertDecision(tx, scope, c, null);
        }
      });
    },

    /**
     * Map accept|reject onto ActionCandidate.status and upsert idempotently.
     * Optional clientKey replays the same decision write.
     */
    async recordDecision(scope, input) {
      const status: ActionDigestDecisionStatus =
        input.decision === "accept" ? "accepted" : "rejected";
      const parsed = actionCandidateSchema.parse({
        ...input.candidate,
        status,
        needsConfirmation: false,
      });
      const clientKey = input.clientKey ?? null;

      try {
        return await sql.begin(async (tx) => {
          await assertOwnedWorkspace(tx, scope);

          if (clientKey) {
            const prior = await findByClientKey(tx, scope, clientKey);
            if (prior) {
              if (prior.candidateId !== parsed.id || prior.status !== status) {
                throw new OpeningPlanError("CONFLICT", "clientKey payload differs");
              }
              if (!sameDecisionPayload(prior.row, parsed)) {
                throw new OpeningPlanError("CONFLICT", "clientKey payload differs");
              }
              return prior.row;
            }
          }

          if (status === "accepted") {
            await assertAcceptSourcesWritable(tx, scope, parsed.sourceIds);
          }

          const existing = await findByCandidateId(tx, scope, parsed.id);
          if (existing) {
            if (existing.status === status) {
              if (!sameDecisionPayload(existing, parsed)) {
                throw new OpeningPlanError("CONFLICT", "decision payload differs for same status");
              }
              return existing;
            }
            throw new OpeningPlanError(
              "CONFLICT",
              `decision status conflict: stored ${existing.status}, requested ${status}`,
            );
          }

          return insertDecision(tx, scope, parsed, clientKey);
        });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "23505" &&
          clientKey
        ) {
          const prior = await findByClientKey(sql, scope, clientKey);
          if (
            prior &&
            prior.candidateId === parsed.id &&
            prior.status === status &&
            sameDecisionPayload(prior.row, parsed)
          ) {
            return prior.row;
          }
          throw new OpeningPlanError("CONFLICT", "clientKey payload differs");
        }
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "23505"
        ) {
          const raced = await findByCandidateId(sql, scope, parsed.id);
          if (raced && raced.status === status && sameDecisionPayload(raced, parsed)) {
            return raced;
          }
          throw new OpeningPlanError("CONFLICT", "decision write conflict");
        }
        throw error;
      }
    },
  };
}

export type OpeningActionDigestDecisionsRepository = ReturnType<
  typeof createOpeningActionDigestDecisionsRepository
>;
