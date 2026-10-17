import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql } from "postgres";
import { failOpeningJob, releaseOpeningParseClaim } from "./opening-job-failure";
import type { OpeningScope } from "./opening-sources";
import { dispatchOpeningOutbox } from "./opening-job-dispatch";

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
  claimToken?: string;
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
  heartbeat(id: string, claimToken: string): Promise<boolean>;
  recoverExpired(limit?: number): Promise<number>;
  sourcePrivacyEpoch(sourceId: string, workspaceId: string): Promise<number | null>;
  /** Workspace privacy epoch (M02); defaults to 0 if column absent / row missing. */
  workspacePrivacyEpoch(workspaceId: string): Promise<number>;
  finish(id: string, state: "succeeded" | "failed" | "outcome_unknown", value: unknown, claimToken?: string): Promise<boolean>;
  /**
   * Cancel a queued/running opening job (V2-07). For compile-teaching-unit,
   * also fences activity generate_status queued|generating → cancelled.
   */
  cancel(scope: OpeningScope, id: string): Promise<OpeningJobRecord | null>;
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
    ...(typeof row.claim_token === "string" ? { claimToken: row.claim_token } : {}),
  };
}

function samePayload(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
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
      return dispatchOpeningOutbox(sql, enqueue, limit);
    },
    async sourcePrivacyEpoch(sourceId, workspaceId) {
      const rows = await sql`
        SELECT w.privacy_epoch FROM opening_sources s
        JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.id = ${sourceId} AND s.workspace_id = ${workspaceId}
        LIMIT 1
      `;
      return rows.length ? Number((rows[0] as Record<string, unknown>).privacy_epoch ?? 0) : null;
    },
    async workspacePrivacyEpoch(workspaceId) {
      const rows = await sql`
        SELECT privacy_epoch FROM workspaces WHERE id = ${workspaceId} LIMIT 1
      `;
      if (!rows.length) return 0;
      return Number((rows[0] as Record<string, unknown>).privacy_epoch ?? 0);
    },
    async claim(id) {
      return sql.begin(async (tx) => {
        await tx`SELECT w.id FROM workspaces w JOIN opening_jobs j ON j.workspace_id = w.id
          WHERE j.id = ${id} FOR SHARE OF w`;
        // Never take over an execution with an unknown external outcome. The
        // recovery sweep ends stale running jobs instead of executing them twice.
        const rows = await tx`
          UPDATE opening_jobs SET state = 'running', claim_token = ${randomUUID()}, updated_at = now()
          WHERE id = ${id} AND state = 'queued'
          RETURNING *
        `;
        if (!rows.length) return null;
        const job = mapJob(rows[0] as Record<string, unknown>);
        // Honest source status: parse / parse-media claim → source running (G7).
        // Keep version fence; never overwrite ready/failed/unsupported.
        if (job.kind === "parse" || job.kind === "parse-media") {
          const payload = job.payload && typeof job.payload === "object" ? job.payload as Record<string, unknown> : null;
          const sourceId = payload && typeof payload.sourceId === "string" ? payload.sourceId : null;
          if (sourceId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceId)) {
            const rawVersion = payload && "sourceVersion" in payload ? payload.sourceVersion : null;
            const sourceVersion = typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 0 ? rawVersion : null;
            await tx`
              UPDATE opening_sources s SET parse_state = 'running', updated_at = now()
              WHERE s.id = ${sourceId} AND s.workspace_id = ${job.workspaceId}
                AND s.upload_state = 'uploaded'
                AND (${sourceVersion}::integer IS NULL OR s.version = ${sourceVersion}::integer)
                AND s.parse_state IN ('not_started', 'queued', 'running')`;
          }
        }
        return job;
      });
    },
    async heartbeat(id, claimToken) {
      const rows = await sql`UPDATE opening_jobs SET updated_at = now()
        WHERE id = ${id} AND state = 'running' AND claim_token = ${claimToken} RETURNING id`;
      return rows.length > 0;
    },
    async recoverExpired(limit = 50) {
      const rows = await sql`SELECT id, now() - interval '5 minutes' AS stale_before FROM opening_jobs
        WHERE state = 'running' AND updated_at < now() - interval '5 minutes'
        ORDER BY updated_at LIMIT ${limit}`;
      let recovered = 0;
      for (const row of rows) {
        if (await failOpeningJob(sql, row.id, {
          error: "worker execution interrupted; outcome requires reconciliation", retryable: false,
        }, "outcome_unknown", { staleBefore: row.stale_before as Date })) recovered += 1;
      }
      return recovered;
    },
    async finish(id, state, value, claimToken) {
      if (state === "failed" || state === "outcome_unknown") return failOpeningJob(sql, id, value, state, { claimToken: claimToken ?? null });
      const rows = await sql`
        UPDATE opening_jobs SET state = ${state},
          result = ${sql.json(value as never)},
          updated_at = now()
        WHERE id = ${id} AND state = 'running'
          AND claim_token IS NOT DISTINCT FROM ${claimToken ?? null}::uuid RETURNING id
      `;
      return rows.length > 0;
    },
    async cancel(scope, id) {
      return sql.begin(async (tx) => {
        await tx`
          SELECT id FROM workspaces
          WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE
        `;
        const rows = await tx`
          UPDATE opening_jobs
          SET state = 'cancelled',
            result = ${tx.json({ message: "cancelled by user" } as never)},
            updated_at = now()
          WHERE id = ${id}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND state IN ('queued', 'running')
          RETURNING *
        `;
        if (!rows.length) return null;
        const job = mapJob(rows[0] as Record<string, unknown>);
        if (job.kind === "parse" || job.kind === "parse-media") {
          await releaseOpeningParseClaim(tx, job.payload);
        }
        if (job.kind === "compile-teaching-unit") {
          const payload =
            job.payload && typeof job.payload === "object"
              ? (job.payload as Record<string, unknown>)
              : null;
          const activityId =
            payload && typeof payload.activityId === "string" ? payload.activityId : null;
          if (activityId) {
            await tx`
              UPDATE opening_teaching_activities
              SET generate_status = 'cancelled', updated_at = now()
              WHERE id = ${activityId}
                AND workspace_id = ${scope.workspaceId}
                AND owner_user_id = ${scope.ownerUserId}
                AND generate_status IN ('queued', 'generating')
            `;
          }
        }
        return job;
      });
    },
  };
}
