import { describe, expect, it, vi } from "vitest";
import { providerInputSchema, sourceChunkSchema, type SourceChunk } from "@aistudy/contracts";
import { createCompilerProviderInput, createCompilerBuildPublishInput, proposeTeachingOutline } from "./teaching-compiler";
import { assembleTeachingEvidencePack } from "./teaching-evidence";

const A="00000000-0000-4000-8000-0000000000a1", B="00000000-0000-4000-8000-0000000000b1";
const ACT="00000000-0000-4000-8000-0000000000c1", UNIT="00000000-0000-4000-8000-0000000000d1";
const good:SourceChunk={id:"00000000-0000-4000-8000-000000000001",sourceId:A,sourceVersion:0,page:null,startMs:null,endMs:null,imageObjectKey:null,text:"AUTHORIZED_CONTROL"};
const other:SourceChunk={...good,id:"00000000-0000-4000-8000-000000000002",sourceId:B,text:"OUTSIDE_FOCUS_SENTINEL"};
const payload={activityId:ACT,teachingUnitId:UNIT,expectedContentVersion:0,sourceIds:[A]};
function outline(sources:string[]){return proposeTeachingOutline({activityId:ACT,intentKind:"topic",intentSummary:"focus",sourceIds:sources,chunks:[],maxItems:1});}

describe("source shape validity cannot authorize membership in an active focus",()=>{
  it("both chunks are valid schema input while only the explicit nonempty pack allowlist source is selected",()=>{
    expect(sourceChunkSchema.parse(other)).toEqual(other);
    const pack=assembleTeachingEvidencePack({chunks:[good,other],query:"CONTROL",maxCharacters:6000,ranked:true,allowlistSourceIds:[A]});
    expect(pack.chunks).toEqual([good]);
    expect(pack.anchors.map(row=>row.sourceId)).toEqual([A]);
  });
  it("empty direct-pack allowlist is legacy unrestricted, not a deny-all membership policy",()=>{
    const pack=assembleTeachingEvidencePack({chunks:[good,other],query:"CONTROL",maxCharacters:6000,ranked:true,allowlistSourceIds:[]});
    expect(pack.chunks).toEqual([good,other]);
  });
  it("normal loader output respects empty focus sources without relying on a nonempty pack allowlist",async()=>{
    const selected=outline([]);
    const input=await createCompilerProviderInput({readOutline:()=>selected,loadChunks:async()=>[good,other]})({},payload);
    expect(input.chunks).toEqual([]);expect(input.text).not.toContain("OUTSIDE_FOCUS_SENTINEL");
  });
  it("retriever cannot reintroduce chunks into a saved source-free focus",async()=>{
    const retrieveContext=vi.fn(async()=>({chunks:[other],mode:"hybrid" as const}));
    const input=await createCompilerProviderInput({readOutline:()=>outline([]),loadChunks:async()=>[good],retrieveContext})({},payload);
    expect(retrieveContext).toHaveBeenCalledExactlyOnceWith({},expect.objectContaining({sourceIds:[],chunks:[]}));
    expect(input.chunks).toEqual([]);expect(JSON.stringify(input)).not.toContain("OUTSIDE_FOCUS_SENTINEL");
    expect(providerInputSchema.safeParse(input).success).toBe(true);
  });
  it("retriever returning a payload source outside current item sources cannot revive it even when payload itself is authorized",async()=>{
    const retrieveContext=vi.fn(async()=>({chunks:[good,other],mode:"hybrid" as const}));
    const input=await createCompilerProviderInput({readOutline:()=>outline([A]),loadChunks:async()=>[good,other],retrieveContext})({},
      {...payload,sourceIds:[A,B]});
    expect(input.chunks).toEqual([good]);
    expect(retrieveContext).toHaveBeenCalledWith({},expect.objectContaining({sourceIds:[A],chunks:[good]}));
  });
  it("an empty payload cannot be enlarged by retriever output despite an existing outline referencing a source",async()=>{
    const input=await createCompilerProviderInput({readOutline:()=>outline([A]),loadChunks:async()=>[good],
      retrieveContext:async()=>({chunks:[good],mode:"hybrid"})})({},{...payload,sourceIds:[]});
    expect(input.chunks).toEqual([]);
  });
  it("a disjoint payload/focus intersection leaves no material even when retrieval returns individually schema-valid chunks",async()=>{
    const input=await createCompilerProviderInput({readOutline:()=>outline([B]),loadChunks:async()=>[good,other],
      retrieveContext:async()=>({chunks:[good,other],mode:"hybrid"})})({},payload);
    expect(input.chunks).toEqual([]);
  });
  it("pinned excerpts without a loader still cannot enter a saved source-free focus",async()=>{
    const input=await createCompilerProviderInput({readOutline:()=>outline([]),evidenceChunks:[good,other]})({},payload);
    expect(input.chunks).toEqual([]);
  });
  it("pinned excerpts with a loader fail identity revalidation instead of being silently ignored",async()=>{
    const writeLibraryBlocks=vi.fn();
    await expect(createCompilerBuildPublishInput({readOutline:()=>outline([]),loadChunks:async()=>[good],evidenceChunks:[other],writeLibraryBlocks})({},payload,null))
      .rejects.toThrow("evidence is unavailable or its source version/location changed");
    expect(writeLibraryBlocks).not.toHaveBeenCalled();
  });
  it("source-free publication without loader neither cites nor quotes rejected pinned chunks",async()=>{
    let written:unknown;
    const published=await createCompilerBuildPublishInput({readOutline:()=>outline([]),evidenceChunks:[other],writeLibraryBlocks:async blocks=>{written=blocks;}})({},payload,null);
    expect(published.sourceRefs).toEqual([]);expect(JSON.stringify(written)).not.toContain("OUTSIDE_FOCUS_SENTINEL");
  });
  it("empty focus does not acquire source material by advancing content revision",async()=>{
    const readOutline=()=>outline([]);
    const options={readOutline,evidenceChunks:[other]};
    const first=await createCompilerProviderInput(options)({},payload);
    const later=await createCompilerProviderInput(options)({},{...payload,expectedContentVersion:9,expectedUnitVersion:7});
    expect(first.chunks).toEqual([]);expect(later.chunks).toEqual([]);
  });
  it("source allowlist filtering occurs before rendering held-out string checks for an excluded source",()=>{
    const pack=assembleTeachingEvidencePack({chunks:[good,{...other,text:"forbidden-problem"}],query:"CONTROL",maxCharacters:6000,ranked:true,
      allowlistSourceIds:[A],denylist:{problemIds:["forbidden-problem"]}});
    expect(pack.chunks).toEqual([good]);
    expect(()=>assembleTeachingEvidencePack({chunks:[good,{...other,text:"forbidden-problem"}],query:"CONTROL",maxCharacters:6000,ranked:true,
      allowlistSourceIds:[A,B],denylist:{problemIds:["forbidden-problem"]}})).toThrow("held-out leak");
  });
});
