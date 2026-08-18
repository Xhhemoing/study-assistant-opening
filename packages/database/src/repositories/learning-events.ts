import { randomUUID } from "node:crypto";
import {
  appendLearningEventInputSchema,
  learningEventSchema,
  type AppendLearningEventInput,
  type LearningEvent,
} from "@aistudy/contracts";
import type { Sql } from "postgres";

export type LearningEventErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "WORKSPACE_MISMATCH"
  | "CONFLICT";

export class LearningEventRepositoryError extends Error {
  constructor(
    readonly code: LearningEventErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LearningEventRepositoryError";
  }
}

export type LearningEventRepository = {
  append(input: AppendLearningEventInput): Promise<LearningEvent>;
  get(input: { workspaceId: string; eventId: string }): Promise<LearningEvent>;
  findByIdempotency(input: {
    workspaceId: string;
    ownerUserId: string;
    idempotencyKey: string;
  }): Promise<LearningEvent | null>;
  listForOwner(input: {
    workspaceId: string;
    ownerUserId: string;
    syllabusPointId?: string;
    occurredBefore?: string;
  }): Promise<LearningEvent[]>;
};

type Row = Record<string, unknown>;

function toIso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function map(row: Row): LearningEvent {
  return learningEventSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    type: row.type,
    schemaVersion: row.schema_version,
    idempotencyKey: row.idempotency_key,
    occurredAt: toIso(row.occurred_at),
    createdAt: toIso(row.created_at),
    contentId: row.content_id,
    contentVersion: row.content_version,
    syllabusPointId: row.syllabus_point_id,
    correctsEventId: row.corrects_event_id,
    payload: row.payload,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export function createLearningEventRepository(sql: Sql): LearningEventRepository {
  async function assertWorkspaceOwner(workspaceId: string, ownerUserId: string): Promise<void> {
    const rows = await sql<{ owner_user_id: string }[]>`
      SELECT owner_user_id FROM workspaces WHERE id = ${workspaceId} LIMIT 1
    `;
    if (!rows.length) {
      throw new LearningEventRepositoryError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
    }
    if (rows[0]!.owner_user_id !== ownerUserId) {
      throw new LearningEventRepositoryError(
        "WORKSPACE_MISMATCH",
        "Learning event owner must match workspace owner",
      );
    }
  }

  async function findByIdempotency(
    workspaceId: string,
    ownerUserId: string,
    idempotencyKey: string,
  ): Promise<LearningEvent | null> {
    const rows = await sql`
      SELECT * FROM learning_events
      WHERE workspace_id = ${workspaceId}
        AND owner_user_id = ${ownerUserId}
        AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] ? map(rows[0] as Row) : null;
  }

  return {
    async append(input) {
      const parsed = appendLearningEventInputSchema.parse(input);
      await assertWorkspaceOwner(parsed.workspaceId, parsed.ownerUserId);
      if (parsed.type === "correction") {
        const target = await sql<{ workspace_id: string }[]>`
          SELECT workspace_id FROM learning_events WHERE id = ${parsed.correctsEventId} LIMIT 1
        `;
        if (!target.length) {
          throw new LearningEventRepositoryError(
            "NOT_FOUND",
            `Corrected event not found: ${parsed.correctsEventId}`,
          );
        }
        if (target[0]!.workspace_id !== parsed.workspaceId) {
          throw new LearningEventRepositoryError(
            "WORKSPACE_MISMATCH",
            "Correction must stay in the same workspace",
          );
        }
      }

      const existing = await findByIdempotency(
        parsed.workspaceId,
        parsed.ownerUserId,
        parsed.idempotencyKey,
      );
      if (existing) return existing;

      const eventId = parsed.eventId ?? randomUUID();
      try {
        const rows = await sql`
          INSERT INTO learning_events (
            id, workspace_id, owner_user_id, type, schema_version, idempotency_key,
            occurred_at, content_id, content_version, syllabus_point_id, corrects_event_id, payload
          ) VALUES (
            ${eventId}, ${parsed.workspaceId}, ${parsed.ownerUserId}, ${parsed.type},
            ${parsed.schemaVersion}, ${parsed.idempotencyKey}, ${parsed.occurredAt},
            ${parsed.contentId}, ${parsed.contentVersion}, ${parsed.syllabusPointId},
            ${parsed.correctsEventId}, ${sql.json(parsed.payload)}
          )
          RETURNING *
        `;
        return map(rows[0] as Row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          const replayed = await findByIdempotency(
            parsed.workspaceId,
            parsed.ownerUserId,
            parsed.idempotencyKey,
          );
          if (replayed) return replayed;
        }
        throw error;
      }
    },

    async get(input) {
      const rows = await sql`SELECT * FROM learning_events WHERE id = ${input.eventId} LIMIT 1`;
      if (!rows.length) {
        throw new LearningEventRepositoryError("NOT_FOUND", `Learning event not found: ${input.eventId}`);
      }
      if ((rows[0] as Row).workspace_id !== input.workspaceId) {
        throw new LearningEventRepositoryError(
          "WORKSPACE_MISMATCH",
          `Learning event ${input.eventId} is not in workspace ${input.workspaceId}`,
        );
      }
      return map(rows[0] as Row);
    },

    async findByIdempotency(input) {
      return findByIdempotency(input.workspaceId, input.ownerUserId, input.idempotencyKey);
    },

    async listForOwner(input) {
      const point = input.syllabusPointId ?? null;
      const before = input.occurredBefore ?? null;
      const rows = await sql`
        SELECT * FROM learning_events
        WHERE workspace_id = ${input.workspaceId}
          AND owner_user_id = ${input.ownerUserId}
          AND (${point}::uuid IS NULL OR syllabus_point_id = ${point})
          AND (${before}::timestamptz IS NULL OR occurred_at < ${before})
        ORDER BY occurred_at ASC, created_at ASC, id ASC
      `;
      return rows.map((row) => map(row as Row));
    },
  };
}
