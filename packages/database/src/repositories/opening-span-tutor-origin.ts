import { uuidSchema, type Scope, type SpanLessonSnapshot } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { createOpeningSpanSessionRepository } from "./opening-span-session";
import { readOpeningCourseObservationHeads } from "./opening-learning-read";
import { learningError, mapLearningObservation, probeLearningSourcesAvailability } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { z } from "zod";
import { contextSourceRefsIncluded, parseContextSourceRefs } from "./opening-context-provenance";
export type OpeningSpanTutorOriginReference = { activityId: string; expectedRevision: number; observationId: string | null };
export type OpeningSpanTutorOriginChange = {
  reason: "evidence_changed" | "source_unavailable";
  originSession: SpanLessonSnapshot | null;
  observationId: string | null;
};
const metadataSchema = z.object({ observationIds: z.array(uuidSchema), sourceRefs: z.unknown().optional(),
  originReference: z.object({ activityId: uuidSchema, expectedRevision: z.number().int().positive(), observationId: uuidSchema.nullable() }).optional(),
}).passthrough();
function transactionClient(tx: TransactionSql): Sql {
  return new Proxy(tx, { get(target, key, receiver) {
    if (key === "begin") return (...args: unknown[]) => target.savepoint(nested =>
      (args.at(-1) as (value: TransactionSql) => Promise<unknown>)(nested));
    return Reflect.get(target, key, receiver);
  } }) as unknown as Sql;
}
/** A derived recommendation keeps its exact consumed heads, independent of unrelated later work. */
export async function readOpeningSpanTutorOriginChange(db: Sql, scope: Scope, activityId: string): Promise<OpeningSpanTutorOriginChange | undefined> {
  const [activity] = await db`SELECT course_id,source_ids,goal_json FROM opening_teaching_activities WHERE id=${activityId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!activity) throw learningError("NOT_FOUND", "学习活动不存在。");
  const raw = (activity.goal_json as { tutorNextAction?: unknown } | null)?.tutorNextAction;
  if (raw === undefined) return undefined;
  const parsed = metadataSchema.safeParse(raw);
  if (!parsed.success) return { reason: "evidence_changed", originSession: null, observationId: null };
  const metadata = parsed.data;
  const origin = metadata.originReference ? await createOpeningSpanSessionRepository(db).get(scope, metadata.originReference.activityId) : null;
  const originSession = origin?.courseId === activity.course_id ? origin : null;
  const heads = originSession ? (await readOpeningCourseObservationHeads(db, scope, originSession.courseId))
    .filter(row => row.sessionId === originSession.sessionId && row.revisionKind !== "retract" && (!row.effectiveHeadId || row.effectiveHeadId === row.id))
    .sort((a, b) => Date.parse(b.submittedAt ?? b.occurredAt) - Date.parse(a.submittedAt ?? a.occurredAt) || b.id.localeCompare(a.id)) : [];
  const change = (reason: OpeningSpanTutorOriginChange["reason"]): OpeningSpanTutorOriginChange => ({ reason, originSession, observationId: heads[0]?.id ?? null });
  if (metadata.originReference && !originSession) return change("evidence_changed");
  const materials = await probeLearningSourcesAvailability(db, scope, activity.source_ids as string[]);
  if (materials.availableIds.length !== (activity.source_ids as string[]).length) return change("source_unavailable");
  if (metadata.sourceRefs !== undefined) {
    const refs = parseContextSourceRefs(metadata.sourceRefs);
    if (!refs) return change("source_unavailable");
    const [available] = await db`SELECT 1 AS ok WHERE ${contextSourceRefsIncluded(db, scope.workspaceId, db`${db.json(refs)}`)}`;
    if (!available) return change("source_unavailable");
  }
  const ids = [...new Set([...metadata.observationIds, ...(metadata.originReference?.observationId ? [metadata.originReference.observationId] : [])])];
  if (metadata.originReference?.observationId === null && heads.length) return change("evidence_changed");
  if (!ids.length) return undefined;
  const rows = await db`SELECT o.*,COALESCE(root.effective_head_id,root.id) AS current_head_id
    FROM opening_learning_observations o JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
    WHERE o.id=ANY(${ids}::uuid[]) AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}`;
  if (rows.length !== ids.length || rows.some(row => row.current_head_id !== row.id || row.revision_kind === "retract")) return change("evidence_changed");
  const observations = rows.map(mapLearningObservation), inputs = await readOpeningLearningEvidenceContexts(db, scope, observations);
  if (observations.some(row => {
    const input = inputs[row.id];
    return !input || evaluateEvidenceEligibility(input.observation, input.context).usableForCurrentVersion !== "yes";
  })) return change("source_unavailable");
  return undefined;
}
/** Call after old receipt replay, inside the existing workspace-history transaction. */
export async function assertOpeningSpanTutorOriginCurrent(tx: TransactionSql, scope: Scope, activityId: string): Promise<void> {
  const change = await readOpeningSpanTutorOriginChange(transactionClient(tx), scope, activityId);
  if (change) throw Object.assign(learningError("CONFLICT", "原评价或材料已变化，请重新加载后选择下一步；已有答案和帮助记录保留。"),
    { reasonCode: "SPAN_TUTOR_ORIGIN_CHANGED", originChange: change });
}
export async function readOpeningSpanTutorOrigin(db: Sql, scope: Scope, reference: OpeningSpanTutorOriginReference,
  courseId?: string, currentRevision = reference.expectedRevision) {
  const session = await createOpeningSpanSessionRepository(db).get(scope, reference.activityId);
  if (!session || courseId && session.courseId !== courseId) throw learningError("NOT_FOUND", "原学习活动不存在或不属于当前课程。");
  if (session.revision !== currentRevision) throw learningError("CONFLICT", "原活动已在另一处更新，请重新读取后再选择下一步。");
  const observations = (await readOpeningCourseObservationHeads(db, scope, session.courseId))
    .filter(row => row.sessionId === session.sessionId && row.revisionKind !== "retract" && (!row.effectiveHeadId || row.effectiveHeadId === row.id))
    .sort((a, b) => Date.parse(b.submittedAt ?? b.occurredAt) - Date.parse(a.submittedAt ?? a.occurredAt) || b.id.localeCompare(a.id));
  const observation = observations[0] ?? null;
  if ((observation?.id ?? null) !== reference.observationId) throw learningError("CONFLICT", "本次答案或评价已更新，请重新读取后再选择下一步。");
  return { session, observation };
}
