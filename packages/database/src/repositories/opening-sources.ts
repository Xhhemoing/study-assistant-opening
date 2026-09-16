import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { SourceRecord, UploadInput } from "@aistudy/contracts";

export type OpeningSourceErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT";

export class OpeningSourceError extends Error {
  readonly code: OpeningSourceErrorCode;
  constructor(code: OpeningSourceErrorCode, message: string) {
    super(message);
    this.name = "OpeningSourceError";
    this.code = code;
  }
}

export type OpeningScope = { workspaceId: string; ownerUserId: string };

export type OpeningSourceRepository = {
  create(scope: OpeningScope, input: UploadInput): Promise<SourceRecord>;
  get(scope: OpeningScope, id: string): Promise<SourceRecord>;
  /** Marks pending → uploaded after validateStoredUpload at the boundary. */
  complete(
    scope: OpeningScope,
    id: string,
    actual: { bytes: number; sha256: string; mime: string },
  ): Promise<SourceRecord>;
  list(scope: OpeningScope): Promise<SourceRecord[]>;
};

function mapSource(row: Record<string, unknown>): SourceRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    mime: row.mime as SourceRecord["mime"],
    bytes: Number(row.bytes),
    sha256: row.sha256 as string,
    version: Number(row.version),
    uploadState: row.upload_state as SourceRecord["uploadState"],
    parseState: row.parse_state as SourceRecord["parseState"],
    error: (row.error as SourceRecord["error"]) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}

function assertMatch(
  expected: { bytes: number; sha256: string; mime: string },
  actual: { bytes: number; sha256: string; mime: string },
): void {
  if (
    actual.bytes !== expected.bytes ||
    actual.sha256.toLowerCase() !== expected.sha256.toLowerCase() ||
    actual.mime !== expected.mime
  ) {
    throw new OpeningSourceError(
      "VALIDATION",
      "stored object does not match upload ticket",
    );
  }
}

export function createOpeningSourceRepository(sql: Sql): OpeningSourceRepository {
  return {
    async create(scope, input) {
      const id = randomUUID();
      const rows = await sql`
        INSERT INTO opening_sources (
          id, workspace_id, name, mime, bytes, sha256, version,
          upload_state, parse_state, error
        ) VALUES (
          ${id}, ${scope.workspaceId}, ${input.name}, ${input.mime}, ${input.bytes},
          ${input.sha256}, 0, 'pending', 'not_started', NULL
        )
        RETURNING *
      `;
      return mapSource(rows[0] as Record<string, unknown>);
    },

    async get(scope, id) {
      const rows = await sql`
        SELECT * FROM opening_sources
        WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
        LIMIT 1
      `;
      if (!rows.length) {
        throw new OpeningSourceError("NOT_FOUND", `Source not found: ${id}`);
      }
      return mapSource(rows[0] as Record<string, unknown>);
    },

    async complete(scope, id, actual) {
      const current = await this.get(scope, id);
      if (current.uploadState === "uploaded") {
        return current;
      }
      if (current.uploadState !== "pending") {
        throw new OpeningSourceError(
          "CONFLICT",
          `cannot complete uploadState=${current.uploadState}`,
        );
      }
      assertMatch(
        { bytes: current.bytes, sha256: current.sha256, mime: current.mime },
        actual,
      );
      const rows = await sql`
        UPDATE opening_sources
        SET upload_state = 'uploaded', updated_at = now()
        WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
          AND upload_state = 'pending'
        RETURNING *
      `;
      if (!rows.length) {
        return this.get(scope, id);
      }
      return mapSource(rows[0] as Record<string, unknown>);
    },

    async list(scope) {
      const rows = await sql`
        SELECT * FROM opening_sources
        WHERE workspace_id = ${scope.workspaceId}
        ORDER BY created_at ASC
      `;
      return rows.map((row) => mapSource(row as Record<string, unknown>));
    },
  };
}
