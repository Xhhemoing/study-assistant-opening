import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createOpeningConceptPreviewRepository, createOpeningMaterialManifestRepository, createOpeningStudyExposureRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { conceptPreviewService } from "../../apps/web/src/features/opening/concepts/preview-service";
import { conceptPreviewResponseSchema } from "../../apps/web/src/features/opening/concepts/preview-contract";
const runtime = vi.hoisted(() => ({ requireScope: vi.fn() }));
vi.mock("../../apps/web/src/features/opening/runtime",()=>({requireOpeningScope:runtime.requireScope}));
import { POST } from "../../apps/web/src/app/api/opening/concepts/preview/route";
let fixture: OpeningFixture;
beforeEach(() => { vi.stubEnv("OPENING_EXPLORE_PREVIEW", "1"); runtime.requireScope.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
beforeAll(async()=>{fixture=await createOpeningFixture();});
afterAll(async()=>{await fixture.close();});
// Deliberately NO fixture.reset(): isolated UUID rows only, never TRUNCATE shared DB.
async function setup() {
  const rows=backupRows(fixture.sql,fixture.scope),sourceId=await rows.source();
  await rows.chunk(sourceId);
  return {sourceId,sourceVersion:1,page:1,term:"source",selection:{text:"source evidence"},clientKey:randomUUID()};
}
it.each([undefined, "0"])("unset/OFF %s POST writes no exposure even with a valid source", async value => {
  const input = await setup();
  runtime.requireScope.mockResolvedValue({ scope: fixture.scope, sql: fixture.sql });
  const [before] = await fixture.sql`SELECT count(*)::int AS n FROM opening_help_exposures WHERE workspace_id=${fixture.scope.workspaceId}`;
  vi.stubEnv("OPENING_EXPLORE_PREVIEW", value);
  const response = await POST(new Request("http://local/api/opening/concepts/preview", { method: "POST", body: JSON.stringify(input) }));
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(runtime.requireScope).not.toHaveBeenCalled();
  const [after] = await fixture.sql`SELECT count(*)::int AS n FROM opening_help_exposures WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect(after!.n).toBe(before!.n);
});
it("real ON POST cannot deliver another owner's source", async () => {
  const input = await setup();
  runtime.requireScope.mockResolvedValue({ scope: fixture.otherScope, sql: fixture.sql });
  const response = await POST(new Request("http://local/api/opening/concepts/preview", { method: "POST", body: JSON.stringify(input) }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "unavailable" });
});
it("real POST delivers only pinned server text and conservatively persists delivery without ack",async()=>{
  const input=await setup(); runtime.requireScope.mockResolvedValue({scope:fixture.scope,sql:fixture.sql});
  const response=await POST(new Request("http://local/api/opening/concepts/preview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)}));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const result=await response.json();
  expect(result).toMatchObject({status:"available",kind:"source_excerpt",text:"source evidence",locator:{sourceId:input.sourceId,sourceVersion:1,page:1,start:0,end:15,manifestRevision:0}});
  const [receipt]=await fixture.sql`SELECT delivered,acknowledged_at FROM opening_help_exposures WHERE id=${result.exposureReceipts[0].id}`;
  expect(receipt).toMatchObject({delivered:true,acknowledged_at:null});
  await expect(createOpeningStudyExposureRepository(fixture.sql).acknowledge(fixture.otherScope,result.exposureReceipts[0].id)).rejects.toMatchObject({code:"NOT_FOUND"});
  expect((await fixture.sql`SELECT delivered FROM opening_help_exposures WHERE id=${result.exposureReceipts[0].id}`)[0]!.delivered).toBe(true);
  const replay=await conceptPreviewService(fixture.sql).preview(fixture.scope,input);
  expect(replay).toMatchObject({exposureReceipts:[{id:result.exposureReceipts[0].id}]});
  await expect(conceptPreviewService(fixture.sql).preview(fixture.scope,{...input,selection:{text:"source"}})).rejects.toMatchObject({code:"CONFLICT"});
}, 15000);
it("no owner, wrong page/version, deleted source, forged text do not disclose",async()=>{
  const input=await setup(),service=conceptPreviewService(fixture.sql);
  expect(await service.preview(fixture.otherScope,input)).toMatchObject({status:"unavailable"});
  expect(await service.preview(fixture.scope,{...input,page:2})).toMatchObject({status:"unavailable"});
  expect(await service.preview(fixture.scope,{...input,sourceVersion:2})).toMatchObject({status:"stale"});
  expect(await service.preview(fixture.scope,{...input,selection:{text:"source invented"}})).toMatchObject({status:"unavailable"});
  await fixture.sql`UPDATE opening_sources SET upload_state='rejected' WHERE id=${input.sourceId}`;
  expect(await service.preview(fixture.scope,input)).toMatchObject({status:"unavailable"});
});
it("historical version manifest, not current manifest, controls answer restriction",async()=>{
  const input=await setup(),{sql,scope}=fixture;
  await sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability,material_manifest,material_manifest_revision)
    SELECT id,1,workspace_id,bytes,sha256,'available',${sql.json({role:"answer_key",sections:[],questions:[],answers:[]})},3 FROM opening_sources WHERE id=${input.sourceId}`;
  await sql`UPDATE opening_sources SET version=2 WHERE id=${input.sourceId}`;
  expect(await conceptPreviewService(sql).preview(scope,input)).toMatchObject({status:"restricted"});
  await sql`UPDATE opening_source_versions SET material_manifest=${sql.json({role:"lecture",sections:[],questions:[],answers:[]})},material_manifest_revision=4 WHERE source_id=${input.sourceId}`;
  expect(await conceptPreviewService(sql).preview(scope,input)).toMatchObject({status:"available",locator:{manifestRevision:4,sourceVersion:1}});
  await sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${input.sourceId}`;
  expect(await conceptPreviewService(sql).preview(scope,input)).toMatchObject({status:"stale"});
});
it("manifest revision changes cannot reuse an old delivery intent",async()=>{
  const input=await setup(),{sql,scope}=fixture,service=conceptPreviewService(sql);
  await service.preview(scope,input);
  await createOpeningMaterialManifestRepository(sql).write(scope,input.sourceId,{sourceVersion:1,expectedRevision:0,manifest:{role:"lecture",sections:[],questions:[],answers:[]}});
  await expect(service.preview(scope,input)).rejects.toMatchObject({code:"CONFLICT"});
  expect(await service.preview(scope,{...input,clientKey:randomUUID()})).toMatchObject({status:"available",locator:{manifestRevision:1}});
});
it("single-connection pool does not deadlock inside the history lock",async()=>{
  const input=await setup();
  const sql=postgres(process.env.OPENING_TEST_DATABASE_URL!,{max:1});
  try { expect(await createOpeningConceptPreviewRepository(sql).deliver(fixture.scope,{...input,releaseKey:input.clientKey},text=>({text,start:0,end:text.length}))).toMatchObject({status:"read"}); }
  finally {await sql.end({timeout:2});}
},10000);
it("malformed persisted manifests fail closed, repeated terms require explicit offsets",async()=>{
  const input=await setup(),{sql,scope}=fixture,service=conceptPreviewService(sql);
  await sql`UPDATE opening_source_chunks SET text='source source' WHERE source_id=${input.sourceId}`;
  expect(await service.preview(scope,{...input,selection:undefined})).toMatchObject({status:"ambiguous"});
  expect(await service.preview(scope,{...input,selection:{text:"source",start:7,end:13}})).toMatchObject({status:"available",text:"source source",selection:{text:"source",start:7,end:13},locator:{start:0,end:13},context:{expanded:true}});
  await expect(service.preview(scope,{...input,selection:{text:"source",start:0,end:6}})).rejects.toMatchObject({code:"CONFLICT"});
  await sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability,material_manifest)
    SELECT id,1,workspace_id,bytes,sha256,'available','{"role":"bogus"}'::jsonb FROM opening_sources WHERE id=${input.sourceId}`;
  await expect(service.preview(scope,{...input,clientKey:randomUUID()})).rejects.toThrow("Invalid persisted material manifest");
});
it("client intent boundary produces a schema-valid 200-character receipt and rejects 120 before delivery",async()=>{
  const input=await setup(),service=conceptPreviewService(fixture.sql);
  const result=await service.preview(fixture.scope,{...input,clientKey:"x".repeat(119)});
  expect(conceptPreviewResponseSchema.safeParse(result).success).toBe(true);
  if(result.status!=="available") throw new Error("expected preview");
  expect(result.exposureReceipts[0]!.releaseKey.length).toBe(200);
  const [before]=await fixture.sql`SELECT count(*)::int AS n FROM opening_help_exposures WHERE workspace_id=${fixture.scope.workspaceId}`;
  await expect(service.preview(fixture.scope,{...input,clientKey:"x".repeat(120)})).rejects.toThrow();
  const [after]=await fixture.sql`SELECT count(*)::int AS n FROM opening_help_exposures WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect(after!.n).toBe(before!.n);
});
it("all open attempts conservatively block even requests omitting attempt identity",async()=>{
  const f=await learningAttemptFixture(fixture); await f.start();
  const input=await setup();
  expect(await conceptPreviewService(fixture.sql).preview(fixture.scope,input)).toEqual({status:"restricted",reason:"reader_preview_restricted_material_or_open_attempt"});
});
