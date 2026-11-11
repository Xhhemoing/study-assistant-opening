import { describe, expect, it } from "vitest";
import { learningObservation, qualifiedInput } from "../learning-summary-fixtures";
import type { CourseEvidence } from "../learning-summary";
import { toSnapshotEvidence } from "./snapshot-evidence";

const now=new Date("2026-11-10T12:00:00Z");
function make(rows:Array<{id:string;label:string;submitted:number;recorded?:string;requirement?:string|null;current?:boolean}>):CourseEvidence {
  return { observations:rows.map(row=>({...learningObservation,id:row.id,skillLabel:row.label,occurredAt:row.recorded??"2026-11-10T00:00:00Z"})),
    evidenceContexts:Object.fromEntries(rows.map(row=>[row.id,{observation:{...qualifiedInput.observation,submittedAt:row.submitted,requirementKey:row.requirement??null},
      context:{...qualifiedInput.context,...(row.current===false?{version:{applicability:"unavailable" as const}}:{})}}])) };
}

describe("canonical focus label is display provenance, not newer-revision eligibility",()=>{
  it("earliest captured submission spelling wins even if its feedback was recorded latest",()=>{
    const evidence=make([{id:"old",label:" ＦＲＡＣＴＩＯＮＳ ",submitted:100,recorded:"2026-11-10T11:59:00Z",requirement:"r"},
      {id:"new",label:"Fractions",submitted:200,recorded:"2026-11-09T00:00:00Z",requirement:"r"}]);
    const mapped=toSnapshotEvidence(evidence,now);
    expect(mapped.observations.map(row=>row.skillLabel)).toEqual([" ＦＲＡＣＴＩＯＮＳ "," ＦＲＡＣＴＩＯＮＳ "]);
    expect(mapped.observations.map(row=>row.attemptedAt)).toEqual([new Date(100).toISOString(),new Date(200).toISOString()]);
  });
  it("same submission time uses observation id tie rather than caller iteration order for canonical spelling",()=>{
    const rows=[{id:"z",label:"Fractions",submitted:100,requirement:"r"},{id:"a",label:"ＦＲＡＣＴＩＯＮＳ",submitted:100,requirement:"r"}];
    const a=toSnapshotEvidence(make(rows),now),b=toSnapshotEvidence(make([...rows].reverse()),now);
    expect(a.observations.every(row=>row.skillLabel==="ＦＲＡＣＴＩＯＮＳ")).toBe(true);
    expect(b.observations.every(row=>row.skillLabel==="ＦＲＡＣＴＩＯＮＳ")).toBe(true);
  });
  it("earliest stale spelling can remain display owner while stale answer never becomes current evidence",()=>{
    const evidence=make([{id:"stale",label:"ＦＲＡＣＴＩＯＮＳ",submitted:100,requirement:"r",current:false},
      {id:"new",label:"fractions",submitted:200,requirement:"r"}]);
    const mapped=toSnapshotEvidence(evidence,now);
    expect(mapped.observations.find(row=>row.id==="stale")).toMatchObject({skillLabel:"ＦＲＡＣＴＩＯＮＳ",usableForCurrentVersion:"no"});
    expect(mapped.observations.find(row=>row.id==="new")).toMatchObject({skillLabel:"ＦＲＡＣＴＩＯＮＳ",usableForCurrentVersion:"yes"});
  });
  it("an earlier identical alias in another named requirement does not take spelling ownership",()=>{
    const evidence=make([{id:"prove",label:"ＦＲＡＣＴＩＯＮＳ",submitted:1,requirement:"prove"},
      {id:"calc",label:"Fractions",submitted:100,requirement:"calc"},{id:"calc2",label:"fractions",submitted:200,requirement:"calc"}]);
    const mapped=toSnapshotEvidence(evidence,now);
    expect(mapped.observations.map(row=>row.skillLabel)).toEqual(["ＦＲＡＣＴＩＯＮＳ","Fractions","Fractions"]);
    expect(mapped.summaries).toHaveLength(2);
  });
  it("missing context cannot assign a named requirement from raw row text",()=>{
    const evidence=make([{id:"legacy",label:"ＦＲＡＣＴＩＯＮＳ",submitted:1,requirement:"r"},{id:"current",label:"Fractions",submitted:100,requirement:"r"}]);
    evidence.observations[0]={...evidence.observations[0]!,requirementKey:"r"};delete evidence.evidenceContexts.legacy;
    const mapped=toSnapshotEvidence(evidence,now);
    expect(mapped.observations.find(row=>row.id==="legacy")).toMatchObject({requirementKey:null,usableForCurrentVersion:"unknown"});
    expect(mapped.observations.find(row=>row.id==="current")).toMatchObject({requirementKey:"r",skillLabel:"Fractions"});
  });
  it("captured requirement is authoritative over a later raw label/key edit for grouping",()=>{
    const evidence=make([{id:"first",label:"Fractions",submitted:100,requirement:"captured"},{id:"second",label:"ＦＲＡＣＴＩＯＮＳ",submitted:200,requirement:"captured"}]);
    evidence.observations[1]={...evidence.observations[1]!,requirementKey:"later-edit"};
    const mapped=toSnapshotEvidence(evidence,now);
    expect(mapped.observations.map(row=>row.requirementKey)).toEqual(["captured","captured"]);
    expect(mapped.observations.map(row=>row.skillLabel)).toEqual(["Fractions","Fractions"]);
  });
  it("punctuation differences cannot acquire another label's earlier display spelling",()=>{
    const mapped=toSnapshotEvidence(make([{id:"dash",label:"linear-algebra",submitted:1,requirement:"r"},
      {id:"plain",label:"linear algebra",submitted:2,requirement:"r"}]),now);
    expect(mapped.observations.map(row=>row.skillLabel)).toEqual(["linear-algebra","linear algebra"]);
    expect(mapped.summaries).toHaveLength(2);
  });
  it("canonicalization does not reorder or mutate the repository's effective source rows",()=>{
    const evidence=make([{id:"later",label:"fractions",submitted:200,requirement:"r"},{id:"earlier",label:"ＦＲＡＣＴＩＯＮＳ",submitted:100,requirement:"r"}]);
    const before=JSON.stringify(evidence);toSnapshotEvidence(evidence,now);
    expect(JSON.stringify(evidence)).toBe(before);expect(evidence.observations.map(row=>row.id)).toEqual(["later","earlier"]);
  });
});
