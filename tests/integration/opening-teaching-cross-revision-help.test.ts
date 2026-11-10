import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { LearningObservation } from "@aistudy/contracts";
import { assembleLearnerState, learnerEvidenceDisplayState, buildDecisionInput, courseRouteRetestOutcome, evaluateEvidenceEligibility } from "@aistudy/domain";
import { createAuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";
import { POST as commandHandler } from "../../apps/web/src/app/api/opening/teaching/activities/[id]/commands/route";
import { POST as attemptHandler } from "../../apps/web/src/app/api/opening/attempts/route";
import { POST as submitHandler } from "../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { openingEligibilityStateQuery, readOpeningLearningEvidenceContext, createOpeningLearnerStateService, createOpeningLearningRepository, createOpeningTeachingActivitiesRepository,
 createOpeningTeachingContentRepository, createOpeningTeachingHintRepository } from "@aistudy/database";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningTeachingCommandService } from "../../apps/web/src/features/opening/teaching/command-service";
import { createOpeningTeachingContentService } from "../../apps/web/src/features/opening/teaching/teaching-content-service";
import { createOpeningObservationService } from "../../apps/web/src/features/opening/learning/observation-service";
import { readOpeningCourseLearningSummary } from "../../packages/database/src/repositories/opening-learning-summary-read";
import { readOpeningCourseEvidence, readOpeningCourseObservationHeads } from "../../packages/database/src/repositories/opening-learning-read";
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
it("refuses example without changing question identity or losing help",async()=>{
 const f=await seed(),old=await f.start(); await f.hint(old.id); const result=await f.command("example");
 record("example-boundary",{result,old});
 expect(result.ok).toBe(false); const current=await f.start(); expect(current.problemId).toBe(old.problemId);
 expect((await f.submit(current.id)).eligibility?.independentAttempt).toBe("no");
});
it("same saved question, fresh raw submission retains help",async()=>{
 const f=await seed(),old=await f.start();await f.hint(old.id);const next=await f.start(),observed=await f.submit(next.id);
 record("fresh-submission",{old,next,observed});expect(next.id).not.toBe(old.id);expect(next.problemId).toBe(old.problemId);expect(next.itemVersionId).toBe(old.itemVersionId);expect(observed.eligibility?.independentAttempt).toBe("no");
});
it("actual answer revision after delivered help retains attempt/item and is non-independent",async()=>{
 const f=await seed(),old=await f.start(),original=await f.submit(old.id,"1"); await f.hint(old.id);
 const revised=await f.revise(original,"2");record("answer-revision",{original,revised});
 expect(revised.observation).toMatchObject({attemptId:old.id,problemId:old.problemId,itemVersionId:old.itemVersionId,eligibility:{independentAttempt:"no"}});
});
it("path-only branch/return does not mint a fresh question",async()=>{
 const f=await seed(),old=await f.start();await f.hint(old.id); const branch=await f.command("branch");expect(branch.ok).toBe(true);
 if(!branch.ok) throw new Error("branch unexpectedly refused");
 const returned=await f.command("return",1,branch.pathVersion);expect(returned.ok).toBe(true);
 const next=await f.start(),observed=await f.submit(next.id);record("path-only",{branch,returned,old,next,observed});
 expect(next.problemId).toBe(old.problemId);expect(observed.eligibility?.independentAttempt).toBe("no");
});
it.each(["rephrase","expand"] as const)("legal %s of unchanged same question must not wash away delivered help",async kind=>{
 const f=await seed(),old=await f.start(),original=await f.submit(old.id,"1");
 const delivered=await f.hint(old.id);
 const beforeHelp=await fixture.sql`SELECT * FROM opening_help_exposures WHERE id=${delivered.exposureReceipt.id}`;
 const beforeRaw=await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${original.id}`;
 const command=await f.command(kind);expect(command).toMatchObject({ok:true,contentVersion:2});
 const next=await f.start(2),observed=await f.submit(next.id),init=await f.content.getClientInit(fixture.scope,f.activity.id);
 const savedHelp=await fixture.sql`SELECT attempt_id,problem_id,item_version_id,delivered,level,context_anchor FROM opening_help_exposures WHERE id=${delivered.exposureReceipt.id}`;
 expect(savedHelp).toHaveLength(1);expect(savedHelp[0]).toMatchObject({attempt_id:old.id,problem_id:old.problemId,item_version_id:old.itemVersionId,delivered:true});
 expect(next.problemId).not.toBe(old.problemId);expect(next.itemVersionId).not.toBe(old.itemVersionId);
 expect(observed.evidenceVerdict).toBe("MASTERY_NOT_ESTABLISHED");expect(observed.allowsIndependent).toBe(false);
 const heads=await readOpeningCourseObservationHeads(fixture.sql,fixture.scope,f.courseId);
 const summary=await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:10});
 const items=await fixture.sql`SELECT id,problem_id,stem_snapshot,evaluation_spec FROM opening_learning_item_versions WHERE id IN (${old.itemVersionId!},${next.itemVersionId!})`;
 const evidence=await readOpeningCourseEvidence(fixture.sql,fixture.scope,f.courseId);
 const state=assembleLearnerState({evidence,dataAsOf:new Date().toISOString(),stateVersion:"private-test"});
 const head=heads.find(h=>h.id===observed.id)!;expect(head).toBeTruthy();expect(head.eligibility).toBeTruthy();
 const snapshot={id:head.id,skillLabel:head.skillLabel,attemptedAt:head.submittedAt!,assistance:head.assistance,problemId:head.problemId??null,
 verifiedCorrect:head.eligibility!.verifiedCorrect,independentAttempt:head.eligibility!.independentAttempt,usableForCurrentVersion:head.eligibility!.usableForCurrentVersion};
 const decision=buildDecisionInput({observations:[snapshot],wantsFullExplanation:false});
 const retest=courseRouteRetestOutcome({status:"in_progress",deadlineAt:null,observation:snapshot},new Date());
 const display=learnerEvidenceDisplayState(head);
 const projection=await fixture.sql`SELECT independent_attempt,verified_correct,usable_for_current_version FROM opening_learning_eligibility WHERE head_observation_id=${observed.id}`;
 record(`legal-${kind}`,{delivered,savedHelp,command,old,next,observed,items,init,heads,summary,state,decision,retest,display,projection});
 expect(projection).toHaveLength(1);expect(projection[0]).toMatchObject({independent_attempt:"no",verified_correct:"unknown"});
 expect(observed.allowsIndependent).toBe(false);
 const fresh=await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[observed.id]});
 expect(fresh[0]?.fresh).toBe(true);
 // Even if an old cache's max receipt revision masks the newly joined help,
 // a positive label contradicted by exact prior question help is stale.
 await fixture.sql`UPDATE opening_learning_eligibility SET independent_attempt='yes' WHERE root_observation_id=${observed.id}`;
 expect((await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[observed.id]}))[0]?.fresh).toBe(false);
 expect((await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:10})).status).toBe("ready");
 // Simulate the old publication-only dependency cache, not a new learning fact.
 await fixture.sql`UPDATE opening_learning_eligibility SET independent_attempt='yes',help_revision=0 WHERE root_observation_id=${observed.id}`;
 expect((await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[observed.id]}))[0]?.fresh).toBe(false);
 const repaired=await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:10});
 expect(repaired.status).toBe("ready");
 expect((await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[observed.id]}))[0]).toMatchObject({fresh:true,independent_attempt:"no"});
 const persistedState=await createOpeningLearnerStateService(fixture.sql).read(fixture.scope,{courseId:f.courseId});
 expect(persistedState.features.find(s=>s.observationId===observed.id)?.views).not.toContain("independent");
 expect(await fixture.sql`SELECT * FROM opening_help_exposures WHERE id=${delivered.exposureReceipt.id}`).toEqual(beforeHelp);
 expect(await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${original.id}`).toEqual(beforeRaw);
 expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE session_id=${f.session.id}`).toHaveLength(2);
 expect(head.eligibility?.independentAttempt).toBe(observed.eligibility?.independentAttempt);
 expect(state.features.find(s=>s.observationId===observed.id)?.views).not.toContain("independent");
 expect(display).toBe("insufficient");expect(decision.status).toBe("needs_check");expect(retest).not.toBe("passed");
 expect(summary.groups.every(g=>g.independentVerifiedCurrentCount===0)).toBe(true);
 expect(items).toHaveLength(2);expect(items.every(i=>i.stem_snapshot===body)).toBe(true);
 expect(observed.eligibility?.independentAttempt).toBe("no");
});
it("legal reference-answer-only revision of unchanged prompt must retain old help",async()=>{
 const f=await seed(),old=await f.start();await f.hint(old.id);
 const changed=f.blocks.map(b=>b.id===f.answerId?{...b,content:{...b.content,answer:"秩为2。"}}:b);
 const revision=await f.content.writeUnitBlocks(fixture.scope,f.unit.id,changed);
 const published=await createOpeningTeachingContentService(fixture.sql).adoptReferenceRevision(fixture.scope,f.activity.id,{expectedContentVersion:1,expectedRevisionNumber:1,revisionNumber:revision.revisionNumber});
 const next=await f.start(2),observed=await f.submit(next.id);record("reference-only-revision",{revision,published,old,next,observed});
 expect(next.stemSnapshot).toBe(old.stemSnapshot);expect(observed.eligibility?.independentAttempt).toBe("no");
});
it("genuinely changed prompt in new authored publication is not forever tainted by old item help",async()=>{
 const f=await seed(),old=await f.start();await f.hint(old.id);
 const changed=f.blocks.map(b=>b.id===f.blockId?{...b,content:{...b.content,text:"求三阶单位矩阵的秩。"}}:{...b,content:{...b.content,answer:"3"}});
 const revision=await f.content.writeUnitBlocks(fixture.scope,f.unit.id,changed);
 await createOpeningTeachingContentService(fixture.sql).publishActivitySpec(fixture.scope,{activityId:f.activity.id,teachingUnitId:f.unit.id,expectedVersion:1,expectedRevisionNumber:1,revisionNumber:revision.revisionNumber,blockOrder:f.order,sourceRefs:f.refs});
 const next=await f.start(2),observed=await f.submit(next.id,"3");record("genuine-new-question",{old,next,observed});
 expect(next.stemSnapshot).not.toBe(old.stemSnapshot);expect(observed.eligibility).toMatchObject({independentAttempt:"yes",verifiedCorrect:"unknown"});
 expect(observed.allowsIndependent).toBe(false);expect(observed.evidenceVerdict).toBe("MASTERY_NOT_ESTABLISHED");
});

it.each(["options", "unit"] as const)("changed saved %s are a different question despite identical body",async kind=>{
 const f=await seed(),old=await f.start();await f.hint(old.id);
 const interaction=kind==="options"?{kind:"choice",options:[{id:"a",label:"1"},{id:"b",label:"2"}]}:{kind:"numeric",unit:"维"};
 const blocks=f.blocks.map(b=>b.id===f.blockId?{...b,content:{...b.content,interaction}}:b);
 const revision=await f.content.writeUnitBlocks(fixture.scope,f.unit.id,blocks);
 await createOpeningTeachingContentService(fixture.sql).publishActivitySpec(fixture.scope,{activityId:f.activity.id,teachingUnitId:f.unit.id,expectedVersion:1,expectedRevisionNumber:1,revisionNumber:revision.revisionNumber,blockOrder:f.order,sourceRefs:f.refs});
 const next=await f.start(2),observed=await f.submit(next.id);
 expect(observed.eligibility?.independentAttempt).toBe("yes");expect(observed.allowsIndependent).toBe(false);
});

it("returning to the old authored question after a genuinely different publication retains its help",async()=>{
 const f=await seed(),old=await f.start();await f.hint(old.id);
 const changed=f.blocks.map(b=>b.id===f.blockId?{...b,content:{...b.content,text:"求三阶单位矩阵的秩。"}}:b);
 const second=await f.content.writeUnitBlocks(fixture.scope,f.unit.id,changed);
 const publish=(version:number,pinned:number,revisionNumber:number)=>createOpeningTeachingContentService(fixture.sql).publishActivitySpec(fixture.scope,{activityId:f.activity.id,teachingUnitId:f.unit.id,expectedVersion:version,expectedRevisionNumber:pinned,revisionNumber,blockOrder:f.order,sourceRefs:f.refs});
 await publish(1,1,second.revisionNumber);
 expect((await f.submit((await f.start(2)).id)).eligibility?.independentAttempt).toBe("yes");
 const third=await f.content.writeUnitBlocks(fixture.scope,f.unit.id,f.blocks);
 await publish(2,second.revisionNumber,third.revisionNumber);
 expect((await f.submit((await f.start(3)).id)).eligibility?.independentAttempt).toBe("no");
});

it("repeated metadata rewrites preserve the earliest receipt without fabricating history",async()=>{
 const f=await seed(),old=await f.start(),hint=await f.hint(old.id);
 await f.command("rephrase");await f.command("expand",2);
 const next=await f.start(3),observed=await f.submit(next.id);
 expect(observed.eligibility?.independentAttempt).toBe("no");
 expect(await fixture.sql`SELECT id FROM opening_help_exposures WHERE activity_id=${f.activity.id}`).toHaveLength(1);
 record("rewrite-chain",{old,hint,next,observed});
});

it("cross-publication help after capture preserves the original answer but qualifies its later correction",async()=>{
 const f=await seed(),old=await f.start(),original=await f.submit(old.id,"1");
 await f.command("rephrase");const next=await f.start(2);await f.hint(next.id);
 const heads=await readOpeningCourseObservationHeads(fixture.sql,fixture.scope,f.courseId);
 expect(heads.find(o=>o.id===original.id)?.eligibility?.independentAttempt).toBe("yes");
 const revised=await f.revise(original,"2");
 expect(revised.observation?.eligibility?.independentAttempt).toBe("no");
 expect((await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[original.id]}))[0]?.fresh).toBe(true);
});

it("legacy anchor-only receipt cannot become independent after publication changes",async()=>{
 const f=await seed(),old=await f.start(),hint=await f.hint(old.id);
 // Historical receipts may predate item/attempt binding. Retain actual delivery
 // and the saved activity/block/version anchor; missing association stays unknown.
 await fixture.sql`UPDATE opening_help_exposures SET item_version_id=NULL,attempt_id=NULL,problem_id=NULL WHERE id=${hint.exposureReceipt.id}`;
 await f.command("rephrase");const next=await f.start(2),observed=await f.submit(next.id);
 expect(observed.eligibility?.independentAttempt).toBe("unknown");
 expect((await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[observed.id]}))[0]?.fresh).toBe(true);
});

it.each([false,true])("multi-answer reference adoption retains only the helped question's qualification (Q2 issued=%s)",async issued=>{
 const f=await seed(true),old=await f.start();await f.hint(old.id);
 // Current pinned order proves unattempted bindings; an issued item's immutable
 // spec also proves historical bindings without guessing from block adjacency.
 if(issued) await f.service.create(fixture.scope,{sessionId:f.session.id,clientKey:randomUUID(),teachingBlock:{blockId:f.secondBlockId,contentVersion:1}});
 const changed=f.blocks.map(b=>(b.id===f.answerId||b.id===f.secondAnswerId)?{...b,content:{...b.content,answer:b.id===f.answerId?"秩为2。":"秩为3。"}}:b);
 const revision=await f.content.writeUnitBlocks(fixture.scope,f.unit.id,changed);
 await createOpeningTeachingContentService(fixture.sql).adoptReferenceRevision(fixture.scope,f.activity.id,{expectedContentVersion:1,expectedRevisionNumber:1,revisionNumber:revision.revisionNumber});
 const next=await f.start(2);
 const response=await submitHandler(new Request(`https://localhost/api/opening/attempts/${next.id}/submit`,{method:"POST",headers:{cookie:fixture.cookie,"content-type":"application/json"},body:JSON.stringify({clientKey:randomUUID(),answer:"2",outcome:"unverified",assistance:"independent",verdictSource:"self_report"})}),{params:Promise.resolve({id:next.id})});
 expect(response.status).toBe(201);const q1=await response.json();
 const second=await f.service.create(fixture.scope,{sessionId:f.session.id,clientKey:randomUUID(),teachingBlock:{blockId:f.secondBlockId,contentVersion:2}}),q2=await f.submit(second.id,"3");
 record("multi-answer-adoption",{old,next,q1,q2});
 expect(q1.eligibility?.independentAttempt).toBe("no");
 expect(q2.eligibility).toMatchObject({independentAttempt:"yes",verifiedCorrect:"unknown"});
 expect((await readOpeningCourseObservationHeads(fixture.sql,fixture.scope,f.courseId)).find(o=>o.id===q1.id)?.eligibility?.independentAttempt).toBe("no");
 // Move the mutable publication pin away from both compared revisions. Issued
 // bindings must still explain A2; don't silently rely only on the current spec.
 expect(await f.command("rephrase",2)).toMatchObject({ok:true,contentVersion:3});
 expect((await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[q1.id]}))[0]).toMatchObject({fresh:true,independent_attempt:"no",prior_question_help:true});
});

