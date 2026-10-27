import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,expect,it } from "vitest";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET,POST } from "../../../apps/web/src/app/api/opening/observations/[id]/interpretation/route";
import { createOpeningAiGradingRepository } from "@aistudy/database";
import { createOpeningFixture,type OpeningFixture } from "../opening-fixture";
import { learningAttemptFixture } from "../opening-learning-attempt-fixture";
import { backupRows } from "../opening-backup-records-fixture";
let f:OpeningFixture,runtime:ReturnType<typeof createAuthRuntime>;
beforeAll(async()=>{f=await createOpeningFixture();runtime=createAuthRuntime({databaseUrl:process.env.OPENING_TEST_DATABASE_URL!,authSecret:process.env.AUTH_SECRET!,sessionCookieSecure:false,
  sessionTtlSeconds:3600,authCookieName:"aistudy_session"});setAuthRuntimeForTests(runtime);});
afterAll(async()=>{setAuthRuntimeForTests(null);await runtime?.close();await f?.close();});
const context=(id:string)=>({params:Promise.resolve({id})});
function request(id:string,method="GET",body?:unknown,cookie=f.cookie){return new Request(`http://localhost/api/opening/observations/${id}/interpretation`,{
  method,headers:{cookie,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function seed(){const base=await learningAttemptFixture(f),attempt=await base.start(),photoId=await backupRows(f.sql,f.scope).source();
  await f.sql`UPDATE opening_sources SET mime='image/png',parse_state='not_started' WHERE id=${photoId}`;
  const original=await base.learning.insertObservation(f.scope,{sessionId:base.sessionId,courseId:base.courseId,skillLabel:"fractions",sourceIds:[base.sourceId],attemptId:attempt.id,
    problemId:attempt.problemId,answer:"见图",outcome:"unverified",assistance:"hinted",clientKey:randomUUID()},{workSource:{id:photoId,version:1,physicalPage:1}});
  const graded=await createOpeningAiGradingRepository(f.sql).apply(f.scope,{observationId:original.id},{outcome:"incorrect",confidence:.95,questionMatch:true,feedback:"识别文字有误请核对。",
    criteria:[{label:"等式",verdict:"incorrect",feedback:"核对原图。"}],transcription:"2"},"controlled-handler-fixture");return {original,graded};}
it("authenticates photo interpretation reads and rejects another owner's actual observation",async()=>{
  const x=await seed();expect((await GET(request(x.original.id,"GET",undefined,""),context(x.original.id))).status).toBe(401);
  const response=await GET(request(x.original.id),context(x.original.id));expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({originalAnswer:"见图",originalTranscription:"2",headObservationId:x.graded.id});
  const foreign=await learningAttemptFixture({...f,scope:f.otherScope}),foreignObservation=await foreign.submit(await foreign.start());
  expect((await GET(request(foreignObservation.id),context(foreignObservation.id))).status).toBe(404);
});
it("saves one free CAS correction through the actual handler, replays it and refuses head or image substitution",async()=>{
  const x=await seed(),input={expectedHead:x.graded.id,correctedTranscription:"1",reason:"漏识别分母",clientKey:randomUUID()};
  const charges=await f.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`;
  const response=await POST(request(x.original.id,"POST",input),context(x.original.id));expect(response.status).toBe(200);const saved=await response.json();
  expect(saved).toMatchObject({replayed:false,snapshot:{currentInterpretation:{version:1,correctedTranscription:"1"}},observation:{outcome:"unverified",assistance:"hinted"}});
  const replay=await POST(request(x.original.id,"POST",input),context(x.original.id));expect(replay.status).toBe(200);expect((await replay.json()).observation.id).toBe(saved.observation.id);
  expect((await POST(request(x.original.id,"POST",{...input,clientKey:randomUUID(),correctedTranscription:"3"}),context(x.original.id))).status).toBe(409);
  expect((await POST(request(x.original.id,"POST",{...input,workSource:{id:randomUUID(),version:1,physicalPage:1}}),context(x.original.id))).status).toBe(400);
  expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toEqual(charges);
});
