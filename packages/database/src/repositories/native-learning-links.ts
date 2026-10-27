import { learningAssetLinkSchema } from "@aistudy/contracts";
import type { NativeBackupRecord } from "@aistudy/domain";
import type { Sql } from "postgres";
import { BackupRestoreError } from "./backup-types";
import { contextSourceRefsIncluded } from "./opening-context-provenance";
type Row = Record<string, unknown>;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value;
function parseLink(row: Row, documentId: string) {
  const origin = row.origin_json;
  const parsed = learningAssetLinkSchema.safeParse({ id: row.id, assetType: row.asset_type, assetId: row.asset_id, assetVersion: row.asset_version,
    courseId: row.course_id, goalId: row.goal_id, requirementId: row.requirement_id, purpose: row.purpose,
    origin: origin && typeof origin === "object" && Object.keys(origin).length ? origin : null, sourceRefs: row.source_refs,
    status: row.status, revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
  if (!parsed.success || parsed.data.assetType !== "document" || parsed.data.assetId !== documentId
    || typeof row.client_key !== "string" || !row.create_intent || typeof row.create_intent !== "object" || Array.isArray(row.create_intent)) {
    throw new BackupRestoreError("VALIDATION", "Note learning link is invalid or belongs to another document");
  }
  return parsed.data;
}
/** Native documents carry their learning links; Opening-only backup does not carry note bodies. */
export async function attachNativeLearningLinks(sql: Sql, workspaceId: string, documents: NativeBackupRecord[]): Promise<NativeBackupRecord[]> {
  const rows = await sql`SELECT l.* FROM opening_learning_asset_links l JOIN workspaces w ON w.id=l.workspace_id AND w.owner_user_id=l.owner_user_id
    WHERE l.workspace_id=${workspaceId} AND l.asset_type='document'
      AND ${contextSourceRefsIncluded(sql, workspaceId, sql`l.source_refs`, true)} ORDER BY l.id`;
  return documents.map(document => ({ ...document, learningAssetLinks: rows.filter(row => row.asset_id === document.id) }));
}
/** Insert only after documents/goals have been restored. Missing Opening references remain detached history. */
export async function restoreNativeLearningLinks(sql: Sql, documents: NativeBackupRecord[]): Promise<void> {
  for (const document of documents) {
    const links = document.learningAssetLinks;
    if (links === undefined) continue; // Older native packages have no learning associations.
    if (!Array.isArray(links)) throw new BackupRestoreError("VALIDATION", "Note learning links must be a list");
    const workspaceId = String(document.workspaceId);
    const [owner] = await sql`SELECT owner_user_id FROM workspaces WHERE id=${workspaceId}`;
    if (!owner) throw new BackupRestoreError("VALIDATION", "Note learning link workspace is missing");
    for (const raw of links) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BackupRestoreError("VALIDATION", "Note learning link is invalid");
      const row = raw as Row, link = parseLink(row, document.id);
      const [privacy] = await sql`SELECT ${contextSourceRefsIncluded(sql, workspaceId, sql`${sql.json(link.sourceRefs)}::jsonb`, true)} AS included`;
      if (!privacy?.included) throw new BackupRestoreError("VALIDATION", "Note learning link sources are unavailable in this workspace");
      const [course] = link.courseId ? await sql`SELECT id FROM courses WHERE workspace_id=${workspaceId} AND id=${link.courseId}` : [];
      const [goal] = course && link.goalId ? await sql`SELECT g.id FROM course_goals g WHERE g.workspace_id=${workspaceId} AND g.id=${link.goalId}
        AND (g.course_id=${course.id} OR EXISTS(SELECT 1 FROM course_goal_links c WHERE c.workspace_id=g.workspace_id AND c.goal_id=g.id AND c.course_id=${course.id}))` : [];
      const [requirement] = course && link.requirementId ? await sql`SELECT id FROM course_requirements WHERE workspace_id=${workspaceId} AND owner_user_id=${owner.owner_user_id} AND course_id=${course.id} AND id=${link.requirementId}` : [];
      await sql`INSERT INTO opening_learning_asset_links(id,workspace_id,owner_user_id,asset_type,asset_id,asset_version,course_id,goal_id,requirement_id,
        purpose,origin_json,source_refs,status,revision,client_key,create_intent,created_at,updated_at)
        VALUES(${link.id},${workspaceId},${owner.owner_user_id},'document',${document.id},NULL,${course?.id ?? null},${goal?.id ?? null},${requirement?.id ?? null},
        ${link.purpose},${sql.json(link.origin ?? {})},${sql.json(link.sourceRefs)},'detached',${link.revision},${String(row.client_key)},${sql.json(row.create_intent as never)},${link.createdAt},${link.updatedAt})`;
    }
  }
}
