import { z } from "zod";
import type { Scope } from "@aistudy/contracts";
import type { Sql,TransactionSql } from "postgres";
import { assertRetestSubmitEarliestAllowed,courseRouteRetestOutcome,type CourseRouteObservation } from "@aistudy/domain";
import { readLearningGoal } from "./opening-learning-goals";
import { readCourseRequirements,readCourseRouteObservations } from "./opening-course-route-read";
import { learningError,learningIso } from "./opening-learning-facts";
export const courseRouteDelayedProtocolSchema=z.object({protocolId:z.literal("course-route-delayed-v1"),goalId:z.string().uuid(),goalRevision:z.number().int().positive(),
  requirementId:z.string().uuid(),requirementRevision:z.number().int().positive(),stableSkillId:z.string().uuid(),baselineObservationId:z.string().uuid(),baselineRootId:z.string().uuid(),
  originActivityId:z.string().uuid(),minutes:z.number().int().min(5).max(180)}).strict();
export async function readOpeningCourseRouteRetest(tx:Sql|TransactionSql,scope:Scope,retestId:string){
  const [row]=await tx`SELECT r.*,t.status AS task_status,t.version AS task_version FROM opening_retest_activities r
    LEFT JOIN opening_tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id AND t.owner_user_id=r.owner_user_id
    WHERE r.id=${retestId} AND r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId}`;
  return row??null;
}
/** Recheck lifecycle, baseline head and goal before a *new* delayed question/help/model send. */
export async function assertOpeningCourseRouteRetestCurrent(tx:TransactionSql,scope:Scope,retestId:string,courseId:string,requirementId:string,now=new Date()){
  const row=await readOpeningCourseRouteRetest(tx,scope,retestId),protocol=courseRouteDelayedProtocolSchema.safeParse(row?.learning_protocol);
  if(!row||!protocol.success||row.course_id!==courseId||protocol.data.requirementId!==requirementId
    ||!["accepted","in_progress"].includes(String(row.status))||row.task_status!=="pending")throw learningError("CONFLICT","延迟复测已取消、完成或失效，请重新读取课程路线；原答案保留。");
  if(row.deadline_at&&new Date(row.deadline_at as Date).getTime()<now.getTime())throw learningError("CONFLICT","延迟复测已过期，未重新安排；已有作答保留。");
  assertRetestSubmitEarliestAllowed({notBeforeAt:learningIso(row.not_before_at),recommendedAt:learningIso(row.recommended_at),scheduledStartAt:learningIso(row.scheduled_start_at)},now);
  const goal=await readLearningGoal(tx,scope,protocol.data.goalId),requirements=await readCourseRequirements(tx,scope,courseId),requirement=requirements.find(item=>item.id===requirementId);
  if(!goal||goal.revision!==protocol.data.goalRevision||!["active","maintenance","reduced"].includes(goal.lifecycle)||!requirement
    ||requirement.revision!==protocol.data.requirementRevision||requirement.stableSkillId!==protocol.data.stableSkillId)throw learningError("CONFLICT","延迟复测的目标或要求已变化，请重新核对。");
  const all=await readCourseRouteObservations(tx,scope,courseId);
  if(!all.raw.some(item=>item.id===protocol.data.baselineObservationId&&(item.rootObservationId??item.id)===protocol.data.baselineRootId))throw learningError("CONFLICT","延迟复测所依据的评价已更正或撤回，请重新核对。");
  return row;
}
export async function readOpeningCourseRouteRetestOutcome(db:Sql|TransactionSql,scope:Scope,retestId:string,observation:CourseRouteObservation|null){
  const retest=await readOpeningCourseRouteRetest(db,scope,retestId),protocol=courseRouteDelayedProtocolSchema.safeParse(retest?.learning_protocol);
  let recordedIntervalHelp=false,recordedIntervalPractice=false;
  const [record]=observation?await db`SELECT o.submitted_at,a.started_at,b.recorded_at AS baseline_at,
      EXISTS(SELECT 1 FROM opening_learning_observations root WHERE root.id=COALESCE(b.root_observation_id,b.id)
        AND root.workspace_id=b.workspace_id AND COALESCE(root.effective_head_id,root.id)=b.id AND COALESCE(b.revision_kind,'original')<>'retract') AS baseline_current
    FROM opening_learning_observations o JOIN opening_learning_attempts a ON a.id=o.attempt_id AND a.workspace_id=o.workspace_id AND a.owner_user_id=o.owner_user_id
    JOIN opening_retest_activities r ON r.id=o.retest_id AND r.workspace_id=o.workspace_id AND r.owner_user_id=o.owner_user_id
    JOIN opening_learning_observations b ON b.id::text=r.learning_protocol->>'baselineObservationId' AND b.workspace_id=r.workspace_id AND b.owner_user_id=r.owner_user_id
    WHERE o.id=${observation.id} AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND r.id=${retestId}`:[];
  if(record&&protocol.success){
    const [interval]=await db`SELECT EXISTS(SELECT 1 FROM opening_help_exposures h JOIN opening_learning_sessions l ON l.id=h.session_id AND l.workspace_id=h.workspace_id
      JOIN opening_teaching_activities activity ON activity.id=l.activity_id AND activity.workspace_id=l.workspace_id AND activity.owner_user_id=l.owner_user_id
      WHERE h.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId} AND h.delivered=TRUE
        AND activity.goal_json->'courseRoute'->>'requirementId'=${protocol.data.requirementId}
        AND COALESCE(h.released_at,h.delivered_at)>${record.baseline_at as Date} AND COALESCE(h.released_at,h.delivered_at)<=${record.started_at as Date}) AS helped,
      EXISTS(SELECT 1 FROM opening_learning_attempts a WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
        AND a.course_id=${retest!.course_id as string} AND a.requirement_key=${retest!.requirement_key as string}
        AND a.started_at>${record.baseline_at as Date} AND a.started_at<${record.started_at as Date}) AS practiced`;
    recordedIntervalHelp=interval?.helped===true;recordedIntervalPractice=interval?.practiced===true;
  }
  const usable=record?.baseline_current===true&&protocol.success&&observation?.courseRequirement?.id===protocol.data.requirementId
    &&observation.courseRequirement.revision===protocol.data.requirementRevision&&observation.courseRequirement.stableSkillId===protocol.data.stableSkillId;
  const evidence=observation?{...observation,independentAttempt:observation.firstQuestionExposure===true?observation.independentAttempt:"unknown" as const,
    usableForCurrentVersion:usable?observation.usableForCurrentVersion:"unknown" as const}:null;
  return courseRouteRetestOutcome({status:String(retest?.status??"invalidated"),deadlineAt:learningIso(retest?.deadline_at),submittedAt:learningIso(record?.submitted_at),
    recordedIntervalHelp,recordedIntervalPractice,observation:evidence},new Date());
}
