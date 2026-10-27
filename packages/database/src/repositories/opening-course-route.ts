import { isDeepStrictEqual } from "node:util";
import { courseRouteConfirmSchema, type CourseRouteConfirm, type Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { assertCourseRouteCourse, readCourseRequirements, readOpeningCourseRoute } from "./opening-course-route-read";
import { readLearningGoal } from "./opening-learning-goals";
import { createOpeningCourseRouteActions } from "./opening-course-route-actions";
export { readOpeningCourseRoute } from "./opening-course-route-read";

export function createOpeningCourseRouteRepository(sql:Sql,options:{compilerEnabled:boolean}){
  return {read:(scope:Scope,courseId:string,activityId?:string)=>readOpeningCourseRoute(sql,scope,courseId,activityId),
    ...createOpeningCourseRouteActions(sql,options),
    async confirm(scope:Scope,courseId:string,raw:CourseRouteConfirm){
      const input=courseRouteConfirmSchema.parse(raw);
      return sql.begin(async tx=>{
        await lockWorkspaceLearningHistory(tx,scope);
        await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        await assertCourseRouteCourse(tx,scope,courseId);
        const current=await readCourseRequirements(tx,scope,courseId);
        const definitions=current.map(({courseId:_courseId,revision:_revision,lifecycle:_lifecycle,approvedAt:_approvedAt,...definition})=>definition);
        // An unknown response can replay the same full definition without raising revisions.
        if(current.every(row=>row.approvedAt!==null)&&isDeepStrictEqual(definitions,input.requirements))return readOpeningCourseRoute(tx,scope,courseId);
        if(current.length!==input.expectedRevisions.length||current.some(row=>!input.expectedRevisions.some(expected=>expected.id===row.id&&expected.revision===row.revision)))
          throw learningError("CONFLICT","课程要求已修改，请重新读取完整范围后确认。");
        for(const requirement of input.requirements){
          const previous=current.find(row=>row.id===requirement.id);
          if(previous){const {courseId:_course,revision:_revision,lifecycle:_lifecycle,approvedAt:_approved,...definition}=previous;
            if(previous.approvedAt!==null&&isDeepStrictEqual(definition,requirement))continue;}
          if(previous&&(previous.requirementKey!==requirement.requirementKey||previous.stableSkillId!==requirement.stableSkillId||previous.knowledgeNodeId!==requirement.knowledgeNodeId))
            throw learningError("CONFLICT","已有要求的技能身份不能随编辑改写；请新增要求并明确调整课程范围。");
          for(const goalId of requirement.goalIds){const goal=await readLearningGoal(tx,scope,goalId);
            if(!goal?.courseIds.includes(courseId))throw learningError("VALIDATION","要求关联的目标不属于本课程。");}
          for(const ref of requirement.sourceRefs){
            const [source]=await tx`SELECT s.id,s.version FROM course_asset_memberships m JOIN opening_sources s ON s.id=m.asset_id AND s.workspace_id=m.workspace_id
              WHERE m.workspace_id=${scope.workspaceId} AND m.course_id=${courseId} AND m.asset_type='source' AND s.id=${ref.sourceId}`;
            if(!source||Number(source.version)<ref.sourceVersion)throw learningError("VALIDATION","要求引用的材料不属于本课程或版本不存在。");
            if(ref.chunkId){const [chunk]=await tx`SELECT id FROM opening_source_chunks WHERE id=${ref.chunkId} AND source_id=${ref.sourceId} AND source_version=${ref.sourceVersion}`;
              if(!chunk&&!previous?.sourceRefs.some(old=>isDeepStrictEqual(old,ref)))throw learningError("VALIDATION","要求引用的材料片段不存在。");}
          }
          if(requirement.knowledgeNodeId){
            const [node]=await tx`SELECT 1 FROM opening_course_knowledge k CROSS JOIN LATERAL jsonb_array_elements(k.snapshot->'nodes') n
              WHERE k.workspace_id=${scope.workspaceId} AND k.owner_user_id=${scope.ownerUserId} AND k.course_id=${courseId} AND n->>'id'=${requirement.knowledgeNodeId}`;
            if(!node&&!previous)throw learningError("VALIDATION","要求引用的知识节点不存在。");
          }
          if(previous)await tx`UPDATE course_requirements SET title=${requirement.title},position=${requirement.position},mandatory=${requirement.mandatory},goal_ids=${requirement.goalIds},
            prerequisite_ids=${requirement.prerequisiteIds},source_refs=${tx.json(requirement.sourceRefs)},verification=${tx.json(requirement.verification)},evidence_conditions=${requirement.evidenceConditions?tx.json(requirement.evidenceConditions):null},origin=${requirement.origin},
            revision=revision+1,approved_at=now(),updated_at=now() WHERE workspace_id=${scope.workspaceId} AND id=${requirement.id} AND owner_user_id=${scope.ownerUserId}`;
          else await tx`INSERT INTO course_requirements(id,workspace_id,owner_user_id,course_id,stable_skill_id,knowledge_node_id,requirement_key,title,position,mandatory,
            goal_ids,prerequisite_ids,source_refs,verification,evidence_conditions,origin,approved_at)
            VALUES(${requirement.id},${scope.workspaceId},${scope.ownerUserId},${courseId},${requirement.stableSkillId},${requirement.knowledgeNodeId},${requirement.requirementKey},
              ${requirement.title},${requirement.position},${requirement.mandatory},${requirement.goalIds},${requirement.prerequisiteIds},${tx.json(requirement.sourceRefs)},${tx.json(requirement.verification)},${requirement.evidenceConditions?tx.json(requirement.evidenceConditions):null},${requirement.origin},now())`;
        }
        const ids=input.requirements.map(row=>row.id);
        await tx`UPDATE course_requirements SET lifecycle='archived',revision=revision+1,updated_at=now() WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} AND lifecycle='active' AND NOT(id=ANY(${ids}::uuid[]))`;
        return readOpeningCourseRoute(tx,scope,courseId);
      });
    }};
}
