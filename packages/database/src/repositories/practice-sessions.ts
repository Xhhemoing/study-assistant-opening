import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { createPracticeContentRepository } from "./practice-content";
import {
  mapSession,
  PracticeContentRepositoryError,
  type PracticeSessionRepository,
  type Row,
} from "./practice-content-types";

export type { PracticeSessionRepository } from "./practice-content-types";

async function assertWorkspaceOwner(
  sql: Sql,
  workspaceId: string,
  ownerUserId: string,
): Promise<void> {
  const rows = await sql<{ owner_user_id: string }[]>`
    SELECT owner_user_id FROM workspaces WHERE id = ${workspaceId} LIMIT 1
  `;
  if (!rows.length) {
    throw new PracticeContentRepositoryError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
  }
  if (rows[0]!.owner_user_id !== ownerUserId) {
    throw new PracticeContentRepositoryError(
      "WORKSPACE_MISMATCH",
      "Practice session owner must match workspace owner",
    );
  }
}

export function createPracticeSessionRepository(sql: Sql): PracticeSessionRepository {
  const content = createPracticeContentRepository(sql);

  async function lockSession(input: {
    workspaceId: string;
    ownerUserId: string;
    sessionId: string;
  }) {
    const rows = await sql`
      SELECT * FROM practice_sessions
      WHERE workspace_id = ${input.workspaceId}
        AND owner_user_id = ${input.ownerUserId}
        AND id = ${input.sessionId}
      LIMIT 1
      FOR UPDATE
    `;
    if (!rows[0]) {
      throw new PracticeContentRepositoryError(
        "NOT_FOUND",
        `Practice session ${input.sessionId} was not found`,
      );
    }
    return mapSession(rows[0] as Row);
  }

  return {
    async start(input) {
      await assertWorkspaceOwner(sql, input.workspaceId, input.ownerUserId);
      const item = await content.getPublicItem({
        workspaceId: input.workspaceId,
        itemId: input.practiceItemId,
      });
      const current = await sql<{ archived_at: string | null }[]>`
        SELECT archived_at FROM practice_items
        WHERE workspace_id = ${input.workspaceId} AND id = ${input.practiceItemId}
        LIMIT 1
      `;
      if (current[0]?.archived_at) {
        throw new PracticeContentRepositoryError("ARCHIVED", "Archived items cannot start a session");
      }
      const rows = await sql`
        INSERT INTO practice_sessions (
          id, workspace_id, owner_user_id, practice_item_id, content_version
        ) VALUES (
          ${randomUUID()}, ${input.workspaceId}, ${input.ownerUserId},
          ${input.practiceItemId}, ${item.contentVersion}
        )
        RETURNING *
      `;
      return mapSession(rows[0] as Row);
    },

    async lock(input) {
      await assertWorkspaceOwner(sql, input.workspaceId, input.ownerUserId);
      return lockSession(input);
    },

    async recordHint(input) {
      await assertWorkspaceOwner(sql, input.workspaceId, input.ownerUserId);
      return sql.begin(async (tx) => {
        const client = tx as Sql;
        const session = await createPracticeSessionRepository(client).lock(input);
        if (session.submittedAt) {
          throw new PracticeContentRepositoryError("CONFLICT", "Submitted sessions cannot request hints");
        }
        const item = await createPracticeContentRepository(client).getGradableVersion({
          workspaceId: input.workspaceId,
          itemId: session.practiceItemId,
          version: session.contentVersion,
        });
        if (session.hintCount >= item.hints.length) {
          throw new PracticeContentRepositoryError("VALIDATION", "No remaining hints");
        }
        const rows = await client`
          UPDATE practice_sessions
          SET hint_count = hint_count + 1
          WHERE id = ${session.id} AND workspace_id = ${input.workspaceId}
          RETURNING *
        `;
        return {
          session: mapSession(rows[0] as Row),
          hint: item.hints[session.hintCount]!,
        };
      });
    },

    async recordAnswerReveal(input) {
      await assertWorkspaceOwner(sql, input.workspaceId, input.ownerUserId);
      const session = await lockSession(input);
      if (session.submittedAt) {
        throw new PracticeContentRepositoryError("CONFLICT", "Submitted sessions cannot reveal answers");
      }
      const rows = await sql`
        UPDATE practice_sessions
        SET answer_revealed_at = COALESCE(answer_revealed_at, now())
        WHERE id = ${session.id} AND workspace_id = ${input.workspaceId}
        RETURNING *
      `;
      return mapSession(rows[0] as Row);
    },

    async markSubmitted(input) {
      await assertWorkspaceOwner(sql, input.workspaceId, input.ownerUserId);
      const session = await lockSession(input);
      if (session.submittedAt) {
        const existing = await sql<{ submission_idempotency_key: string | null }[]>`
          SELECT submission_idempotency_key FROM practice_sessions
          WHERE id = ${session.id} AND workspace_id = ${input.workspaceId}
          LIMIT 1
        `;
        if (existing[0]?.submission_idempotency_key === input.idempotencyKey) {
          return session;
        }
        throw new PracticeContentRepositoryError(
          "CONFLICT",
          "Submitted session cannot be reused with a different idempotency key",
        );
      }
      const rows = await sql`
        UPDATE practice_sessions
        SET submitted_at = now(), submission_idempotency_key = ${input.idempotencyKey}
        WHERE id = ${session.id} AND workspace_id = ${input.workspaceId} AND submitted_at IS NULL
        RETURNING *
      `;
      return mapSession(rows[0] as Row);
    },
  };
}
