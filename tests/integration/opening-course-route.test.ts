import { randomUUID } from "node:crypto";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import type { CourseRouteRequirementInput,CourseRouteActionResult,TeachingActivity } from "@aistudy/contracts";
import { createOpeningLearningGoalRepository,createOpeningLearningRepository,createOpeningAiGradingRepository,createOpeningSourceChunksRepository,
  createOpeningBudgetRepository,createOpeningPrivacyRepository,createOpeningTeachingContentRepository,createOpeningJobRepository,createWorkspacePreferencesRepository,createOpeningRetestActivityRepository,createOpeningTeachingHintRepository } from "@aistudy/database";
import { createOpeningCourseRouteRetestRepository } from "../../packages/database/src/repositories/opening-course-route-retest";
import { assertOpeningCourseRouteReady } from "../../packages/database/src/repositories/opening-course-route-origin";
import { createOpeningCourseRouteVerificationRepository } from "../../packages/database/src/repositories/opening-course-route-verification";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { validateBackupRetestProtocols } from "../../packages/domain/src/opening/backup-retest-protocol";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createCompileTeachingUnitHandler } from "../../apps/worker/src/jobs/compile-teaching-unit";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { rankPedagogy } from "../fixtures/opening/teaching/rank-pedagogy";
import { createOpeningFixture,type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
let f:OpeningFixture;
beforeEach(async()=>{f=await createOpeningFixture();vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED","1");vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED","0");});
afterEach(async()=>{vi.unstubAllEnvs();await f?.close();});
const ready=(value:CourseRouteActionResult)=>{expect(value.kind).toBe("ready");if(value.kind!=="ready")throw new Error(JSON.stringify(value));return value;};
async function seed(count=1){
  const courseId=randomUUID(),rows=backupRows(f.sql,f.scope),sourceId=await rows.source(),chunkId=await rows.chunk(sourceId);
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug)VALUES(${courseId},${f.scope.workspaceId},'Course route',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goals=createOpeningLearningGoalRepository(f.sql),goal=await goals.create(f.scope,{clientKey:randomUUID(),courseIds:[courseId],title:"掌握全课",kind:"custom",targetDate:null,
    examDate:null,weeklyMinutes:120,priority:1,learningMode:"understand",successCriteria:"各要求可独立解释并迁移"});
  const requirements:CourseRouteRequirementInput[]=Array.from({length:count},(_,position)=>({id:randomUUID(),stableSkillId:randomUUID(),knowledgeNodeId:null,requirementKey:`requirement:${position}`,
    title:`矩阵秩${position}`,position,mandatory:true,goalIds:[goal.id],prerequisiteIds:[],sourceRefs:[{sourceId,sourceVersion:1,chunkId}],
    verification:{kind:"rubric",status:"ready",exerciseKeys:["saved-teaching-question"],rubric:"正确应用秩与零空间维数之和等于列数，并说明依据。",missingReasons:[]},origin:"confirmed"}));
  const repo=createOpeningCourseRouteRepository(f.sql,{compilerEnabled:true});
  await repo.confirm(f.scope,courseId,{expectedRevisions:[],requirements,confirmScope:true});
  const start=(index=0,clientKey=randomUUID())=>repo.start(f.scope,courseId,{goalId:goal.id,expectedGoalRevision:1,requirementId:requirements[index]!.id,expectedRequirementRevision:1,clientKey,minutes:20});
  return {courseId,sourceId,chunkId,goals,goal,requirements,repo,start};
}
/** Real job/library/publish/attempt flow; only the model response is a controlled fixture. No external model is called. */
async function compile(activity:TeachingActivity,variant=0){
  const deps=createCompileTeachingUnitWorkerDeps(f.sql,{budget:createOpeningBudgetRepository(f.sql),chunks:createOpeningSourceChunksRepository(f.sql),privacy:createOpeningPrivacyRepository(f.sql)});
  deps.buildProviderInput=async()=>({instruction:"教学编译测试",text:activity.intentSummary,chunks:await createOpeningSourceChunksRepository(f.sql).listForSources(f.scope,activity.sourceIds),mode:"explain",maxOutputTokens:5500,mediaCapability:"text_only",imageParts:[],outputFormat:"json"});
  deps.callModel=async(_scope,_input,options)=>{await options.beforeSend?.();return {text:JSON.stringify({itemTitles:["秩与零空间"],blocks:[
    {type:"text",text:"秩与零空间维数之和等于列数。"},
    {type:"prompt",text:`一个3×${5+variant*3}矩阵的秩为2，零空间维数是多少？`},{type:"answer_key",...rankPedagogy,text:`${5+variant*3} − 2 = ${3+variant*3}`,hints:{direction:"先找列数。",concept:"秩与零空间维数之和等于列数。",firstStep:`用${5+variant*3}减去2。`}},
    {type:"text",text:"再换一个列数验证。"},
    {type:"prompt",text:`一个3×${4+variant*3}矩阵的秩为2，零空间维数是多少？`},{type:"answer_key",...rankPedagogy,text:`${4+variant*3} − 2 = ${2+variant*3}`,hints:{direction:"先找列数。",concept:"秩与零空间维数之和等于列数。",firstStep:`用${4+variant*3}减去2。`}},
  ]}),citedChunkIds:[],requestId:null,candidates:[],inputTokens:10,outputTokens:10};};
  const [row]=await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} AND kind='compile-teaching-unit' AND payload->>'activityId'=${activity.id}`;
  const job=await createOpeningJobRepository(f.sql).claim(String(row!.id));expect(job).not.toBeNull();
  await createCompileTeachingUnitHandler(deps)(job!,job!.payload);
  const content=createOpeningTeachingContentRepository(f.sql),spec=await content.getActivitySpec(f.scope,activity.id);expect(spec?.version).toBe(1);
  return spec!;
}
async function answer(activity:TeachingActivity,index=0,outcome:"correct"|"incorrect"="correct",assistance:"independent"|"hinted"="independent",grade=true){
  const spec=await createOpeningTeachingContentRepository(f.sql).getActivitySpec(f.scope,activity.id),blocks=spec!.blockOrder.filter(row=>row.role==="prompt");
  const session=await createOpeningLearningRepository(f.sql).createSession(f.scope,{activityId:activity.id,courseId:activity.courseId!,skillLabel:activity.learnerFocus!.skillLabel,sourceIds:activity.sourceIds});
  const service=createOpeningAttemptService(f.sql),attempt=await service.create(f.scope,{sessionId:session.id,clientKey:randomUUID(),teachingBlock:{blockId:blocks[index]!.blockId,contentVersion:1}});
  const columns=Number(attempt.stemSnapshot!.match(/3×(\d+)/u)![1]);
  const original=await service.submit(f.scope,attempt.id,{clientKey:randomUUID(),answer:outcome==="correct"?String(columns-2):"-99",outcome:"unverified",assistance,verdictSource:"self_report"});
  const observation=grade?await createOpeningAiGradingRepository(f.sql).apply(f.scope,{observationId:original.id},{outcome,confidence:.99,questionMatch:true,feedback:"按保存的秩与零空间标准核对。",criteria:[{label:"秩与零空间",verdict:outcome,feedback:"核对列数减秩。"}]},"controlled-fixture"):original;
  return {attempt,observation,session};
}
it("reads all 45 confirmed requirements including material gaps and replays confirmation without revision churn",async()=>{
  const x=await seed(45),snapshot=await x.repo.read(f.scope,x.courseId);expect(snapshot.summary.total).toBe(45);
  const list=x.requirements.map((row,index)=>index===44?{...row,sourceRefs:[],verification:{...row.verification,status:"missing" as const,missingReasons:["缺习题材料"]}}:row);
  const updated=await x.repo.confirm(f.scope,x.courseId,{expectedRevisions:snapshot.requirements.map(row=>({id:row.requirement.id,revision:row.requirement.revision})),requirements:list,confirmScope:true});
  expect(updated.requirements).toHaveLength(45);expect(updated.requirements[44]!.status).toBe("blocked");
  expect((await x.repo.confirm(f.scope,x.courseId,{expectedRevisions:[],requirements:list,confirmScope:true})).requirements[0]!.requirement.revision).toBe(1);
  expect(updated.requirements[44]!.requirement.revision).toBe(2);
});
it("creates and compiles a real question, keeps canonical requirement identity, corrects a failed answer and refresh-replays next",async()=>{
  const x=await seed(),one=ready(await x.start());expect(one.activity).toMatchObject({generateStatus:"queued",contentVersion:0,routeManaged:true});
  await compile(one.activity);const result=await answer(one.activity,0,"incorrect");
  expect(result.attempt.requirementKey).toBe(x.requirements[0]!.requirementKey);
  const snapshot=await x.repo.read(f.scope,x.courseId,one.activity.id);expect(snapshot.observationId).toBe(result.observation.id);
  const request={goalId:x.goal.id,expectedGoalRevision:1,activityId:one.activity.id,expectedPathVersion:snapshot.currentActivity!.pathVersion,observationId:snapshot.observationId,clientKey:randomUUID(),minutes:20};
  const next=ready(await x.repo.next(f.scope,x.courseId,request));expect(next.action).toBe("targeted_explain");
  const refreshed=await x.repo.read(f.scope,x.courseId,one.activity.id);
  expect(ready(await x.repo.next(f.scope,x.courseId,{...request,clientKey:randomUUID(),expectedPathVersion:refreshed.currentActivity!.pathVersion})).activity.id).toBe(next.activity.id);
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(2);
});
it("returns configuration without creating an empty activity, and rejects stale formal goal starts",async()=>{
  const x=await seed(),repo=createOpeningCourseRouteRepository(f.sql,{compilerEnabled:false});
  expect(await repo.start(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,requirementId:x.requirements[0]!.id,expectedRequirementRevision:1,clientKey:randomUUID(),minutes:20})).toMatchObject({kind:"choice",reason:"configuration"});
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(0);
  await x.goals.update(f.scope,x.goal.id,{expectedRevision:1,lifecycle:"paused"});await expect(x.start()).rejects.toMatchObject({code:"CONFLICT"});
});
it("preserves old attempts while changed goal or source prevents new questions",async()=>{
  const x=await seed(),one=ready(await x.start());await compile(one.activity);const old=await answer(one.activity);
  const spec=await createOpeningTeachingContentRepository(f.sql).getActivitySpec(f.scope,one.activity.id),service=createOpeningAttemptService(f.sql);
  await x.goals.update(f.scope,x.goal.id,{expectedRevision:1,successCriteria:"新增证明标准"});
  await expect(service.create(f.scope,{sessionId:old.session.id,clientKey:randomUUID(),teachingBlock:{blockId:spec!.blockOrder.find(row=>row.role==="prompt")!.blockId,contentVersion:1}})).rejects.toMatchObject({code:"CONFLICT"});
  expect((await service.getContext(f.scope,old.attempt.id)).attempt.id).toBe(old.attempt.id);
});
it("does not bump unchanged requirement revisions and blocks a vanished reference chunk",async()=>{
  const x=await seed(2),one=ready(await x.start());await compile(one.activity);await answer(one.activity,0);await answer(one.activity,1);
  const before=await x.repo.read(f.scope,x.courseId);expect(before.requirements[0]!.status).toBe("verified");
  const changed=x.requirements.map((row,index)=>index===1?{...row,title:"只编辑第二项"}:row);
  const after=await x.repo.confirm(f.scope,x.courseId,{expectedRevisions:before.requirements.map(row=>({id:row.requirement.id,revision:1})),requirements:changed,confirmScope:true});
  expect(after.requirements[0]).toMatchObject({status:"verified",requirement:{revision:1}});expect(after.requirements[1]!.requirement.revision).toBe(2);
  await f.sql`DELETE FROM opening_source_chunks WHERE id=${x.chunkId}`;
  expect((await x.repo.read(f.scope,x.courseId)).requirements[0]!.sourcesAvailable).toBe(false);
  await expect(assertOpeningCourseRouteReady(f.sql,f.scope,one.activity.id)).rejects.toMatchObject({code:"CONFLICT"});
});
it("rejects model-send and new publication after the actual course is archived",async()=>{
  const x=await seed(),one=ready(await x.start());await compile(one.activity);
  await f.sql`UPDATE courses SET archived_at=now() WHERE id=${x.courseId} AND workspace_id=${f.scope.workspaceId}`;
  await expect(assertOpeningCourseRouteReady(f.sql,f.scope,one.activity.id)).rejects.toMatchObject({code:"NOT_FOUND"});
  const content=createOpeningTeachingContentRepository(f.sql),spec=(await content.getActivitySpec(f.scope,one.activity.id))!;
  await expect(content.publishActivitySpec(f.scope,{activityId:one.activity.id,teachingUnitId:spec.teachingUnitId,expectedVersion:1,revisionNumber:spec.revisionNumber,
    blockOrder:spec.blockOrder,sourceRefs:spec.sourceRefs})).rejects.toMatchObject({code:"NOT_FOUND"});
});
/** Test-only clock fixture: move the immutable fixture's whole baseline chronology together, never a production clock override. */
async function ageBaseline(courseId:string){
  await f.sql`UPDATE opening_learning_attempts SET started_at=started_at-interval '4 days',submitted_at=submitted_at-interval '4 days' WHERE course_id=${courseId} AND workspace_id=${f.scope.workspaceId}`;
  await f.sql`UPDATE opening_learning_observations SET started_at=started_at-interval '4 days',submitted_at=submitted_at-interval '4 days',recorded_at=recorded_at-interval '4 days',occurred_at=occurred_at-interval '4 days'
    WHERE course_id=${courseId} AND workspace_id=${f.scope.workspaceId}`;
}
async function delayedSeed(twoChecks=false){
  const x=await seed();await createWorkspacePreferencesRepository(f.sql).setLearningPreferences(f.scope,{assessmentEnabled:true,retestSuggestionsEnabled:true,automaticRemindersEnabled:false});
  const baseline=ready(await x.start());await compile(baseline.activity);let answered=await answer(baseline.activity);
  if(twoChecks)answered=await answer(baseline.activity,1);
  await ageBaseline(x.courseId);
  const retests=createOpeningCourseRouteRetestRepository(f.sql),snapshot=await x.repo.read(f.scope,x.courseId,baseline.activity.id);
  const request={goalId:x.goal.id,expectedGoalRevision:1,activityId:baseline.activity.id,expectedPathVersion:snapshot.currentActivity!.pathVersion,
    observationId:answered.observation.id,clientKey:randomUUID(),minutes:20};
  const receipt=await retests.schedule(f.scope,x.courseId,request),context=await retests.readTask(f.scope,x.courseId,receipt.taskId);
  expect(context.managed).toBe(true);if(!context.managed)throw new Error("Expected managed retest");
  const started=ready(await x.repo.start(f.scope,x.courseId,{goalId:context.goalId,expectedGoalRevision:context.expectedGoalRevision,requirementId:context.requirementId,
    expectedRequirementRevision:context.expectedRequirementRevision,taskId:context.taskId,expectedTaskVersion:context.expectedTaskVersion,minutes:context.minutes,clientKey:randomUUID()}));
  await compile(started.activity,1);
  return {...x,retests,receipt,request,started,baselineAnswer:answered};
}
it.each(["passed","failed","assisted","insufficient_evidence"] as const)("connects a real generic delayed retest %s to the actual next action",async branch=>{
  const x=await delayedSeed(),result=await answer(x.started.activity,0,branch==="failed"?"incorrect":"correct",branch==="assisted"?"hinted":"independent",branch!=="insufficient_evidence");
  const snapshot=await x.repo.read(f.scope,x.courseId,x.started.activity.id);
  expect(snapshot.requirements[0]!.delayedCheck?.status).toBe(branch);
  const next=await x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,activityId:x.started.activity.id,expectedPathVersion:snapshot.currentActivity!.pathVersion,
    observationId:result.observation.id,clientKey:randomUUID(),minutes:20});
  if(branch==="insufficient_evidence")expect(next).toMatchObject({kind:"choice",reason:"evidence_unknown"});
  else expect(ready(next).action).toBe(branch==="failed"?"targeted_explain":branch==="assisted"?"reduced_help_practice":"comprehensive");
  const [fact]=await f.sql`SELECT retest_id FROM opening_learning_observations WHERE id=${result.observation.id}`;expect(fact!.retest_id).toBe(x.receipt.retestId);
  if(branch==="passed"){const snapshot=await readOpeningBackupRecords(f.sql,f.scope),errors:string[]=[];validateBackupRetestProtocols(snapshot.tables,errors);expect(errors).toEqual([]);}
});
it.each(["cancelled","expired"] as const)("keeps a real %s delayed retest terminal and does not resurrect it on receipts or next",async branch=>{
  const x=await delayedSeed();
  if(branch==="cancelled")await createOpeningRetestActivityRepository(f.sql).transition(f.scope,x.receipt.retestId,{type:"cancel",at:new Date().toISOString()});
  else await f.sql`UPDATE opening_retest_activities SET deadline_at=now()-interval '1 minute' WHERE id=${x.receipt.retestId}`;
  const snapshot=await x.repo.read(f.scope,x.courseId,x.started.activity.id);
  expect(snapshot.requirements[0]!.delayedCheck?.status).toBe(branch);
  const next=await x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,activityId:x.started.activity.id,expectedPathVersion:snapshot.currentActivity!.pathVersion,
    observationId:null,clientKey:randomUUID(),minutes:20});expect(next).toMatchObject({kind:"choice",reason:branch==="cancelled"?"retest_cancelled":"retest_expired"});
  const replay=await x.retests.schedule(f.scope,x.courseId,x.request);expect(replay.retestId).toBe(x.receipt.retestId);
  await expect(assertOpeningCourseRouteReady(f.sql,f.scope,x.started.activity.id)).rejects.toMatchObject({code:"CONFLICT"});
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(2);
});
it("uses real interval help to choose reduced-help correction even after two prior independent checks",async()=>{
  const x=await delayedSeed(true);
  await createOpeningTeachingHintRepository(f.sql).read(f.scope,{attemptId:x.baselineAnswer.attempt.id,level:1});
  const result=await answer(x.started.activity),snapshot=await x.repo.read(f.scope,x.courseId,x.started.activity.id);
  expect(snapshot.requirements[0]!.delayedCheck?.status).toBe("assisted");
  expect(ready(await x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,activityId:x.started.activity.id,
    expectedPathVersion:snapshot.currentActivity!.pathVersion,observationId:result.observation.id,clientKey:randomUUID(),minutes:20})).action).toBe("reduced_help_practice");
});
it.each(["cancelled","expired"] as const)("preserves an already-issued %s answer and old hint receipt, while refusing new questions/help",async branch=>{
  const x=await delayedSeed(),content=createOpeningTeachingContentRepository(f.sql),spec=(await content.getActivitySpec(f.scope,x.started.activity.id))!;
  const session=await createOpeningLearningRepository(f.sql).createSession(f.scope,{courseId:x.courseId,activityId:x.started.activity.id,
    skillLabel:x.started.activity.learnerFocus!.skillLabel,sourceIds:[x.sourceId]});
  const service=createOpeningAttemptService(f.sql),request={sessionId:session.id,clientKey:randomUUID(),teachingBlock:{blockId:spec.blockOrder.find(row=>row.role==="prompt")!.blockId,contentVersion:1}};
  const attempt=await service.create(f.scope,request),hints=createOpeningTeachingHintRepository(f.sql),oldHint=await hints.read(f.scope,{attemptId:attempt.id,level:1});
  if(branch==="cancelled")await createOpeningRetestActivityRepository(f.sql).transition(f.scope,x.receipt.retestId,{type:"cancel",at:new Date().toISOString()});
  else await f.sql`UPDATE opening_retest_activities SET deadline_at=now()-interval '1 minute' WHERE id=${x.receipt.retestId}`;
  expect((await service.create(f.scope,request)).id).toBe(attempt.id);
  const fact=await service.submit(f.scope,attempt.id,{clientKey:randomUUID(),answer:"6",outcome:"unverified",assistance:"independent",verdictSource:"self_report"});
  expect(fact.retestId).toBe(x.receipt.retestId);
  expect(await hints.read(f.scope,{attemptId:attempt.id,level:1})).toEqual(oldHint);
  await expect(hints.read(f.scope,{attemptId:attempt.id,level:2})).rejects.toMatchObject({code:"CONFLICT"});
  await expect(service.create(f.scope,{...request,clientKey:randomUUID()})).rejects.toMatchObject({code:"CONFLICT"});
  expect((await x.repo.read(f.scope,x.courseId)).requirements[0]!.delayedCheck?.status).toBe(branch);
});
it("creates a prerequisite repair activity and really returns to its original requirement",async()=>{
  const x=await seed(2),snapshot=await x.repo.read(f.scope,x.courseId),list=x.requirements.map((row,index)=>index===1?{...row,prerequisiteIds:[x.requirements[0]!.id]}:row);
  await x.repo.confirm(f.scope,x.courseId,{expectedRevisions:snapshot.requirements.map(row=>({id:row.requirement.id,revision:1})),requirements:list,confirmScope:true});
  const basic=ready(await x.start());await compile(basic.activity);await answer(basic.activity,0,"incorrect");
  const repair=ready(await x.repo.start(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,requirementId:x.requirements[1]!.id,expectedRequirementRevision:2,clientKey:randomUUID(),minutes:20}));
  expect(repair).toMatchObject({requirementId:x.requirements[0]!.id,action:"prerequisite"});
  await compile(repair.activity,2);const firstCheck=await answer(repair.activity,0);
  const firstSnapshot=await x.repo.read(f.scope,x.courseId,repair.activity.id),practice=ready(await x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,
    activityId:repair.activity.id,expectedPathVersion:firstSnapshot.currentActivity!.pathVersion,observationId:firstCheck.observation.id,clientKey:randomUUID(),minutes:20}));
  expect(practice).toMatchObject({requirementId:x.requirements[0]!.id,action:"transfer_check"});
  await compile(practice.activity,3);const checked=await answer(practice.activity);
  const current=await x.repo.read(f.scope,x.courseId,practice.activity.id),returned=ready(await x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,
    activityId:practice.activity.id,expectedPathVersion:current.currentActivity!.pathVersion,observationId:checked.observation.id,clientKey:randomUUID(),minutes:20}));
  expect(returned).toMatchObject({requirementId:x.requirements[1]!.id,action:"return"});expect(returned.activity.id).not.toBe(repair.activity.id);
});
it("runs a separate comprehensive check for every requirement before an idempotent current-scope finish",async()=>{
  const x=await seed(2),a=ready(await x.start(0));await compile(a.activity,0);await answer(a.activity,0);await answer(a.activity,1);
  const b=ready(await x.start(1));await compile(b.activity,1);await answer(b.activity,0);const result=await answer(b.activity,1);
  async function next(activity:TeachingActivity,observationId:string){const current=await x.repo.read(f.scope,x.courseId,activity.id);return x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,
    expectedGoalRevision:1,activityId:activity.id,expectedPathVersion:current.currentActivity!.pathVersion,observationId,clientKey:randomUUID(),minutes:20});}
  const first=ready(await next(b.activity,result.observation.id));expect(first).toMatchObject({action:"comprehensive",requirementId:x.requirements[0]!.id});
  await compile(first.activity,3);const checkedA=await answer(first.activity);const second=ready(await next(first.activity,checkedA.observation.id));
  expect(second).toMatchObject({action:"comprehensive",requirementId:x.requirements[1]!.id});
  await compile(second.activity,4);const checkedB=await answer(second.activity);
  expect(await next(second.activity,checkedB.observation.id)).toMatchObject({kind:"choice",reason:"course_complete"});
  expect(await next(second.activity,checkedB.observation.id)).toMatchObject({kind:"choice",reason:"course_complete"});
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(4);
});
it("makes a real saved submitted question usable only after explicit verification confirmation, without upgrading old answers",async()=>{
  const x=await seed();await x.repo.read(f.scope,x.courseId);const definition={...x.requirements[0]!,verification:{...x.requirements[0]!.verification,status:"needs_check" as const,exerciseKeys:[]}};
  await x.repo.confirm(f.scope,x.courseId,{expectedRevisions:[{id:definition.id,revision:1}],requirements:[definition],confirmScope:true});
  const started=ready(await x.repo.start(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,requirementId:definition.id,expectedRequirementRevision:2,clientKey:randomUUID(),minutes:20}));
  await compile(started.activity);const answerA=await answer(started.activity),verification=createOpeningCourseRouteVerificationRepository(f.sql);
  const view=await verification.read(f.scope,x.courseId,started.activity.id);expect(view.available).toBe(true);expect(view.items).toHaveLength(1);
  const input={goalId:x.goal.id,expectedGoalRevision:1,activityId:started.activity.id,expectedContentVersion:1,requirementId:definition.id,expectedRequirementRevision:2,
    itemVersionIds:[answerA.attempt.itemVersionId!],confirmed:true as const};
  const confirmed=await verification.confirm(f.scope,x.courseId,input);expect(confirmed.requirements[0]).toMatchObject({status:"unobserved",requirement:{revision:3,verification:{status:"ready"}}});
  expect((await verification.confirm(f.scope,x.courseId,input)).requirements[0]!.requirement.revision).toBe(3);
  expect(ready(await x.repo.start(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,requirementId:definition.id,expectedRequirementRevision:3,clientKey:randomUUID(),minutes:20})).activity.id).not.toBe(started.activity.id);
  await expect(verification.confirm(f.otherScope,x.courseId,input)).rejects.toMatchObject({code:"NOT_FOUND"});
});
it("does not confirm a saved question against another goal or a later requirement standard",async()=>{
  const x=await seed(),definition={...x.requirements[0]!,verification:{...x.requirements[0]!.verification,status:"needs_check" as const,exerciseKeys:[]}};
  await x.repo.confirm(f.scope,x.courseId,{expectedRevisions:[{id:definition.id,revision:1}],requirements:[definition],confirmScope:true});
  const started=ready(await x.repo.start(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,requirementId:definition.id,expectedRequirementRevision:2,clientKey:randomUUID(),minutes:20}));
  await compile(started.activity);const answered=await answer(started.activity),verification=createOpeningCourseRouteVerificationRepository(f.sql);
  const input={goalId:x.goal.id,expectedGoalRevision:1,activityId:started.activity.id,expectedContentVersion:1,requirementId:definition.id,expectedRequirementRevision:2,itemVersionIds:[answered.attempt.itemVersionId!],confirmed:true as const};
  const otherGoal=await x.goals.create(f.scope,{clientKey:randomUUID(),courseIds:[x.courseId],title:"第二目标",kind:"custom",targetDate:null,examDate:null,weeklyMinutes:60,
    priority:1,learningMode:"understand",successCriteria:"另一标准"});
  await expect(verification.confirm(f.scope,x.courseId,{...input,goalId:otherGoal.id})).rejects.toMatchObject({code:"CONFLICT"});
  const view=await verification.read(f.scope,x.courseId,started.activity.id);expect(view.items[0]!.referenceText).toContain("5 − 2 = 3");
  await x.repo.confirm(f.scope,x.courseId,{expectedRevisions:[{id:definition.id,revision:2}],requirements:[{...definition,verification:{...definition.verification,rubric:"新增必须给出证明的新标准"}}],confirmScope:true});
  expect(await verification.read(f.scope,x.courseId,started.activity.id)).toMatchObject({available:false,items:[]});
  await expect(verification.confirm(f.scope,x.courseId,{...input,expectedRequirementRevision:3})).rejects.toMatchObject({code:"CONFLICT"});
  expect((await x.repo.read(f.scope,x.courseId)).requirements[0]!.requirement.verification.status).toBe("needs_check");
});
