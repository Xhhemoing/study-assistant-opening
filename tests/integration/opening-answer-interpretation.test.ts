import { randomUUID } from "node:crypto";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import type { AiGradingProposal } from "@aistudy/contracts";
import { createOpeningAiGradingRepository,createOpeningAiGradingJobRepository,createOpeningBudgetRepository,readOpeningCourseEvidence } from "@aistudy/database";
import { createOpeningAnswerInterpretationRepository } from "../../packages/database/src/repositories/opening-answer-interpretation";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createOpeningAiGradingService } from "../../packages/ai/src/opening/ai-grading-service";
import { createModelGateway } from "../../packages/ai/src/opening/model-gateway";
import { nextLearningStep,toSnapshotEvidence } from "@aistudy/domain";
import { createOpeningFixture,type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let f:OpeningFixture;
beforeEach(async()=>{f=await createOpeningFixture();});afterEach(async()=>{await f?.close();});
const proposal=(outcome:"correct"|"incorrect"="incorrect"):AiGradingProposal=>({outcome,questionMatch:true,confidence:.95,feedback:outcome==="correct"?"应用线性性，逐步代入原等式。":"第二步漏掉了一次λ因子。",
  criteria:[{label:"线性性与代入",verdict:outcome,feedback:"核对两次使用Av=λv。"}],transcription:outcome==="correct"?"A²v=A(Av)=A(λv)=λAv=λ²v":"A²v=λv",
  proofFeedback:{coverage:"complete",steps:[{stepIndex:1,claim:"已知Av=λv",required:true,verdict:"correct",feedback:"条件对应原题。",repairPrompt:"保留原等式。"},
    {stepIndex:2,claim:outcome==="correct"?"A²v=λ²v":"A²v=λv",required:true,verdict:outcome,feedback:"需核对再次代入的因子。",repairPrompt:"先写A(λv)，再使用线性性。"}]}});
async function seed(){
  const base=await learningAttemptFixture(f),photoId=await backupRows(f.sql,f.scope).source();
  const proofStem="设v≠0且Av=λv，证明A²v=λ²v。";
  await f.sql`UPDATE opening_source_chunks SET text=${proofStem} WHERE id=${base.chunkId} AND source_id=${base.sourceId} AND source_version=1`;
  await f.sql`UPDATE opening_sources SET mime='image/png',parse_state='not_started' WHERE id=${photoId}`;
  const attempt=await base.start({problem:{sourceId:base.sourceId,chunkId:base.chunkId,physicalPage:1,stemSnapshot:proofStem,artifactKind:"reference_item"}});
  await base.help(attempt);
  const original=await base.learning.insertObservation(f.scope,{sessionId:base.sessionId,courseId:base.courseId,skillLabel:"fractions",sourceIds:[base.sourceId],attemptId:attempt.id,
    problemId:attempt.problemId,answer:"证明见原图",outcome:"unverified",assistance:"hinted",clientKey:randomUUID()},{workSource:{id:photoId,version:1,physicalPage:1}});
  const repository=createOpeningAiGradingRepository(f.sql),budget=createOpeningBudgetRepository(f.sql,{envCapCents:100000});let output=proposal();
  expect((await repository.context(f.scope,{observationId:original.id})).stem).toBe(proofStem);
  const provider=vi.fn(async()=>({text:JSON.stringify(output),citedChunkIds:[],requestId:null,candidates:[],inputTokens:100,outputTokens:100}));
  const rawGateway=createModelGateway({resolve:async()=>({provider:{complete:provider},supportsVision:true,inputCentsPerMillion:100,outputCentsPerMillion:100,
    mediaInputTokenUpperBound:1000,mediaInputCentsPerMillion:100,mediaMaxInputBytes:1000000,
    modelSnapshot:{id:"fixture",providerId:"fixture",modelName:"proof-fixture",inputCentsPerMillion:100,outputCentsPerMillion:100,
      mediaInputTokenUpperBound:1000,mediaInputCentsPerMillion:100,mediaMaxInputBytes:1000000}})});
  const gateway={call:async(...args:Parameters<typeof rawGateway.call>)=>{try{return await rawGateway.call(...args);}catch(error){throw Object.assign(new Error(`controlled grading gateway: ${error instanceof Error?error.message:String(error)}`,{cause:error}),{code:"CONFLICT"});}}};
  const service=createOpeningAiGradingService({repository,gateway,budget:scope=>({reserve:input=>budget.reserve(scope,input),release:(id,reason)=>budget.release(scope,id,reason),
    claimExecution:id=>budget.claimExecution(scope,id),settle:(...args)=>budget.settle(scope,...args),markUnknown:id=>budget.markUnknown(scope,id)}),
    images:async()=>[{mediaType:"image/png",data:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=",sourceId:photoId,physicalPage:1}]});
  const graded=await service.grade(f.scope,{observationId:original.id});
  const interpretations=createOpeningAnswerInterpretationRepository(f.sql),input={expectedHead:graded.id,correctedTranscription:"A²v=A(Av)=A(λv)=λAv=λ²v",reason:"原图第二行的平方被漏识别",clientKey:randomUUID()};
  return {...base,photoId,attempt,original,graded,interpretations,input,repository,service,provider,setOutput:(value:AiGradingProposal)=>{output=value;}};
}
it("preserves captured image, original transcription/submission/help while saving one free correction version",async()=>{
  const x=await seed(),[before]=await f.sql`SELECT * FROM opening_learning_observations WHERE id=${x.original.id}`;
  const charges=await f.sql`SELECT id,request_id,state,amount_cents FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`;
  const jobs=await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`;
  expect(charges).toHaveLength(1);expect(x.provider).toHaveBeenCalledTimes(1);
  const result=await x.interpretations.correct(f.scope,x.graded.id,x.input);
  expect(result.snapshot).toMatchObject({originalAnswer:"证明见原图",originalTranscription:"A²v=λv",workSource:{id:x.photoId,version:1,physicalPage:1},
    currentInterpretation:{version:1,correctedTranscription:x.input.correctedTranscription}});
  expect(result.observation).toMatchObject({attemptId:x.attempt.id,itemVersionId:x.attempt.itemVersionId,startedAt:x.original.startedAt,submittedAt:x.original.submittedAt,
    assistance:"hinted",outcome:"unverified",eligibility:{independentAttempt:"no",verifiedCorrect:"unknown"}});
  expect(await f.sql`SELECT id,request_id,state,amount_cents FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toEqual(charges);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`).toEqual(jobs);
  expect((await x.interpretations.correct(f.scope,x.graded.id,x.input)).replayed).toBe(true);
  expect((await x.interpretations.read(f.scope,x.original.id)).versions).toHaveLength(1);
  const [after]=await f.sql`SELECT * FROM opening_learning_observations WHERE id=${x.original.id}`;
  expect({...after,effective_head_id:before!.effective_head_id}).toEqual(before);expect(x.provider).toHaveBeenCalledTimes(1);
});
it("only explicitly regrades the saved correction, with one durable paid key and effective proof feedback",async()=>{
  const x=await seed(),corrected=await x.interpretations.correct(f.scope,x.original.id,x.input),jobs=createOpeningAiGradingJobRepository(f.sql);
  expect(await jobs.read(f.scope,{observationId:corrected.observation.id})).toMatchObject({answerRevision:2,jobId:null,retryable:true,autoGradeSkipped:"answer_changed"});
  await jobs.enqueue(f.scope,{observationId:corrected.observation.id});
  const context=await x.repository.context(f.scope,{observationId:corrected.observation.id});expect(context.interpretation?.correctedTranscription).toBe(x.input.correctedTranscription);
  x.setOutput(proposal("correct"));const graded=await x.service.grade(f.scope,{observationId:corrected.observation.id});
  expect(graded).toMatchObject({outcome:"correct",aiEvaluation:{proofFeedback:{coverage:"complete"}},eligibility:{independentAttempt:"no",verifiedCorrect:"unknown"}});
  expect((await x.service.grade(f.scope,{observationId:corrected.observation.id})).id).toBe(graded.id);expect(x.provider).toHaveBeenCalledTimes(2);
  expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(2);
  const facts=toSnapshotEvidence(await readOpeningCourseEvidence(f.sql,f.scope,x.courseId),new Date());
  expect(facts.observations.map(row=>row.id)).toEqual([graded.id]);
  expect(nextLearningStep({status:"needs_check",observations:facts.observations,wantsFullExplanation:false}).activityKind).toBe("diagnose");
});
it("cannot escape an unresolved original-photo charge by saving a correction or enqueueing a new operation",async()=>{
  const x=await seed();await f.sql`UPDATE opening_budget_reservations SET outcome_unknown_at=now(),pending_reconcile_cents=1 WHERE workspace_id=${f.scope.workspaceId}`;
  const result=await x.interpretations.correct(f.scope,x.original.id,x.input),jobs=createOpeningAiGradingJobRepository(f.sql);
  expect(await jobs.read(f.scope,{observationId:result.observation.id})).toMatchObject({status:"unknown_cost",retryable:false});
  await jobs.enqueue(f.scope,{observationId:result.observation.id});
  await expect(x.service.grade(f.scope,{observationId:result.observation.id})).rejects.toMatchObject({code:"CONFLICT"});
  expect(x.provider).toHaveBeenCalledTimes(1);expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
});
it("rejects stale heads, foreign owners and replacement photo fields without altering the original interpretation",async()=>{
  const x=await seed(),saved=await x.interpretations.correct(f.scope,x.original.id,x.input);
  await expect(x.interpretations.correct(f.scope,x.original.id,{...x.input,clientKey:randomUUID(),correctedTranscription:"另一个版本"})).rejects.toMatchObject({code:"CONFLICT"});
  await expect(x.interpretations.read(f.otherScope,x.original.id)).rejects.toMatchObject({code:"NOT_FOUND"});
  await expect(x.interpretations.correct(f.scope,x.original.id,{...x.input,workSource:{id:randomUUID(),version:1,physicalPage:1}} as never)).rejects.toBeDefined();
  expect((await x.interpretations.read(f.scope,x.original.id)).headObservationId).toBe(saved.observation.id);
});
it("versions a genuine recognition correction even when its text equals the original answer, without resetting help or auto charging",async()=>{
  const x=await seed(),corrected=await x.interpretations.correct(f.scope,x.original.id,{...x.input,correctedTranscription:x.original.answer});
  expect(corrected.snapshot.currentInterpretation).toMatchObject({version:1,correctedTranscription:x.original.answer,originalTranscription:"A²v=λv"});
  expect(await createOpeningAiGradingJobRepository(f.sql).read(f.scope,{observationId:corrected.observation.id})).toMatchObject({answerRevision:2,jobId:null,retryable:true});
  expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  expect(corrected.observation.eligibility?.independentAttempt).toBe("no");expect(x.provider).toHaveBeenCalledTimes(1);
});
it("stores contradictory necessary proof feedback as uncertain and a later manual judgement remains the effective head",async()=>{
  const x=await seed(),corrected=await x.interpretations.correct(f.scope,x.original.id,x.input),wrong=proposal("correct");
  wrong.proofFeedback!.steps[1]!.verdict="unverified";x.setOutput(wrong);
  const graded=await x.service.grade(f.scope,{observationId:corrected.observation.id});
  expect(graded).toMatchObject({outcome:"unverified",eligibility:{verifiedCorrect:"unknown"}});
  const manual=await reviseOpeningLearningObservation(f.sql,f.scope,{rootObservationId:x.original.id,revisesObservationId:graded.id,expectedHead:graded.id,revisionKind:"replace",
    reason:"证明还有必要条件未明确",clientKey:randomUUID(),replacement:{answer:graded.answer,outcome:"incorrect",assistance:graded.assistance}});
  const facts=await readOpeningCourseEvidence(f.sql,f.scope,x.courseId);expect(facts.observations.map(row=>row.id)).toEqual([manual.observation!.id]);
  expect(await createOpeningAiGradingJobRepository(f.sql).read(f.scope,{observationId:manual.observation!.id})).toMatchObject({retryable:false});
});
it("persists one paid uncertain result when an explicit proof question omits proof steps",async()=>{
  const x=await seed(),corrected=await x.interpretations.correct(f.scope,x.original.id,x.input),missing=proposal("correct");delete missing.proofFeedback;missing.feedback="长".repeat(6000);x.setOutput(missing);
  const graded=await x.service.grade(f.scope,{observationId:corrected.observation.id});expect(graded).toMatchObject({outcome:"unverified",eligibility:{verifiedCorrect:"unknown"}});
  expect(graded.aiEvaluation!.feedback).toContain("缺少证明步骤");expect(x.provider).toHaveBeenCalledTimes(2);
  expect(graded.aiEvaluation!.feedback.length).toBeLessThanOrEqual(6000);
  expect((await x.service.grade(f.scope,{observationId:corrected.observation.id})).id).toBe(graded.id);expect(x.provider).toHaveBeenCalledTimes(2);
  expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(2);
});
