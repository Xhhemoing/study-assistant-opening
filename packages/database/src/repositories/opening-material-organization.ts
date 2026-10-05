import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { OpeningSourceError } from "./opening-sources";

/** Course references organize one original without copying it or changing model eligibility. */
export async function readOpeningMaterialOrganization(sql: Sql, scope: OpeningScope) {
  return sql.begin("isolation level repeatable read read only", async tx => {
    const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if (!owners.length) throw new OpeningSourceError("NOT_FOUND", "Workspace not found");
    const courses = await tx`SELECT id,title,archived_at FROM courses WHERE workspace_id=${scope.workspaceId} ORDER BY title,id`;
    const memberships = await tx`SELECT m.course_id,m.asset_id,m.role FROM course_asset_memberships m
      JOIN courses c ON c.id=m.course_id AND c.workspace_id=m.workspace_id
      JOIN opening_sources s ON s.id=m.asset_id AND s.workspace_id=m.workspace_id
      WHERE m.workspace_id=${scope.workspaceId} AND m.asset_type='source' ORDER BY m.course_id,m.asset_id`;
    return {
      courses: courses.map(row => ({ id: String(row.id), title: String(row.title), archived: row.archived_at != null })),
      memberships: memberships.map(row => ({ courseId: String(row.course_id), sourceId: String(row.asset_id), role: String(row.role) })),
    };
  });
}
