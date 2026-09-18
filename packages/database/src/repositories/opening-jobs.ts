import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";

export type OpeningJobErrorCode = "NOT_FOUND" | "CONFLICT";

export class OpeningJobError extends Error {
  readonly code: OpeningJobErrorCode;
  constructor(code: OpeningJobErrorCode, message: string) {
    super(message);
    this.name = "OpeningJobError";
    this.code = code;
  }
}

/** Persisted job snapshot; payload/result are opaque JSON to callers. */
export type OpeningJobRecord = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  key: string;
  kind: string;
  payload: unknown;
  result: unknown;
  state: string;
  privacyEpoch: number;
};

export type CreateOpeningJobInput = {
  key: string;
  kind: string;
  payload: unknown;
  privacyEpoch: number;
};

export type OpeningOutboxRecord = {
  id: string;
  workspaceId: string;
  jobId: string;
  payload: unknown;
};

export type OpeningJobRepository = {
  /**
   * Idempotent enqueue keyed by (workspace_id, key): the same payload replays
   * the original row; a changed payload for the same key is a CONFLICT.
   */
  createOnce(scope: OpeningScope, input: CreateOpeningJobInput): Promise<OpeningJobRecord>;
  get(scope: OpeningScope, id: string): Promise<OpeningJobRecord>;
  dispatchPending(
    enqueue: (outbox: OpeningOutboxRecord) => Promise<void>,
    limit?: number,
  ): Promise<number>;
  claim(id: string): Promise<OpeningJobRecord | null>;
  sourcePrivacyEpoch(sourceId: string, workspaceId: string): Promise<number | null>;
  finish(id: string, state: "succeeded" | "failed" | "outcome_unknown", value: unknown): Promise<boolean>;
};

function mapJob(row: Record<string, unknown>): OpeningJobRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    ownerUserId: row.owner_user_id as string,
    key: row.key as string,
    kind: row.kind as string,
    payload: row.payload,
    result: row.result ?? null,
    state: row.state as string,
    privacyEpoch: Number(row.privacy_epoch),
  };
}

function samePayload(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createOpeningJobRepository(sql: Sql): OpeningJobRepository {
  return {
    async createOnce(scope, input) {
      const id = randomUUID();
      const inserted = await sql`
        INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
        VALUES (${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.key}, ${input.kind},
          ${sql.json(input.payload as never)}, ${input.privacyEpoch})
        ON CONFLICT (workspace_id, key) DO NOTHING
        RETURNING *
      `;
      if (inserted.length) return mapJob(inserted[0] as Record<string, unknown>);
      const existing = await sql`
        SELECT * FROM opening_jobs
        WHERE workspace_id = ${scope.workspaceId} AND key = ${input.key}
      `;
      const row = existing[0] as Record<string, unknown> | undefined;
      if (!row) throw new OpeningJobError("NOT_FOUND", "job disappeared after conflict");
      if (!samePayload(row.payload, input.payload)) {
        throw new OpeningJobError("CONFLICT", "idempotency payload differs for the same key");
      }
      return mapJob(row);
    },
    async get(scope, id) {
      const rows = await sql`
        SELECT * FROM opening_jobs
        WHERE id = ${id} AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      `;
      if (!rows.length) throw new OpeningJobError("NOT_FOUND", "job not found");
      return mapJob(rows[0] as Record<string, unknown>);
    },
    async dispatchPending(enqueue, limit = 50) {
      return sql.begin(async (tx) => {
        const rows = await tx`
          SELECT id, workspace_id, job_id, payload FROM opening_outbox
          WHERE state = 'pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT ${limit}
        `;
        let dispatched = 0;
        for (const row of rows as Array<Record<string, unknown>>) {
          const item = { id: row.id as string, workspaceId: row.workspace_id as string, jobId: row.job_id as string, payload: row.payload };
          try {
            await enqueue(item);
            await tx`UPDATE opening_outbox SET state = 'published', updated_at = now() WHERE id = ${item.id}`;
            dispatched += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : "enqueue failed";
            await tx`UPDATE opening_outbox SET state = 'failed', payload = ${tx.json({ ...item.payload as Record<string, unknown>, error: message } as never)}, updated_at = now() WHERE id = ${item.id}`;
          }
        }
        return dispatched;
      });
    },
    async sourcePrivacyEpoch(sourceId, workspaceId) {
      const rows = await sql`
        SELECT version AS privacy_epoch FROM opening_sources
        WHERE id = ${sourceId} AND workspace_id = ${workspaceId}
        LIMIT 1
      `;
      return rows.length ? Number((rows[0] as Record<string, unknown>).privacy_epoch ?? 0) : null;
    },
    async claim(id) {
      // updated_at is the heartbeat. Long handlers must periodically touch it;
      // only jobs stale for five minutes are eligible for takeover.
      const rows = await sql`
        UPDATE opening_jobs SET state = 'running', updated_at = now()
        WHERE id = ${id}
          AND (state = 'queued' OR (state = 'running' AND updated_at < now() - interval '5 minutes'))
        RETURNING *
      `;
      return rows.length ? mapJob(rows[0] as Record<string, unknown>) : null;
    },
    async finish(id, state, value) {
      const rows = await sql`
        UPDATE opening_jobs SET state = ${state},
          result = ${sql.json(value as never)},
          updated_at = now()
        WHERE id = ${id} AND state = 'running' RETURNING id
      `;
      if (!rows.length && state !== 'succeeded') {
        await sql`UPDATE opening_jobs SET state = ${state}, result = ${sql.json(value as never)}, updated_at = now() WHERE id = ${id} AND state = 'running'`;
      }
      return rows.length > 0;
    },
  };
}