it("duplicate-position publication retains Q1 help after dual-answer adoption with Q2 unissued",async()=>{
 const f=await seed(true,false,true);
 const [published]=await fixture.sql`SELECT block_order FROM opening_teaching_activity_specs WHERE activity_id=${f.activity.id}`;
 expect(published!.block_order).toEqual(f.order);
 const stable=[...f.order].sort((a,b)=>a.position-b.position);
 const [pairs]=await fixture.sql`SELECT
  (SELECT jsonb_agg(jsonb_build_array(ref->>'blockId',answer_ref->>'blockId') ORDER BY position,ordinality)
   FROM (SELECT ref,(ref->>'position')::int AS position,ordinality,
     lead(ref) OVER (ORDER BY (ref->>'position')::int,ordinality) AS answer_ref
    FROM jsonb_array_elements(${fixture.sql.json(f.order)}) WITH ORDINALITY AS refs(ref,ordinality)) ordered) AS stable,
  (SELECT jsonb_agg(jsonb_build_array(ref->>'blockId',answer_ref->>'blockId') ORDER BY position,ordinality)
   FROM (SELECT ref,(ref->>'position')::int AS position,ordinality,
     lead(ref) OVER (ORDER BY (ref->>'position')::int) AS answer_ref
    FROM jsonb_array_elements(${fixture.sql.json(f.order)}) WITH ORDINALITY AS refs(ref,ordinality)) ordered) AS legacy`;
 const jsPairs=stable.map((ref,index)=>[ref.blockId,stable[index+1]?.blockId??null]);
 expect(pairs!.stable).toEqual(jsPairs);
 record("duplicate-position-order",{order:f.order,jsPairs,sql:pairs});
 const old=await f.start(),help=await f.hint(old.id);
 expect((await fixture.sql`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${old.itemVersionId!}`)[0]?.evaluation_spec).toMatchObject({answerBlockId:f.answerId});
 expect(await fixture.sql`SELECT id FROM opening_learning_item_versions WHERE activity_id=${f.activity.id} AND teaching_block_id=${f.secondBlockId}`).toHaveLength(0);
 const changed=f.blocks.map(b=>(b.id===f.answerId||b.id===f.secondAnswerId)?{...b,content:{...b.content,answer:"参考答案：2。"}}:b);
 const revision=await f.content.writeUnitBlocks(fixture.scope,f.unit.id,changed);
 await createOpeningTeachingContentService(fixture.sql).adoptReferenceRevision(fixture.scope,f.activity.id,{expectedContentVersion:1,expectedRevisionNumber:1,revisionNumber:revision.revisionNumber});
 const next=await f.start(2),q1=await f.submit(next.id);
 const second=await f.service.create(fixture.scope,{sessionId:f.session.id,clientKey:randomUUID(),teachingBlock:{blockId:f.secondBlockId,contentVersion:2}}),q2=await f.submit(second.id);
 expect((await fixture.sql`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${second.itemVersionId!}`)[0]?.evaluation_spec).toMatchObject({answerBlockId:f.secondAnswerId});
 record("duplicate-position-adoption",{old,help,next,q1,second,q2});
 expect(q1.eligibility?.independentAttempt).toBe("no");
 expect(q2.eligibility).toMatchObject({independentAttempt:"yes",verifiedCorrect:"unknown"});
 expect((await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[q1.id]}))[0]).toMatchObject({fresh:true,independent_attempt:"no",prior_question_help:true});
 expect(await fixture.sql`SELECT id FROM opening_help_exposures WHERE activity_id=${f.activity.id}`).toEqual([{id:help.exposureReceipt.id}]);
});

