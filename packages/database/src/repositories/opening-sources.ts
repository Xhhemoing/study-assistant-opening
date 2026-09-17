import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { SourceRecord, UploadInput } from "@aistudy/contracts";
import type { OpeningJobRecord } from "./opening-jobs";

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
  completeWithParseJob(scope: OpeningScope, id: string, input: { key: string; payload: unknown; privacyEpoch: number; actual: { bytes: number; sha256: string; mime: string } }): Promise<SourceRecord>;
  list(scope: OpeningScope): Promise<SourceRecord[]>;
  /**
   * Commits the source row, its parse job, and the outbox entry in ONE
   * transaction; any failure (e.g. an invalid job kind violates the CHECK)
   * rolls back so no orphan source remains.
   */
  createWithParseJob(
    scope: OpeningScope,
    input: {
      source: UploadInput;
      key: string;
      /** Enforced by the 0018 CHECK constraint: parse|tutor|retest|remind. */
      kind?: string;
      payload: unknown;
      privacyEpoch: number;
    },
  ): Promise<{ source: SourceRecord; job: OpeningJobRecord }>;
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

    async completeWithParseJob(scope, id, input) {
      return sql.begin(async (tx) => {
        const currentRows = await tx`SELECT * FROM opening_sources WHERE id = ${id} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
        if (!currentRows.length) throw new OpeningSourceError("NOT_FOUND", `Source not found: ${id}`);
        const current = mapSource(currentRows[0] as Record<string, unknown>);
        if (current.uploadState === "uploaded") return current;
        assertMatch({ bytes: current.bytes, sha256: current.sha256, mime: current.mime }, input.actual);
        const sourceRows = await tx`UPDATE opening_sources SET upload_state = 'uploaded', updated_at = now() WHERE id = ${id} AND workspace_id = ${scope.workspaceId} AND upload_state = 'pending' RETURNING *`;
        const jobId = randomUUID();
        await tx`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch) VALUES (${jobId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.key}, 'parse', ${tx.json(input.payload as never)}, ${input.privacyEpoch})`;
        await tx`INSERT INTO opening_outbox (workspace_id, job_id, topic, payload) VALUES (${scope.workspaceId}, ${jobId}, 'opening.job.enqueue', ${tx.json({ jobId, kind: 'parse', sourceId: id } as never)})`;
        return mapSource(sourceRows[0] as Record<string, unknown>);
      });
    },

    async list(scope) {
      const rows = await sql`
        SELECT * FROM opening_sources
        WHERE workspace_id = ${scope.workspaceId}
        ORDER BY created_at ASC
      `;
      return rows.map((row) => mapSource(row as Record<string, unknown>));
    },

    async createWithParseJob(scope, input) {
      const kind = input.kind ?? "parse";
      return sql.begin(async (tx) => {
        const sourceId = randomUUID();
        const sourceRows = await tx`
          INSERT INTO opening_sources (
            id, workspace_id, name, mime, bytes, sha256, version,
            upload_state, parse_state, error
          ) VALUES (
            ${sourceId}, ${scope.workspaceId}, ${input.source.name}, ${input.source.mime},
            ${input.source.bytes}, ${input.source.sha256}, 0, 'pending', 'not_started', NULL
          )
          RETURNING *
        `;
        const jobId = randomUUID();
        const jobRows = await tx`
          INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
          VALUES (
            ${jobId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.key}, ${kind},
            ${tx.json(input.payload as never)}, ${input.privacyEpoch}
          )
          RETURNING *
        `;
        await tx`
          INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
          VALUES (
            ${scope.workspaceId}, ${jobId}, 'opening.job.enqueue',
            ${tx.json({ jobId, kind, sourceId } as never)}
          )
        `;
        return {
          source: mapSource(sourceRows[0] as Record<string, unknown>),
          job: {
            id: (jobRows[0] as Record<string, unknown>).id as string,
            workspaceId: scope.workspaceId,
            ownerUserId: scope.ownerUserId,
            key: input.key,
            kind,
            payload: input.payload,
            result: null,
            state: (jobRows[0] as Record<string, unknown>).state as string,
            privacyEpoch: input.privacyEpoch,
          } satisfies OpeningJobRecord,
        };
      });
    },
  };
}
