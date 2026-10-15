import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { LearningSessionCreateInput, Scope } from "@aistudy/contracts";
import { admitLearningSources, learningError, lockLearningOwner } from "./opening-learning-facts";

/** Caller owns the transaction. Also used when an SRS review records evidence atomically. */
export async function createOpeningLearningSessionInTx(tx: TransactionSql, scope: Scope, input: LearningSessionCreateInput): Promise<{ id: string }> {
        await lockLearningOwner(tx, scope);
        const course = await tx`SELECT id FROM courses WHERE id=${input.courseId} AND workspace_id=${scope.workspaceId} AND archived_at IS NULL FOR SHARE`;
        if (!course.length) throw learningError("NOT_FOUND", "course not found");
        await admitLearningSources(tx, scope, input.sourceIds);
        if (input.activityId) {
          const activities = await tx`SELECT id,course_id,source_ids,status FROM opening_teaching_activities
            WHERE id=${input.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
          const activity = activities[0];
          if (!activity) throw learningError("NOT_FOUND", "teaching activity not found");
          if (activity.status === "completed") throw learningError("CONFLICT", "completed teaching activity cannot accept new attempts");
          if (activity.course_id !== input.courseId) throw learningError("VALIDATION", "learning session course does not match teaching activity");
          if (input.sourceIds.some((id) => !(activity.source_ids as string[]).includes(id))) throw learningError("VALIDATION", "learning session source is outside teaching activity");
          const id = randomUUID();
          await tx`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label,source_ids)
            VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${input.courseId},${input.activityId},${input.skillLabel},${input.sourceIds})`;
          return { id };
        }
        const clientKey = `legacy-course-continue:${input.courseId}`;
        const existing = await tx`
          SELECT id FROM opening_teaching_activities
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey}
          FOR UPDATE`;
        let activityId = existing[0] ? String(existing[0].id) : randomUUID();
        if (!existing[0]) {
          const createIntent = { intentKind: "course_continue", courseId: input.courseId, legacy: true };
          const inserted = await tx`
            INSERT INTO opening_teaching_activities (
              id, workspace_id, owner_user_id, course_id, status, generate_status,
              intent_kind, intent_summary, source_ids, goal_json, path_version, content_version,
              checkpoint_json, client_key, create_intent
            ) VALUES (
              ${activityId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.courseId}, 'active', 'ready',
              'course_continue', 'Legacy course activity', ${[] as string[]}, ${tx.json({})},
              1, 0, ${tx.json({})}, ${clientKey}, ${tx.json(createIntent as never)}
            )
            ON CONFLICT (workspace_id, owner_user_id, client_key) DO NOTHING
            RETURNING id`;
          if (!inserted[0]) {
            const raced = await tx`
              SELECT id FROM opening_teaching_activities
              WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey}`;
            if (!raced[0]) throw learningError("CONFLICT", "course continue activity write conflict");
            activityId = String(raced[0].id);
          }
        }
        const id = randomUUID();
        await tx`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label,source_ids)
          VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${input.courseId},${activityId},${input.skillLabel},${input.sourceIds})`;
        return { id };
}
