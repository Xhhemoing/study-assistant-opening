import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";

export class OpeningJobError extends Error { constructor(readonly code: "NOT_FOUND" | "CONFLICT", message: string) { super(message); } }
export type OpeningJobRepository = {
  createOnce(scope: OpeningScope, input: { key: string; kind: string; payload: unknown; privacyEpoch: number }): Promise<Record<string, unknown>>;
  get(scope: OpeningScope, id: string): Promise<Record<string, unknown>>;
};
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
export function createOpeningJobRepository(sql: Sql): OpeningJobRepository {
  return {
    async createOnce(scope, input) {
      const id = randomUUID();
      const rows = await sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
        VALUES (${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.key}, ${input.kind}, ${sql.json(input.payload as never)}, ${input.privacyEpoch})
        ON CONFLICT (workspace_id, key) DO NOTHING RETURNING *`;
      if (rows.length) return rows[0] as Record<string, unknown>;
      const existing = await sql`SELECT * FROM opening_jobs WHERE workspace_id=${scope.workspaceId} AND key=${input.key}`;
      if (!existing.length) throw new OpeningJobError("NOT_FOUND", "job disappeared");
      if (!same((existing[0] as Record<string, unknown>).payload, input.payload)) throw new OpeningJobError("CONFLICT", "idempotency payload differs");
      return existing[0] as Record<string, unknown>;
    },
    async get(scope, id) {
      const rows = await sql`SELECT * FROM opening_jobs WHERE id=${id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      if (!rows.length) throw new OpeningJobError("NOT_FOUND", "Job not found");
      return rows[0] as Record<string, unknown>;
    },
  };
}
