import type { Sql } from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeachingLearnerFocus, KnowledgeSnapshot } from "@aistudy/contracts";
import type { CourseEvidence } from "@aistudy/domain";
import { learningObservation, qualifiedInput } from "../../../domain/src/opening/learning-summary-fixtures";
import { readOpeningTeachingCompilerFocus } from "./opening-teaching-focus";
import { readOpeningCourseEvidence } from "./opening-learning-read";
import { readOpeningLearnerSnapshotCourses } from "./opening-learner-snapshot-read";

vi.mock("./opening-learning-read",()=>({readOpeningCourseEvidence:vi.fn()}));
vi.mock("./opening-course-route-read",()=>({readCourseRouteObservations:vi.fn()}));
vi.mock("./opening-learner-snapshot-read",()=>({readOpeningLearnerSnapshotCourses:vi.fn()}));
const P="00000000-0000-4000-8000-000000000001",T="00000000-0000-4000-8000-000000000002",X="00000000-0000-4000-8000-000000000003";
const scope={workspaceId:learningObservation.workspaceId,ownerUserId:"22222222-2222-4222-8222-222222222222"};
const goal={mode:"exam" as const,reasonCode:"selected_exam" as const,targetDate:null,daysRemaining:null,priority:3,prerequisiteBudgetMinutes:5};
const focus:TeachingLearnerFocus={skillLabel:"Span",requirementKey:"span",activityKind:"full_explain",reasonCode:"requested_full",focusObservationId:null,
  recentAssistance:[],strategyVersion:"adaptive-1",goalContext:goal,prerequisiteRepair:{nodeId:P,targetNodeId:T,skillLabel:"Linear Equations",returnToSkillLabel:"Span",
    maxMinutes:5,reason:"stored",stopCondition:"stored stop"}};
function graph():KnowledgeSnapshot{return {courseId:learningObservation.courseId!,version:1,nodes:[
  {id:P,courseId:learningObservation.courseId!,label:"Linear Equations",kind:"concept",status:"supported",evidenceChunkIds:[]},
  {id:T,courseId:learningObservation.courseId!,label:"Span",kind:"procedure",status:"supported",evidenceChunkIds:[]},
],edges:[{from:P,to:T,kind:"prerequisite",status:"supported",evidenceChunkIds:[]}]};}
function facts():CourseEvidence{return {observations:[{...learningObservation,skillLabel:"Linear Equations",outcome:"incorrect"}],evidenceContexts:{[learningObservation.id]:{
  observation:{...qualifiedInput.observation,outcome:"incorrect",submittedAt:Date.parse("2026-11-09T12:00:00Z")},
  context:{...qualifiedInput.context,referenceCheck:{...qualifiedInput.context.referenceCheck!,outcome:"incorrect"}},
}}};}
function sqlFor(stored:unknown=focus,courseId:unknown=learningObservation.courseId){return vi.fn().mockResolvedValue([{course_id:courseId,goal_json:{learnerFocus:stored}}]);}
const read=(stored:unknown=focus,courseId:unknown=learningObservation.courseId)=>readOpeningTeachingCompilerFocus(sqlFor(stored,courseId) as unknown as Sql,scope,X);
const setGraph=(snapshot:unknown)=>vi.mocked(readOpeningLearnerSnapshotCourses).mockResolvedValue([{courseId:learningObservation.courseId,knowledgeSnapshot:snapshot}] as never);
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));vi.clearAllMocks();vi.mocked(readOpeningCourseEvidence).mockResolvedValue(facts());setGraph(graph());});
afterEach(()=>vi.useRealTimers());

