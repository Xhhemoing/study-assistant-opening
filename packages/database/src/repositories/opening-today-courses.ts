import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { learningError, learningIso } from "./opening-learning-facts";

export type OpeningTodayCourse = { id: string; title: string; archivedAt: string | null };

/** Includes archived courses: no active course does not mean the learner has never created one. */
export async function readOpeningTodayCourses(sql: Sql, scope: Scope): Promise<OpeningTodayCourse[]> {
  const rows = await sql`SELECT c.id,c.title,c.archived_at FROM workspaces w
    LEFT JOIN courses c ON c.workspace_id=w.id
    WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}
    ORDER BY c.title,c.id`;
  if (!rows.length) throw learningError("NOT_FOUND", "workspace not found");
  return rows.flatMap(row => row.id == null ? [] : [{ id: String(row.id), title: String(row.title), archivedAt: learningIso(row.archived_at) }]);
}