it.each(["unbound_answer","context","other_prompt","answer_metadata"] as const)("multi-question comparison preserves %s differences",async kind=>{
 const f=await seed(true,true),old=await f.start();await f.hint(old.id);
 const changed=f.blocks.map(b=>{
  if(b.id===f.answerId) return {...b,content:{...b.content,answer:"秩为2。"}};
  if(b.id===f.secondAnswerId) return {...b,content:{...b.content,answer:"秩为3。",...(kind==="answer_metadata"?{hidden:false}:{})}};
  if(kind==="unbound_answer"&&b.id===f.unboundAnswerId) return {...b,content:{...b.content,answer:"新的未绑定答案"}};
  if(kind==="context"&&b.id===f.extraBlockId) return {...b,content:{...b.content,text:"条件：仅考虑复矩阵。"}};
  if(kind==="other_prompt"&&b.id===f.secondBlockId) return {...b,content:{...b.content,text:"求四阶单位矩阵的秩。"}};
  return b;
 });
 const revision=await f.content.writeUnitBlocks(fixture.scope,f.unit.id,changed);
 await f.content.publishActivitySpec(fixture.scope,{activityId:f.activity.id,teachingUnitId:f.unit.id,expectedVersion:1,expectedRevisionNumber:1,revisionNumber:revision.revisionNumber,blockOrder:f.order,sourceRefs:f.refs});
 const next=await f.start(2),observed=await f.submit(next.id);
 expect(observed.eligibility).toMatchObject({independentAttempt:"yes",verifiedCorrect:"unknown"});
});

