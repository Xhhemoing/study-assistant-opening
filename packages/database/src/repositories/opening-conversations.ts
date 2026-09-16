import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type {
  ConversationCreateInput,
  ConversationSummary,
  TurnRecord,
  TutorMode,
} from "@aistudy/contracts";

export type OpeningConversationScope = {
  workspaceId: string;
  ownerUserId: string;
};

export type OpeningConversationErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "VALIDATION";

export class OpeningConversationError extends Error {
  readonly code: OpeningConversationErrorCode;
  constructor(code: OpeningConversationErrorCode, message: string) {
    super(message);
    this.name = "OpeningConversationError";
    this.code = code;
  }
}

export type StoredTurn = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  mode: TutorMode;
  status: "pending" | "complete" | "failed";
  clientKey: string | null;
  learningSessionId: string | null;
  currentPage: number | null;
  chunkId: string | null;
  sourceIds: string[];
  createdAt: string;
};

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

export function createOpeningConversationRepository(sql: Sql) {
  return {
    async create(
      scope: OpeningConversationScope,
      input: ConversationCreateInput,
    ): Promise<{ id: string; title: string; courseId: string | null }> {
      const id = randomUUID();
      await sql`
        INSERT INTO opening_conversations (
          id, workspace_id, owner_user_id, title, course_id
        ) VALUES (
          ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.title}, ${input.courseId}
        )
      `;
      return { id, title: input.title, courseId: input.courseId };
    },

    async getOwned(
      scope: OpeningConversationScope,
      conversationId: string,
    ): Promise<{
      id: string;
      title: string;
      courseId: string | null;
      updatedAt: string;
    }> {
      const rows = await sql`
        SELECT id, title, course_id, updated_at
        FROM opening_conversations
        WHERE id = ${conversationId}
          AND workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
        LIMIT 1
      `;
      if (!rows.length) {
        throw new OpeningConversationError(
          "NOT_FOUND",
          `Conversation not found: ${conversationId}`,
        );
      }
      const row = rows[0] as Record<string, unknown>;
      return {
        id: row.id as string,
        title: row.title as string,
        courseId: (row.course_id as string | null) ?? null,
        updatedAt: iso(row.updated_at as string | Date),
      };
    },

    async listSummaries(
      scope: OpeningConversationScope,
    ): Promise<ConversationSummary[]> {
      const rows = await sql`
        SELECT
          c.id,
          c.title,
          c.course_id,
          c.updated_at,
          (
            SELECT LEFT(t.text, 280)
            FROM opening_turns t
            WHERE t.conversation_id = c.id
            ORDER BY t.created_at DESC
            LIMIT 1
          ) AS last_turn_preview
        FROM opening_conversations c
        WHERE c.workspace_id = ${scope.workspaceId}
          AND c.owner_user_id = ${scope.ownerUserId}
        ORDER BY c.updated_at DESC
      `;
      return rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: r.id as string,
          title: r.title as string,
          courseId: (r.course_id as string | null) ?? null,
          updatedAt: iso(r.updated_at as string | Date),
          lastTurnPreview: (r.last_turn_preview as string | null) ?? null,
        };
      });
    },

    async listTurns(
      scope: OpeningConversationScope,
      conversationId: string,
    ): Promise<TurnRecord[]> {
      await this.getOwned(scope, conversationId);
      const rows = await sql`
        SELECT id, conversation_id, role, text, mode, status, created_at, citations
        FROM opening_turns
        WHERE conversation_id = ${conversationId}
          AND workspace_id = ${scope.workspaceId}
        ORDER BY created_at ASC
      `;
      return rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: r.id as string,
          conversationId: r.conversation_id as string,
          role: r.role as TurnRecord["role"],
          text: r.text as string,
          citations: (r.citations as TurnRecord["citations"]) ?? [],
          createdAt: iso(r.created_at as string | Date),
          mode: r.mode as TutorMode,
          status: r.status as TurnRecord["status"],
        };
      });
    },

    async loadContinuityTurns(
      scope: OpeningConversationScope,
      conversationId: string,
    ): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
      await this.getOwned(scope, conversationId);
      const rows = await sql`
        SELECT role, text
        FROM opening_turns
        WHERE conversation_id = ${conversationId}
          AND workspace_id = ${scope.workspaceId}
          AND status IN ('complete', 'pending')
        ORDER BY created_at ASC
      `;
      return rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          role: r.role as "user" | "assistant",
          text: r.text as string,
        };
      });
    },

    async findTurnByClientKey(
      scope: OpeningConversationScope,
      clientKey: string,
    ): Promise<{ userTurnId: string; jobId: string } | null> {
      const rows = await sql`
        SELECT t.id AS turn_id, j.id AS job_id
        FROM opening_turns t
        LEFT JOIN opening_tutor_jobs j ON j.user_turn_id = t.id
        WHERE t.workspace_id = ${scope.workspaceId}
          AND t.client_key = ${clientKey}
          AND t.role = 'user'
        LIMIT 1
      `;
      if (!rows.length) return null;
      const r = rows[0] as Record<string, unknown>;
      if (!r.job_id) return null;
      return { userTurnId: r.turn_id as string, jobId: r.job_id as string };
    },

    async appendSavedTurn(input: {
      scope: OpeningConversationScope;
      conversationId: string;
      text: string;
      mode: TutorMode;
      clientKey: string;
      sourceIds: string[];
      learningSessionId: string | null;
      currentPage: number | null;
      chunkId: string | null;
    }): Promise<{ turnId: string; jobId: string; assistantTurnId: string }> {
      await this.getOwned(input.scope, input.conversationId);
      const existing = await this.findTurnByClientKey(
        input.scope,
        input.clientKey,
      );
      if (existing) return { turnId: existing.userTurnId, jobId: existing.jobId, assistantTurnId: existing.userTurnId };

      const turnId = randomUUID();
      const assistantTurnId = randomUUID();
      const jobId = randomUUID();

      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO opening_turns (
            id, workspace_id, conversation_id, role, text, mode, status,
            client_key, learning_session_id, current_page, chunk_id, source_ids
          ) VALUES (
            ${turnId}, ${input.scope.workspaceId}, ${input.conversationId},
            'user', ${input.text}, ${input.mode}, 'complete',
            ${input.clientKey}, ${input.learningSessionId}, ${input.currentPage},
            ${input.chunkId}, ${input.sourceIds}
          )
        `;
        await tx`
          INSERT INTO opening_turns (
            id, workspace_id, conversation_id, role, text, mode, status,
            client_key, learning_session_id, current_page, chunk_id, source_ids
          ) VALUES (
            ${assistantTurnId}, ${input.scope.workspaceId}, ${input.conversationId},
            'assistant', '', ${input.mode}, 'pending',
            NULL, ${input.learningSessionId}, ${input.currentPage},
            ${input.chunkId}, ${input.sourceIds}
          )
        `;
        await tx`
          INSERT INTO opening_tutor_jobs (
            id, workspace_id, conversation_id, user_turn_id, assistant_turn_id,
            status, mode
          ) VALUES (
            ${jobId}, ${input.scope.workspaceId}, ${input.conversationId},
            ${turnId}, ${assistantTurnId}, 'queued', ${input.mode}
          )
        `;
        await tx`
          UPDATE opening_conversations
          SET updated_at = now()
          WHERE id = ${input.conversationId}
            AND workspace_id = ${input.scope.workspaceId}
        `;
      });

      return { turnId, jobId, assistantTurnId };
    },
  };
}

export type OpeningConversationRepository = ReturnType<
  typeof createOpeningConversationRepository
>;
