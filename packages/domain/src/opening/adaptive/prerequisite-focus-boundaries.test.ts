import { describe, expect, it } from "vitest";
import type { GoalLearningContext, KnowledgeSnapshot } from "@aistudy/contracts";
import type { SnapshotKnowledgeNode, SnapshotObservation } from "./snapshot-sources";
import { selectPrerequisiteRepair, toSupportedKnowledgeNodes } from "./prerequisite-repair";

const now=new Date("2026-11-10T12:00:00Z");
const goal:GoalLearningContext={mode:"exam",reasonCode:"selected_exam",targetDate:null,daysRemaining:null,priority:3,prerequisiteBudgetMinutes:5};
const nodes:SnapshotKnowledgeNode[]=[{id:"ancestor",title:"Arithmetic",prerequisiteIds:[]},
  {id:"direct",title:"Linear Equations",prerequisiteIds:["ancestor"]}, {id:"target",title:"Span",prerequisiteIds:["direct"]}];
const fact=(patch:Partial<SnapshotObservation>={}):SnapshotObservation=>({id:"evidence",skillLabel:"Linear Equations",requirementKey:"calculate",
  attemptedAt:"2026-11-09T12:00:00Z",problemId:null,verifiedCorrect:"no",independentAttempt:"yes",assistance:"independent",usableForCurrentVersion:"yes",...patch});
const run=(observations:SnapshotObservation[],knowledgeNodes:readonly SnapshotKnowledgeNode[]=nodes,clock=now)=>
  selectPrerequisiteRepair({targetSkillLabel:"Span",knowledgeNodes,observations,goalContext:goal,now:clock});

describe("focus prerequisite selection: exact elapsed boundary, not calendar-day guess",()=>{
  it.each([
    {name:"instant now",delta:0,accepted:true}, {name:"exactly 30 elapsed days",delta:30*86400000,accepted:true},
    {name:"one millisecond too old",delta:30*86400000+1,accepted:false}, {name:"future by one millisecond",delta:-1,accepted:false},
  ])("$name",({delta,accepted})=>{
    const result=run([fact({attemptedAt:new Date(now.getTime()-delta).toISOString()})]);
    expect(result?.nodeId??null).toBe(accepted?"direct":null);
  });
  it("invalid attempted time does not revive a prerequisite",()=>expect(run([fact({attemptedAt:"invalid-time"})])).toBeNull());
  it("invalid current clock does not authorize a detour",()=>expect(run([fact()],nodes,new Date(NaN))).toBeNull());
  it("the same instant across offset representations has the same qualification",()=>{
    const a=run([fact({attemptedAt:"2026-11-09T04:00:00-08:00"})]);
    const b=run([fact({attemptedAt:"2026-11-09T12:00:00Z"})]);
    expect(a).toEqual(b);expect(a?.nodeId).toBe("direct");
  });
});

describe("focus prerequisite identity: no implicit requirement or label bridge",()=>{
  it("NFKC/case/whitespace aliases identify one direct node without rewriting its display title",()=>{
    const result=run([fact({skillLabel:" ＬＩＮＥＡＲ\nＥＱＵＡＴＩＯＮＳ "})]);
    expect(result).toMatchObject({nodeId:"direct",targetNodeId:"target",skillLabel:"Linear Equations",returnToSkillLabel:"Span",maxMinutes:5});
  });
  it("two canonical aliases in the graph are ambiguous even with only one observation",()=>{
    expect(run([fact()],[...nodes,{id:"alias",title:" ＬＩＮＥＡＲ EQUATIONS ",prerequisiteIds:[]}])).toBeNull();
  });
  it("target alias collisions do not choose a first graph target",()=>{
    expect(run([fact()],[...nodes,{id:"alias-target",title:"ＳＰＡＮ",prerequisiteIds:["direct"]}])).toBeNull();
  });
  it("unassigned and named requirements cannot be inferred from the same unscoped graph node",()=>{
    expect(run([fact(),fact({id:"legacy",requirementKey:null})])).toBeNull();
  });
  it("empty and null requirement identities remain distinct for ambiguity detection",()=>{
    expect(run([fact({requirementKey:""}),fact({id:"legacy",requirementKey:null})])).toBeNull();
  });
  it("undefined and null mean one unassigned requirement rather than two invented targets",()=>{
    expect(run([fact({requirementKey:undefined}),fact({id:"legacy",requirementKey:null})])?.nodeId).toBe("direct");
  });
  it("non-current observations under a different requirement do not create a false ambiguity",()=>{
    expect(run([fact(),fact({id:"stale-prove",requirementKey:"prove",usableForCurrentVersion:"no"})])?.nodeId).toBe("direct");
  });
  it("latest current unknown prevents revival of an older exact error even when older error has assistance",()=>{
    expect(run([fact({assistance:"revealed"}),fact({id:"new",attemptedAt:"2026-11-10T11:00:00Z",verifiedCorrect:"unknown"})])).toBeNull();
  });
  it("canonical same-time tie picks smallest observation id, not source iteration order",()=>{
    const wrong=fact({id:"a"}),unknown=fact({id:"z",verifiedCorrect:"unknown"});
    expect(run([unknown,wrong])?.nodeId).toBe("direct");expect(run([wrong,unknown])).toEqual(run([unknown,wrong]));
  });
  it("only a direct prerequisite is eligible; weak ancestor cannot substitute",()=>{
    expect(run([fact({skillLabel:"Arithmetic"})])).toBeNull();
  });
  it("self edge never creates a prerequisite of the target itself",()=>{
    const cyclic=nodes.map(node=>node.id==="target"?{...node,prerequisiteIds:["target"]}:node);
    expect(run([fact({skillLabel:"Span"})],cyclic)).toBeNull();
  });
  it("a title at the persisted focus limit is eligible and one beyond it is not",()=>{
    const title="x".repeat(200),long=title+"x";
    const graph=(label:string)=>[{id:"p",title:label,prerequisiteIds:[]},{id:"target",title:"Span",prerequisiteIds:["p"]}];
    expect(run([fact({skillLabel:title})],graph(title))?.skillLabel).toBe(title);
    expect(run([fact({skillLabel:long})],graph(long))).toBeNull();
  });
});

