import { describe,it,expect } from "vitest";
import type { CourseRequirement } from "@aistudy/contracts";
import { courseRequirementProgress, selectCourseRouteStep,remainingCourseComprehensiveRequirements } from "./course-route";
const req=(id:string,prerequisiteIds:string[]=[]):CourseRequirement=>({id,courseId:"course",stableSkillId:`skill-${id}`,knowledgeNodeId:null,requirementKey:id,title:id,position:0,mandatory:true,goalIds:[],prerequisiteIds,sourceRefs:[{sourceId:"source",sourceVersion:1}],verification:{kind:"exact",status:"ready",exerciseKeys:["question"],rubric:null,missingReasons:[]},revision:1,lifecycle:"active",origin:"confirmed",approvedAt:"2026-10-27T00:00:00Z"});
const obs=(id:string,key:string,correct:"yes"|"no"|"unknown",assistance:"independent"|"hinted"="independent")=>({id,requirementKey:key,skillLabel:key,attemptedAt:"2026-10-27T00:00:00Z",assistance,verifiedCorrect:correct,independentAttempt:"yes" as const,usableForCurrentVersion:"yes" as const,problemId:id,itemVersionId:id,
  courseRequirement:{id:key,revision:1,stableSkillId:`skill-${key}`,requirementKey:key},questionIdentity:`题目${id}`,firstQuestionExposure:true});
describe("course route decisions",()=>{
  it("keeps the full denominator including missing requirements",()=>{
    const rows=Array.from({length:45},(_,i)=>req(String(i)));
    rows[44]!.sourceRefs=[];
    const result=courseRequirementProgress(rows,[],new Map([["source",1]]));
    expect(result).toHaveLength(45);expect(result[44]!.status).toBe("blocked");
  });
  it("repairs an explicit failed prerequisite then returns to its original requirement",()=>{
    const rows=courseRequirementProgress([req("basic"),req("advanced",["basic"])],[obs("wrong","basic","no")],new Map([["source",1]]));
    expect(selectCourseRouteStep(rows,"advanced")).toMatchObject({requirementId:"basic",action:"prerequisite",returnTo:"advanced"});
    const fixed=courseRequirementProgress([req("basic"),req("advanced",["basic"])],[obs("a","basic","yes"),obs("b","basic","yes")],new Map([["source",1]]));
    expect(selectCourseRouteStep(fixed,"advanced")).toMatchObject({requirementId:"advanced",action:"diagnose"});
  });
  it("does not turn assisted or unknown answers into verified course coverage",()=>{
    const rows=courseRequirementProgress([req("a"),req("b")],[obs("x","a","yes","hinted"),obs("y","b","unknown")],new Map([["source",1]]));
    expect(rows.map(row=>row.status)).toEqual(["assisted","needs_verification"]);
    expect(selectCourseRouteStep(rows,"a")).toMatchObject({action:"reduced_help_practice"});
  });
  it("does not reuse two old correct items after the requirement standard is revised",()=>{
    const requirement={...req("a"),revision:2};
    expect(courseRequirementProgress([requirement],[obs("a1","a","yes"),obs("a2","a","yes")],new Map([["source",1]]))[0]!.status).toBe("unobserved");
  });
  it("requires a distinct current check for every comprehensive requirement",()=>{
    const rows=courseRequirementProgress([req("a"),req("b")],[],new Map([["source",1]]));
    const a={...obs("a1","a","yes"),routeAction:"comprehensive",comprehensiveRunKey:"run-1"};
    const b={...obs("b1","b","yes"),routeAction:"comprehensive",comprehensiveRunKey:"other-run"};
    expect(remainingCourseComprehensiveRequirements(rows,[a,b],"run-1")).toEqual(["b"]);
    expect(remainingCourseComprehensiveRequirements(rows,[a,{...b,comprehensiveRunKey:"run-1"}],"run-1")).toEqual([]);
  });
  it("does not count an identical question recompiled with new item IDs as two independent checks",()=>{
    const a=obs("a1","a","yes"),b={...obs("a2","a","yes"),questionIdentity:a.questionIdentity,firstQuestionExposure:false};
    expect(courseRequirementProgress([req("a")],[a,b],new Map([["source",1]]))[0]!.status).toBe("needs_verification");
  });
  it("blocks a vanished referenced chunk even if its source version remains ready",()=>{
    const requirement={...req("a"),sourceRefs:[{sourceId:"source",sourceVersion:1,chunkId:"gone"}]};
    expect(courseRequirementProgress([requirement],[],new Map([["source",1]]),[])[0]!.status).toBe("blocked");
  });
});