it.each(["before_attempt","during_attempt","after_capture","server_before_clock_after","legacy_before","legacy_after"] as const)("cross-session anchor-only cache repair respects answer capture (%s)",async timing=>{
 const postcapture=timing==="after_capture"||timing==="legacy_after";
 const f=await seed(),old=await f.start();
 const legacy=await f.hint(old.id);
 await fixture.sql`UPDATE opening_help_exposures SET item_version_id=NULL,attempt_id=NULL,problem_id=NULL WHERE id=${legacy.exposureReceipt.id}`;
 await f.command("rephrase");
 const session=await createOpeningLearningRepository(fixture.sql).createSession(fixture.scope,{courseId:f.courseId,activityId:f.activity.id,skillLabel:"矩阵秩",sourceIds:[f.sourceId]});
 const next=await f.service.create(fixture.scope,{sessionId:session.id,clientKey:randomUUID(),teachingBlock:{blockId:f.blockId,contentVersion:2}}),observed=await f.submit(next.id);
 // A newer current-question receipt already supplied the old cache's max revision.
 const mask=await f.hint(next.id);
 // Synthetic legacy import: wall-clock remains before capture, but authoritative
 // server order records delivery after it. Never call hints on a stale attempt.
 if(timing==="after_capture") await fixture.sql`UPDATE opening_help_exposures SET workspace_history_revision=(SELECT workspace_history_revision FROM opening_help_exposures WHERE id=${mask.exposureReceipt.id}) WHERE id=${legacy.exposureReceipt.id}`;
 if(timing==="during_attempt") await fixture.sql`UPDATE opening_help_exposures SET delivered_at=(SELECT started_at+(submitted_at-started_at)/2 FROM opening_learning_observations WHERE id=${observed.id}) WHERE id=${legacy.exposureReceipt.id}`;
 if(timing==="server_before_clock_after") await fixture.sql`UPDATE opening_help_exposures SET delivered_at=(SELECT submitted_at+interval '1 hour' FROM opening_learning_observations WHERE id=${observed.id}) WHERE id=${legacy.exposureReceipt.id}`;
 if(timing==="legacy_before"||timing==="legacy_after") await fixture.sql`UPDATE opening_help_exposures SET workspace_history_revision=NULL,delivered_at=(SELECT submitted_at+${timing==="legacy_after"?1:-1}*interval '1 hour' FROM opening_learning_observations WHERE id=${observed.id}) WHERE id=${legacy.exposureReceipt.id}`;
 const before=await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${observed.id}`;
 await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:10});
 const [live]=await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[observed.id]});
 await fixture.sql`UPDATE opening_learning_eligibility SET independent_attempt='yes',reason_codes=ARRAY[]::text[],help_revision=${Number(live!.live_help_revision)} WHERE root_observation_id=${observed.id}`;
 const [warm]=await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[observed.id]});
 const evidence=await readOpeningLearningEvidenceContext(fixture.sql,fixture.scope,observed);
 const domain=evaluateEvidenceEligibility(evidence.observation,evidence.context);
 const receiptsBeforeRepair=await fixture.sql`SELECT * FROM opening_help_exposures WHERE id IN (${legacy.exposureReceipt.id},${mask.exposureReceipt.id}) ORDER BY id`;
 expect(domain.independentAttempt).toBe(postcapture?"yes":"unknown");
 if(!postcapture) expect(domain.reasonCodes).toContain("help_association_unknown");
 record("anchor-masked-cache",{timing,postcapture,legacy,mask,observed,warm,domain});
 expect(warm?.fresh).toBe(postcapture);
 expect((await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:10})).status).toBe("ready");
 const [repaired]=await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[observed.id]});
 expect(repaired).toMatchObject({fresh:true,independent_attempt:postcapture?"yes":"unknown"});
 if(!postcapture) expect(repaired?.reason_codes).toContain("help_association_unknown");
 expect(await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${observed.id}`).toEqual(before);
 expect(await fixture.sql`SELECT * FROM opening_help_exposures WHERE id IN (${legacy.exposureReceipt.id},${mask.exposureReceipt.id}) ORDER BY id`).toEqual(receiptsBeforeRepair);
});

