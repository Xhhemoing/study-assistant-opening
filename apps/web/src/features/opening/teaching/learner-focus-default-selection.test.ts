import { describe, expect, it } from "vitest";
import type { LearnerSnapshotRead } from "../planning/learner-snapshot-service";
import { teachingLearnerFocus } from "./learner-focus";

const courseId="11111111-1111-4111-8111-111111111111";
const now=new Date("2026-11-10T12:00:00Z");
function read():LearnerSnapshotRead{return {
  snapshot:{date:"2026-11-10",timeZone:"UTC",dueCardCount:0,plannerHistory:[],courses:[{courseId,title:"Math",hasUsableMaterials:true,goal:null,minutesThisWeek:0,
    skills:[{skillLabel:"Already observed",requirementKey:"calculate",status:"observed_independent",lastObservedAt:null,recentAssistance:[]}],nextSkills:[]}]},
  sources:{date:"2026-11-10",timeZone:"UTC",dueCardCount:0,tasks:[],courses:[{courseId,title:"Math",hasUsableMaterials:true,goal:null,evidenceStatus:"available",
    summaries:[],observations:[],knowledgeNodes:[{id:"node",title:"Graph fallback",prerequisiteIds:[]}]}]},
  autonomy:"copilot",plannerInputRevision:"r",dataStatus:{evidence:"available",goals:"available",dueCards:"available"},metrics:{reads:1,durationMs:1},
};}
const focus=(value:LearnerSnapshotRead,skill:string|null=null,key?:string|null)=>teachingLearnerFocus(value,courseId,skill,false,key,now);

describe("default teaching focus follows saved selection precedence without treating preference as evidence",()=>{
  it("no explicit skill, review need, or next node selects the first saved skill but derives diagnose from actual empty observations",()=>{
    expect(focus(read())).toMatchObject({skillLabel:"Already observed",requirementKey:"calculate",activityKind:"diagnose",reasonCode:"no_evidence",focusObservationId:null});
  });
  it("a current needs_review saved skill precedes the first skill and graph next skills",()=>{
    const value=read(),course=value.snapshot.courses[0]!;
    value.snapshot={...value.snapshot,courses:[{...course,skills:[...course.skills,{...course.skills[0]!,skillLabel:"Review me",requirementKey:"prove",status:"needs_review"}],nextSkills:["Next graph"]}]};
    expect(focus(value)).toMatchObject({skillLabel:"Review me",requirementKey:"prove",activityKind:"diagnose",focusObservationId:null});
  });
  it("next skill takes precedence over an already observed first skill when no review is needed",()=>{
    const value=read();value.snapshot={...value.snapshot,courses:[{...value.snapshot.courses[0]!,nextSkills:["Next graph"]}]};
    const result=focus(value);
    expect(result).toMatchObject({skillLabel:"Next graph",activityKind:"diagnose",recentErrors:[]});
    expect(result).not.toHaveProperty("requirementKey");
  });
  it("when all saved skills and nextSkills are empty, only the first supported source graph title is used",()=>{
    const value=read();value.snapshot={...value.snapshot,courses:[{...value.snapshot.courses[0]!,skills:[],nextSkills:[]}]};
    expect(focus(value)).toMatchObject({skillLabel:"Graph fallback",activityKind:"diagnose",focusObservationId:null});
  });
  it("no saved or source graph label yields null, not an invented focus",()=>{
    const value=read();value.snapshot={...value.snapshot,courses:[{...value.snapshot.courses[0]!,skills:[],nextSkills:[]}]};
    value.sources.courses=[{...value.sources.courses[0]!,knowledgeNodes:[]}];
    expect(focus(value)).toBeNull();
  });
  it("an explicitly requested unknown skill bypasses default review selection without borrowing its requirement",()=>{
    const value=read();value.snapshot={...value.snapshot,courses:[{...value.snapshot.courses[0]!,skills:[{...value.snapshot.courses[0]!.skills[0]!,status:"needs_review"}]}]};
    const result=focus(value,"New explicit target");
    expect(result).toMatchObject({skillLabel:"New explicit target",activityKind:"diagnose",focusObservationId:null});
    expect(result).not.toHaveProperty("requirementKey");
  });
  it("explicit empty skill stays null while null means use default selection",()=>{
    expect(focus(read(),"")).toBeNull();expect(focus(read(),null)?.skillLabel).toBe("Already observed");
  });
  it("explicit requirement choice applies to default skill but cannot import another skill's observations",()=>{
    const value=read();value.sources.courses[0]!.observations=[{id:"other",skillLabel:"Other skill",requirementKey:"prove",attemptedAt:now.toISOString(),
      usableForCurrentVersion:"yes",verifiedCorrect:"no",independentAttempt:"yes",assistance:"independent",problemId:null}];
    expect(focus(value,null,"prove")).toMatchObject({skillLabel:"Already observed",requirementKey:"prove",activityKind:"diagnose",focusObservationId:null,recentAssistance:[]});
  });
  it("a requirement explicitly set to null is not replaced with the default skill's named requirement",()=>{
    expect(focus(read(),null,null)).toMatchObject({skillLabel:"Already observed",requirementKey:null,activityKind:"diagnose"});
  });
  it("an explicit unknown label plus explicit key admits only exact same-label/key observations",()=>{
    const value=read();value.sources.courses[0]!.observations=[{id:"exact",skillLabel:"New Target",requirementKey:"r",attemptedAt:now.toISOString(),
      usableForCurrentVersion:"yes",verifiedCorrect:"no",independentAttempt:"yes",assistance:"independent",problemId:null}];
    expect(focus(value,"ＮＥＷ TARGET","r")).toMatchObject({skillLabel:"ＮＥＷ TARGET",requirementKey:"r",activityKind:"targeted_explain",focusObservationId:"exact"});
    expect(focus(value,"ＮＥＷ TARGET")).toMatchObject({activityKind:"diagnose",focusObservationId:null});
  });
  it("unattributed explicit label cannot borrow null-key evidence merely because spelling matches",()=>{
    const value=read();value.sources.courses[0]!.observations=[{id:"legacy",skillLabel:"New Target",requirementKey:null,attemptedAt:now.toISOString(),
      usableForCurrentVersion:"yes",verifiedCorrect:"no",independentAttempt:"yes",assistance:"independent",problemId:null}];
    expect(focus(value,"New Target")).toMatchObject({activityKind:"diagnose",focusObservationId:null,recentAssistance:[]});
    expect(focus(value,"New Target",null)).toMatchObject({requirementKey:null,activityKind:"targeted_explain",focusObservationId:"legacy"});
  });
  it("a missing course source cannot be replaced with another course's graph fallback",()=>{
    const value=read();value.sources.courses=[{...value.sources.courses[0]!,courseId:"other-course"}];
    expect(focus(value)).toBeNull();
  });
  it("default selection itself never mutates a saved snapshot or its source graph",()=>{
    const value=read(),before=JSON.stringify(value);focus(value);focus(value,"New explicit target","r");
    expect(JSON.stringify(value)).toBe(before);
  });
});
