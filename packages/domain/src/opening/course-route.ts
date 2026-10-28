import type { CourseRequirement, CourseRequirementProgress, LearningActivityKind } from "@aistudy/contracts";
import type { SnapshotObservation } from "./adaptive/snapshot-sources";
import { nextLearningStep } from "./adaptive/next-learning-step";

/** The manifest is the denominator. Source/context selection must never truncate it. */
export type CourseRouteObservation=SnapshotObservation&{courseRequirement?:{id:string;revision:number;stableSkillId:string;requirementKey:string};activityId?:string;routeAction?:string;comprehensiveRunKey?:string;questionIdentity?:string|null;firstQuestionExposure?:boolean;evidenceContext?:{responseFormat:"numeric"|"choice"|"text";elapsedSeconds:number|null};sharedFor?:{linkId:string;requirementId:string;requirementRevision:number;stableSkillId:string;sourceCourseId:string;sourceRequirementId:string}[]};
export type CourseRouteSourceChunk={id:string;sourceId:string;sourceVersion:number;page:number|null};
export function courseRequirementSourcesAvailable(requirement:CourseRequirement,sources:ReadonlyMap<string,number>,chunks?:readonly CourseRouteSourceChunk[]){
  return requirement.sourceRefs.length>0&&requirement.sourceRefs.every(ref=>sources.get(ref.sourceId)===ref.sourceVersion&&(!chunks||chunks.some(chunk=>chunk.sourceId===ref.sourceId
    &&chunk.sourceVersion===ref.sourceVersion&&(!ref.chunkId||chunk.id===ref.chunkId)&&(!ref.page||chunk.page===ref.page))));
}
export function courseRequirementProgress(requirements:readonly CourseRequirement[],observations:readonly CourseRouteObservation[],sources:ReadonlyMap<string,number>,chunks?:readonly CourseRouteSourceChunk[]):CourseRequirementProgress[]{
  return requirements.filter(row=>row.lifecycle==="active").map(requirement=>{
    let matching=observations.filter(row=>row.usableForCurrentVersion==="yes"&&((row.requirementKey===requirement.requirementKey
      &&row.courseRequirement?.id===requirement.id&&row.courseRequirement.revision===requirement.revision&&row.courseRequirement.stableSkillId===requirement.stableSkillId
      &&row.courseRequirement.requirementKey===requirement.requirementKey)||row.sharedFor?.some(ref=>ref.requirementId===requirement.id&&ref.requirementRevision===requirement.revision&&ref.stableSkillId===requirement.stableSkillId)))
      .sort((a,b)=>Date.parse(b.attemptedAt)-Date.parse(a.attemptedAt)||b.id.localeCompare(a.id));
    const local=matching.find(row=>!row.sharedFor?.length);
    if(local&&(local.verifiedCorrect!=="yes"||local.assistance!=="independent"))matching=matching.filter(row=>!row.sharedFor?.length);
    const latest=matching[0];
    const sourcesAvailable=courseRequirementSourcesAvailable(requirement,sources,chunks);
    const missingReasons=[...requirement.verification.missingReasons,...(!sourcesAvailable?["要求所引用的材料缺失、不可用或版本已变化"]:[])];
    let status:CourseRequirementProgress["status"]="unobserved";
    if(!sourcesAvailable) status="blocked";
    else if(latest?.verifiedCorrect==="no") status="needs_correction";
    else if(latest&&(latest.assistance==="hinted"||latest.assistance==="revealed"))status="assisted";
    else if(latest){
      const independent=matching.filter(row=>row.verifiedCorrect==="yes"&&row.independentAttempt==="yes"&&row.assistance==="independent"&&row.questionIdentity&&row.firstQuestionExposure===true);
      // Replays/regrades of the same item cannot supply a second check.
      const items=new Set(independent.map(row=>row.questionIdentity));
      status=latest.verifiedCorrect==="yes"&&items.size>=2&&requirement.verification.status==="ready"?"verified":"needs_verification";
    }
    const sharedEvidence=matching.flatMap(row=>(row.sharedFor??[]).filter(ref=>ref.requirementId===requirement.id).map(ref=>({linkId:ref.linkId,observationId:row.id,sourceCourseId:ref.sourceCourseId,sourceRequirementId:ref.sourceRequirementId,sourceActivityId:row.activityId??null,applicableGoalIds:requirement.goalIds})));
    return {requirement,status,observationId:latest?.id??null,missingReasons,sourcesAvailable,...(sharedEvidence.length?{sharedEvidence}:{})};
  });
}
export type CourseRouteStep={requirementId:string;action:LearningActivityKind|"prerequisite"|"return"|"comprehensive";returnTo?:string;focusObservationId:string|null};
export function selectCourseRouteStep(rows:readonly CourseRequirementProgress[],requestedId?:string):CourseRouteStep|null{
  const target=requestedId?rows.find(row=>row.requirement.id===requestedId):rows.find(row=>row.requirement.mandatory&&row.status!=="verified")??rows.find(row=>row.status!=="verified");
  if(!target)return null;
  // Only explicit course identities create a prerequisite detour; no label inference.
  const visited=new Set<string>();
  const weakPrerequisite=(row:CourseRequirementProgress):CourseRequirementProgress|undefined=>{
    if(visited.has(row.requirement.id))return undefined;visited.add(row.requirement.id);
    for(const id of row.requirement.prerequisiteIds){const prerequisite=rows.find(item=>item.requirement.id===id);
      if(prerequisite&&["needs_correction","assisted"].includes(prerequisite.status))return weakPrerequisite(prerequisite)??prerequisite;
    }return undefined;
  };
  const prerequisite=weakPrerequisite(target);
  if(prerequisite)return {requirementId:prerequisite.requirement.id,action:"prerequisite",returnTo:target.requirement.id,focusObservationId:prerequisite.observationId};
  const action:LearningActivityKind=target.status==="needs_correction"?"targeted_explain":target.status==="assisted"?"reduced_help_practice"
    :target.status==="needs_verification"||target.status==="verified"?"transfer_check":"diagnose";
  return {requirementId:target.requirement.id,action,focusObservationId:target.observationId};
}
/** The full observation context remains the existing adaptive policy's responsibility. */
export function courseRouteLearningDecision(observations:readonly SnapshotObservation[]){
  return nextLearningStep({observations,status:observations[0]?.verifiedCorrect==="yes"&&observations[0].independentAttempt==="yes"?"observed_independent":"unobserved",wantsFullExplanation:false});
}
export function remainingCourseComprehensiveRequirements(rows:readonly CourseRequirementProgress[],observations:readonly CourseRouteObservation[],runKey:string):string[]{
  return rows.filter(row=>row.requirement.mandatory).filter(row=>{
    const latest=observations.filter(observation=>observation.comprehensiveRunKey===runKey&&observation.routeAction==="comprehensive"
      &&observation.courseRequirement?.id===row.requirement.id&&observation.courseRequirement.revision===row.requirement.revision
      &&observation.courseRequirement.stableSkillId===row.requirement.stableSkillId&&observation.usableForCurrentVersion==="yes")
      .sort((a,b)=>Date.parse(b.attemptedAt)-Date.parse(a.attemptedAt)||b.id.localeCompare(a.id))[0];
    return !latest||latest.verifiedCorrect!=="yes"||latest.independentAttempt!=="yes"||latest.assistance!=="independent"||latest.firstQuestionExposure!==true;
  }).map(row=>row.requirement.id);
}
