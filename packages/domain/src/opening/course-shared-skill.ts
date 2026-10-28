import type { CourseRequirement } from "@aistudy/contracts";
import type { CourseRouteObservation } from "./course-route";
export type CourseEvidenceLink={id:string;sourceRequirementId:string;sourceRequirementRevision:number;targetRequirementId:string;targetRequirementRevision:number;stableSkillId:string;active:boolean};
const normalized=(text:string|null)=>text?.normalize("NFKC").replace(/\s+/gu," ").trim()??null;
/** Explicit identity is necessary; equal names or exercise IDs never prove compatibility. */
export function courseRequirementsShareCompatible(source:CourseRequirement,target:CourseRequirement){
 const a=source.evidenceConditions,b=target.evidenceConditions;
 return source.courseId!==target.courseId&&source.stableSkillId===target.stableSkillId&&source.lifecycle==="active"&&target.lifecycle==="active"
  &&source.approvedAt!==null&&target.approvedAt!==null&&!!a&&!!b&&a.responseFormat===b.responseFormat&&a.timeLimitSeconds===b.timeLimitSeconds&&a.assistance===b.assistance
  &&source.verification.status==="ready"&&target.verification.status==="ready"&&source.verification.kind===target.verification.kind
  &&source.verification.kind!=="unavailable"&&!!normalized(source.verification.rubric)&&normalized(source.verification.rubric)===normalized(target.verification.rubric);
}
export function projectSharedCourseEvidence(input:{source:CourseRequirement;target:CourseRequirement;link:CourseEvidenceLink;observations:readonly CourseRouteObservation[]}):CourseRouteObservation[]{
 const {source,target,link}=input;
 if(!link.active||link.sourceRequirementId!==source.id||link.targetRequirementId!==target.id||link.sourceRequirementRevision!==source.revision
  ||link.targetRequirementRevision!==target.revision||link.stableSkillId!==source.stableSkillId||!courseRequirementsShareCompatible(source,target))return [];
 const bound=input.observations.filter(row=>!row.sharedFor?.length&&row.courseRequirement?.id===source.id&&row.courseRequirement.revision===source.revision
  &&row.courseRequirement.stableSkillId===source.stableSkillId&&row.courseRequirement.requirementKey===source.requirementKey).sort((a,b)=>Date.parse(b.attemptedAt)-Date.parse(a.attemptedAt)||b.id.localeCompare(a.id));
 const eligible=(row:CourseRouteObservation)=>row.verifiedCorrect==="yes"&&row.independentAttempt==="yes"&&row.assistance==="independent"&&row.usableForCurrentVersion==="yes"
  &&row.firstQuestionExposure===true&&!!row.questionIdentity&&row.evidenceContext?.responseFormat===source.evidenceConditions!.responseFormat
  &&(source.evidenceConditions!.timeLimitSeconds===null||row.evidenceContext.elapsedSeconds!==null&&row.evidenceContext.elapsedSeconds>=0&&row.evidenceContext.elapsedSeconds<=source.evidenceConditions!.timeLimitSeconds);
 if(!bound[0]||!eligible(bound[0]))return [];
 return bound.filter(eligible).map(row=>({...row,sharedFor:[{linkId:link.id,requirementId:target.id,requirementRevision:target.revision,stableSkillId:target.stableSkillId,sourceCourseId:source.courseId,sourceRequirementId:source.id}]}));
}