describe("one prerequisite reminder does not expand assistance into negative knowledge",()=>{
  it.each([
    {independence:"yes",help:"hinted",accept:false}, {independence:"unknown",help:"hinted",accept:false},
    {independence:"no",help:"independent",accept:false}, {independence:"no",help:"unknown",accept:false},
    {independence:"no",help:"hinted",accept:true}, {independence:"no",help:"revealed",accept:true},
  ] as const)("correct result with independence=$independence and help=$help",({independence,help,accept})=>{
    expect(run([fact({verifiedCorrect:"yes",independentAttempt:independence,assistance:help})])?.nodeId??null).toBe(accept?"direct":null);
  });
  it("an actual current incorrect prerequisite wins over newer assisted success on another direct prerequisite",()=>{
    const graph=nodes.map(node=>node.id==="target"?{...node,prerequisiteIds:["ancestor","direct"]}:node);
    const result=run([fact(),fact({id:"assist",skillLabel:"Arithmetic",verifiedCorrect:"yes",independentAttempt:"no",assistance:"hinted",attemptedAt:"2026-11-10T11:59:00Z"})],graph);
    expect(result?.nodeId).toBe("direct");
  });
  it("equal incorrect candidates prefer newest qualified evidence, then stable node id",()=>{
    const graph=[{id:"b",title:"Beta",prerequisiteIds:[]},{id:"a",title:"Alpha",prerequisiteIds:[]},{id:"t",title:"Span",prerequisiteIds:["b","a"]}];
    const b=fact({id:"b-e",skillLabel:"Beta"}),a=fact({id:"a-e",skillLabel:"Alpha"});
    expect(run([b,a],graph)?.nodeId).toBe("a");
    expect(run([{...b,attemptedAt:"2026-11-10T11:00:00Z"},a],graph)?.nodeId).toBe("b");
  });
  it("selecting a short prelude preserves graph/evidence and only takes the goal snapshot budget",()=>{
    const observations=[fact()],before=JSON.stringify({nodes,observations});
    const result=selectPrerequisiteRepair({targetSkillLabel:"Span",knowledgeNodes:nodes,observations,goalContext:{...goal,mode:"understand",prerequisiteBudgetMinutes:10},now});
    expect(result?.maxMinutes).toBe(10);expect(result?.stopCondition).toContain("Span");
    expect(JSON.stringify({nodes,observations})).toBe(before);
    expect(result).not.toHaveProperty("mastery");
  });
});

describe("supported-graph adapter removes unsupported structure before focus selection",()=>{
  const C="00000000-0000-4000-8000-0000000000c1";
  const make=(patch:Partial<KnowledgeSnapshot>={}):KnowledgeSnapshot=>({courseId:C,version:0,nodes:[
    {id:"p",courseId:C,label:"Prerequisite",kind:"concept",status:"supported",evidenceChunkIds:[]},
    {id:"t",courseId:C,label:"Target",kind:"procedure",status:"supported",evidenceChunkIds:[]},
  ],edges:[{from:"p",to:"t",kind:"prerequisite",status:"supported",evidenceChunkIds:[]}],...patch});
  it("keeps only directed supported prerequisite relations and deduplicates them",()=>{
    const graph=make();graph.edges.push({...graph.edges[0]!},{...graph.edges[0]!,kind:"contains"},{...graph.edges[0]!,from:"t",to:"p",kind:"applies_to"});
    expect(toSupportedKnowledgeNodes(graph)).toEqual([{id:"p",title:"Prerequisite",prerequisiteIds:[]},{id:"t",title:"Target",prerequisiteIds:["p"]}]);
  });
  it.each(["suggested","needs_check"] as const)("%s edge cannot authorize an automatic detour",status=>{
    const graph=make();graph.edges[0]!.status=status;
    expect(toSupportedKnowledgeNodes(graph)[1]!.prerequisiteIds).toEqual([]);
  });
  it.each(["suggested","needs_check"] as const)("%s prerequisite node and its inbound relation are omitted",status=>{
    const graph=make();graph.nodes[0]!.status=status;
    expect(toSupportedKnowledgeNodes(graph)).toEqual([{id:"t",title:"Target",prerequisiteIds:[]}]);
  });
  it("chapter nodes, self edges and dangling nodes cannot become supported prerequisites",()=>{
    const graph=make();graph.nodes.push({...graph.nodes[0]!,id:"chapter",kind:"chapter"});
    graph.edges.push({...graph.edges[0]!,from:"chapter"},{...graph.edges[0]!,from:"t"},{...graph.edges[0]!,from:"missing"});
    expect(toSupportedKnowledgeNodes(graph)[1]!.prerequisiteIds).toEqual(["p"]);
    expect(toSupportedKnowledgeNodes(graph).map(node=>node.id)).not.toContain("chapter");
  });
  it("does not mutate source graph when removing unsupported structure",()=>{
    const graph=make(),before=JSON.stringify(graph);const supported=toSupportedKnowledgeNodes(graph);
    supported.pop();
    expect(JSON.stringify(graph)).toBe(before);
  });
});
