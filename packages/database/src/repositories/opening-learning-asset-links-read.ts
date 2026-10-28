import { learningAssetLinkSchema, learningAssetLinkViewSchema, studyContextAnchorSchema, uuidSchema, type LearningAssetLinkView, type Scope, type StudyContextAnchor } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { learningIso } from "./opening-learning-facts";
import { openingNoteReadable } from "./opening-note-provenance";
export type LearningAssetDb = Sql | TransactionSql;
export function learningAssetOriginHref(origin: StudyContextAnchor, checkpoint: unknown): string | null {
  if (!origin.courseId || !origin.activityId) return null;
  const span = checkpoint && typeof checkpoint === "object" && "spanLesson" in checkpoint ? checkpoint.spanLesson : null;
  if (span && typeof span === "object") { const params = new URLSearchParams({ lesson: origin.activityId }); if ("retestId" in span && uuidSchema.safeParse(span.retestId).success) params.set("retest", String(span.retestId)); return `/opening/courses/${origin.courseId}/study/span?${params}`; }
  const params = new URLSearchParams({ activity: origin.activityId });
  if (origin.blockId) params.set("block", origin.blockId);
  if (origin.contentVersion != null) params.set("contentVersion", String(origin.contentVersion));
  return `/opening/courses/${origin.courseId}/study?${params}`;
}
export async function learningAssetSourceAvailable(db: LearningAssetDb, workspaceId: string, sourceId: string, version: number | null) {
  const [row] = await db`SELECT s.name,s.version,s.upload_state,
    EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id AND e.asset_deleted_at IS NOT NULL) AS deleted,
    EXISTS(SELECT 1 FROM opening_source_versions v WHERE v.workspace_id=s.workspace_id AND v.source_id=s.id AND v.version=${version} AND v.availability='available') AS historical
    FROM opening_sources s WHERE s.id=${sourceId} AND s.workspace_id=${workspaceId}`;
  return { available: Boolean(row && row.upload_state === "uploaded" && !row.deleted && (version === null || Number(row.version) === version || row.historical)), title: row ? String(row.name) : "原材料", currentVersion: row ? Number(row.version) : null };
}
export async function readLearningAssetLinkView(db: LearningAssetDb, scope: Scope, row: Record<string, unknown>): Promise<LearningAssetLinkView> {
  const storedOrigin = row.origin_json && typeof row.origin_json === "object" && "purpose" in row.origin_json ? studyContextAnchorSchema.safeParse(row.origin_json) : null;
  const origin = storedOrigin?.success ? storedOrigin.data : null;
  const link = learningAssetLinkSchema.parse({ id: row.id, assetType: row.asset_type, assetId: row.asset_id, assetVersion: row.asset_version == null ? null : Number(row.asset_version), courseId: row.course_id, goalId: row.goal_id, requirementId: row.requirement_id, purpose: row.purpose, origin, sourceRefs: row.source_refs, status: row.status, revision: Number(row.revision), createdAt: learningIso(row.created_at), updatedAt: learningIso(row.updated_at) });
  const warnings: string[] = [];
  if (link.status === "detached") warnings.push("这是已解除或恢复的历史关联；不会自动恢复课程目标或学习行为。");
  const [course] = link.courseId ? await db`SELECT title,archived_at FROM courses WHERE workspace_id=${scope.workspaceId} AND id=${link.courseId}` : [];
  const [goal] = link.goalId ? await db`SELECT title,revision,lifecycle FROM course_goals WHERE workspace_id=${scope.workspaceId} AND id=${link.goalId}` : [];
  const [requirement] = link.requirementId ? await db`SELECT title,revision,lifecycle FROM course_requirements WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND id=${link.requirementId}` : [];
  if (course?.archived_at) warnings.push("关联课程已归档，历史关联保留。");
  if (goal && ["paused", "archived", "stopped"].includes(String(goal.lifecycle))) warnings.push("关联目标已暂停或结束，笔记与出处仍保留。");
  if (requirement?.lifecycle === "archived") warnings.push("原课程要求已移出当前范围，未将笔记转给新要求。");
  let assetAvailable = false;
  if (link.assetType === "source") assetAvailable = (await learningAssetSourceAvailable(db, scope.workspaceId, link.assetId, link.assetVersion)).available;
  else { const [document] = await db`SELECT d.id FROM library_documents d WHERE d.id=${link.assetId} AND d.workspace_id=${scope.workspaceId} AND d.deleted_at IS NULL AND ${openingNoteReadable(db, scope.workspaceId, db`d.id`)}`; assetAvailable = Boolean(document); }
  if (!assetAvailable) warnings.push("原资料或笔记已删除、版本不可读或出处不可用；历史关联保留，不会切换到其他内容。");
  const sourceHrefs: Array<{ label: string; href: string }> = [];
  let sourcesAvailable = true;
  for (const ref of link.sourceRefs) {
    const source = await learningAssetSourceAvailable(db, scope.workspaceId, ref.sourceId, ref.sourceVersion);
    if (!source.available) { sourcesAvailable = false; warnings.push("一条原材料引用已不可读取，保留其版本记录。"); continue; }
    const query = new URLSearchParams({ source: ref.sourceId, version: String(ref.sourceVersion) });
    if (origin?.sourceId === ref.sourceId && origin.page) query.set("page", String(origin.page));
    sourceHrefs.push({ label: `${source.title} · v${ref.sourceVersion}`, href: `/opening/library?${query}` });
  }
  let originAvailable = false, originHref: string | null = null;
  if (origin?.activityId) {
    const [activity] = await db`SELECT course_id,content_version,checkpoint_json FROM opening_teaching_activities WHERE id=${origin.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if (activity && activity.course_id === origin.courseId && sourcesAvailable) {
      const [originalCourse] = await db`SELECT archived_at FROM courses WHERE workspace_id=${scope.workspaceId} AND id=${origin.courseId ?? null}`;
      const [spec] = origin.blockId ? await db`SELECT block_order FROM opening_teaching_activity_specs WHERE activity_id=${origin.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND version=${origin.contentVersion ?? null}` : [];
      const blockExists = !origin.blockId || (Array.isArray(spec?.block_order) && spec.block_order.some((block: { blockId?: string }) => block.blockId === origin.blockId));
      originAvailable = Boolean(originalCourse && !originalCourse.archived_at && (origin.contentVersion == null || Number(activity.content_version) === origin.contentVersion) && blockExists);
      if (originAvailable) originHref = learningAssetOriginHref(origin, activity.checkpoint_json);
    }
    if (!originAvailable) warnings.push("原活动位置已变化、归档或不可读取；原位置记录保留，未创建替代学习活动。");
  }
  if (origin && !origin.activityId && sourceHrefs.length) { originAvailable = true; originHref = sourceHrefs[0]!.href; }
  if (!origin && row.origin_json && Object.keys(row.origin_json).length) warnings.push("原返回位置无法验证，保留关联记录。请从课程或资料列表核对。");
  return learningAssetLinkViewSchema.parse({ link, courseTitle: course ? String(course.title) : null, goalTitle: goal ? String(goal.title) : null, requirementTitle: requirement ? String(requirement.title) : null, assetAvailable, originAvailable, originHref, sourceHrefs, warnings: [...new Set(warnings)] });
}
