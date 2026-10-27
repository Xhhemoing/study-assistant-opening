import { expect,it } from "vitest";
import type { CourseRequirement } from "@aistudy/contracts";
import { courseRequirementsShareCompatible,projectSharedCourseEvidence } from "./course-shared-skill";
import { courseRequirementProgress,type CourseRouteObservation } from "./course-route";
const requirement=(id:string):CourseRequirement=>({id,courseId:`course-${id}`,stableSkillId:"skill",knowledgeNodeId:null,requirementKey:id,title:id,position:0,mandatory:true,goalIds:[`goal-${id}`],prerequisiteIds:[],sourceRefs:[{sourceId:`source-${id}`,sourceVersion:1}],verification:{kind:"rubric",status:"ready",exerciseKeys:[id],rubric:"解释理由",missingReasons:[]},revision:1,lifecycle:"active",origin:"confirmed",approvedAt:"2026-10-27T00:00:00Z",evidenceConditions:{responseFormat:"numeric",timeLimitSeconds:120,assistance:"independent"}});
const source=requirement("a"),target=requirement("b");
const link={id:"link",sourceRequirementId:source.id,sourceRequirementRevision:1,targetRequirementId:target.id,targetRequirementRevision:1,stableSkillId:"skill",active:true};
const observation=(id:string):CourseRouteObservation=>({id,skillLabel:"skill",requirementKey:source.requirementKey,attemptedAt:"2026-10-27T00:00:00Z",assistance:"independent",verifiedCorrect:"yes",independentAttempt:"yes",usableForCurrentVersion:"yes",problemId:id,itemVersionId:id,courseRequirement:{id:source.id,revision:1,stableSkillId:"skill",requirementKey:source.requirementKey},questionIdentity:id,firstQuestionExposure:true,evidenceContext:{responseFormat:"numeric",elapsedSeconds:90}});
it("shares only explicit compatible current identity without rewriting the original evidence",()=>{
 const original=observation("first"),shared=projectSharedCourseEvidence({source,target,link,observations:[original,observation("second")]});
 expect(shared).toHaveLength(2);expect(shared[0]!.courseRequirement?.id).toBe(source.id);expect(original).not.toHaveProperty("sharedFor");
 const progress=courseRequirementProgress([target],shared,new Map([["source-b",1]]));expect(progress[0]!.status).toBe("verified");expect(progress[0]!.sharedEvidence).toEqual(expect.arrayContaining([expect.objectContaining({sourceCourseId:"course-a",observationId:"first",applicableGoalIds:["goal-b"]})]));
});
it("does not borrow absent or different standards, question formats, timing or skill identities",()=>{
 for(const changed of [{...target,evidenceConditions:undefined},{...target,evidenceConditions:{...target.evidenceConditions!,responseFormat:"text" as const}},{...target,evidenceConditions:{...target.evidenceConditions!,timeLimitSeconds:null}},{...target,stableSkillId:"other"},{...target,verification:{...target.verification,rubric:"需要证明"}}])expect(courseRequirementsShareCompatible(source,changed)).toBe(false);
 for(const changed of [{...observation("x"),evidenceContext:undefined},{...observation("x"),evidenceContext:{responseFormat:"text" as const,elapsedSeconds:60}},{...observation("x"),evidenceContext:{responseFormat:"numeric" as const,elapsedSeconds:121}},{...observation("x"),assistance:"hinted" as const},{...observation("x"),usableForCurrentVersion:"no" as const}])expect(projectSharedCourseEvidence({source,target,link,observations:[changed]})).toEqual([]);
});
it("withdraws the projection on changed revisions, disabled mappings or a newer failed effective head",()=>{
 for(const changed of [{...link,active:false},{...link,sourceRequirementRevision:2},{...link,targetRequirementRevision:2}])expect(projectSharedCourseEvidence({source,target,link:changed,observations:[observation("x")]})).toEqual([]);
 expect(projectSharedCourseEvidence({source,target,link,observations:[observation("x"),{...observation("bad"),attemptedAt:"2026-10-28T00:00:00Z",verifiedCorrect:"no"}]})).toEqual([]);
});
it("does not let later shared success hide the receiving course's current failed attempt",()=>{
 const shared=projectSharedCourseEvidence({source,target,link,observations:[{...observation("source-new"),attemptedAt:"2026-10-29T00:00:00Z"},observation("source-old")]});
 const failed={...observation("target-wrong"),verifiedCorrect:"no" as const,attemptedAt:"2026-10-28T00:00:00Z",requirementKey:target.requirementKey,courseRequirement:{id:target.id,revision:1,stableSkillId:"skill",requirementKey:target.requirementKey}};
 expect(courseRequirementProgress([target],[failed,...shared],new Map([["source-b",1]]))[0]!.status).toBe("needs_correction");
});
it("does not call absent exact or manual criteria compatible",()=>{
 for(const kind of ["exact","manual"] as const)expect(courseRequirementsShareCompatible({...source,verification:{...source.verification,kind,rubric:null}},{...target,verification:{...target.verification,kind,rubric:null}})).toBe(false);
});
