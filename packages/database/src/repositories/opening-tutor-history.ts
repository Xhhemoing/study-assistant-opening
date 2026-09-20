import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";

type HistoryTurn = { role: "user" | "assistant"; text: string };

/** Completed exchanges only. A revoked ancestor invalidates all derived history. */
export async function loadTutorHistory(sql: Sql, scope: OpeningScope, currentTurnId: string): Promise<HistoryTurn[]> {
  const rows = await sql`
    WITH prior AS (
      SELECT u.text AS question, a.text AS answer, u.created_at, u.id,
        EXISTS (
          SELECT 1 FROM unnest(u.source_ids || a.source_ids) AS ref(id)
          WHERE NOT EXISTS (SELECT 1 FROM opening_sources s WHERE s.id=ref.id
            AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded')
        ) OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(a.citations) AS citation
          WHERE NOT EXISTS (SELECT 1 FROM opening_sources s
            WHERE s.id::text=citation->>'sourceId' AND s.workspace_id=${scope.workspaceId}
              AND s.upload_state='uploaded' AND s.version::text=citation->>'sourceVersion')
        ) AS invalid
      FROM opening_turns current
      JOIN opening_conversations c ON c.id=current.conversation_id
      JOIN opening_tutor_jobs j ON j.conversation_id=c.id AND j.workspace_id=c.workspace_id
      JOIN opening_turns u ON u.id=j.user_turn_id AND u.workspace_id=c.workspace_id
      JOIN opening_turns a ON a.id=j.assistant_turn_id AND a.workspace_id=c.workspace_id
      WHERE current.id=${currentTurnId} AND current.role='user'
        AND current.workspace_id=${scope.workspaceId} AND c.workspace_id=${scope.workspaceId}
        AND c.owner_user_id=${scope.ownerUserId}
        AND u.created_at < current.created_at AND u.status='complete' AND a.status='complete'
    )
    SELECT left(question,12001) AS question, left(answer,12001) AS answer
    FROM prior WHERE NOT EXISTS (SELECT 1 FROM prior WHERE invalid)
    ORDER BY created_at DESC, id DESC LIMIT 20
  `;
  const history: HistoryTurn[] = [];
  let characters = 0;
  for (const row of rows) {
    const question = row.question as string;
    const answer = row.answer as string;
    if (characters + question.length + answer.length > 12_000) break;
    history.unshift({ role: "user", text: question }, { role: "assistant", text: answer });
    characters += question.length + answer.length;
  }
  return history;
}
