import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { LearningObservation, ExplicitRegradeRequest } from "@aistudy/contracts";
import { createAuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";
import { createOpeningLearningRepository, createOpeningTeachingActivitiesRepository,
 createOpeningTeachingContentRepository, createOpeningTeachingHintRepository } from "@aistudy/database";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningTeachingCommandService } from "../../apps/web/src/features/opening/teaching/command-service";
import { createOpeningObservationService } from "../../apps/web/src/features/opening/learning/observation-service";
import { readOpeningCourseObservationHeads } from "../../packages/database/src/repositories/opening-learning-read";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
let fixture: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => { fixture = await createOpeningFixture();
 runtime=createAuthRuntime({databaseUrl:process.env.DATABASE_URL!,authSecret:process.env.AUTH_SECRET!,sessionCookieSecure:false,sessionTtlSeconds:3600,authCookieName:"aistudy_session"});
 setAuthRuntimeForTests(runtime);
 await fixture.sql.begin(async tx=>{await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE NOWAIT`;});
 await fixture.sql`SET lock_timeout='5000ms'`; await fixture.sql`SET statement_timeout='15000ms'`;
 const settings = await fixture.sql`SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout`;
 expect(settings[0]).toMatchObject({lock_timeout:"5s",statement_timeout:"15s"});
 record("settings",settings);
});
afterAll(async () => { setAuthRuntimeForTests(null);await runtime?.close();await fixture?.close(); });
function record(name: string, data: unknown) { if(process.env.REACH_RAW_PATH) appendFileSync(process.env.REACH_RAW_PATH,JSON.stringify({utc:new Date().toISOString(),name,data})+"\n"); }
const body="求二阶单位矩阵的秩。";
async function seed(twoQuestions = false, extraContext = false, duplicatePositions = false) {
 const base=await learningAttemptFixture(fixture), sourceIds=[base.sourceId];
 const activity=await createOpeningTeachingActivitiesRepository(fixture.sql).create(fixture.scope,{clientKey:randomUUID(),intentKind:"topic",intentSummary:"矩阵秩",courseId:base.courseId,sourceIds,createIntent:{}});
 const content=createOpeningTeachingContentRepository(fixture.sql), blockId=randomUUID(), answerId=randomUUID();
 const blocks: Array<{id:string;type:string;content:Record<string,unknown>}>=[{id:blockId,type:"prompt",content:{text:body}},{id:answerId,type:"answer_key",content:{answer:"2",hidden:true,hints:{direction:"检查两列。",concept:"线性无关列的数量。",firstStep:"写出第一列。"}}}];
 const order=[{blockId,position:0,role:"prompt" as const,blockType:"prompt"},{blockId:answerId,position:1,role:"answer_key" as const,blockType:"answer_key"}];
 const secondBlockId=randomUUID(), secondAnswerId=randomUUID();
 if(twoQuestions) {
  blocks.push({id:secondBlockId,type:"prompt",content:{text:"求三阶单位矩阵的秩。"}},{id:secondAnswerId,type:"answer_key",content:{answer:"3"}});
  order.push({blockId:secondBlockId,position:2,role:"prompt",blockType:"prompt"},{blockId:secondAnswerId,position:3,role:"answer_key",blockType:"answer_key"});
 }
 const extraBlockId=randomUUID(),unboundAnswerId=randomUUID();
 if(extraContext) blocks.push({id:extraBlockId,type:"paragraph",content:{text:"条件：仅考虑实矩阵。"}},{id:unboundAnswerId,type:"answer_key",content:{answer:"未绑定答案"}});
 if(duplicatePositions) {
  // Twenty legal refs force PostgreSQL's position-only sort to reorder ties.
  // Q1 is ref 1 -> 4; unissued Q2 is ref 7 -> 10 in the stable JS order.
  blocks.length=0;order.length=0;
  for(let n=1;n<=20;n++) {
   const prompt=n%2===1;
   const id=n===1?blockId:n===4?answerId:n===7?secondBlockId:n===10?secondAnswerId:randomUUID();
   blocks.push({id,type:prompt?"prompt":"answer_key",content:prompt?{text:n===1?body:`合成题 ${n}`}:{answer:"2",hints:{direction:"检查两列。",concept:"线性无关列的数量。",firstStep:"写出第一列。"}}});
   order.push({blockId:id,position:n%3,role:prompt?"prompt":"answer_key",blockType:prompt?"prompt":"answer_key"});
  }
 }
 const unit=await content.createUnit(fixture.scope,{title:"矩阵秩",blocks});
 const refs=[{sourceId:base.sourceId,chunkId:base.chunkId,version:1}];
 await content.publishActivitySpec(fixture.scope,{activityId:activity.id,teachingUnitId:unit.id,expectedVersion:0,expectedRevisionNumber:1,revisionNumber:1,blockOrder:order,sourceRefs:refs});
 const learning=createOpeningLearningRepository(fixture.sql), service=createOpeningAttemptService(fixture.sql);
 const session=await learning.createSession(fixture.scope,{courseId:base.courseId,activityId:activity.id,skillLabel:"矩阵秩",sourceIds});
 const start=(contentVersion=1)=>service.create(fixture.scope,{sessionId:session.id,clientKey:randomUUID(),teachingBlock:{blockId,contentVersion}});
 const submit=(id:string,answer="2")=>service.submit(fixture.scope,id,{clientKey:randomUUID(),answer,outcome:"unverified",assistance:"independent",verdictSource:"self_report"});
 const hint=(attemptId:string)=>createOpeningTeachingHintRepository(fixture.sql).read(fixture.scope,{attemptId,level:1});
 const command=(kind:"example"|"rephrase"|"expand"|"branch"|"return",expectedVersion=1,expectedPathVersion?:number)=>createOpeningTeachingCommandService(fixture.sql).execute(fixture.scope,activity.id,{clientKey:randomUUID(),kind,blockId,expectedVersion,...(expectedPathVersion===undefined?{}:{expectedPathVersion}),prompt:"用更清楚的方式说明本题"});
 const revise=(old:LearningObservation,answer:string)=>createOpeningObservationService(learning).reviseObservation(fixture.scope,{rootObservationId:old.rootObservationId??old.id,revisesObservationId:old.id,expectedHead:old.id,revisionKind:"replace",reason:"synthetic correction",clientKey:randomUUID(),replacement:{answer,outcome:"unverified",assistance:"independent"}});
 return {...base,activity,content,unit,blocks,blockId,answerId,secondBlockId,secondAnswerId,extraBlockId,unboundAnswerId,session,start,submit,hint,command,revise,order,refs,service};
}

import { EXPLICIT_REGRADE_CONFIRMATION_VERSION } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, createOpeningBudgetRepository, createOpeningJobRepository } from "@aistudy/database";
import { createModelGateway } from "../../packages/ai/src/opening/model-gateway";
import { OpeningProviderError } from "../../packages/ai/src/opening/provider";
import { createGradeObservationHandler } from "../../apps/worker/src/jobs/grade-observation";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { GET, POST } from "../../apps/web/src/app/api/opening/observations/regrade/route";
import { POST as CONFIRM } from "../../apps/web/src/app/api/opening/observations/regrade/confirm/route";
import { useTutorModelFixture } from "./handler/tutor-model-fixture";
import { createOpeningTeachingResumeService } from "../../apps/web/src/features/opening/teaching/resume-service";
useTutorModelFixture();
const rootUrl="http://localhost/api/opening/observations/regrade";
async function call(method:string, suffix="", data?:unknown) {
 const request=new Request(rootUrl+suffix,{method,headers:{cookie:fixture.cookie,origin:"http://localhost","content-type":"application/json"},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const response=method==="GET"?await GET(request):suffix==="/confirm"?await CONFIRM(request):await POST(request);
 const body=await response.json();record("handler",{method,suffix,status:response.status,cache:response.headers.get("cache-control"),body});
 expect(response.headers.get("cache-control")).toBe("no-store");return {status:response.status,body};
}
function selector(observationId:string,clientKey:string,requestId?:string){return "?"+new URLSearchParams({observationId,clientKey,...(requestId?{requestId}:{})});}
async function snapshot(){
 const tables=["opening_jobs","opening_outbox","opening_budget_reservations","opening_learning_observations","opening_explicit_regrade_requests","opening_help_exposures","opening_learning_eligibility","opening_learning_attempts","opening_teaching_activities","opening_teaching_activity_specs","opening_source_versions","opening_sources"];
 const result:Record<string,unknown>={};for(const table of tables)result[table]=[...await fixture.sql`SELECT * FROM ${fixture.sql(table)} ORDER BY 1`];return result;
}
async function unknown(observation:LearningObservation){
 const [row]=await fixture.sql`SELECT grading_operation_id FROM opening_learning_observations WHERE id=${observation.id}`;
 const operation=String(row!.grading_operation_id);expect(operation).not.toBe("null");
 await fixture.sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at) VALUES(${fixture.scope.workspaceId},'grading',9,${operation},'reserved',now(),now())`;
 return operation;
}
async function prepared(observation:LearningObservation){
 const input={observationId:observation.id,expectedHead:observation.id,expectedGradingVersion:0,clientKey:randomUUID()};
 const p=await call("POST","",input);expect(p.status).toBe(200);expect(p.body.kind).toBe("prepared");return {input,row:p.body.request as ExplicitRegradeRequest};
}
async function confirmed(row:ExplicitRegradeRequest){return call("POST","/confirm",{requestId:row.requestId,confirmationVersion:EXPLICIT_REGRADE_CONFIRMATION_VERSION,acceptPossibleDoubleCharge:true});}
async function worker(row:ExplicitRegradeRequest,uncertain=false){
 const complete=vi.fn(async()=>{if(uncertain)throw new OpeningProviderError("PROVIDER_TIMEOUT","synthetic sent, outcome unknown",true,true);
 return {text:JSON.stringify({outcome:"correct",confidence:.95,questionMatch:true,feedback:"synthetic",criteria:[{label:"rank",verdict:"correct",feedback:"checked"}]}),inputTokens:10,outputTokens:10,citedChunkIds:[],requestId:null,candidates:[]};});
 const gateway=createModelGateway({resolve:async()=>({provider:{complete},modelSnapshot:{id:"synthetic",providerId:"fixture",modelName:"synthetic",inputCentsPerMillion:100,outputCentsPerMillion:100},inputCentsPerMillion:100,outputCentsPerMillion:100})});
 const budget=createOpeningBudgetRepository(fixture.sql,{envCapCents:50}),queue=createOpeningJobRepository(fixture.sql);
 const handler=createGradeObservationHandler({repository:createOpeningAiGradingRepository(fixture.sql),gateway,budget:scope=>({reserve:input=>budget.reserve(scope,input),release:(...args)=>budget.release(scope,...args),claimExecution:id=>budget.claimExecution(scope,id),settle:(...args)=>budget.settle(scope,...args),markUnknown:id=>budget.markUnknown(scope,id)}),images:async()=>[]});
 expect(await runJob(queue,row.jobId!,handler)).toBe(true);expect(await runJob(queue,row.jobId!,handler)).toBe(false);expect(complete).toHaveBeenCalledOnce();return queue.get(fixture.scope,row.jobId!);
}
async function readHead(courseId:string,rootId:string){const heads=await readOpeningCourseObservationHeads(fixture.sql,fixture.scope,courseId);return heads.find(h=>(h.rootObservationId??h.id)===rootId)!;}

it("X1: unchanged publication + confirmed same-answer regrade preserves raw help and never grants independence",async()=>{
 const f=await seed(),old=await f.start(),help=await f.hint(old.id);await f.command("rephrase");
 const next=await f.start(2),original=await f.submit(next.id);expect(original.eligibility?.independentAttempt).toBe("no");
 const oldOperation=await unknown(original),p=await prepared(original),before=await snapshot();
 const c=await confirmed(p.row);expect(c.status).toBe(202);const row=c.body.progress.request as ExplicitRegradeRequest;
 expect((await worker(row)).state).toBe("succeeded");
 const published=await call("GET",selector(original.id,p.input.clientKey,row.requestId));expect(published.body.progress.status.status).toBe("graded");
 const head=await readHead(f.courseId,original.id);expect(head.id).not.toBe(original.id);expect(head.answer).toBe(original.answer);
 expect((await fixture.sql`SELECT answer_revision FROM opening_learning_observations WHERE id=${head.id}`)[0]!.answer_revision).toBe(1);
 expect(head.eligibility).toMatchObject({independentAttempt:"no",verifiedCorrect:"unknown"});expect(head.eligibility?.reasonCodes).toContain("ai_graded_correct");expect(head.eligibility?.reasonCodes).toContain("ai_evaluation_uncalibrated");
 expect(await fixture.sql`SELECT * FROM opening_help_exposures WHERE id=${help.exposureReceipt.id}`).toEqual((before.opening_help_exposures as Array<{id:string}>).filter(h=>h.id===help.exposureReceipt.id));
 const [fee]=await fixture.sql`SELECT state,outcome_unknown_at FROM opening_budget_reservations WHERE request_id=${oldOperation}`;expect(fee!.state).toBe("reserved");expect(fee!.outcome_unknown_at).not.toBeNull();
 await expect(createOpeningAiGradingRepository(fixture.sql).apply(fixture.scope,{observationId:original.id},{outcome:"correct",confidence:.95,questionMatch:true,feedback:"old late",criteria:[{label:"rank",verdict:"correct",feedback:"late"}]},"synthetic")).rejects.toMatchObject({code:"CONFLICT"});
 const stable=await snapshot();for(let n=0;n<2;n++)expect((await call("GET",selector(original.id,p.input.clientKey,row.requestId))).body).toEqual(published.body);
 expect(await snapshot()).toEqual(stable);
 expect(await fixture.sql`SELECT id FROM opening_jobs WHERE key=${row.operationId}`).toHaveLength(1);
 expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${row.jobId}`).toHaveLength(1);
 const rawBefore=(before.opening_learning_observations as Array<Record<string,unknown>>).find(o=>o.id===original.id)!;
 const rawAfter=(stable.opening_learning_observations as Array<Record<string,unknown>>).find(o=>o.id===original.id)!;
 for(const field of ["answer","answer_revision","outcome","assistance","attempt_id","problem_id","item_version_id","submitted_at"])expect(rawAfter[field]).toEqual(rawBefore[field]);
 record("X1-before-after",{before,after:stable,head});
});

it("X2: answer correction after help + metadata head + regrade cannot launder manual independence",async()=>{
 const f=await seed(),attempt=await f.start(),original=await f.submit(attempt.id,"1");await f.hint(attempt.id);
 const corrected=(await f.revise(original,"2")).observation!,metadata=(await f.revise(corrected,"2")).observation!;
 expect(metadata.eligibility?.independentAttempt).toBe("no");const operation=await unknown(metadata),p=await prepared(metadata);
 const before=await snapshot(),c=await confirmed(p.row);expect(c.status).toBe(202);await worker(c.body.progress.request);
 const head=await readHead(f.courseId,original.id);
 const versions=await fixture.sql`SELECT answer_revision FROM opening_learning_observations WHERE id IN (${head.id},${corrected.id})`;
 expect(versions).toHaveLength(2);expect(versions.every(r=>Number(r.answer_revision)===2)).toBe(true);
 expect(head.eligibility).toMatchObject({independentAttempt:"no",verifiedCorrect:"unknown"});expect(head.eligibility?.reasonCodes).toContain("ai_graded_correct");
 const [fee]=await fixture.sql`SELECT state FROM opening_budget_reservations WHERE request_id=${operation}`;expect(fee!.state).toBe("reserved");
 record("X2-before-after",{before,after:await snapshot(),original,corrected,metadata,head});
});

it("X3: sent-unknown regrade keeps both holds, blocks old late result, readonly recovery creates no successor",async()=>{
 const f=await seed(),attempt=await f.start();await f.hint(attempt.id);const original=await f.submit(attempt.id),operation=await unknown(original),p=await prepared(original);
 const before=await snapshot(),c=await confirmed(p.row);expect(c.status).toBe(202);const row=c.body.progress.request as ExplicitRegradeRequest;
 await worker(row,true);const current=await call("GET",selector(original.id,p.input.clientKey,row.requestId));expect(current.body.progress.status.status).toBe("unknown_cost");
 for(const id of [operation,row.operationId]){const [fee]=await fixture.sql`SELECT state,outcome_unknown_at FROM opening_budget_reservations WHERE request_id=${id}`;expect(fee!.state).toBe("reserved");expect(fee!.outcome_unknown_at).not.toBeNull();}
 await expect(createOpeningAiGradingRepository(fixture.sql).apply(fixture.scope,{observationId:original.id},{outcome:"correct",confidence:.95,questionMatch:true,feedback:"old late",criteria:[{label:"rank",verdict:"correct",feedback:"late"}]},"synthetic")).rejects.toMatchObject({code:"CONFLICT"});
 const stable=await snapshot();await call("GET",selector(original.id,p.input.clientKey));await confirmed(row);expect(await snapshot()).toEqual(stable);
 expect((await readHead(f.courseId,original.id)).eligibility?.verifiedCorrect).toBe("unknown");record("X3-before-after",{before,after:stable,current});
});

it("X4: empty-ready shell denies fabricated attempt while helped publication fences head and privacy epoch",async()=>{
 const f=await seed(),shell=await createOpeningTeachingActivitiesRepository(fixture.sql).create(fixture.scope,{clientKey:randomUUID(),intentKind:"topic",intentSummary:"empty",courseId:f.courseId,sourceIds:[f.sourceId],createIntent:{}});
 const session=await createOpeningLearningRepository(fixture.sql).createSession(fixture.scope,{courseId:f.courseId,activityId:shell.id,skillLabel:"rank",sourceIds:[f.sourceId]});
 const beforeEmpty=await snapshot(),resume=await createOpeningTeachingResumeService(fixture.sql).getResume(fixture.scope,shell.id);
 expect(resume).toMatchObject({generateStatus:"ready",contentVersion:0,clientInit:null,actualAttempts:[],helpDelivered:[]});
 await expect(f.service.create(fixture.scope,{sessionId:session.id,clientKey:randomUUID(),teachingBlock:{blockId:f.blockId,contentVersion:1}})).rejects.toMatchObject({code:"CONFLICT"});
 expect(await snapshot()).toEqual(beforeEmpty);record("X4-empty",{resume,before:beforeEmpty,after:await snapshot()});
 const a=await f.start();await f.hint(a.id);const original=await f.submit(a.id);await unknown(original);const p=await prepared(original);
 await f.revise(original,"3");const beforeHead=await snapshot();const stale=await confirmed(p.row);expect(stale.status).toBe(409);expect(stale.body.kind).toBe("conflict");expect(await snapshot()).toEqual(beforeHead);
 const second=await f.submit((await f.start()).id);await unknown(second);const epoch=await prepared(second);
 await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${fixture.scope.workspaceId}`;
 const beforeEpoch=await snapshot(),hidden=await confirmed(epoch.row);expect(hidden.status).toBe(404);expect(hidden.body.error.code).toBe("NOT_FOUND");expect(await snapshot()).toEqual(beforeEpoch);
 await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch-1 WHERE id=${fixture.scope.workspaceId}`;
 record("X4-fences",{stale,hidden,beforeHead,beforeEpoch,after:await snapshot()});
});

import { backupRows } from "./opening-backup-records-fixture";
it("X6: same-question help publication + sealed photo + readonly locked recovery rejects photo version drift exactly",async()=>{
 const f=await seed(),old=await f.start();await f.hint(old.id);await f.command("rephrase");
 const next=await f.start(2),photoId=await backupRows(fixture.sql,fixture.scope).source();
 await fixture.sql`UPDATE opening_sources SET mime='image/png',parse_state='not_started' WHERE id=${photoId}`;
 const catalog=JSON.parse(process.env.OPENING_MODEL_CATALOG!);
 vi.stubEnv("OPENING_MODEL_CATALOG",JSON.stringify(catalog.map((model:Record<string,unknown>)=>({...model,supportsVision:true,mediaInputTokenUpperBound:10000,mediaMaxInputBytes:3000000,mediaInputCentsPerMillion:100}))));
 const original=await f.service.submit(fixture.scope,next.id,{clientKey:randomUUID(),answer:"见图",outcome:"unverified",assistance:"independent",verdictSource:"self_report",workSource:{id:photoId,version:1,physicalPage:1}});
 expect(original.eligibility?.independentAttempt).toBe("no");await unknown(original);const p=await prepared(original);
 expect(p.row.workSource).toEqual({id:photoId,version:1,physicalPage:1});
 const beforeRead=await snapshot();
 await fixture.sql.begin(async tx=>{
  await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId} FOR UPDATE NOWAIT`;
  const recovered=await call("GET",selector(original.id,p.input.clientKey));expect(recovered.status).toBe(200);expect(recovered.body.request.requestId).toBe(p.row.requestId);
 });
 expect(await snapshot()).toEqual(beforeRead);
 await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${photoId}`;
 const before=await snapshot(),rejected=await confirmed(p.row);expect(rejected.status).toBe(409);expect(rejected.body.error.code).toBe("CONFLICT");
 const recovered=await call("GET",selector(original.id,p.input.clientKey,p.row.requestId));expect(recovered.status).toBe(409);expect(recovered.body.error.code).toBe("CONFLICT");expect(await snapshot()).toEqual(before);
 record("X6-before-after",{original,request:p.row,beforeRead,before,after:await snapshot(),rejected,recovered});
});
