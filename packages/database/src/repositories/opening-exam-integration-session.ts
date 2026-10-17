import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import { createOpeningLearningSessionInTx } from "./opening-learning-session-create";

export async function createExamSession(tx: TransactionSql, scope: Scope, input: {
  sprintId: string; courseId: string; sourceIds: string[]; skillLabel: string; identity: string; now: string;
}) {
  const activityKey = `exam-activity:${input.sprintId}:${input.identity}`.slice(0, 200);
  const [existing] = await tx`SELECT id FROM opening_teaching_activities
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${activityKey}`;
  const activityId = existing ? String(existing.id) : randomUUID();
  if (!existing) await tx`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,status,generate_status,intent_kind,
    intent_summary,source_ids,client_key,create_intent,created_at,updated_at)
    VALUES(${activityId},${scope.workspaceId},${scope.ownerUserId},${input.courseId},'active','ready','question',
      ${`考前冲刺 · ${input.skillLabel}`},${input.sourceIds},${activityKey},${tx.json({ examSprint: input.sprintId, identity: input.identity })},${input.now},${input.now})`;
  const session = await createOpeningLearningSessionInTx(tx, scope, { courseId: input.courseId, activityId,
    skillLabel: input.skillLabel, sourceIds: input.sourceIds });
  return { sessionId: session.id, activityId };
}
