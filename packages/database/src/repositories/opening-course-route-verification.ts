import { courseRouteActivityContextSchema,courseRouteVerificationConfirmSchema,type CourseRouteVerificationConfirm,type CourseRouteVerificationRead,type Scope } from "@aistudy/contracts";
import type { Sql,TransactionSql } from "postgres";
import { learningError,lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { assertLearningGoalAction } from "./opening-learning-goals";
import { assertCourseRouteCourse,readCourseRequirements,readOpeningCourseRoute } from "./opening-course-route-read";
import { readTeachingQuestionForGrading } from "./opening-teaching-question";

async function read(db:TransactionSql,scope:Scope,courseId:string,activityId:string):Promise<CourseRouteVerificationRead>{
  await assertCourseRouteCourse(db,scope,courseId);
  const [activity]=await db`SELECT content_version,goal_json FROM opening_teaching_activities WHERE id=${activityId} AND workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
  if(!activity)throw learningError("NOT_FOUND","本课程的教学活动不存在。");
  const context=courseRouteActivityContextSchema.parse((activity.goal_json as {courseRoute:unknown}).courseRoute),requirements=await readCourseRequirements(db,scope,courseId);
  const requirement=requirements.find(row=>row.id===context.requirementId);
  if(!requirement)throw learningError("CONFLICT","原要求已不可用，请回到课程核对。");
  const rows=await db`SELECT DISTINCT v.* FROM opening_learning_attempts a JOIN opening_learning_item_versions v
    ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${courseId} AND a.activity_id=${activityId}
      AND a.submitted_at IS NOT NULL AND v.evaluation_spec->>'contentVersion'=${String(activity.content_version)}
      AND v.evaluation_spec->'courseRequirement'->>'id'=${requirement.id} AND v.evaluation_spec->'courseRequirement'->>'revision'=${String(requirement.revision)}
      AND v.evaluation_spec->'courseRequirement'->>'stableSkillId'=${requirement.stableSkillId} AND v.evaluation_spec->'courseRequirement'->>'requirementKey'=${requirement.requirementKey}
      AND v.teaching_revision_id IS NOT NULL ORDER BY v.id`;
  const route=await readOpeningCourseRoute(db,scope,courseId,activityId),available=route.requirements.find(row=>row.requirement.id===requirement.id)?.sourcesAvailable===true
    &&context.requirementRevision===requirement.revision&&context.stableSkillId===requirement.stableSkillId&&context.requirementKey===requirement.requirementKey
    &&rows.length>0&&!!requirement.verification.rubric?.trim()&&Number(activity.content_version)>0;
  const items=[];for(const row of rows){const reference=await readTeachingQuestionForGrading(db,scope,row);
    items.push({itemVersionId:String(row.id),prompt:String(row.stem_snapshot),...(reference?{referenceText:reference.referenceText}:{})});}
  return {courseId,activityId,contentVersion:Number(activity.content_version),requirementId:requirement.id,requirementRevision:requirement.revision,rubric:requirement.verification.rubric,
    items,available,reason:available?null:"请先保存判定标准、完成一份本要求的真实题目，并核对其材料是否仍可用。"};
}
export function createOpeningCourseRouteVerificationRepository(sql:Sql){return {
  read:(scope:Scope,courseId:string,activityId:string)=>sql.begin("isolation level repeatable read read only",tx=>read(tx,scope,courseId,activityId)),
  async confirm(scope:Scope,courseId:string,raw:CourseRouteVerificationConfirm){
    const input=courseRouteVerificationConfirmSchema.parse(raw);
    return sql.begin(async tx=>{
      await lockWorkspaceLearningHistory(tx,scope);const goal=await assertLearningGoalAction(tx,scope,input.goalId,input.expectedGoalRevision);
      if(!goal.courseIds.includes(courseId))throw learningError("VALIDATION","目标不属于本课程。");
      const current=await read(tx,scope,courseId,input.activityId);
      if(current.requirementId!==input.requirementId||current.contentVersion!==input.expectedContentVersion)throw learningError("CONFLICT","原教学内容或要求已变化，请重新读取核对。");
      const requirements=await readCourseRequirements(tx,scope,courseId),requirement=requirements.find(row=>row.id===input.requirementId)!;
      const [activity]=await tx`SELECT goal_json FROM opening_teaching_activities WHERE id=${input.activityId} AND workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
      const context=courseRouteActivityContextSchema.parse((activity!.goal_json as {courseRoute:unknown}).courseRoute);
      if(context.goalId!==goal.id||context.goalRevision!==goal.revision||context.requirementId!==requirement.id
        ||context.requirementRevision!==input.expectedRequirementRevision||context.stableSkillId!==requirement.stableSkillId||context.requirementKey!==requirement.requirementKey
        ||requirement.goalIds.length>0&&!requirement.goalIds.includes(goal.id))throw learningError("CONFLICT","该题目属于不同目标或旧要求标准，请在当前要求下重新学习与核对。");
      const keys=[...new Set(input.itemVersionIds)].sort().map(id=>`teaching-item:${id}`);
      const same=requirement.verification.kind==="rubric"&&requirement.verification.status==="ready"&&requirement.verification.exerciseKeys.length===keys.length
        &&keys.every(key=>requirement.verification.exerciseKeys.includes(key));
      // Exact unknown-response replay after the single revision bump is read-only.
      if(same&&requirement.revision===input.expectedRequirementRevision+1)return readOpeningCourseRoute(tx,scope,courseId);
      if(requirement.revision!==input.expectedRequirementRevision)throw learningError("CONFLICT","课程要求已修改，请重新核对题目与标准。");
      if(input.itemVersionIds.some(id=>!current.items.some(item=>item.itemVersionId===id)))throw learningError("VALIDATION","请仅核对该活动中已保存、已提交的题目版本。");
      if(!current.available)throw learningError("CONFLICT",current.reason!);
      for(const id of input.itemVersionIds){const [item]=await tx`SELECT * FROM opening_learning_item_versions WHERE id=${id} AND workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} AND activity_id=${input.activityId}`;
        if(!item||!(await readTeachingQuestionForGrading(tx,scope,item))?.referenceText.trim())throw learningError("VALIDATION","保存的题目缺少可核对的参考解答或判定标准。");}
      const verification={kind:"rubric",status:"ready",exerciseKeys:keys,rubric:requirement.verification.rubric,missingReasons:[]};
      await tx`UPDATE course_requirements SET verification=${tx.json(verification)},revision=revision+1,approved_at=now(),updated_at=now()
        WHERE id=${requirement.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      return readOpeningCourseRoute(tx,scope,courseId);
    });
  }};}