it.each([false,true])("anchor-only masked cache follows the last changed answer, not metadata head (changed=%s)",async changed=>{
 const f=await seed(),old=await f.start(),legacy=await f.hint(old.id);
 await fixture.sql`UPDATE opening_help_exposures SET item_version_id=NULL,attempt_id=NULL,problem_id=NULL WHERE id=${legacy.exposureReceipt.id}`;
 await f.command("rephrase");
 const session=await createOpeningLearningRepository(fixture.sql).createSession(fixture.scope,{courseId:f.courseId,activityId:f.activity.id,skillLabel:"矩阵秩",sourceIds:[f.sourceId]});
 const next=await f.service.create(fixture.scope,{sessionId:session.id,clientKey:randomUUID(),teachingBlock:{blockId:f.blockId,contentVersion:2}}),original=await f.submit(next.id,"1"),mask=await f.hint(next.id);
 // Imported legacy delivery is after the original answer but before correction.
 await fixture.sql`UPDATE opening_help_exposures SET workspace_history_revision=(SELECT workspace_history_revision FROM opening_help_exposures WHERE id=${mask.exposureReceipt.id}) WHERE id=${legacy.exposureReceipt.id}`;
 // Make the masking receipt instruction-only so only legacy association matters.
 await fixture.sql`UPDATE opening_help_exposures SET kind='instruction' WHERE id=${mask.exposureReceipt.id}`;
 const replacement=await f.revise(original,changed?"2":"1");
 const head=replacement.observation!;
 // One additional metadata-only revision must retain the latest answer event.
 const metadata=(await f.revise(head,head.answer!)).observation!;
 expect(metadata.eligibility?.independentAttempt).toBe(changed?"unknown":"yes");
 const [live]=await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[original.id]});
 await fixture.sql`UPDATE opening_learning_eligibility SET independent_attempt='yes',reason_codes=ARRAY[]::text[],help_revision=${Number(live!.live_help_revision)} WHERE root_observation_id=${original.id}`;
 expect((await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[original.id]}))[0]?.fresh).toBe(!changed);
 await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:10});
 expect((await openingEligibilityStateQuery(fixture.sql,fixture.scope,{rootIds:[original.id]}))[0]).toMatchObject({fresh:true,independent_attempt:changed?"unknown":"yes"});
});