describe("compiler prerequisite focus rechecks its own current graph and evidence",()=>{
  it("rebuilds bounded details from the current supported graph, not old reason text",async()=>{
    const result=await read();
    expect(result.learnerFocus).toMatchObject({skillLabel:"Span",activityKind:"full_explain",focusObservationId:null,goalContext:goal,
      prerequisiteRepair:{nodeId:P,targetNodeId:T,skillLabel:"Linear Equations",returnToSkillLabel:"Span",maxMinutes:5}});
    expect(result.learnerFocus?.prerequisiteRepair?.reason).not.toBe("stored");
    expect(result).not.toHaveProperty("focusAttempt");
    expect(readOpeningLearnerSnapshotCourses).toHaveBeenCalledWith(expect.anything(),scope);
  });
  it.each([
    {name:"graph absent",change:()=>undefined}, {name:"graph null",change:()=>null}, {name:"wrong schema",change:()=>({nodes:[]})},
    {name:"direct edge removed",change:()=>({...graph(),edges:[]})},
    {name:"suggested edge",change:()=>({...graph(),edges:[{...graph().edges[0]!,status:"suggested"}]})},
    {name:"prerequisite needs check",change:()=>({...graph(),nodes:graph().nodes.map(n=>n.id===P?{...n,status:"needs_check"}:n)})},
    {name:"replaced prerequisite node",change:()=>({...graph(),nodes:graph().nodes.map(n=>n.id===P?{...n,id:X}:n),edges:[{...graph().edges[0]!,from:X}]})},
    {name:"replaced target node",change:()=>({...graph(),nodes:graph().nodes.map(n=>n.id===T?{...n,id:X}:n),edges:[{...graph().edges[0]!,to:X}]})},
    {name:"normalized label duplicate",change:()=>({...graph(),nodes:[...graph().nodes,{...graph().nodes[0]!,id:X,label:" ＬＩＮＥＡＲ EQUATIONS "}]})},
  ])("$name clears old detour, preserves explicit target and goal",async({change})=>{
    setGraph(change());const result=await read();
    expect(result.learnerFocus).toMatchObject({activityKind:"full_explain",skillLabel:"Span",goalContext:goal});
    expect(result.learnerFocus).not.toHaveProperty("prerequisiteRepair");
  });
  it("canonical alias spelling can survive only with the same node identities",async()=>{
    const current=graph();current.nodes[0]!.label="ＬＩＮＥＡＲ EQUATIONS";current.nodes[1]!.label="ＳＰＡＮ";setGraph(current);
    expect((await read()).learnerFocus?.prerequisiteRepair).toMatchObject({nodeId:P,targetNodeId:T,skillLabel:"ＬＩＮＥＡＲ EQUATIONS",returnToSkillLabel:"Span"});
  });
  it("same prerequisite node id with a genuinely changed display identity cannot reuse the old repair",async()=>{
    const current=graph();current.nodes[0]!.label="Different prerequisite";setGraph(current);
    const evidence=facts();evidence.observations[0]!.skillLabel="Different prerequisite";
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(evidence);
    const result=await read();expect(result.learnerFocus).not.toHaveProperty("prerequisiteRepair");
    expect(result.learnerFocus?.skillLabel).toBe("Span");
  });
  it("stored return label mismatch cannot attach a current candidate to a different saved target",async()=>{
    const result=await read({...focus,prerequisiteRepair:{...focus.prerequisiteRepair!,returnToSkillLabel:"Other target"}});
    expect(result.learnerFocus).not.toHaveProperty("prerequisiteRepair");
    expect(result.learnerFocus?.skillLabel).toBe("Span");
  });
  it("a shorter current goal budget replaces the old persisted prelude budget",async()=>{
    const result=await read({...focus,goalContext:{...goal,prerequisiteBudgetMinutes:2}});
    expect(result.learnerFocus?.prerequisiteRepair?.maxMinutes).toBe(2);
  });
  it.each(["unavailable","privacy_excluded","changed_needs_check"] as const)("prerequisite %s evidence removes detour instead of borrowing its old reason",async applicability=>{
    const evidence=facts();evidence.evidenceContexts[learningObservation.id]!.context.version={applicability};
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(evidence);
    expect((await read()).learnerFocus).not.toHaveProperty("prerequisiteRepair");
  });
  it("current independent success removes the old weakness prelude",async()=>{
    const evidence=facts(),captured=evidence.evidenceContexts[learningObservation.id]!;
    evidence.observations[0]!.outcome="correct";captured.observation.outcome="correct";
    captured.context.referenceCheck={...captured.context.referenceCheck!,outcome:"correct"};
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(evidence);
    expect((await read()).learnerFocus).not.toHaveProperty("prerequisiteRepair");
  });
  it("30-day-old bound evidence is accepted but older by one millisecond is not",async()=>{
    const evidence=facts();const captured=evidence.evidenceContexts[learningObservation.id]!;
    captured.observation.submittedAt=Date.now()-30*86400000;vi.mocked(readOpeningCourseEvidence).mockResolvedValue(evidence);
    expect((await read()).learnerFocus?.prerequisiteRepair?.nodeId).toBe(P);
    captured.observation.submittedAt!--;
    expect((await read()).learnerFocus).not.toHaveProperty("prerequisiteRepair");
  });
  it("missing goal snapshot cannot reuse a prelude budget",async()=>{
    const {goalContext:_g,...stored}=focus;const result=await read(stored);
    expect(result.learnerFocus).not.toHaveProperty("prerequisiteRepair");expect(readOpeningLearnerSnapshotCourses).not.toHaveBeenCalled();
  });
  it("missing course cannot authorize a prelude or start a graph read",async()=>{
    const result=await read(focus,null);
    expect(result.learnerFocus).not.toHaveProperty("prerequisiteRepair");expect(readOpeningLearnerSnapshotCourses).not.toHaveBeenCalled();
  });
  it("transfer-check target never diverts through old prerequisite even with stored repair",async()=>{
    const result=await read({...focus,strategyVersion:"course-route-1",activityKind:"transfer_check",reasonCode:"independent"});
    expect(result.learnerFocus).toMatchObject({activityKind:"transfer_check"});
    expect(result.learnerFocus).not.toHaveProperty("prerequisiteRepair");expect(readOpeningLearnerSnapshotCourses).not.toHaveBeenCalled();
  });
  it("graph repository failure propagates rather than falling back to stale prelude",async()=>{
    vi.mocked(readOpeningLearnerSnapshotCourses).mockRejectedValueOnce(new Error("current graph unavailable"));
    await expect(read()).rejects.toThrow("current graph unavailable");
  });
});
