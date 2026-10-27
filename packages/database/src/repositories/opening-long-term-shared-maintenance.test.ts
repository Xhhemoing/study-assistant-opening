import { beforeEach,it,expect,vi } from "vitest";
import { buildLongTermSuggestions } from "./opening-long-term-maintenance";
import { readOpeningCourseRoute,readCourseRouteObservations } from "./opening-course-route-read";
vi.mock("./opening-course-route-read",()=>({readOpeningCourseRoute:vi.fn(),readCourseRouteObservations:vi.fn()}));
vi.mock("./opening-learner-snapshot-read",()=>({readOpeningLearnerSnapshotCourses:async()=>[]}));
vi.mock("./cards",()=>({createCardRepository:()=>({listQueue:async()=>[]})}));
const sourceObservation={id:"shared-real",attemptedAt:"2026-11-03T12:00:00Z",courseRequirement:{id:"source-requirement",revision:1,stableSkillId:"skill"},usableForCurrentVersion:"yes",independentAttempt:"yes",verifiedCorrect:"yes"};
const requirement={id:"target-requirement",revision:2,stableSkillId:"skill",lifecycle:"active",goalIds:[],verification:{status:"ready"},title:"秩",requirementKey:"rank"};
const row={requirement,sourcesAvailable:true,sharedEvidence:[{observationId:"shared-real"}]};
const db=((parts:TemplateStringsArray)=>Promise.resolve(parts.join("").includes("FROM courses")?[{id:"course-b"}]:[])) as never;
const goal=(id:string,days:number)=>({id,courseIds:["course-b"],lifecycle:"maintenance",maintenanceIntervalDays:days});
beforeEach(()=>{vi.mocked(readOpeningCourseRoute).mockResolvedValue({scopeState:"confirmed",requirements:[row]} as never);vi.mocked(readCourseRouteObservations).mockResolvedValue({projected:[sourceObservation]} as never);});
it("uses only the route's adopted shared evidence time and keeps every goal's maintenance interval separate",async()=>{
 const result=await buildLongTermSuggestions(db,{workspaceId:"w",ownerUserId:"u"},{date:"2026-11-05",timeZone:"UTC",now:new Date("2026-11-05T12:00:00Z"),goals:[goal("weekly",7),goal("daily",1)] as never,tasks:[]});
 expect(result.suggestions.map(item=>item.key)).toEqual(["planner:2026-11-05:maintenance:daily:target-requirement"]);
});
it("does not defer maintenance from an unadopted raw shared row after a receiving-course failure",async()=>{
 vi.mocked(readOpeningCourseRoute).mockResolvedValue({scopeState:"confirmed",requirements:[{...row,sharedEvidence:undefined}]} as never);
 const result=await buildLongTermSuggestions(db,{workspaceId:"w",ownerUserId:"u"},{date:"2026-11-05",timeZone:"UTC",now:new Date("2026-11-05T12:00:00Z"),goals:[goal("weekly",7)] as never,tasks:[]});
 expect(result.suggestions.map(item=>item.key)).toEqual(["planner:2026-11-05:maintenance:weekly:target-requirement"]);
});
