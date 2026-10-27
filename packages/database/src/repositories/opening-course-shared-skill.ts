import { courseSharedSkillCommandSchema,type CourseSharedSkillCommand,type CourseSharedSkillRead,type Scope } from "@aistudy/contracts";
import { courseRequirementsShareCompatible } from "@aistudy/domain";
import type { Sql,TransactionSql } from "postgres";
import { learningError,lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { readLearningGoals } from "./opening-learning-goals";
import { assertCourseRouteCourse,readCourseRequirements,readCourseRouteObservations,readCourseRouteMaterials,readCourseRouteSourceChunks } from "./opening-course-route-read";
import { courseRequirementSourcesAvailable } from "@aistudy/domain";
async function available(tx:TransactionSql,scope:Scope,courseId:string,requirement:Awaited<ReturnType<typeof readCourseRequirements>>[number]){
 const materials=await readCourseRouteMaterials(tx,scope,courseId);
 return courseRequirementSourcesAvailable(requirement,new Map(materials.filter(row=>row.available).map(row=>[row.sourceId,row.sourceVersion])),await readCourseRouteSourceChunks(tx,scope,courseId));
}
async function read(tx:TransactionSql,scope:Scope,courseId:string):Promise<CourseSharedSkillRead>{
 await assertCourseRouteCourse(tx,scope,courseId);
 const courses=await tx`SELECT c.id,c.title FROM courses c JOIN workspaces w ON w.id=c.workspace_id AND w.owner_user_id=${scope.ownerUserId} WHERE c.workspace_id=${scope.workspaceId} AND c.archived_at IS NULL ORDER BY c.title,c.id`;
 const goals=await readLearningGoals(tx,scope),requirements:CourseSharedSkillRead["requirements"]=[],candidates:CourseSharedSkillRead["candidates"]=[];
 for(const course of courses){const rows=await readCourseRequirements(tx,scope,String(course.id));
  for(const requirement of rows){const choice={requirement,courseTitle:String(course.title),goals:goals.filter(goal=>goal.courseIds.includes(requirement.courseId)&&(!requirement.goalIds.length||requirement.goalIds.includes(goal.id))).map(goal=>({id:goal.id,title:goal.title}))};
   (String(course.id)===courseId?requirements:candidates).push(choice);}}
 const evidence=(await readCourseRouteObservations(tx,scope,courseId)).projected;
 const links=await tx`SELECT l.* FROM course_requirement_evidence_links l JOIN course_requirements r ON r.id=l.target_requirement_id AND r.workspace_id=l.workspace_id AND r.owner_user_id=l.owner_user_id
  WHERE l.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId} AND r.course_id=${courseId} ORDER BY l.created_at,l.id`;
 return {courseId,requirements,candidates,links:links.map(row=>{const observationIds=[...new Set(evidence.filter(item=>item.sharedFor?.some(ref=>ref.linkId===row.id)).map(item=>item.id))];
  return {id:String(row.id),sourceRequirementId:String(row.source_requirement_id),sourceRequirementRevision:Number(row.source_requirement_revision),targetRequirementId:String(row.target_requirement_id),targetRequirementRevision:Number(row.target_requirement_revision),stableSkillId:String(row.stable_skill_id),revision:Number(row.revision),active:row.active===true,effective:observationIds.length>0,observationIds,
   reason:row.active!==true?"此映射已停止，历史记录保留。":observationIds.length?null:"当前没有兼容的独立有效证据；版本、材料或评价变化后须重新核对。"};})};
}
export function createOpeningCourseSharedSkillRepository(sql:Sql){return {
 read:(scope:Scope,courseId:string)=>sql.begin("isolation level repeatable read read only",tx=>read(tx,scope,courseId)),
 async command(scope:Scope,courseId:string,raw:CourseSharedSkillCommand){const input=courseSharedSkillCommandSchema.parse(raw);return sql.begin(async tx=>{
  await lockWorkspaceLearningHistory(tx,scope);
  const [workspace]=await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if(!workspace)throw learningError("NOT_FOUND","工作区不可用。");await assertCourseRouteCourse(tx,scope,courseId);
  if(input.action==="unlink"){
   const [link]=await tx`SELECT l.* FROM course_requirement_evidence_links l JOIN course_requirements t ON t.id=l.target_requirement_id AND t.workspace_id=l.workspace_id AND t.owner_user_id=l.owner_user_id
    WHERE l.id=${input.linkId} AND l.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId} AND t.course_id=${courseId} FOR UPDATE OF l`;
   if(!link)throw learningError("NOT_FOUND","共享映射不存在。");
   if(link.active===false&&Number(link.revision)===input.expectedRevision+1)return read(tx,scope,courseId);
   if(Number(link.revision)!==input.expectedRevision)throw learningError("CONFLICT","映射已变化，请重新读取。");
   await tx`UPDATE course_requirement_evidence_links SET active=false,revision=revision+1,updated_at=now() WHERE id=${input.linkId}`;
   return read(tx,scope,courseId);
  }
  const rows=await tx`SELECT r.id,r.course_id FROM course_requirements r JOIN courses c ON c.id=r.course_id AND c.workspace_id=r.workspace_id AND c.archived_at IS NULL
   WHERE r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId} AND r.id IN (${input.sourceRequirementId},${input.targetRequirementId}) AND r.lifecycle='active' ORDER BY r.id FOR UPDATE OF r FOR SHARE OF c`;
  const sourceRow=rows.find(row=>row.id===input.sourceRequirementId),targetRow=rows.find(row=>row.id===input.targetRequirementId);
  if(!sourceRow||!targetRow||targetRow.course_id!==courseId)throw learningError("NOT_FOUND","本工作区的课程要求不存在。");
  if(sourceRow.course_id===targetRow.course_id)throw learningError("VALIDATION","请选择另一门课程中的真实要求。");
  const source=(await readCourseRequirements(tx,scope,String(sourceRow.course_id))).find(row=>row.id===input.sourceRequirementId)!;
  const target=(await readCourseRequirements(tx,scope,courseId)).find(row=>row.id===input.targetRequirementId)!;
  const [previous]=await tx`SELECT * FROM course_requirement_evidence_links WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
   AND source_requirement_id=${source.id} AND target_requirement_id=${target.id} FOR UPDATE`;
  // Same command after a lost response is a read receipt, never a second identity change.
  if(previous?.active===true&&Number(previous.revision)===input.expectedLinkRevision+1&&Number(previous.source_requirement_revision)===input.expectedSourceRevision
   &&Number(previous.target_requirement_revision)===input.expectedTargetRevision+1&&source.revision===input.expectedSourceRevision&&target.revision===input.expectedTargetRevision+1)return read(tx,scope,courseId);
  if(source.revision!==input.expectedSourceRevision||target.revision!==input.expectedTargetRevision||Number(previous?.revision??0)!==input.expectedLinkRevision)throw learningError("CONFLICT","要求或映射版本已变化，请重新核对两门课程。");
  if(!courseRequirementsShareCompatible(source,{...target,stableSkillId:source.stableSkillId})||!await available(tx,scope,source.courseId,source)||!await available(tx,scope,courseId,target))throw learningError("CONFLICT","两项要求的当前标准、题型、时限、独立条件或材料不兼容；不会借用成绩。");
  if((await readCourseRequirements(tx,scope,courseId)).some(row=>row.id!==target.id&&row.stableSkillId===source.stableSkillId))throw learningError("CONFLICT","本课程已有该稳定技能，请先核对完整范围，避免重复要求。");
  await tx`UPDATE course_requirements SET stable_skill_id=${source.stableSkillId},revision=revision+1,updated_at=now() WHERE id=${target.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if(previous)await tx`UPDATE course_requirement_evidence_links SET source_requirement_revision=${source.revision},target_requirement_revision=${target.revision+1},stable_skill_id=${source.stableSkillId},active=true,revision=revision+1,updated_at=now() WHERE id=${previous.id}`;
  else await tx`INSERT INTO course_requirement_evidence_links(workspace_id,owner_user_id,source_requirement_id,source_requirement_revision,target_requirement_id,target_requirement_revision,stable_skill_id)
   VALUES(${scope.workspaceId},${scope.ownerUserId},${source.id},${source.revision},${target.id},${target.revision+1},${source.stableSkillId})`;
  return read(tx,scope,courseId);
 });}
};}
