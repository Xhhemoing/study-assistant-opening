import type { OpeningConversationScope } from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";
import { resolveTodayResume, type TodayResumeState } from "./today-read";

export type TodayResumeReader = {
  latestOwned(scope: OpeningConversationScope): Promise<{
    id: string;
    title: string;
    courseId: string | null;
    lastUserText: string | null;
    sourceVersions: Record<string, number>;
    currentPage: number | null;
  } | null>;
  pendingCandidateCount(scope: OpeningConversationScope): Promise<number>;
  pendingCandidates(scope: OpeningConversationScope): Promise<{
    id: string;
    payload: { kind?: string } | null;
  }[]>;
};

/** Owner-scoped resume facts. No writes and no invented rows. */
export function createTodayResumeReader(sql: Sql): TodayResumeReader {
  async function pendingCandidates(scope: OpeningConversationScope) {
    const rows = await sql`
      SELECT c.id, c.payload
      FROM opening_assistant_candidates c
      INNER JOIN opening_conversations conv
        ON conv.id = c.conversation_id
       AND conv.workspace_id = c.workspace_id
       AND conv.owner_user_id = ${scope.ownerUserId}
      WHERE c.workspace_id = ${scope.workspaceId}
        AND c.status = 'pending'
    `;
    return rows.map((row) => {
      const record = row as Record<string, unknown>;
      const payload = record.payload;
      return {
        id: record.id as string,
        payload: payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload as { kind?: string }
          : null,
      };
    });
  }
  return {
    async latestOwned(scope) {
      const rows = await sql`
        SELECT
          c.id,
          c.title,
          c.course_id,
          user_turn.text AS last_user_text,
          user_turn.source_versions,
          user_turn.current_page
        FROM opening_conversations c
        LEFT JOIN LATERAL (
          SELECT text, source_versions, current_page
          FROM opening_turns
          WHERE conversation_id = c.id
            AND workspace_id = c.workspace_id
            AND role = 'user'
          ORDER BY created_at DESC
          LIMIT 1
        ) user_turn ON true
        WHERE c.workspace_id = ${scope.workspaceId}
          AND c.owner_user_id = ${scope.ownerUserId}
        ORDER BY c.updated_at DESC
        LIMIT 1
      `;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      const versions = row.source_versions;
      return {
        id: row.id as string,
        title: row.title as string,
        courseId: (row.course_id as string | null) ?? null,
        lastUserText: (row.last_user_text as string | null) ?? null,
        sourceVersions:
          versions && typeof versions === "object" && !Array.isArray(versions)
            ? (versions as Record<string, number>)
            : {},
        currentPage: row.current_page == null ? null : Number(row.current_page),
      };
    },
    pendingCandidates,
    async pendingCandidateCount(scope) {
      return (await pendingCandidates(scope)).length;
    },
  };
}

export async function loadTodayResumeState(input: {
  scope: OpeningConversationScope | null;
  reader: TodayResumeReader;
}): Promise<TodayResumeState> {
  if (!input.scope) {
    return resolveTodayResume({ hasSession: false, loadFailed: false });
  }
  try {
    const [latest, pendingConfirmations] = await Promise.all([
      input.reader.latestOwned(input.scope),
      input.reader.pendingCandidateCount(input.scope),
    ]);
    return resolveTodayResume({
      hasSession: true,
      loadFailed: false,
      pendingConfirmations,
      lastConversation: latest
        ? {
            id: latest.id,
            title: latest.title,
            courseId: latest.courseId,
            lastUserText: latest.lastUserText ?? undefined,
            sourceVersions: latest.sourceVersions,
            currentPage: latest.currentPage,
          }
        : undefined,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return resolveTodayResume({ hasSession: false, loadFailed: false });
    }
    return resolveTodayResume({ hasSession: true, loadFailed: true });
  }
}
