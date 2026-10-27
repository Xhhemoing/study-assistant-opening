import type { CourseRequirement,Scope } from "@aistudy/contracts";
import { courseRequirementsShareCompatible,projectSharedCourseEvidence,type CourseRouteObservation,type CourseRouteSourceChunk } from "@aistudy/domain";
import type { Sql,TransactionSql } from "postgres";
export type CourseSharedSkillReaders={requirements:(courseId:string)=>Promise<CourseRequirement[]>;observations:(courseId:string)=>Promise<{projected:CourseRouteObservation[]}>;sources:(courseId:string)=>Promise<{sourceId:string;sourceVersion:number;available:boolean}[]>;chunks:(courseId:string)=>Promise<CourseRouteSourceChunk[]>};
export async function readSharedCourseEvidence(db:Sql|TransactionSql,scope:Scope,courseId:string,readers:CourseSharedSkillReaders){
 const links=await db`SELECT l.* FROM course_requirement_evidence_links l JOIN course_requirements t ON t.id=l.target_requirement_id AND t.workspace_id=l.workspace_id AND t.owner_user_id=l.owner_user_id
   JOIN course_requirements s ON s.id=l.source_requirement_id AND s.workspace_id=l.workspace_id AND s.owner_user_id=l.owner_user_id
   JOIN courses c ON c.id=s.course_id AND c.workspace_id=s.workspace_id AND c.archived_at IS NULL
   WHERE l.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId} AND t.course_id=${courseId} AND l.active=true`;
 const targets=await readers.requirements(courseId),result:CourseRouteObservation[]=[];
 for(const row of links){
  const [sourceRow]=await db`SELECT course_id FROM course_requirements WHERE id=${row.source_requirement_id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if(!sourceRow)continue;const sourceCourseId=String(sourceRow.course_id),target=targets.find(item=>item.id===row.target_requirement_id),source=(await readers.requirements(sourceCourseId)).find(item=>item.id===row.source_requirement_id);
  if(!target||!source||!courseRequirementsShareCompatible(source,target))continue;
  const materials=await readers.sources(sourceCourseId),chunks=await readers.chunks(sourceCourseId);
  if(!source.sourceRefs.length||!source.sourceRefs.every(ref=>materials.some(item=>item.sourceId===ref.sourceId&&item.sourceVersion===ref.sourceVersion&&item.available)&&chunks.some(chunk=>chunk.sourceId===ref.sourceId&&chunk.sourceVersion===ref.sourceVersion&&(!ref.chunkId||chunk.id===ref.chunkId)&&(!ref.page||chunk.page===ref.page))))continue;
  result.push(...projectSharedCourseEvidence({source,target,link:{id:String(row.id),sourceRequirementId:String(row.source_requirement_id),sourceRequirementRevision:Number(row.source_requirement_revision),targetRequirementId:String(row.target_requirement_id),targetRequirementRevision:Number(row.target_requirement_revision),stableSkillId:String(row.stable_skill_id),active:row.active===true},observations:(await readers.observations(sourceCourseId)).projected}));
 }
 return result;
}
