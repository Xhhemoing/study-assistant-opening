import { isDeepStrictEqual } from "node:util";
import { courseRouteConfirmSchema, type CourseRouteConfirm, type Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { admitLearningSources, learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { assertCourseRouteCourse, readCourseRequirements, readCourseRouteMaterials, readCourseRouteSourceChunks, readOpeningCourseRoute } from "./opening-course-route-read";
import { decideCourseRouteVerification, readConfirmedCourseSpanExerciseKeys, resolveCourseSpanExerciseKeys } from "./opening-course-route-verification-policy";
import { readLearningGoal } from "./opening-learning-goals";
import { createOpeningCourseRouteActions } from "./opening-course-route-actions";
export { readOpeningCourseRoute } from "./opening-course-route-read";

export function createOpeningCourseRouteRepository(sql:Sql,options:{compilerEnabled:boolean;exactVerificationEnabled?:boolean}){
  return {read:(scope:Scope,courseId:string,activityId?:string)=>readOpeningCourseRoute(sql,scope,courseId,activityId,options.exactVerificationEnabled),
    ...createOpeningCourseRouteActions(sql,options),
    async confirm(scope:Scope,courseId:string,raw:CourseRouteConfirm){
      const input=courseRouteConfirmSchema.parse(raw);
      return sql.begin(async tx=>{
        await lockWorkspaceLearningHistory(tx,scope);
        await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        await assertCourseRouteCourse(tx,scope,courseId);
        const current=await readCourseRequirements(tx,scope,courseId);
        const spanSets = new Map<string, string[]>();
        for (const requirement of input.requirements) {
          const explicit = input.spanBindings?.find(binding => binding.requirementId === requirement.id);
          const previous = current.find(row => row.id === requirement.id);
          if (explicit) {
            if (!options.exactVerificationEnabled || requirement.requirementKey !== SPAN_REQUIREMENT_KEY || requirement.verification.kind !== "exact")
              throw learningError("VALIDATION", "仅已开启的 canonical span exact 要求可显式确认内容绑定。");
            spanSets.set(requirement.id, resolveCourseSpanExerciseKeys(explicit.exerciseKeys));
          } else if (previous?.approvedAt && options.exactVerificationEnabled) {
            const { courseId: _course, revision: _revision, lifecycle: _lifecycle, approvedAt: _approved, ...definition } = previous;
            const keys = readConfirmedCourseSpanExerciseKeys(previous.requirementKey, previous.verification);
            if (keys && isDeepStrictEqual({ ...definition, verification: requirement.verification }, requirement)
              && requirement.verification.kind === "exact" && requirement.verification.rubric === previous.verification.rubric)
              spanSets.set(requirement.id, keys);
          }
        }
        // History and owner locks precede source locks. Never authorize content from a stale pre-lock material probe.
        const boundRequirements = input.requirements.filter(requirement => spanSets.has(requirement.id));
        await admitLearningSources(tx, scope, boundRequirements.flatMap(requirement => requirement.sourceRefs.map(ref => ref.sourceId)), { recordVersions: false });
        const materials=await readCourseRouteMaterials(tx,scope,courseId);
        const chunks = boundRequirements.length ? await readCourseRouteSourceChunks(tx, scope, courseId) : [];
        const requirements=input.requirements.map(requirement=>{
          const previous=current.find(row=>row.id===requirement.id);
          const keys = spanSets.get(requirement.id);
          const sourcesAvailable = requirement.sourceRefs.length>0&&requirement.sourceRefs.every(ref=>materials.some(material=>material.sourceId===ref.sourceId&&material.sourceVersion===ref.sourceVersion&&material.available));
          if (keys && (!sourcesAvailable || requirement.sourceRefs.some(ref => !chunks.some(chunk => chunk.sourceId === ref.sourceId && chunk.sourceVersion === ref.sourceVersion
            && (!ref.chunkId || chunk.id === ref.chunkId) && (!ref.page || chunk.page === ref.page)))))
            throw Object.assign(learningError("CONFLICT", "span 内容绑定的来源、片段或页码已不可用。"), { reasonCode: "SPAN_PREREQUISITE_SOURCE_UNAVAILABLE" });
          // Only an approved row's verification counts as an existing requirement; submitted keys/status never confer authority.
          return { ...requirement, verification: keys ? { kind: "exact" as const, status: "ready" as const, exerciseKeys: keys, rubric: requirement.verification.rubric, missingReasons: [] }
            : decideCourseRouteVerification(requirement.verification,previous?.approvedAt!=null?previous.verification:null,sourcesAvailable,options.exactVerificationEnabled===true) };
        });
        const definitions=current.map(({courseId:_courseId,revision:_revision,lifecycle:_lifecycle,approvedAt:_approvedAt,...definition})=>definition);
        // An unknown response can replay the same full definition without raising revisions.
        if(current.every(row=>row.approvedAt!==null)&&isDeepStrictEqual(definitions,requirements))return readOpeningCourseRoute(tx,scope,courseId,undefined,options.exactVerificationEnabled);
        if(current.length!==input.expectedRevisions.length||current.some(row=>!input.expectedRevisions.some(expected=>expected.id===row.id&&expected.revision===row.revision)))
          throw learningError("CONFLICT","课程要求已修改，请重新读取完整范围后确认。");
        for(const requirement of requirements){
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
        const ids=requirements.map(row=>row.id);
        await tx`UPDATE course_requirements SET lifecycle='archived',revision=revision+1,updated_at=now() WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} AND lifecycle='active' AND NOT(id=ANY(${ids}::uuid[]))`;
        return readOpeningCourseRoute(tx,scope,courseId,undefined,options.exactVerificationEnabled);
      });
    }};
}
