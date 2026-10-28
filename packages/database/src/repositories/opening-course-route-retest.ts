import { randomUUID } from "node:crypto";
import { courseRouteDelayedProtocolSchema } from "./opening-course-route-retest-state";
export { readOpeningCourseRouteRetest,assertOpeningCourseRouteRetestCurrent } from "./opening-course-route-retest-state";
import { courseRouteRetestScheduleSchema,type CourseRouteRetestSchedule,type CourseRouteRetestReceipt,type CourseRouteTaskContext,type Scope } from "@aistudy/contracts";
import type { Sql,TransactionSql } from "postgres";

import { assertLearningGoalAction,readLearningGoal } from "./opening-learning-goals";
import { assertOpeningCourseRouteCurrent } from "./opening-course-route-origin";
import { readOpeningCourseRoute,readCourseRouteObservations,readCourseRequirements } from "./opening-course-route-read";
import { learningError,learningIso,lockWorkspaceLearningHistory,nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { createOpeningRetestRepository } from "./opening-retests";
import { createOpeningPlansRepository } from "./opening-plans";
import { assertOpeningWorkspaceCapacity } from "./opening-learning-capacity";

/** Existing repositories use savepoints so candidate, task, lifecycle and common capacity commit together. */
function transactionClient(tx:TransactionSql):Sql{return new Proxy(tx,{get(target,key,receiver){
  if(key==="begin")return (...args:unknown[])=>target.savepoint(nested=>(args.at(-1) as (db:TransactionSql)=>Promise<unknown>)(nested));
  return Reflect.get(target,key,receiver);
}}) as unknown as Sql;}
function receipt(row:Record<string,unknown>):CourseRouteRetestReceipt{
  return {courseId:String(row.course_id),taskId:String(row.task_id),retestId:String(row.id),notBeforeAt:learningIso(row.not_before_at)!,
    taskStatus:row.task_status as CourseRouteRetestReceipt["taskStatus"],retestStatus:row.status as CourseRouteRetestReceipt["retestStatus"],
    href:`/opening/courses/${row.course_id}/study?task=${row.task_id}`};
}
export function createOpeningCourseRouteRetestRepository(sql:Sql){
  return {async schedule(scope:Scope,courseId:string,raw:CourseRouteRetestSchedule):Promise<CourseRouteRetestReceipt>{
    const input=courseRouteRetestScheduleSchema.parse(raw);
    return sql.begin(async tx=>{
      await lockWorkspaceLearningHistory(tx,scope);
      const [replay]=await tx`SELECT r.*,t.status AS task_status FROM opening_retest_activities r JOIN opening_tasks t ON t.id=r.task_id
        AND t.workspace_id=r.workspace_id AND t.owner_user_id=r.owner_user_id WHERE r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId}
        AND r.accept_client_key=${input.clientKey} AND r.learning_protocol->>'protocolId'='course-route-delayed-v1'`;
      if(replay){const protocol=courseRouteDelayedProtocolSchema.parse(replay.learning_protocol);
        if(replay.course_id!==courseId||protocol.goalId!==input.goalId||protocol.originActivityId!==input.activityId||protocol.baselineObservationId!==input.observationId||protocol.minutes!==input.minutes)
          throw learningError("CONFLICT","原延迟复测回执与本次请求不一致。");
        return receipt(replay);}
      const goal=await assertLearningGoalAction(tx,scope,input.goalId,input.expectedGoalRevision);
      if(!goal.courseIds.includes(courseId))throw learningError("VALIDATION","目标不属于本课程。");
      const snapshot=await readOpeningCourseRoute(tx,scope,courseId,input.activityId),context=await assertOpeningCourseRouteCurrent(tx,scope,input.activityId);
      if(!context||context.goalId!==goal.id||snapshot.currentActivity?.pathVersion!==input.expectedPathVersion||snapshot.observationId!==input.observationId)
        throw learningError("CONFLICT","当前学习位置或有效评价已变化，请重新读取后安排。");
      const all=await readCourseRouteObservations(tx,scope,courseId),head=all.raw.find(item=>item.id===input.observationId),evidence=all.projected.find(item=>item.id===input.observationId);
      if(!head||!evidence||evidence.verifiedCorrect==="unknown"||evidence.usableForCurrentVersion!=="yes"||evidence.courseRequirement?.id!==context.requirementId)
        throw learningError("VALIDATION","请先核对这道题的有效判定；缺少证据不能直接安排延迟验证。");
      const [existing]=await tx`SELECT r.*,t.status AS task_status FROM opening_retest_activities r JOIN opening_tasks t ON t.id=r.task_id
        AND t.workspace_id=r.workspace_id AND t.owner_user_id=r.owner_user_id WHERE r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId}
        AND r.course_id=${courseId} AND r.learning_protocol->>'protocolId'='course-route-delayed-v1' AND r.learning_protocol->>'baselineObservationId'=${head.id}`;
      if(existing)return receipt(existing); // Terminal/cancelled receipts remain terminal, even with a new HTTP key.
      const baselineAt=Math.max(Date.parse(head.submittedAt??""),Date.parse(head.recordedAt??""));
      if(!Number.isFinite(baselineAt))throw learningError("CONFLICT","原答案缺少可信提交时间，暂不能建立延迟间隔。");
      const dueAt=new Date(baselineAt+72*60*60*1000).toISOString();
      await assertOpeningWorkspaceCapacity(tx,scope,{minutes:input.minutes,targetAt:new Date(dueAt)});
      const db=transactionClient(tx),candidateId=randomUUID(),candidate={id:candidateId,courseId,skillLabel:head.skillLabel,requirementKey:head.requirementKey,
        prompt:`${head.skillLabel}：3天后离开原答案独立完成新题，按已确认的课程要求核对。`,sourceIds:head.sourceIds,dueAt,accepted:false,kind:"task" as const,
        evidenceObservationIds:[head.id],evidenceRootIds:[head.rootObservationId??head.id]};
      const saved=await createOpeningRetestRepository(db).saveCandidates(scope,[candidate]);
      if(saved.length!==1)throw learningError("CONFLICT","本要求已有复测安排，或复测建议当前已关闭；请核对已有任务与学习设置。");
      const task=await createOpeningPlansRepository(db).createTask(scope,{title:candidate.prompt.slice(0,240),minutes:input.minutes,dueAt:null,priority:1,candidateId,clientKey:input.clientKey,baseVersion:0,
        inputSnapshot:{kind:"retest",candidateId,courseId,skillLabel:head.skillLabel,prompt:candidate.prompt,sourceIds:head.sourceIds,dueAt,heuristic:true}});
      const protocol={protocolId:"course-route-delayed-v1" as const,goalId:goal.id,goalRevision:goal.revision,requirementId:context.requirementId,requirementRevision:context.requirementRevision,
        stableSkillId:context.stableSkillId,baselineObservationId:head.id,baselineRootId:head.rootObservationId??head.id,originActivityId:input.activityId,minutes:input.minutes};
      const [scheduled]=await tx`UPDATE opening_retest_activities SET learning_protocol=${tx.json(protocol)},candidate_reference_id=${candidateId},accept_client_key=${input.clientKey},
        not_before_at=${dueAt},recommended_at=${dueAt},deadline_at=${new Date(baselineAt+14*86400000).toISOString()},version=version+1,updated_at=now()
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND candidate_id=${candidateId} AND task_id=${task.id} RETURNING *`;
      if(!scheduled)throw learningError("CONFLICT","延迟复测任务回执未完整保存。");
      await tx`UPDATE opening_tasks SET not_before=${dueAt},due_at=${dueAt} WHERE id=${task.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      await nextWorkspaceLearningHistoryRevision(tx,scope);
      return receipt({...scheduled,task_status:"pending"});
    });
  },async readTask(scope:Scope,courseId:string,taskId:string):Promise<CourseRouteTaskContext>{
    const [task]=await sql`SELECT * FROM opening_tasks WHERE id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if(!task||task.course_id!==courseId)throw learningError("NOT_FOUND","本课程任务不存在。");
    const [retest]=await sql`SELECT * FROM opening_retest_activities WHERE task_id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    const protocol=courseRouteDelayedProtocolSchema.safeParse(retest?.learning_protocol);
    const maintenance=typeof task.client_key==="string"?task.client_key.match(/^planner:\d{4}-\d{2}-\d{2}:maintenance:([a-f0-9-]{36}):([a-f0-9-]{36})$/i):null;
    if(!protocol.success&&!maintenance)return {managed:false};
    const goalId=protocol.success?protocol.data.goalId:maintenance![1]!,requirementId=protocol.success?protocol.data.requirementId:maintenance![2]!;
    const goal=await readLearningGoal(sql,scope,goalId),requirements=await readCourseRequirements(sql,scope,courseId),requirement=requirements.find(item=>item.id===requirementId);
    if(!goal||!requirement)throw learningError("CONFLICT","原目标或要求不可用；任务与历史保留，请回到课程核对。");
    let reason:string|null=null;
    if(task.status!=="pending")reason="原任务已完成或取消，未重新开始。";
    else if(!["active","maintenance","reduced"].includes(goal.lifecycle)||!goal.courseIds.includes(courseId))reason="目标已暂停、停止或移出本课程。";
    else if(protocol.success&&(protocol.data.goalRevision!==goal.revision||protocol.data.requirementRevision!==requirement.revision))reason="延迟复测的目标或要求版本已改变。";
    else if(retest&&!["accepted","in_progress"].includes(String(retest.status)))reason="原复测已结束或失效，未重新安排。";
    else if(retest?.deadline_at&&new Date(retest.deadline_at as Date).getTime()<Date.now())reason="原复测已过期，可回到课程明确选择新的普通学习。";
    else if(task.not_before&&new Date(task.not_before as Date).getTime()>Date.now())reason="尚未到达本次复测或维护抽查的最早开始时间。";
    return {managed:true,courseId,taskId,expectedTaskVersion:Number(task.version),goalId,expectedGoalRevision:goal.revision,requirementId,expectedRequirementRevision:requirement.revision,
      minutes:Number(task.minutes),notBeforeAt:learningIso(task.not_before),available:reason===null,reason};
  }};
}
