import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { learningAssetIdentitySchema, learningAssetLinkCreateSchema, learningAssetLinkDetachSchema, type LearningAssetLinkCreate, type Scope, type StudyContextAnchor, type StudyNoteCreate } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { readLearningGoal } from "./opening-learning-goals";
import { resolveOpeningStudyContext } from "./opening-study-context";
import { mergeContextSourceRefs, parseContextSourceRefs, type ContextSourceRef } from "./opening-context-provenance";
import { openingNoteReadable } from "./opening-note-provenance";
import { learningAssetSourceAvailable, readLearningAssetLinkView, type LearningAssetDb } from "./opening-learning-asset-links-read";

export async function lockLearningAssetOwner(tx: TransactionSql, scope: Scope) {
  await lockWorkspaceLearningHistory(tx, scope);
  const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!owner) throw learningError("NOT_FOUND", "当前工作区不可用。");
}
export async function assertLearningAssetTarget(tx: TransactionSql, scope: Scope, input: Pick<LearningAssetLinkCreate, "courseId" | "goalId" | "requirementId" | "expectedGoalRevision" | "expectedRequirementRevision">) {
  if (input.courseId) { const [course] = await tx`SELECT id FROM courses WHERE id=${input.courseId} AND workspace_id=${scope.workspaceId} FOR SHARE`; if (!course) throw learningError("NOT_FOUND", "所选课程不属于当前工作区。"); }
  if (input.goalId) { const goal = await readLearningGoal(tx, scope, input.goalId); if (!goal || !goal.courseIds.includes(input.courseId!)) throw learningError("NOT_FOUND", "所选目标不属于该课程。"); if (goal.revision !== input.expectedGoalRevision) throw learningError("CONFLICT", "目标已变化，请重新核对关联；原资产保留。"); }
  if (input.requirementId) { const [requirement] = await tx`SELECT revision,goal_ids FROM course_requirements WHERE id=${input.requirementId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${input.courseId!} AND lifecycle='active' FOR SHARE`; if (!requirement) throw learningError("NOT_FOUND", "所选课程要求已不可用。"); if (Number(requirement.revision) !== input.expectedRequirementRevision) throw learningError("CONFLICT", "课程要求已变化，请重新核对关联。"); if (input.goalId && (requirement.goal_ids as string[]).length && !(requirement.goal_ids as string[]).includes(input.goalId)) throw learningError("CONFLICT", "所选课程要求不属于该目标范围。"); }
}
export async function resolveLearningAssetOrigin(tx: TransactionSql, scope: Scope, input: StudyContextAnchor | null): Promise<{ origin: StudyContextAnchor | null; refs: ContextSourceRef[] }> {
  if (!input) return { origin: null, refs: [] };
  const origin = await resolveOpeningStudyContext(tx, scope, input, { sourceAccess: "human_read" });
  let refs: ContextSourceRef[] = origin.sourceId && origin.sourceVersion != null ? [{ sourceId: origin.sourceId, sourceVersion: origin.sourceVersion }] : [];
  if (origin.activityId) {
    const [activity] = await tx`SELECT source_ids FROM opening_teaching_activities WHERE id=${origin.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    const [spec] = await tx`SELECT source_refs FROM opening_teaching_activity_specs WHERE activity_id=${origin.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND (${origin.contentVersion ?? null}::int IS NULL OR version=${origin.contentVersion ?? null}) FOR SHARE`;
    if (Array.isArray(spec?.source_refs)) {
      const mapped = spec.source_refs.map((ref: { sourceId?: unknown; version?: unknown; sourceVersion?: unknown }) => ({ sourceId: ref.sourceId, sourceVersion: ref.sourceVersion ?? (ref.version == null ? null : Number(ref.version)) }));
      const parsed = parseContextSourceRefs(mapped);
      if (!parsed) throw learningError("CONFLICT", "原活动出处版本不完整，请先核对原材料；未保存关联。");
      refs = mergeContextSourceRefs(refs, parsed);
    } else if ((activity?.source_ids as string[] | undefined)?.length && !refs.length) throw learningError("CONFLICT", "原活动缺少可确认的出处版本，请先从原资料入口记录笔记。");
  }
  for (const ref of refs) if (!(await learningAssetSourceAvailable(tx, scope.workspaceId, ref.sourceId, ref.sourceVersion)).available) throw learningError("CONFLICT", "原材料版本已不可用，未切换到新材料保存。");
  return { origin, refs };
}
export async function readLearningAssetReceipt(tx: LearningAssetDb, scope: Scope, clientKey: string, intent: unknown) {
  const [row] = await tx`SELECT * FROM opening_learning_asset_links WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey}`;
  if (row && !isDeepStrictEqual(row.create_intent, intent)) throw learningError("CONFLICT", "这次保存的原请求内容已变化，请保留原请求核对。");
  return row;
}
export async function insertLearningAssetLink(tx: TransactionSql, scope: Scope, input: LearningAssetLinkCreate | StudyNoteCreate, asset: { type: "source" | "document"; id: string; version: number | null }, origin: StudyContextAnchor | null, refs: ContextSourceRef[], intent: unknown) {
  if (input.courseId) {
    const [membership] = await tx`SELECT id FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId} AND course_id=${input.courseId} AND asset_type=${asset.type} AND asset_id=${asset.id} FOR SHARE`;
    if (!membership) await tx`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility) VALUES(${randomUUID()},${scope.workspaceId},${input.courseId},${asset.type},${asset.id},'reference',0,'private')`;
  }
  const [row] = await tx`INSERT INTO opening_learning_asset_links(workspace_id,owner_user_id,asset_type,asset_id,asset_version,course_id,goal_id,requirement_id,purpose,origin_json,source_refs,client_key,create_intent)
    VALUES(${scope.workspaceId},${scope.ownerUserId},${asset.type},${asset.id},${asset.version},${input.courseId},${input.goalId},${input.requirementId},${input.purpose},${tx.json(origin ?? {})},${tx.json(refs)},${input.clientKey},${tx.json(intent as never)}) RETURNING *`;
  return row!;
}
export function createOpeningLearningAssetLinkRepository(sql: Sql) {
  return {
    async list(scope: Scope, raw: unknown) {
      const input = learningAssetIdentitySchema.parse(raw);
      const rows = await sql`SELECT l.* FROM opening_learning_asset_links l JOIN workspaces w ON w.id=l.workspace_id AND w.owner_user_id=${scope.ownerUserId} WHERE l.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId} AND l.asset_type=${input.assetType} AND l.asset_id=${input.assetId} ORDER BY l.created_at,l.id`;
      return { links: await Promise.all(rows.map(row => readLearningAssetLinkView(sql, scope, row))) };
    },
    create: (scope: Scope, raw: LearningAssetLinkCreate) => sql.begin(async tx => {
      const input = learningAssetLinkCreateSchema.parse(raw), intent = { kind: "asset-link", input };
      await lockLearningAssetOwner(tx, scope);
      const receipt = await readLearningAssetReceipt(tx, scope, input.clientKey, intent);
      if (receipt) return readLearningAssetLinkView(tx, scope, receipt);
      await assertLearningAssetTarget(tx, scope, input);
      let assetRefs: ContextSourceRef[] = [], version = input.assetVersion;
      if (input.assetType === "source") { const source = await learningAssetSourceAvailable(tx, scope.workspaceId, input.assetId, version); if (!source.available || source.currentVersion == null) throw learningError("NOT_FOUND", "原资料或选定版本不可用。"); version ??= source.currentVersion; assetRefs = [{ sourceId: input.assetId, sourceVersion: version }]; }
      else { const [document] = await tx`SELECT d.id,np.context_source_refs FROM library_documents d LEFT JOIN opening_note_provenance np ON np.document_id=d.id AND np.workspace_id=d.workspace_id WHERE d.id=${input.assetId} AND d.workspace_id=${scope.workspaceId} AND d.deleted_at IS NULL AND ${openingNoteReadable(tx, scope.workspaceId, tx`d.id`)} FOR SHARE OF d`; if (!document) throw learningError("NOT_FOUND", "原笔记不可用。"); if (document.context_source_refs != null) { const refs = parseContextSourceRefs(document.context_source_refs); if (!refs) throw learningError("CONFLICT", "原笔记出处不完整，保留笔记但不新增关联。"); assetRefs = refs; } }
      const resolved = await resolveLearningAssetOrigin(tx, scope, input.origin);
      return readLearningAssetLinkView(tx, scope, await insertLearningAssetLink(tx, scope, input, { type: input.assetType, id: input.assetId, version }, resolved.origin, mergeContextSourceRefs(assetRefs, resolved.refs), intent));
    }),
    detach: (scope: Scope, raw: unknown) => sql.begin(async tx => {
      const input = learningAssetLinkDetachSchema.parse(raw); await lockLearningAssetOwner(tx, scope);
      const [row] = await tx`SELECT * FROM opening_learning_asset_links WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND id=${input.id} FOR UPDATE`;
      if (!row) throw learningError("NOT_FOUND", "关联记录不存在。");
      if (row.status === "detached" && Number(row.revision) === input.expectedRevision + 1) return readLearningAssetLinkView(tx, scope, row);
      if (Number(row.revision) !== input.expectedRevision) throw learningError("CONFLICT", "关联已变化，请重新读取后操作。");
      const [saved] = await tx`UPDATE opening_learning_asset_links SET status='detached',revision=revision+1,updated_at=now() WHERE id=${input.id} AND workspace_id=${scope.workspaceId} RETURNING *`;
      return readLearningAssetLinkView(tx, scope, saved!);
    }),
  };
}
