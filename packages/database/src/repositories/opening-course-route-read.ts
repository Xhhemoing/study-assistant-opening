import { courseRequirementSchema, courseRouteActivityContextSchema, knowledgeSnapshotSchema, type CourseRequirement, type CourseRouteRequirementInput, type CourseRouteSnapshot, type Scope } from "@aistudy/contracts";
import { courseRequirementProgress, toSnapshotEvidence } from "@aistudy/domain";
import type { Sql,TransactionSql } from "postgres";
import { learningError, learningIso, mapLearningObservation } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { mapTeachingActivity } from "./opening-teaching-activities";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { courseRouteDelayedProtocolSchema,readOpeningCourseRouteRetestOutcome } from "./opening-course-route-retest-state";
import type { CourseRouteObservation,CourseRouteSourceChunk } from "@aistudy/domain";
import { readSharedCourseEvidence } from "./opening-course-shared-skill-projection";
const bindingSchema=z.object({id:z.string().uuid(),revision:z.number().int().positive(),stableSkillId:z.string().uuid(),requirementKey:z.string()}).strict();
export type CourseRouteDb=Sql|TransactionSql;
export async function assertCourseRouteCourse(db:CourseRouteDb,scope:Scope,courseId:string){
  const [row]=await db`SELECT c.id FROM courses c JOIN workspaces w ON w.id=c.workspace_id AND w.owner_user_id=${scope.ownerUserId}
    WHERE c.id=${courseId} AND c.workspace_id=${scope.workspaceId} AND c.archived_at IS NULL`;
  if(!row)throw learningError("NOT_FOUND","课程不存在或已归档。");
}
export function mapCourseRequirement(row:Record<string,unknown>):CourseRequirement{
  return courseRequirementSchema.parse({id:row.id,courseId:row.course_id,stableSkillId:row.stable_skill_id,knowledgeNodeId:row.knowledge_node_id,
    requirementKey:row.requirement_key,title:row.title,position:Number(row.position),mandatory:row.mandatory,goalIds:row.goal_ids,
    prerequisiteIds:row.prerequisite_ids,sourceRefs:row.source_refs,verification:row.verification,revision:Number(row.revision),
    lifecycle:row.lifecycle,origin:row.origin,approvedAt:learningIso(row.approved_at),...(row.evidence_conditions?{evidenceConditions:row.evidence_conditions}:{})});
}
export async function readCourseRequirements(db:CourseRouteDb,scope:Scope,courseId:string){
  return (await db`SELECT * FROM course_requirements WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND course_id=${courseId} AND lifecycle='active' ORDER BY position,id`).map(mapCourseRequirement);
}
export async function readCourseRouteObservations(db:CourseRouteDb,scope:Scope,courseId:string,includeShared=true){
  const rows=await db`SELECT o.*,s.activity_id AS route_activity_id,v.evaluation_spec,a.goal_json AS route_goal FROM opening_learning_observations o
    JOIN opening_learning_sessions s ON s.id=o.session_id AND s.workspace_id=o.workspace_id AND s.owner_user_id=o.owner_user_id
    LEFT JOIN opening_learning_item_versions v ON v.id=o.item_version_id AND v.workspace_id=o.workspace_id AND v.owner_user_id=o.owner_user_id
    LEFT JOIN opening_teaching_activities a ON a.id=s.activity_id AND a.workspace_id=s.workspace_id AND a.owner_user_id=s.owner_user_id
    JOIN opening_learning_observations root
    ON root.id=COALESCE(o.root_observation_id,o.id) AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
      AND COALESCE(root.effective_head_id,root.id)=o.id
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND o.course_id=${courseId}
      AND COALESCE(o.revision_kind,'original')<>'retract' ORDER BY o.occurred_at DESC,o.id DESC`;
  const observations=rows.map(row=>({...mapLearningObservation(row),activityId:String(row.route_activity_id)}));
  const evidenceContexts=await readOpeningLearningEvidenceContexts(db,scope,observations);
  const history=await db`SELECT a.id,a.started_at,a.submitted_at,v.stem_snapshot,v.teaching_block_id,r.blocks FROM opening_learning_attempts a JOIN opening_learning_item_versions v ON v.id=a.item_version_id
    AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id LEFT JOIN library_revisions r ON r.id=v.teaching_revision_id AND r.workspace_id=v.workspace_id WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
    ORDER BY a.started_at,a.id`;
  const identity=(stem:unknown)=>typeof stem==="string"&&stem.trim()?stem.normalize("NFKC").replace(/\s+/gu," ").trim():null;
  const first=new Map<string,string>();for(const row of history){const key=identity(row.stem_snapshot);if(key&&!first.has(key))first.set(key,String(row.id));}
  const projected:CourseRouteObservation[]=toSnapshotEvidence({observations,evidenceContexts},new Date()).observations.map(observation=>{
    const row=rows.find(row=>String(row.id)===observation.id)!,binding=bindingSchema.safeParse((row.evaluation_spec as {courseRequirement?:unknown}|null)?.courseRequirement);
    const actual=history.find(item=>String(item.id)===row.attempt_id),questionIdentity=identity(actual?.stem_snapshot);
    const block=(actual?.blocks as {id:string;content?:{interaction?:{kind?:string}}}[]|undefined)?.find(block=>block.id===actual?.teaching_block_id);
    const format=block?.content?.interaction?.kind,responseFormat:"numeric"|"choice"|"text"=format==="numeric"||format==="choice"?format:"text";
    const elapsedSeconds=actual?.started_at&&actual.submitted_at?(new Date(actual.submitted_at as Date).getTime()-new Date(actual.started_at as Date).getTime())/1000:null;
    return {...observation,activityId:String(row.route_activity_id),routeAction:(row.route_goal as {courseRoute?:{action?:string}}|null)?.courseRoute?.action,
      comprehensiveRunKey:(row.route_goal as {courseRoute?:{comprehensiveRunKey?:string}}|null)?.courseRoute?.comprehensiveRunKey,
      ...(block?{evidenceContext:{responseFormat,elapsedSeconds}}:{}),questionIdentity,firstQuestionExposure:questionIdentity!==null&&first.get(questionIdentity)===row.attempt_id,
      ...(binding.success?{courseRequirement:binding.data}:{})};
  });
  if(includeShared)projected.push(...await readSharedCourseEvidence(db,scope,courseId,{requirements:id=>readCourseRequirements(db,scope,id),observations:id=>readCourseRouteObservations(db,scope,id,false),sources:id=>readCourseRouteMaterials(db,scope,id),chunks:id=>readCourseRouteSourceChunks(db,scope,id)}));
  return {raw:observations,projected};
}
export async function readCourseRouteSourceChunks(db:CourseRouteDb,scope:Scope,courseId:string):Promise<CourseRouteSourceChunk[]>{
  const rows=await db`SELECT ch.id,ch.source_id,ch.source_version,ch.page FROM opening_source_chunks ch JOIN opening_sources s
    ON s.id=ch.source_id AND s.workspace_id=${scope.workspaceId} AND s.version=ch.source_version
    JOIN course_asset_memberships m ON m.asset_id=s.id AND m.workspace_id=s.workspace_id AND m.asset_type='source' AND m.course_id=${courseId}
    WHERE s.upload_state='uploaded' AND s.parse_state='ready' AND (length(btrim(ch.text))>0 OR ch.image_object_key IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)`;
  return rows.map(row=>({id:String(row.id),sourceId:String(row.source_id),sourceVersion:Number(row.source_version),page:row.page==null?null:Number(row.page)}));
}
export async function readCourseRouteMaterials(db:CourseRouteDb,scope:Scope,courseId:string){
  const rows=await db`SELECT s.id,s.version,s.name,s.upload_state,s.parse_state,
    NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id) AS included
    FROM course_asset_memberships m JOIN opening_sources s ON s.id=m.asset_id AND s.workspace_id=m.workspace_id
    WHERE m.workspace_id=${scope.workspaceId} AND m.course_id=${courseId} AND m.asset_type='source' ORDER BY m.sort_order,s.id`;
  return rows.map(row=>({sourceId:String(row.id),sourceVersion:Number(row.version),
    title:String(row.name),
    available:row.upload_state==="uploaded"&&row.parse_state==="ready"&&row.included===true}));
}
async function suggestions(db:CourseRouteDb,scope:Scope,courseId:string,requirements:CourseRequirement[]):Promise<CourseRouteRequirementInput[]>{
  const [row]=await db`SELECT snapshot FROM opening_course_knowledge WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
  if(!row)return [];
  const graph=knowledgeSnapshotSchema.parse(row.snapshot);
  const nodes=graph.nodes.filter(node=>node.status==="supported"&&node.kind!=="chapter"&&!requirements.some(item=>item.knowledgeNodeId===node.id));
  const chunks=await db`SELECT ch.id,ch.source_id,ch.source_version,ch.page FROM opening_source_chunks ch
    JOIN opening_sources s ON s.id=ch.source_id AND s.version=ch.source_version AND s.workspace_id=${scope.workspaceId}
    JOIN course_asset_memberships m ON m.workspace_id=s.workspace_id AND m.asset_id=s.id AND m.asset_type='source' AND m.course_id=${courseId}
    WHERE s.upload_state='uploaded' AND s.parse_state='ready' AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)`;
  const identities=new Map(nodes.map(node=>[node.id,{id:randomUUID(),skillId:randomUUID()}]));
  return nodes.map((node,position)=>({id:identities.get(node.id)!.id,stableSkillId:identities.get(node.id)!.skillId,knowledgeNodeId:node.id,requirementKey:`knowledge:${node.id}`,title:node.label.slice(0,200),
    position:requirements.length+position,mandatory:true,goalIds:[],prerequisiteIds:graph.edges.filter(edge=>edge.kind==="prerequisite"&&edge.status==="supported"&&edge.to===node.id)
      .map(edge=>requirements.find(item=>item.knowledgeNodeId===edge.from)?.id??identities.get(edge.from)?.id).filter((id):id is string=>!!id),
    sourceRefs:chunks.filter(chunk=>node.evidenceChunkIds.includes(String(chunk.id))).map(chunk=>({sourceId:String(chunk.source_id),sourceVersion:Number(chunk.source_version),chunkId:String(chunk.id),...(chunk.page?{page:Number(chunk.page)}:{})})),
    verification:{kind:"unavailable",status:"missing",exerciseKeys:[],rubric:null,missingReasons:["尚未确认本要求的题目与判定标准"]},origin:"extracted"}));
}
export async function readOpeningCourseRoute(db:CourseRouteDb,scope:Scope,courseId:string,activityId?:string):Promise<CourseRouteSnapshot>{
  await assertCourseRouteCourse(db,scope,courseId);
  const requirements=await readCourseRequirements(db,scope,courseId),materials=await readCourseRouteMaterials(db,scope,courseId);
  const observations=await readCourseRouteObservations(db,scope,courseId);
  const progress=courseRequirementProgress(requirements,observations.projected,new Map(materials.filter(row=>row.available).map(row=>[row.sourceId,row.sourceVersion])),await readCourseRouteSourceChunks(db,scope,courseId));
  const retests=await db`SELECT id,task_id,learning_protocol,not_before_at FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} AND learning_protocol->>'protocolId'='course-route-delayed-v1' ORDER BY created_at DESC,id DESC`;
  for(const item of progress){
    const retest=retests.find(row=>{const protocol=courseRouteDelayedProtocolSchema.safeParse(row.learning_protocol);return protocol.success&&protocol.data.requirementId===item.requirement.id
      &&protocol.data.requirementRevision===item.requirement.revision&&protocol.data.stableSkillId===item.requirement.stableSkillId;});
    const head=retest?observations.raw.filter(row=>row.retestId===String(retest.id)).sort((a,b)=>Date.parse(b.submittedAt??b.occurredAt)-Date.parse(a.submittedAt??a.occurredAt)||b.id.localeCompare(a.id))[0]:null;
    item.delayedCheck=retest?{status:await readOpeningCourseRouteRetestOutcome(db,scope,String(retest.id),observations.projected.find(row=>row.id===head?.id)??null),
      retestId:String(retest.id),taskId:retest.task_id?String(retest.task_id):null,notBeforeAt:learningIso(retest.not_before_at)}:{status:"not_scheduled",retestId:null,taskId:null,notBeforeAt:null};
  }
  const [current]=await db`SELECT * FROM opening_teaching_activities a WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND course_id=${courseId} AND (${activityId??null}::uuid IS NULL AND status IN ('active','paused') OR id=${activityId??null}::uuid)
    AND (${activityId??null}::uuid IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM opening_learning_observations o JOIN opening_learning_observations root
        ON root.id=COALESCE(o.root_observation_id,o.id) AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
      WHERE o.id::text=a.goal_json->'courseRoute'->>'originObservationId'
        AND o.workspace_id=a.workspace_id AND o.owner_user_id=a.owner_user_id AND COALESCE(root.effective_head_id,root.id)<>o.id))
    AND goal_json ? 'courseRoute' ORDER BY updated_at DESC,id DESC LIMIT 1`;
  if(activityId&&!current)throw learningError("NOT_FOUND","本课程路线活动不存在。");
  const currentRoute=current?courseRouteActivityContextSchema.parse((current.goal_json as {courseRoute:unknown}).courseRoute):null;
  const currentHead=current?observations.raw.filter(row=>row.activityId===String(current.id))
    .sort((a,b)=>Date.parse(b.submittedAt??b.occurredAt)-Date.parse(a.submittedAt??a.occurredAt)||b.id.localeCompare(a.id))[0]:null;
  return {courseId,scopeState:!requirements.length?"missing":requirements.every(row=>row.approvedAt!==null)?"confirmed":"unconfirmed",requirements:progress,
    suggestions:await suggestions(db,scope,courseId,requirements),materials,currentActivity:current?mapTeachingActivity(current):null,currentRoute,observationId:currentHead?.id??null,
    summary:{total:progress.length,mandatory:progress.filter(row=>row.requirement.mandatory).length,
      verified:progress.filter(row=>row.status==="verified").length,blocked:progress.filter(row=>row.status==="blocked").length}};
}
