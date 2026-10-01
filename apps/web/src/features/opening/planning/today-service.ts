import { readOpeningAssistantReviewCandidates, readOpeningRetestReviewCandidates, type OpeningConversationScope } from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";
import { validatePageSelection } from "../tutor/page-selection";
import { resolveTodayResume, type TodayResumeState } from "./today-read";

export type TodayResumeReader = {
  latestOwned(scope: OpeningConversationScope): Promise<{
    id: string;
    title: string;
    courseId: string | null;
    lastUserText: string | null;
    sourceVersions: Record<string, number>;
    currentPage: number | null;
    manualSourceCount?: number;
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
    const [assistant, retests] = await Promise.all([
      readOpeningAssistantReviewCandidates(sql, scope), readOpeningRetestReviewCandidates(sql, scope),
    ]);
    return [...assistant.map((row) => ({ id: row.id, payload: row.payload as { kind?: string } | null })),
      ...retests.map((row) => ({ id: row.id, payload: { kind: "retest" } }))];
  }
  async function materialPosition(scope: OpeningConversationScope, row: Record<string, unknown>) {
    const requested = (row.source_ids as string[] | null) ?? [];
    const raw = row.source_versions;
    // This JSON snapshot is unstructured persistence; never substitute today's version.
    const versions = Object.fromEntries(Object.entries(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {})
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] >= 0)
      .map(([id, version]) => [id.toLowerCase(), version]));
    const sources = requested.length ? await sql`
      SELECT s.id,s.version,s.upload_state,s.parse_state,v.availability,
        e.asset_deleted_at,(e.source_id IS NOT NULL) AS ai_excluded
      FROM opening_sources s JOIN workspaces w ON w.id=s.workspace_id
      LEFT JOIN opening_source_versions v ON v.source_id=s.id AND v.version=s.version AND v.workspace_id=s.workspace_id
      LEFT JOIN opening_privacy_exclusions e ON e.source_id=s.id AND e.workspace_id=s.workspace_id
      WHERE s.workspace_id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}
        AND s.id IN ${sql(requested)}` : [];
    const eligible = sources.filter(source => source.upload_state === "uploaded" && source.parse_state === "ready"
      && source.asset_deleted_at == null && (source.availability == null || source.availability === "available")
      && versions[String(source.id)] === Number(source.version));
    const chunks = eligible.length ? await sql`
      SELECT c.id,c.source_id,c.source_version,c.page FROM opening_source_chunks c
      JOIN opening_sources s ON s.id=c.source_id
      WHERE s.workspace_id=${scope.workspaceId} AND c.source_version=s.version
        AND c.source_id IN ${sql(eligible.map(source => String(source.id)))}` : [];
    const currentChunks = chunks.filter(chunk => versions[String(chunk.source_id)] === Number(chunk.source_version));
    const sourceVersions = Object.fromEntries(eligible.filter(source => !source.ai_excluded && currentChunks.some(chunk => chunk.source_id === source.id))
      .map(source => [String(source.id), versions[String(source.id)]!]));
    const sourceIds = Object.keys(sourceVersions);
    const page = row.current_page == null ? null : Number(row.current_page);
    // Losing any original material makes an unbound page ambiguous, even if a survivor has the same page.
    const complete = requested.length > 0 && requested.every(id => id in sourceVersions);
    const selection = validatePageSelection({ sourceIds, currentPage: page, chunkId: row.chunk_id as string | null },
      currentChunks.map(chunk => ({ id: String(chunk.id), sourceId: String(chunk.source_id), page: chunk.page == null ? null : Number(chunk.page) })));
    return {
      sourceVersions,
      currentPage: complete && page != null && Number.isInteger(page) && page > 0 && selection.ok ? page : null,
      manualSourceCount: eligible.filter(source => source.ai_excluded).length,
    };
  }
  return {
    async latestOwned(scope) {
      const rows = await sql`
        SELECT
          c.id,
          c.title,
          c.course_id,
          user_turn.text AS last_user_text,
          user_turn.source_ids,
          user_turn.source_versions,
          user_turn.chunk_id,
          user_turn.current_page
        FROM opening_conversations c
        LEFT JOIN LATERAL (
          SELECT text, source_ids, source_versions, current_page, chunk_id
          FROM opening_turns
          WHERE conversation_id = c.id
            AND workspace_id = c.workspace_id
            AND role = 'user'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) user_turn ON true
        WHERE c.workspace_id = ${scope.workspaceId}
          AND c.owner_user_id = ${scope.ownerUserId}
        ORDER BY c.updated_at DESC
        LIMIT 1
      `;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        title: row.title as string,
        courseId: (row.course_id as string | null) ?? null,
        lastUserText: (row.last_user_text as string | null) ?? null,
        ...await materialPosition(scope, row),
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
            manualSourceCount: latest.manualSourceCount,
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
