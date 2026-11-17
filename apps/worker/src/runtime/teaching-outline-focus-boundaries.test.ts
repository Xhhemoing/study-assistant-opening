import { describe, expect, it } from "vitest";
import type { TeachingOutline } from "@aistudy/domain";
import { readStoredTeachingOutline } from "./teaching-outline";

const saved=():TeachingOutline=>({kind:"teaching_path",outlineId:"saved",activityId:"activity",focusItemId:"second",items:[
  {itemId:"first",title:"Edited first",goalIds:["g1"],intendedBlockTypes:["text"],sourceIds:["a"]},
  {itemId:"second",title:"Edited second",goalIds:["g2"],intendedBlockTypes:["text","prompt"],sourceIds:[],prereqItemIds:["first"]},
],prereqs:[{itemId:"first",reason:"Optional bridge",skippable:true,skipEffect:"continue_without"}]});
const read=(raw:unknown)=>readStoredTeachingOutline(raw,"activity",["a","b"]);

describe("stored focus is a distinct unstructured boundary, not provider schema admission",()=>{
  it("an intentionally source-free current item is admitted even when another item has materials",()=>{
    const result=read(saved());expect(result?.focusItemId).toBe("second");expect(result?.items[1]?.sourceIds).toEqual([]);
  });
  it.each([
    {name:"root array",value:[]}, {name:"root string",value:"saved"}, {name:"root number",value:1},
    {name:"missing items",value:{...saved(),items:undefined}}, {name:"empty items",value:{...saved(),items:[]}},
    {name:"missing prereqs",value:{...saved(),prereqs:undefined}}, {name:"foreign activity",value:{...saved(),activityId:"another"}},
    {name:"null focus",value:{...saved(),focusItemId:null}}, {name:"unknown focus",value:{...saved(),focusItemId:"missing"}},
    {name:"planning kind",value:{...saved(),kind:"day_plan"}},
  ])("$name is rejected before compilation",({value})=>expect(()=>read(value)).toThrow());
  it.each([
    {name:"null item",item:null}, {name:"array item",item:[]}, {name:"duplicate id",item:saved().items[0]},
    {name:"blank title",item:{...saved().items[1],title:" \n "}},
    {name:"numeric goal",item:{...saved().items[1],goalIds:[3]}},
    {name:"null blocks",item:{...saved().items[1],intendedBlockTypes:null}},
    {name:"numeric source",item:{...saved().items[1],sourceIds:[1]}},
    {name:"foreign source",item:{...saved().items[1],sourceIds:["not-in-activity"]}},
    {name:"object notes",item:{...saved().items[1],notes:{text:"notes"}}},
    {name:"null notes",item:{...saved().items[1],notes:null}},
    {name:"numeric prior item",item:{...saved().items[1],prereqItemIds:[1]}},
  ])("$name item is rejected",({item})=>expect(()=>read({...saved(),items:[saved().items[0],item]})).toThrow());
  it.each([
    {name:"null",prereq:null}, {name:"array",prereq:[]},
    {name:"unknown id",prereq:{...saved().prereqs[0],itemId:"absent"}},
    {name:"mandatory",prereq:{...saved().prereqs[0],skippable:false}},
    {name:"string skip",prereq:{...saved().prereqs[0],skippable:"true"}},
    {name:"blank reason",prereq:{...saved().prereqs[0],reason:" "}},
    {name:"unknown skip effect",prereq:{...saved().prereqs[0],skipEffect:"lock_mastery"}},
  ])("$name prerequisite cannot authorize a compulsory graph detour",({prereq})=>expect(()=>read({...saved(),prereqs:[prereq]})).toThrow());
  it("duplicate item identity is rejected even when focus membership and all other honesty constraints remain valid",()=>{
    const original=saved().items[0]!;
    const raw={...saved(),focusItemId:"first",items:[original,{...original,title:"Second spelling for the same id"}],prereqs:[]};
    expect(()=>read(raw)).toThrow("已保存的教学大纲不可读取");
  });
  it("normalizes unsupported block names on the clone without replacing stored learner focus/title",()=>{
    const raw=saved();raw.items[1]!.intendedBlockTypes=["matrix-viz","text","text"];
    const before=JSON.stringify(raw),result=read(raw)!;
    expect(result.focusItemId).toBe("second");expect(result.items[1]!.title).toBe("Edited second");
    expect(result.items[1]!.intendedBlockTypes).not.toContain("matrix-viz");
    expect(JSON.stringify(raw)).toBe(before);
  });
  it("returned graph containers and metadata do not alias the persisted draft",()=>{
    const raw=saved();const result=read(raw)!;
    result.items[0]!.sourceIds.push("local-only");result.items[1]!.prereqItemIds!.push("local-only");result.prereqs[0]!.reason="changed";
    expect(raw.items[0]!.sourceIds).toEqual(["a"]);expect(raw.items[1]!.prereqItemIds).toEqual(["first"]);
    expect(raw.prereqs[0]!.reason).toBe("Optional bridge");
  });
  it("source authorization is per activity even for a nonfocus future item",()=>{
    const raw=saved();raw.items[0]!.sourceIds=["foreign-future"];
    expect(()=>read(raw)).toThrow("已保存的教学大纲不可读取");
  });
  it("legacy absent outline stays absent, not an invented focused unit",()=>{
    expect(read(null)).toBeNull();expect(read(undefined)).toBeNull();
  });
});
