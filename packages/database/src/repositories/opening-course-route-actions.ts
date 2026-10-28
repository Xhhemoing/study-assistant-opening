import { courseRouteActivityContextSchema, type CourseRouteActivityContext, type CourseRouteActionResult, type CourseRouteNext, type CourseRouteStart, type Scope } from "@aistudy/contracts";
import { courseRequirementProgress, selectCourseRouteStep, courseRouteLearningDecision,remainingCourseComprehensiveRequirements } from "@aistudy/domain";
import { assertOpeningCourseRouteRetestCurrent,readOpeningCourseRouteRetest,readOpeningCourseRouteRetestOutcome,courseRouteDelayedProtocolSchema } from "./opening-course-route-retest-state";
import type { Sql,TransactionSql } from "postgres";
import { learningError,lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { assertLearningGoalAction,readLearningGoal } from "./opening-learning-goals";
import { createOpeningTeachingActivityInTransaction,mapTeachingActivity } from "./opening-teaching-activities";
import { reserveOpeningLearningActivityBudget } from "./opening-learning-capacity";
import { readOpeningCourseRoute,readCourseRouteObservations,readCourseRouteSourceChunks } from "./opening-course-route-read";

const href=(courseId:string,activityId?:string)=>activityId?`/opening/courses/${courseId}/study?activity=${activityId}`:`/opening/courses/${courseId}#course-learning-route`;
const messages={scope_unconfirmed:"先核对并确认本课程的完整要求范围；材料或题目缺口也保留在清单内。",source_unavailable:"要求引用的材料不可用或版本已变化，请核对材料后继续。",
  verification_unavailable:"本要求尚缺可用习题或判定标准；保留已有学习与答案，请补充验证材料。",evidence_unknown:"当前答案尚无可靠判定，请先核对评价；不会把缺少证据当作不会。",
  evidence_changed:"原活动的要求、材料或评价已变化，请读取当前课程路线再选择；已有活动和答案保留。",configuration:"教学内容生成尚未开启，未创建空白活动。",
  course_complete:"已完成当前确认范围的当前检查与逐项综合收尾；延迟验证单独记录。可回看课程记录，或明确安排延迟复测与维护。",
  retest_waiting:"尚未到达本次复测的最早开始时间。原任务与学习位置保留。",retest_expired:"原延迟复测已过期，未降低能力记录或重新安排；可明确选择新的普通学习。",
  retest_cancelled:"原延迟复测已取消或失效，未重新开始；原答案保留，可明确选择新的普通学习。"};
function choice(courseId:string,reason:keyof typeof messages,ids:string[]=[]):CourseRouteActionResult{
  return {kind:"choice",reason,message:messages[reason],courseId,href:href(courseId),requirementIds:ids};
}
type Origin={row:Record<string,unknown>;context:CourseRouteActivityContext;input:CourseRouteNext};
export function createOpeningCourseRouteActions(sql:Sql,options:{compilerEnabled:boolean}){
  async function act(tx:TransactionSql,scope:Scope,courseId:string,input:CourseRouteStart|CourseRouteNext,origin?:Origin):Promise<CourseRouteActionResult>{
    const key=origin?`course-route-next:${origin.input.activityId}:${origin.input.observationId??"none"}`
      :"taskId" in input&&input.taskId?`course-route-task:${input.taskId}`:`course-route-start:${courseId}:${input.clientKey}`;
    const [receipt]=await tx`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${key}`;
    const snapshot=await readOpeningCourseRoute(tx,scope,courseId);
    if(receipt){
      const context=courseRouteActivityContextSchema.parse((receipt.goal_json as {courseRoute:unknown}).courseRoute);
      if(context.goalId!==input.goalId)throw learningError("CONFLICT","原请求属于不同目标。");
      if((receipt.goal_json as {learningBudget?:{minutes?:number}}).learningBudget?.minutes!==input.minutes
        ||"requirementId" in input&&context.requirementId!==input.requirementId&&!context.returnTo)throw learningError("CONFLICT","同一次请求的要求或时长已变化，请恢复原请求。");
      const goal=await readLearningGoal(tx,scope,input.goalId);
      if(!goal||goal.revision!==context.goalRevision||!["active","maintenance","reduced"].includes(goal.lifecycle)||!goal.courseIds.includes(courseId))return choice(courseId,"evidence_changed",[context.requirementId]);
      const row=snapshot.requirements.find(row=>row.requirement.id===context.requirementId);
      if(!row?.sourcesAvailable||row.requirement.revision!==context.requirementRevision)return choice(courseId,"evidence_changed",[context.requirementId]);
      if(origin){
        const all=await readCourseRouteObservations(tx,scope,courseId);
        const head=all.raw.filter(row=>row.activityId===origin.input.activityId).sort((a,b)=>Date.parse(b.submittedAt??b.occurredAt)-Date.parse(a.submittedAt??a.occurredAt)||b.id.localeCompare(a.id))[0];
        if((head?.id??null)!==context.originObservationId)return choice(courseId,"evidence_changed",[context.requirementId]);
      }
      if(context.retestId){const retest=await readOpeningCourseRouteRetest(tx,scope,context.retestId);
        if(!retest||["cancelled","declined","invalidated","superseded"].includes(String(retest.status)))return choice(courseId,"retest_cancelled",[context.requirementId]);
        if(retest.status!=="completed"&&retest.deadline_at&&new Date(retest.deadline_at as Date).getTime()<Date.now())return choice(courseId,"retest_expired",[context.requirementId]);}
      const taskId=(receipt.create_intent as {taskId?:string}|undefined)?.taskId;
      if(taskId){const [task]=await tx`SELECT status FROM opening_tasks WHERE id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if(!task||task.status==="skipped")return choice(courseId,context.retestId?"retest_cancelled":"evidence_changed",[context.requirementId]);}
      return {kind:"ready",activity:mapTeachingActivity(receipt),href:href(courseId,String(receipt.id)),resumed:true,requirementId:context.requirementId,action:context.action};
    }
    const goal=await assertLearningGoalAction(tx,scope,input.goalId,input.expectedGoalRevision);
    if(!goal.courseIds.includes(courseId))throw learningError("VALIDATION","目标不属于本课程。");
    if(snapshot.scopeState!=="confirmed")return choice(courseId,"scope_unconfirmed");
    let progress=snapshot.requirements.filter(row=>row.requirement.goalIds.length===0||row.requirement.goalIds.includes(goal.id));
    let requestedId="requirementId" in input?input.requirementId:origin!.context.requirementId;
    const current=progress.find(row=>row.requirement.id===requestedId);
    if(!current)throw learningError("CONFLICT","要求已移出当前目标范围，请重新读取课程路线。");
    if("requirementId" in input&&current.requirement.revision!==input.expectedRequirementRevision)throw learningError("CONFLICT","课程要求已更新，请重新读取。");
    let boundRetestId:string|undefined;
    if("requirementId" in input&&input.taskId){
      const [task]=await tx`SELECT * FROM opening_tasks WHERE id=${input.taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      if(!task||task.status!=="pending"||Number(task.version)!==input.expectedTaskVersion||task.course_id!==courseId||task.requirement_key!==current.requirement.requirementKey)
        throw learningError("CONFLICT","维护抽查任务已变化或不属于此目标与课程要求，请重新读取。");
      const [retest]=await tx`SELECT id,learning_protocol,status,deadline_at,not_before_at FROM opening_retest_activities WHERE task_id=${input.taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      if(retest){const protocol=courseRouteDelayedProtocolSchema.safeParse(retest.learning_protocol);
        if(!protocol.success||protocol.data.goalId!==goal.id||protocol.data.requirementId!==current.requirement.id)throw learningError("CONFLICT","复测任务不属于本目标与要求。");
        if(["cancelled","declined","invalidated","superseded","completed"].includes(String(retest.status)))return choice(courseId,"retest_cancelled",[current.requirement.id]);
        if(retest.deadline_at&&new Date(retest.deadline_at as Date).getTime()<Date.now())return choice(courseId,"retest_expired",[current.requirement.id]);
        if(retest.not_before_at&&new Date(retest.not_before_at as Date).getTime()>Date.now())return choice(courseId,"retest_waiting",[current.requirement.id]);
        boundRetestId=String(retest.id);await assertOpeningCourseRouteRetestCurrent(tx,scope,boundRetestId,courseId,current.requirement.id);
      }else if(typeof task.client_key!=="string"||!task.client_key.endsWith(`:maintenance:${goal.id}:${current.requirement.id}`))throw learningError("CONFLICT","任务缺少可信目标与要求绑定。");
    }
    let currentObservation:Awaited<ReturnType<typeof readCourseRouteObservations>>["projected"][number]|undefined;
    let comprehensiveIds=origin?.context.coveredRequirementIds;
    let comprehensiveRunKey=origin?.context.comprehensiveRunKey;
    if(origin){
      if(origin.context.requirementRevision!==current.requirement.revision||origin.context.goalRevision!==goal.revision)return choice(courseId,"evidence_changed",[requestedId]);
      const all=await readCourseRouteObservations(tx,scope,courseId);
      const head=all.raw.filter(row=>row.activityId===origin.input.activityId).sort((a,b)=>Date.parse(b.submittedAt??b.occurredAt)-Date.parse(a.submittedAt??a.occurredAt)||b.id.localeCompare(a.id))[0];
      if((head?.id??null)!==origin.input.observationId)throw learningError("CONFLICT","原答案的有效评价已更新，请重新读取。");
      const closure=(origin.row.goal_json as {courseRouteClosure?:{observationId:string;goalId:string}}).courseRouteClosure;
      if(closure?.observationId===origin.input.observationId&&closure.goalId===goal.id)return choice(courseId,"course_complete");
      if(Number(origin.row.path_version)!==origin.input.expectedPathVersion)throw learningError("CONFLICT","原学习位置已更新，请重新读取。");
      currentObservation=all.projected.find(row=>row.id===head?.id&&row.usableForCurrentVersion==="yes");
      if(origin.context.retestId){
        const outcome=await readOpeningCourseRouteRetestOutcome(tx,scope,origin.context.retestId,currentObservation??null);
        if(outcome==="cancelled")return choice(courseId,"retest_cancelled",[requestedId]);
        if(outcome==="expired")return choice(courseId,"retest_expired",[requestedId]);
        if(outcome==="insufficient_evidence")return choice(courseId,"evidence_unknown",[requestedId]);
        if(outcome==="assisted"&&currentObservation)currentObservation={...currentObservation,assistance:"hinted",independentAttempt:"no"};
      }
      if(!currentObservation||currentObservation.verifiedCorrect==="unknown")return choice(courseId,"evidence_unknown",[requestedId]);
      // Origin feedback wins over later observations from another activity.
      const focused=all.projected.filter(row=>row.requirementKey!==current.requirement.requirementKey||row.id===head!.id||Date.parse(row.attemptedAt)<Date.parse(currentObservation!.attemptedAt))
        .map(row=>row.id===head!.id?currentObservation!:row);
      const recalculated=courseRequirementProgress(progress.map(row=>row.requirement),focused,new Map(snapshot.materials.filter(row=>row.available).map(row=>[row.sourceId,row.sourceVersion])),await readCourseRouteSourceChunks(tx,scope,courseId));
      progress=recalculated;
      if(origin.context.returnTo&&recalculated.find(row=>row.requirement.id===requestedId)?.status==="verified")requestedId=origin.context.returnTo;
      else if(recalculated.find(row=>row.requirement.id===requestedId)?.status==="verified")requestedId="";
      if(comprehensiveIds&&comprehensiveRunKey){
        const mandatory=progress.filter(row=>row.requirement.mandatory).map(row=>row.requirement.id);
        if(mandatory.length!==comprehensiveIds.length||mandatory.some(id=>!comprehensiveIds!.includes(id)))return choice(courseId,"evidence_changed",mandatory);
        const remaining=remainingCourseComprehensiveRequirements(progress,all.projected,comprehensiveRunKey);
        if(!remaining.length){
          await tx`UPDATE opening_teaching_activities SET status='completed',path_version=path_version+1,updated_at=now(),
            goal_json=goal_json||${tx.json({courseRouteClosure:{observationId:origin.input.observationId,goalId:goal.id,comprehensiveRunKey}})}
            WHERE id=${origin.input.activityId} AND workspace_id=${scope.workspaceId}`;
          return choice(courseId,"course_complete");
        }
        requestedId=remaining.includes(origin.context.requirementId)?origin.context.requirementId:remaining[0]!;
      }
    }
    let step=selectCourseRouteStep(progress,requestedId||undefined);
    if(boundRetestId)step={requirementId:current.requirement.id,action:"transfer_check",focusObservationId:null};
    if(!step){
      const first=progress.find(row=>row.requirement.mandatory)??progress[0];
      if(!first)return choice(courseId,"scope_unconfirmed");
      step={requirementId:first.requirement.id,action:"comprehensive",focusObservationId:null};
      comprehensiveIds=progress.filter(row=>row.requirement.mandatory).map(row=>row.requirement.id);
      comprehensiveRunKey=key;
    }
    if(comprehensiveIds)step={requirementId:requestedId||step.requirementId,action:"comprehensive",focusObservationId:currentObservation?.verifiedCorrect==="no"?currentObservation.id:null};
    const selected=progress.find(row=>row.requirement.id===step.requirementId)!;
    if(!selected.sourcesAvailable)return choice(courseId,"source_unavailable",[selected.requirement.id]);
    if(["transfer_check","comprehensive"].includes(step.action)&&selected.requirement.verification.status!=="ready")return choice(courseId,"verification_unavailable",[selected.requirement.id]);
    if(!options.compilerEnabled)return choice(courseId,"configuration",[selected.requirement.id]);
    const action=origin?.context.returnTo===selected.requirement.id?"return":step.action;
    const existing=await tx`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}
      AND status IN ('active','paused') AND goal_json->'courseRoute'->>'goalId'=${goal.id} AND goal_json->'courseRoute'->>'requirementId'=${selected.requirement.id}
      AND goal_json->'courseRoute'->>'requirementRevision'=${String(selected.requirement.revision)} AND goal_json->'courseRoute'->>'goalRevision'=${String(goal.revision)}
      AND goal_json->'courseRoute'->>'action'=${action} AND goal_json->'courseRoute'->>'originActivityId' IS NOT DISTINCT FROM ${origin?.input.activityId??null}
      AND goal_json->'courseRoute'->>'comprehensiveRunKey' IS NOT DISTINCT FROM ${comprehensiveRunKey??null}
      AND (${origin?.input.activityId??null}::uuid IS NULL OR id<>${origin?.input.activityId??null}::uuid)
      ORDER BY updated_at DESC,id DESC LIMIT 1`;
    if(existing[0]){const context=courseRouteActivityContextSchema.parse((existing[0].goal_json as {courseRoute:unknown}).courseRoute);
      return {kind:"ready",activity:mapTeachingActivity(existing[0]),href:href(courseId,String(existing[0].id)),resumed:true,requirementId:context.requirementId,action:context.action};}
    // A comprehensive run issues a real check per requirement, never one item for the whole course.
    const covering=[selected];
    const sourceIds=[...new Set(covering.flatMap(row=>row.requirement.sourceRefs.map(ref=>ref.sourceId)))];
    if(sourceIds.length>32||covering.some(row=>!row.sourcesAvailable))return choice(courseId,"source_unavailable",covering.map(row=>row.requirement.id));
    const all=await readCourseRouteObservations(tx,scope,courseId);
    const observations=all.projected.filter(row=>row.requirementKey===selected.requirement.requirementKey).sort((a,b)=>Date.parse(b.attemptedAt)-Date.parse(a.attemptedAt)||b.id.localeCompare(a.id));
    const decision=courseRouteLearningDecision(currentObservation?[currentObservation,...observations.filter(row=>row.id!==currentObservation!.id)]:observations);
    const context:CourseRouteActivityContext={goalId:goal.id,goalRevision:goal.revision,requirementId:selected.requirement.id,requirementRevision:selected.requirement.revision,
      stableSkillId:selected.requirement.stableSkillId,requirementKey:selected.requirement.requirementKey,action,
      ...(step.returnTo?{returnTo:step.returnTo}:origin?.context.returnTo&&selected.requirement.id!==origin.context.returnTo?{returnTo:origin.context.returnTo}:{}),
      ...(origin?{originActivityId:origin.input.activityId,originObservationId:origin.input.observationId}:{}),...(comprehensiveIds?{coveredRequirementIds:comprehensiveIds,comprehensiveRunKey}:{}),...(boundRetestId?{retestId:boundRetestId}:{})};
    const summary=step.action==="comprehensive"?`综合检查当前要求（全范围共${comprehensiveIds!.length}项，逐项检查）：${selected.requirement.title}；${selected.requirement.verification.rubric??"按本要求已确认标准判定"}`
      :`${action==="prerequisite"?"先补前置要求，检查后返回原要求：":action==="return"?"返回原要求：":"课程要求："}${selected.requirement.title}；本次${input.minutes}分钟；验证方式${selected.requirement.verification.kind}。${selected.requirement.verification.rubric??""}`;
    const activity=await createOpeningTeachingActivityInTransaction(tx,scope,{clientKey:key,intentKind:"goal",intentSummary:summary.slice(0,2000),courseId,sourceIds,
      createIntent:{kind:"course_route",goalId:goal.id,requirementId:selected.requirement.id,...("taskId" in input&&input.taskId?{source:"task",taskId:input.taskId}:{}),
        ...(origin?{originActivityId:origin.input.activityId,observationId:origin.input.observationId}:{clientKey:input.clientKey})},
      goalJson:{courseRoute:context,learnerFocus:{skillLabel:selected.requirement.title,requirementKey:selected.requirement.requirementKey,
        activityKind:["prerequisite","return","comprehensive"].includes(action)?decision.activityKind:step.action,reasonCode:decision.reasonCode,
        focusObservationId:step.focusObservationId,recentAssistance:observations.slice(0,3).map(row=>row.assistance),strategyVersion:"course-route-1"}}},{enqueueCompile:true});
    await reserveOpeningLearningActivityBudget(tx,scope,{activityId:activity.id,minutes:input.minutes,goalId:goal.id,expectedGoalRevision:goal.revision});
    if(origin)await tx`UPDATE opening_teaching_activities SET status='completed',path_version=path_version+1,updated_at=now() WHERE id=${origin.input.activityId} AND workspace_id=${scope.workspaceId}`;
    return {kind:"ready",activity,href:href(courseId,activity.id),resumed:false,requirementId:selected.requirement.id,action};
  }
  return {async start(scope:Scope,courseId:string,input:CourseRouteStart){return sql.begin(async tx=>{await lockWorkspaceLearningHistory(tx,scope);return act(tx,scope,courseId,input);});},
    async next(scope:Scope,courseId:string,input:CourseRouteNext){return sql.begin(async tx=>{
      await lockWorkspaceLearningHistory(tx,scope);
      const [row]=await tx`SELECT * FROM opening_teaching_activities WHERE id=${input.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
      if(!row)throw learningError("NOT_FOUND","本课程的原活动不存在。");
      const context=courseRouteActivityContextSchema.parse((row.goal_json as {courseRoute?:unknown}).courseRoute);
      if(context.goalId!==input.goalId)throw learningError("CONFLICT","活动不属于所选目标。");
      return act(tx,scope,courseId,input,{row,context,input});
    });}};
}
