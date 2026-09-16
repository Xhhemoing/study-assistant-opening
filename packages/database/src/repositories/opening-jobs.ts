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

export type OpeningJobRepository = {
  /**
   * Idempotent enqueue keyed by (workspace_id, key): the same payload replays
   * the original row; a changed payload for the same key is a CONFLICT.
   */
  createOnce(scope: OpeningScope, input: CreateOpeningJobInput): Promise<OpeningJobRecord>;
  get(scope: OpeningScope, id: string): Promise<OpeningJobRecord>;
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
  };
}
