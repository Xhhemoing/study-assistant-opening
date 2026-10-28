import { courseRouteActivityContextSchema,type Scope } from "@aistudy/contracts";
import type { Sql,TransactionSql } from "postgres";
import { learningError,lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { assertCourseRouteCourse,readCourseRequirements,readCourseRouteMaterials,readCourseRouteObservations,readCourseRouteSourceChunks } from "./opening-course-route-read";
import { readLearningGoal } from "./opening-learning-goals";
import { courseRequirementSourcesAvailable } from "@aistudy/domain";
import { assertOpeningCourseRouteRetestCurrent } from "./opening-course-route-retest-state";
/** Called for new questions under the caller's history lock; old attempts stay answerable. */
export async function assertOpeningCourseRouteCurrent(tx:TransactionSql,scope:Scope,activityId:string){
  const [row]=await tx`SELECT course_id,goal_json,create_intent FROM opening_teaching_activities WHERE id=${activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  const raw=(row?.goal_json as {courseRoute?:unknown}|undefined)?.courseRoute;
  if(raw===undefined)return null;
  const context=courseRouteActivityContextSchema.parse(raw),courseId=String(row!.course_id);
  await assertCourseRouteCourse(tx,scope,courseId);
  const requirements=await readCourseRequirements(tx,scope,courseId),requirement=requirements.find(item=>item.id===context.requirementId);
  const goal=await readLearningGoal(tx,scope,context.goalId),materials=await readCourseRouteMaterials(tx,scope,courseId);
  if(!requirement||requirement.approvedAt===null||requirement.revision!==context.requirementRevision||requirement.requirementKey!==context.requirementKey||requirement.stableSkillId!==context.stableSkillId
    ||!goal||goal.revision!==context.goalRevision||!goal.courseIds.includes(courseId)||!["active","maintenance","reduced"].includes(goal.lifecycle)
    ||!courseRequirementSourcesAvailable(requirement,new Map(materials.filter(item=>item.available).map(item=>[item.sourceId,item.sourceVersion])),await readCourseRouteSourceChunks(tx,scope,courseId)))
    throw learningError("CONFLICT","课程要求、目标或材料已变化，请重新读取课程路线；原答案保留。");
  if(context.originActivityId){
    const all=await readCourseRouteObservations(tx,scope,courseId);
    const head=all.raw.filter(item=>item.activityId===context.originActivityId).sort((a,b)=>Date.parse(b.submittedAt??b.occurredAt)-Date.parse(a.submittedAt??a.occurredAt)||b.id.localeCompare(a.id))[0];
    if((head?.id??null)!==(context.originObservationId??null))throw learningError("CONFLICT","原建议采用的评价已变化，请重新读取课程路线；原答案保留。");
  }
  if(context.retestId)await assertOpeningCourseRouteRetestCurrent(tx,scope,context.retestId,courseId,context.requirementId);
  const taskId=(row?.create_intent as {taskId?:string}|undefined)?.taskId;
  if(taskId){const [task]=await tx`SELECT status FROM opening_tasks WHERE id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if(!task||task.status!=="pending")throw learningError("CONFLICT","原任务已完成或取消，请重新读取；已发题和答案保留。");}
  return context;
}
export async function assertOpeningCourseRouteReady(sql:Sql,scope:Scope,activityId:string){
  return sql.begin(async tx=>{await lockWorkspaceLearningHistory(tx,scope);return assertOpeningCourseRouteCurrent(tx,scope,activityId);});
}