it("authenticated HTTP rephrase preserves old help qualification on subsequent submission",async()=>{
 const f=await seed(),old=await f.start();await f.hint(old.id);
 const request=new Request("https://localhost/api/opening/teaching/activities/"+f.activity.id+"/commands",{method:"POST",headers:{cookie:fixture.cookie,"content-type":"application/json"},body:JSON.stringify({clientKey:randomUUID(),kind:"rephrase",blockId:f.blockId,expectedVersion:1,prompt:"解释得更清楚"})});
 const response=await commandHandler(request,{params:Promise.resolve({id:f.activity.id})});
 const result=await response.json();record("handler-command",{status:response.status,result});expect(response.status).toBe(200);expect(result).toMatchObject({ok:true,contentVersion:2});
 const requestFor=(path:string,body:unknown)=>new Request(`https://localhost/api/opening/${path}`,{method:"POST",headers:{cookie:fixture.cookie,"content-type":"application/json"},body:JSON.stringify(body)});
 const attemptResponse=await attemptHandler(requestFor("attempts",{sessionId:f.session.id,clientKey:randomUUID(),teachingBlock:{blockId:f.blockId,contentVersion:2}}));
 expect(attemptResponse.status).toBe(201);const next=await attemptResponse.json();
 const submitResponse=await submitHandler(requestFor(`attempts/${next.id}/submit`,{clientKey:randomUUID(),answer:"2",outcome:"unverified",assistance:"independent",verdictSource:"self_report"}),{params:Promise.resolve({id:next.id})});
 expect(submitResponse.status).toBe(201);const observed=await submitResponse.json();
 record("handler-followup",{old,next,observed});
 expect(observed.eligibility).toMatchObject({independentAttempt:"no",verifiedCorrect:"unknown"});
 expect(observed.allowsIndependent).toBe(false);expect(observed.evidenceVerdict).toBe("MASTERY_NOT_ESTABLISHED");
});
