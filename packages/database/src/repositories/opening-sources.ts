import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { SourceRecord, UploadInput, UploadTicket } from "@aistudy/contracts";
import type { OpeningJobRecord } from "./opening-jobs";
import { lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { invalidateOpeningLearningEligibility } from "./opening-learning-eligibility";

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

/**
 * Null-lease fallback for pending rows that never got `upload_url_expires_at`
 * (create without ticket, or legacy pre-0034). Aligns with staging upload lease
 * `STAGING_UPLOAD_LEASE_MS = 900_000` and delete cleanup fallback in
 * opening-source-actions.
 */
export const PENDING_UPLOAD_TTL_FALLBACK_MS = 900_000;

/** Default batch size for global worker sweeps. */
export const PENDING_UPLOAD_TTL_SWEEP_LIMIT = 100;

/** Stored on `opening_sources.error` jsonb when TTL sweeper rejects a pending upload. */
export const UPLOAD_TTL_EXPIRED_ERROR = {
  code: "UPLOAD_TTL_EXPIRED",
  message: "上传凭证已过期，文件未在有效期内完成上传。",
  retryable: false,
} as const;

export type SweptPendingUpload = { id: string; workspaceId: string };

export type SweepExpiredPendingUploadsOptions = {
  /** Clock injection for tests; defaults to `new Date()`. */
  now?: Date;
  /** Max rows to reject per call (global All path); default PENDING_UPLOAD_TTL_SWEEP_LIMIT. */
  limit?: number;
};

export type OpeningSourceRepository = {
  create(scope: OpeningScope, input: UploadInput): Promise<SourceRecord>;
  get(scope: OpeningScope, id: string): Promise<SourceRecord>;
  issueUploadTicket(scope: OpeningScope, id: string, sign: (source: SourceRecord) => Promise<Omit<UploadTicket, "source">>): Promise<UploadTicket>;
  /** Marks pending → uploaded after validateStoredUpload at the boundary. */
  complete(
    scope: OpeningScope,
    id: string,
    actual: { bytes: number; sha256: string; mime: string },
  ): Promise<SourceRecord>;
  completeWithParseJob(scope: OpeningScope, id: string, input: { key: string; payload: unknown; privacyEpoch: number; actual: { bytes: number; sha256: string; mime: string }; beforeComplete?: (current: SourceRecord) => Promise<void> }): Promise<SourceRecord>;
  retryParseWithJob(scope: OpeningScope, id: string, input: { key: string; payload: unknown; privacyEpoch: number }): Promise<SourceRecord>;
  list(scope: OpeningScope): Promise<SourceRecord[]>;
  markParseState(scope: OpeningScope, id: string, state: SourceRecord["parseState"], error?: unknown): Promise<SourceRecord>;
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
  /**
   * G4: reject workspace-scoped pending uploads whose upload lease (or null-lease
   * fallback) has expired. Idempotent — non-pending rows are skipped.
   * Returns swept ids for optional notify (no Slack/email send here).
   */
  sweepExpiredPendingUploads(
    scope: OpeningScope,
    options?: SweepExpiredPendingUploadsOptions,
  ): Promise<SweptPendingUpload[]>;
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

function parseJobKindForMime(mime: string): "parse" | "parse-media" {
  return mime.startsWith("video/") || mime.startsWith("audio/") ? "parse-media" : "parse";
}

function mapSwept(row: Record<string, unknown>): SweptPendingUpload {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
  };
}

/**
 * G4 pending TTL: primary expiry is `upload_url_expires_at` (set by
 * issueUploadTicket from ticket.expiresAt ≈ now+15m). When that column is NULL,
 * fall back to created_at + PENDING_UPLOAD_TTL_FALLBACK_MS (same 15m lease).
 * Leaves parse_state unchanged (typically not_started). Sets error jsonb.
 */
async function sweepExpiredPendingUploadsQuery(
  sql: Sql,
  filter: { workspaceId?: string },
  options: SweepExpiredPendingUploadsOptions = {},
): Promise<SweptPendingUpload[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? PENDING_UPLOAD_TTL_SWEEP_LIMIT;
  const fallbackCutoff = new Date(now.getTime() - PENDING_UPLOAD_TTL_FALLBACK_MS);
  // null workspaceId → global (worker); uuid → workspace-scoped. Avoid nested sql`` fragments.
  const workspaceId = filter.workspaceId ?? null;
  const rows = await sql`
    UPDATE opening_sources AS s
    SET
      upload_state = 'rejected',
      error = ${sql.json(UPLOAD_TTL_EXPIRED_ERROR as never)},
      updated_at = now()
    FROM (
      SELECT id
      FROM opening_sources
      WHERE upload_state = 'pending'
        AND (
          upload_url_expires_at < ${now}
          OR (
            upload_url_expires_at IS NULL
            AND created_at < ${fallbackCutoff}
          )
        )
        AND (${workspaceId}::uuid IS NULL OR workspace_id = ${workspaceId})
      ORDER BY created_at ASC
      LIMIT ${limit}
    ) AS expired
    WHERE s.id = expired.id
      AND s.upload_state = 'pending'
    RETURNING s.id, s.workspace_id
  `;
  return rows.map((row) => mapSwept(row as Record<string, unknown>));
}

/** Workspace-scoped pending upload TTL sweeper (G4). */
export async function sweepExpiredPendingUploads(
  sql: Sql,
  scope: OpeningScope,
  options: SweepExpiredPendingUploadsOptions = {},
): Promise<SweptPendingUpload[]> {
  return sweepExpiredPendingUploadsQuery(sql, { workspaceId: scope.workspaceId }, options);
}

/**
 * Global pending upload TTL sweeper for a worker/cron hook (G4).
 * Returns swept `{ id, workspaceId }` for optional notify — callers decide delivery.
 */
export async function sweepExpiredPendingUploadsAll(
  sql: Sql,
  options: SweepExpiredPendingUploadsOptions = {},
): Promise<SweptPendingUpload[]> {
  return sweepExpiredPendingUploadsQuery(sql, {}, options);
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

    async issueUploadTicket(scope, id, sign) {
      return sql.begin(async tx => {
        const rows = await tx`SELECT * FROM opening_sources WHERE id=${id} AND workspace_id=${scope.workspaceId} FOR UPDATE`;
        if (!rows.length) throw new OpeningSourceError("NOT_FOUND", "Source not found");
        const source = mapSource(rows[0] as Record<string, unknown>);
        if (source.uploadState !== "pending") throw new OpeningSourceError("CONFLICT", "Upload is no longer pending");
        const ticket = await sign(source);
        await tx`UPDATE opening_sources SET upload_url_expires_at=${new Date(ticket.expiresAt)} WHERE id=${id} AND workspace_id=${scope.workspaceId}`;
        return { source, ...ticket };
      });
    },

    async complete(scope, id, actual) {
      return sql.begin(async (tx) => {
        await lockWorkspaceLearningHistory(tx, scope);
        const currentRows = await tx`SELECT * FROM opening_sources
          WHERE id=${id} AND workspace_id=${scope.workspaceId} FOR UPDATE`;
        if (!currentRows.length) throw new OpeningSourceError("NOT_FOUND", `Source not found: ${id}`);
        const current = mapSource(currentRows[0] as Record<string, unknown>);
        if (current.uploadState === "uploaded") return current;
        if (current.uploadState !== "pending") {
          throw new OpeningSourceError("CONFLICT", `cannot complete uploadState=${current.uploadState}`);
        }
        assertMatch({ bytes: current.bytes, sha256: current.sha256, mime: current.mime }, actual);
        const rows = await tx`
          WITH completed AS (
            UPDATE opening_sources SET upload_state = 'uploaded', updated_at = now()
            WHERE id = ${id} AND workspace_id = ${scope.workspaceId} AND upload_state = 'pending'
            RETURNING *
          ), captured AS (
            INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
            SELECT id,version,workspace_id,bytes,sha256,'available' FROM completed
            ON CONFLICT(source_id,version) DO NOTHING
          ) SELECT * FROM completed
        `;
        if (!rows.length) throw new OpeningSourceError("CONFLICT", "Upload is no longer pending");
        await nextWorkspaceLearningHistoryRevision(tx, scope);
        await invalidateOpeningLearningEligibility(tx, scope, { sourceIds: [id] });
        return mapSource(rows[0] as Record<string, unknown>);
      });
    },
    async completeWithParseJob(scope, id, input) {
      return sql.begin(async (tx) => {
        await lockWorkspaceLearningHistory(tx, scope);
        const owners = await tx`SELECT id, privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
        if (!owners.length) throw new OpeningSourceError("NOT_FOUND", "Workspace not found");
        if (Number((owners[0] as Record<string, unknown>).privacy_epoch ?? 0) !== input.privacyEpoch) {
          throw new OpeningSourceError("CONFLICT", "Workspace privacy settings changed; retry the upload");
        }
        const currentRows = await tx`SELECT * FROM opening_sources WHERE id = ${id} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
        if (!currentRows.length) throw new OpeningSourceError("NOT_FOUND", `Source not found: ${id}`);
        const current = mapSource(currentRows[0] as Record<string, unknown>);
        if (current.uploadState === "uploaded") return current;
        if (current.uploadState !== "pending") throw new OpeningSourceError("CONFLICT", "Upload is no longer pending");
        assertMatch({ bytes: current.bytes, sha256: current.sha256, mime: current.mime }, input.actual);
        await input.beforeComplete?.(current);
        const sourceRows = await tx`UPDATE opening_sources SET upload_state = 'uploaded', parse_state = 'queued', error = NULL, updated_at = now() WHERE id = ${id} AND workspace_id = ${scope.workspaceId} AND upload_state = 'pending' RETURNING *`;
        await tx`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
          SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources
          WHERE id=${id} AND workspace_id=${scope.workspaceId} AND upload_state='uploaded'
          ON CONFLICT(source_id,version) DO NOTHING`;
        const jobId = randomUUID();
        const jobKind = parseJobKindForMime(current.mime);
        await tx`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch) VALUES (${jobId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.key}, ${jobKind}, ${tx.json(input.payload as never)}, ${input.privacyEpoch})`;
        await tx`INSERT INTO opening_outbox (workspace_id, job_id, topic, payload) VALUES (${scope.workspaceId}, ${jobId}, 'opening.job.enqueue', ${tx.json({ jobId, kind: jobKind, sourceId: id } as never)})`;
        await nextWorkspaceLearningHistoryRevision(tx, scope);
        await invalidateOpeningLearningEligibility(tx, scope, { sourceIds: [id] });
        return mapSource(sourceRows[0] as Record<string, unknown>);
      });
    },
    async retryParseWithJob(scope, id, input) {
      return sql.begin(async (tx) => {
        await lockWorkspaceLearningHistory(tx, scope);
        const owners = await tx`SELECT id, privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
        if (!owners.length) throw new OpeningSourceError("NOT_FOUND", "Workspace not found");
        if (Number((owners[0] as Record<string, unknown>).privacy_epoch ?? 0) !== input.privacyEpoch) {
          throw new OpeningSourceError("CONFLICT", "Workspace privacy settings changed; retry parsing");
        }
        const currentRows = await tx`SELECT * FROM opening_sources WHERE id=${id} AND workspace_id=${scope.workspaceId} FOR UPDATE`;
        if (!currentRows.length) throw new OpeningSourceError("NOT_FOUND", `Source not found: ${id}`);
        const current = mapSource(currentRows[0] as Record<string, unknown>);
        if (current.uploadState !== "uploaded") throw new OpeningSourceError("CONFLICT", "Only uploaded sources can be parsed again");
        if (current.parseState !== "failed") throw new OpeningSourceError("CONFLICT", "Only failed sources can be parsed again");
        if (current.error?.code === "PRIVACY_EXCLUDED") throw new OpeningSourceError("CONFLICT", "Excluded sources cannot be parsed again");
        const sourceRows = await tx`UPDATE opening_sources
          SET parse_state='queued', error=NULL, updated_at=now()
          WHERE id=${id} AND workspace_id=${scope.workspaceId} AND upload_state='uploaded' AND parse_state='failed'
          RETURNING *`;
        if (!sourceRows.length) throw new OpeningSourceError("CONFLICT", "Source parse state changed; refresh and try again");
        const jobId = randomUUID();
        const jobKind = parseJobKindForMime(current.mime);
        await tx`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
          VALUES (${jobId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.key}, ${jobKind}, ${tx.json(input.payload as never)}, ${input.privacyEpoch})`;
        await tx`INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
          VALUES (${scope.workspaceId}, ${jobId}, 'opening.job.enqueue', ${tx.json({ jobId, kind: jobKind, sourceId: id } as never)})`;
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

    async markParseState(scope, id, state, error = null) {
      const rows = await sql`UPDATE opening_sources SET parse_state = ${state}, error = ${sql.json(error as never)}, updated_at = now() WHERE id = ${id} AND workspace_id = ${scope.workspaceId} RETURNING *`;
      if (!rows.length) throw new OpeningSourceError("NOT_FOUND", `Source not found: ${id}`);
      return mapSource(rows[0] as Record<string, unknown>);
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

    sweepExpiredPendingUploads(scope, options) {
      return sweepExpiredPendingUploadsQuery(sql, { workspaceId: scope.workspaceId }, options);
    },
  };
}
