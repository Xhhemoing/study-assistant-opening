import { learningAssetLinkSchema } from "@aistudy/contracts";
import { isUuid } from "./backup-validation";
type Row = Record<string, unknown>;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/** Validate imported references as facts, never restore an authorization to share scores or resume tasks. */
export function validateBackupLearningLinks(tables: Record<string, Row[]>, errors: string[], ownerUserId?: string) {
  const requirements = new Map(tables.course_requirements?.map(row => [row.id, row]));
  const scoped = (row: Row, other: Row | undefined) => other?.workspace_id === row.workspace_id && other?.owner_user_id === row.owner_user_id;
  for (const row of tables.course_requirement_evidence_links ?? []) {
    const source = requirements.get(row.source_requirement_id), target = requirements.get(row.target_requirement_id);
    if (!isUuid(row.id) || !isUuid(row.owner_user_id) || !isUuid(row.stable_skill_id) || row.source_requirement_id === row.target_requirement_id
      || !scoped(row, source) || !scoped(row, target) || ownerUserId && row.owner_user_id !== ownerUserId
      || !positive(row.revision) || !positive(row.source_requirement_revision) || !positive(row.target_requirement_revision)
      || row.source_requirement_revision > Number(source?.revision) || row.target_requirement_revision > Number(target?.revision)
      || typeof row.active !== "boolean") errors.push("shared course evidence link is invalid or outside its owner");
  }
  for (const row of tables.opening_learning_asset_links ?? []) {
    const origin = row.origin_json;
    const parsed = learningAssetLinkSchema.safeParse({ id: row.id, assetType: row.asset_type, assetId: row.asset_id, assetVersion: row.asset_version,
      courseId: row.course_id, goalId: row.goal_id, requirementId: row.requirement_id, purpose: row.purpose,
      origin: origin && typeof origin === "object" && Object.keys(origin).length ? origin : null, sourceRefs: row.source_refs,
      status: row.status, revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
    if (!parsed.success || row.asset_type !== "source" || ownerUserId && row.owner_user_id !== ownerUserId || !isUuid(row.owner_user_id)) {
      errors.push("learning asset link is invalid"); continue;
    }
    const link = parsed.data;
    const inWorkspace = (table: string, id: string | null) => id == null || tables[table]?.some(item => item.id === id && item.workspace_id === row.workspace_id);
    if (!inWorkspace("opening_sources", link.assetId) || !inWorkspace("courses", link.courseId) || !inWorkspace("course_goals", link.goalId)
      || !inWorkspace("course_requirements", link.requirementId) || link.sourceRefs.some(ref => !inWorkspace("opening_sources", ref.sourceId))
      || link.origin?.activityId && !tables.opening_teaching_activities?.some(item => item.id === link.origin!.activityId && scoped(row, item))
      || link.origin?.attemptId && !tables.opening_learning_attempts?.some(item => item.id === link.origin!.attemptId && scoped(row, item))) {
      errors.push("learning asset link references are incomplete");
    }
  }
}
