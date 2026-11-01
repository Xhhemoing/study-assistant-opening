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

/** Resolve the selected route evidence without widening stale chunk refs to a source. */
export async function readOpeningCourseRouteEvidenceRefs(sql:Sql,scope:Scope,activityId:string){
  const context=await assertOpeningCourseRouteReady(sql,scope,activityId);
  if(!context)return null;
  const [activity]=await sql`SELECT course_id FROM opening_teaching_activities WHERE id=${activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  const courseId=String(activity!.course_id);
  const requirement=(await readCourseRequirements(sql,scope,courseId)).find(item=>item.id===context.requirementId);
  if(!requirement)throw learningError("CONFLICT","课程要求已变化，请重新读取课程路线；原答案保留。");
  const refs=requirement.sourceRefs;
  const chunks=await readCourseRouteSourceChunks(sql,scope,courseId);
  const constrained=refs.filter(ref=>ref.chunkId!=null||ref.page!=null);
  if(!constrained.length)return null;
  const matches=(ref:typeof refs[number],chunk:typeof chunks[number])=>ref.sourceId===chunk.sourceId&&ref.sourceVersion===chunk.sourceVersion
    &&(ref.chunkId==null||ref.chunkId===chunk.id)&&(ref.page==null||ref.page===chunk.page);
  const selected=chunks.filter(chunk=>refs.some(ref=>matches(ref,chunk)));
  if(constrained.some(ref=>!selected.some(chunk=>matches(ref,chunk))))
    throw learningError("CONFLICT","所选课程材料片段已失效或换版，请重新选择材料后再生成讲义；不会回退整份教材。");
  return {refs,chunkIds:selected.map(chunk=>chunk.id)};
}
