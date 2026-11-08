import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CourseRouteRequirementInput, TeachingActivity } from "@aistudy/contracts";
import { createOpeningLearningGoalRepository, createOpeningLearningRepository, createOpeningAiGradingRepository, createOpeningSourceChunksRepository,
  createOpeningBudgetRepository, createOpeningPrivacyRepository, createOpeningTeachingContentRepository, createOpeningJobRepository,
  createOpeningTeachingHintRepository, createOpeningKnowledgeRepository } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { createOpeningCourseRouteVerificationRepository } from "../../packages/database/src/repositories/opening-course-route-verification";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createCompileTeachingUnitHandler } from "../../apps/worker/src/jobs/compile-teaching-unit";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { rankPedagogy } from "../fixtures/opening/teaching/rank-pedagogy";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { controlledCourseGrading } from "./opening-controlled-grade-fixture";
import { evaluateOpeningTeachingKeyAttempt } from "../../packages/database/src/repositories/opening-teaching-question-evaluation";
let f: OpeningFixture;
let gradingFixture: ReturnType<typeof controlledCourseGrading>;
beforeEach(async () => { f=await createOpeningFixture(); gradingFixture=controlledCourseGrading(); vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED","1"); vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED","0"); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f?.close(); });
async function setup() {
  const courseId=randomUUID(), rows=backupRows(f.sql,f.scope), sourceId=await rows.source("uploaded",1), chunkId=await rows.chunk(sourceId,1);
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Verification policy',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal=await createOpeningLearningGoalRepository(f.sql).create(f.scope,{clientKey:randomUUID(),courseIds:[courseId],title:"掌握全课",kind:"custom",targetDate:null,examDate:null,weeklyMinutes:120,priority:1,learningMode:"understand",successCriteria:"独立解释"});
  const requirement:CourseRouteRequirementInput={id:randomUUID(),stableSkillId:randomUUID(),knowledgeNodeId:null,requirementKey:"rank",title:"矩阵秩",position:0,mandatory:true,goalIds:[goal.id],prerequisiteIds:[],sourceRefs:[{sourceId,sourceVersion:1,chunkId}],verification:{kind:"rubric",status:"ready",exerciseKeys:["forged"],rubric:"正确应用秩与零空间维数之和等于列数，并说明依据。",missingReasons:[]},origin:"confirmed"};
  const route=createOpeningCourseRouteRepository(f.sql,{compilerEnabled:true});
  return {courseId, sourceId, chunkId, rows, goal, requirement, route};
}
/** Real job/library/publish/attempt flow; only the model response is a controlled fixture. No external model is called. */
async function compile(activity:TeachingActivity,variant=0,arithmetic=false){
  const deps=createCompileTeachingUnitWorkerDeps(f.sql,{budget:createOpeningBudgetRepository(f.sql),chunks:createOpeningSourceChunksRepository(f.sql),privacy:createOpeningPrivacyRepository(f.sql)});
  // Arithmetic exercises keep the production input builder as well as publish/evaluation wiring.
  if(!arithmetic)deps.buildProviderInput=async()=>({instruction:"教学编译测试",text:activity.intentSummary,chunks:await createOpeningSourceChunksRepository(f.sql).listForSources(f.scope,activity.sourceIds),mode:"explain",maxOutputTokens:5500,mediaCapability:"text_only",imageParts:[],outputFormat:"json"});
  deps.callModel=async(_scope,input,options)=>{await options.beforeSend?.();expect(input.chunks.length).toBeGreaterThan(0);return {text:JSON.stringify({itemTitles:[arithmetic?"数值运算":"秩与零空间"],blocks:arithmetic?[
    {type:"text",text:"加法可以按位计算，并通过减法核对。",citedChunkIds:input.chunks.map(chunk=>chunk.id)},
    ...[0,1].flatMap(index=>{
      const left=12+variant*10+index, right=7+index;
      return [{type:"prompt",text:`${left}+${right}`,interaction:{kind:"numeric"}},
        {type:"answer_key",text:String(left+right),hints:{direction:"按位相加。",concept:"相同数位的值相加，满十进一。",firstStep:`先对齐${left}和${right}的个位。`},
          misconceptions:[
            {id:"subtract",manifestation:"把加号当成减号。",reason:"没有按题目的运算符计算。",correction:"先确认加号，再相加。"},
            {id:"place_value",manifestation:"把不同数位相加。",reason:"没有对齐数位。",correction:"先将个位与个位对齐。"},
          ],startChoice:{correct:{step:"先对齐个位。",why:"相同数位才能直接相加。"},misconception:{step:"把加号改成减号。",why:"这改变了题目的运算。",misconceptionId:"subtract"}}}];
    }),
  ]:[
    {type:"text",text:"秩与零空间维数之和等于列数。",citedChunkIds:input.chunks.map(chunk=>chunk.id)},
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
  if(assistance==="hinted")await createOpeningTeachingHintRepository(f.sql).read(f.scope,{attemptId:attempt.id,level:1});
  const original=await service.submit(f.scope,attempt.id,{clientKey:randomUUID(),answer:outcome==="correct"?String(columns-2):"-99",outcome:"unverified",assistance,verdictSource:"self_report"});
  const observation=grade?await gradingFixture.apply(createOpeningAiGradingRepository(f.sql),f.scope,{observationId:original.id},{outcome,confidence:.99,questionMatch:true,feedback:"按保存的秩与零空间标准核对。",criteria:[{label:"秩与零空间",verdict:outcome,feedback:"核对列数减秩。"}]},"controlled-fixture"):original;
  return {attempt,observation,session};
}

it("ignores forged ready, preserves server confirmation across title edits, and replays without revisions", async () => {
  const x=await setup(), request={expectedRevisions:[],requirements:[x.requirement],confirmScope:true as const};
  const first=await x.route.confirm(f.scope,x.courseId,request);
  expect(first.requirements[0]!.requirement).toMatchObject({revision:1,verification:{kind:"rubric",status:"needs_check",exerciseKeys:[]}});
  expect((await x.route.confirm(f.scope,x.courseId,request)).requirements[0]!.requirement.revision).toBe(1);
  const start=await x.route.start(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,requirementId:x.requirement.id,expectedRequirementRevision:1,clientKey:randomUUID(),minutes:20});
  if(start.kind!=="ready") throw new Error(JSON.stringify(start));
  await compile(start.activity); const answered=await answer(start.activity,0,"correct","independent",false);
  const confirmed=await createOpeningCourseRouteVerificationRepository(f.sql).confirm(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,activityId:start.activity.id,expectedContentVersion:1,requirementId:x.requirement.id,expectedRequirementRevision:1,itemVersionIds:[answered.attempt.itemVersionId!],confirmed:true});
  const server=confirmed.requirements[0]!.requirement;
  expect(server.verification).toMatchObject({kind:"rubric",status:"ready",exerciseKeys:[`teaching-item:${answered.attempt.itemVersionId}`]});
  const edited={...x.requirement,title:"新标题"}, titleRequest={expectedRevisions:[{id:edited.id,revision:2}],requirements:[edited],confirmScope:true as const};
  const title=await x.route.confirm(f.scope,x.courseId,titleRequest);
  expect(title.requirements[0]!.requirement).toMatchObject({revision:3,verification:server.verification});
  expect((await x.route.confirm(f.scope,x.courseId,titleRequest)).requirements[0]!.requirement.revision).toBe(3);
  const changed={...edited,verification:{...edited.verification,rubric:"新评分标准"}};
  const update=await x.route.confirm(f.scope,x.courseId,{expectedRevisions:[{id:edited.id,revision:3}],requirements:[changed],confirmScope:true});
  expect(update.requirements[0]!.requirement).toMatchObject({revision:4,verification:{status:"needs_check",exerciseKeys:[],rubric:"新评分标准"}});
});
it("rechecks restored ready verification and makes a replay idempotent", async () => {
  const x=await setup();
  await x.route.confirm(f.scope,x.courseId,{expectedRevisions:[],requirements:[x.requirement],confirmScope:true});
  const forged={...x.requirement.verification,status:"ready" as const,exerciseKeys:["forged-restored"]};
  // Simulates backup restore: normalizeOpeningImportedEvaluation clears approved_at but preserves verification.
  await f.sql`UPDATE course_requirements SET verification=${f.sql.json(forged)},approved_at=NULL
    WHERE id=${x.requirement.id} AND workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
  const request={expectedRevisions:[{id:x.requirement.id,revision:1}],requirements:[x.requirement],confirmScope:true as const};
  const confirmed=await x.route.confirm(f.scope,x.courseId,request);
  expect(confirmed.requirements[0]!.requirement).toMatchObject({revision:2,verification:{kind:"rubric",status:"needs_check",exerciseKeys:[]}});
  expect((await x.route.confirm(f.scope,x.courseId,request)).requirements[0]!.requirement.revision).toBe(2);
});
it("does not revise an unchanged legacy row when another requirement changes", async () => {
  const x=await setup(), second={...x.requirement,id:randomUUID(),stableSkillId:randomUUID(),requirementKey:"second",position:1};
  await x.route.confirm(f.scope,x.courseId,{expectedRevisions:[],requirements:[x.requirement,second],confirmScope:true});
  const legacy={kind:"unavailable" as const,status:"missing" as const,exerciseKeys:[],rubric:null,missingReasons:["尚未提供验证题目或评分标准"]};
  // Simulates a legacy row written by the frontend before deployment.
  await f.sql`UPDATE course_requirements SET verification=${f.sql.json(legacy)}
    WHERE id=${x.requirement.id} AND workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
  const snapshot=await x.route.read(f.scope,x.courseId);
  const definitions=snapshot.requirements.map(({requirement:{courseId:_courseId,revision:_revision,lifecycle:_lifecycle,approvedAt:_approvedAt,...definition}})=>definition);
  const updated=await x.route.confirm(f.scope,x.courseId,{expectedRevisions:snapshot.requirements.map(({requirement})=>({id:requirement.id,revision:requirement.revision})),
    requirements:definitions.map(row=>row.id===second.id?{...row,title:"更新标题"}:row),confirmScope:true});
  const firstRow=updated.requirements.find(({requirement})=>requirement.id===x.requirement.id)!.requirement;
  const secondRow=updated.requirements.find(({requirement})=>requirement.id===second.id)!.requirement;
  expect(firstRow.revision).toBe(1);
  expect(firstRow.verification).toEqual(legacy);
  expect(secondRow.revision).toBe(2);
});
it("exact readiness requires both capability and available sources", async () => {
  const x=await setup(), exact={...x.requirement,verification:{...x.requirement.verification,kind:"exact" as const}};
  const first=await x.route.confirm(f.scope,x.courseId,{expectedRevisions:[],requirements:[exact],confirmScope:true});
  expect(first.requirements[0]!.requirement.verification).toMatchObject({status:"missing",exerciseKeys:[]});
  const enabled=createOpeningCourseRouteRepository(f.sql,{compilerEnabled:true,exactVerificationEnabled:true});
  const second=await enabled.confirm(f.scope,x.courseId,{expectedRevisions:[{id:exact.id,revision:1}],requirements:[exact],confirmScope:true});
  expect(second.requirements[0]!.requirement.verification).toMatchObject({status:"ready",exerciseKeys:[]});
  await x.rows.exclude(x.sourceId);
  const third=await enabled.confirm(f.scope,x.courseId,{expectedRevisions:[{id:exact.id,revision:2}],requirements:[exact],confirmScope:true});
  expect(third.requirements[0]!.requirement.verification).toMatchObject({status:"missing",exerciseKeys:[]});
});
it("keeps a confirmed exact requirement ready through route start and next when the switch is on", async () => {
  const x=await setup(), exact={...x.requirement,verification:{...x.requirement.verification,kind:"exact" as const}};
  const enabled=createOpeningCourseRouteRepository(f.sql,{compilerEnabled:true,exactVerificationEnabled:true});
  const confirmed=await enabled.confirm(f.scope,x.courseId,{expectedRevisions:[],requirements:[exact],confirmScope:true});
  expect(confirmed.requirements[0]).toMatchObject({status:"unobserved",sourcesAvailable:true,requirement:{revision:1,verification:{kind:"exact",status:"ready",exerciseKeys:[],missingReasons:[]}}});
  const start=await enabled.start(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,requirementId:exact.id,expectedRequirementRevision:1,clientKey:randomUUID(),minutes:20});
  if(start.kind!=="ready") throw new Error(JSON.stringify(start));
  await compile(start.activity); const checked=await answer(start.activity);
  const current=await enabled.read(f.scope,x.courseId,start.activity.id);
  expect(current.requirements[0]).toMatchObject({status:"needs_verification",sourcesAvailable:true,requirement:{revision:1,verification:{kind:"exact",status:"ready"}}});
  expect(current.summary.blocked).toBe(0);
  // The action path only issues transfer_check for a ready requirement whose sources are available.
  const next=await enabled.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,activityId:start.activity.id,expectedPathVersion:current.currentActivity!.pathVersion,observationId:checked.observation.id,clientKey:randomUUID(),minutes:20});
  expect(next).toMatchObject({kind:"ready",requirementId:exact.id,action:"transfer_check"});
});
it("retains the evaluator-enabled arithmetic expectation as an independent real compiler/evaluator leaf", async () => {
  gradingFixture.restore();
  const x=await setup();
  await f.sql`UPDATE opening_source_chunks SET text='加法按位计算，相同数位相加。',image_object_key=NULL WHERE id=${x.chunkId}`;
  await x.route.confirm(f.scope,x.courseId,{expectedRevisions:[],requirements:[x.requirement],confirmScope:true});
  const start=await x.route.start(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,requirementId:x.requirement.id,
    expectedRequirementRevision:1,clientKey:randomUUID(),minutes:20});
  if(start.kind!=="ready")throw new Error(JSON.stringify(start));
  const spec=await compile(start.activity,0,true);
  const session=await createOpeningLearningRepository(f.sql).createSession(f.scope,{activityId:start.activity.id,courseId:x.courseId,
    skillLabel:start.activity.learnerFocus!.skillLabel,sourceIds:start.activity.sourceIds});
  const attempt=await createOpeningAttemptService(f.sql).create(f.scope,{sessionId:session.id,clientKey:randomUUID(),
    teachingBlock:{blockId:spec.blockOrder.find(block=>block.role==="prompt")!.blockId,contentVersion:1}});
  await f.sql.begin(async tx=>{
    const [saved]=await tx`SELECT * FROM opening_learning_attempts WHERE id=${attempt.id}`;
    expect(await evaluateOpeningTeachingKeyAttempt(tx,f.scope,saved,"19",[])).toMatchObject({
      evaluatorVersion:"teaching-key-exact-v1",specVersion:"teaching-key-v1",decision:"correct",outcome:"correct",priorFeedback:false});
    expect(await evaluateOpeningTeachingKeyAttempt(tx,f.scope,saved,"-99",[])).toMatchObject({decision:"incorrect",outcome:"incorrect"});
  });
});
it("restores real compiler submissions and exact readiness with an unseen transfer question", async () => {
  // The older rank-nullity tests deliberately control AI qualification; this test must not.
  gradingFixture.restore();
  const x=await setup(), exact={...x.requirement,requirementKey:"arithmetic",title:"加法运算",
    verification:{kind:"exact" as const,status:"missing" as const,exerciseKeys:[],rubric:"独立计算加法的数值结果。",missingReasons:[]}};
  // Seed text-only material so the real compiler input builder needs no external image storage.
  await f.sql`UPDATE opening_source_chunks SET text='加法按位计算，相同数位相加，满十进一。',image_object_key=NULL WHERE id=${x.chunkId}`;
  const route=createOpeningCourseRouteRepository(f.sql,{compilerEnabled:true,exactVerificationEnabled:true});
  const confirmed=await route.confirm(f.scope,x.courseId,{expectedRevisions:[],requirements:[exact],confirmScope:true});
  expect(confirmed).toMatchObject({scopeState:"confirmed",summary:{blocked:0}});
  expect(confirmed.requirements[0]).toMatchObject({status:"unobserved",sourcesAvailable:true,
    requirement:{revision:1,verification:{kind:"exact",status:"ready",exerciseKeys:[],missingReasons:[]}}});

  const start=await route.start(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,requirementId:exact.id,
    expectedRequirementRevision:1,clientKey:randomUUID(),minutes:20});
  if(start.kind!=="ready")throw new Error(JSON.stringify(start));
  const submitArithmetic=async(activity:TeachingActivity,stem:string,value:string)=>{
    const spec=await createOpeningTeachingContentRepository(f.sql).getActivitySpec(f.scope,activity.id);
    const prompts=spec!.blockOrder.filter(block=>block.role==="prompt");
    expect(prompts).toHaveLength(2);
    const session=await createOpeningLearningRepository(f.sql).createSession(f.scope,{activityId:activity.id,courseId:x.courseId,
      skillLabel:activity.learnerFocus!.skillLabel,sourceIds:activity.sourceIds});
    const service=createOpeningAttemptService(f.sql);
    const attempt=await service.create(f.scope,{sessionId:session.id,clientKey:randomUUID(),
      teachingBlock:{blockId:prompts[0]!.blockId,contentVersion:1}});
    expect(attempt.stemSnapshot).toBe(stem);
    expect(attempt.courseRequirement).toMatchObject({id:exact.id,revision:1});
    const observation=await service.submit(f.scope,attempt.id,{clientKey:randomUUID(),answer:value,outcome:"unverified",
      assistance:"independent",verdictSource:"self_report"});
    expect(observation).toMatchObject({attemptId:attempt.id,outcome:"correct",assistance:"independent",verdictSource:"deterministic",
      serverEvaluation:{evaluatorVersion:"teaching-key-exact-v1",decision:"correct"},
      eligibility:{verifiedCorrect:"yes",usableForCurrentVersion:"yes",independentAttempt:"yes"}});
    expect(observation.aiEvaluation).toBeUndefined();
    return {attempt,observation};
  };
  await compile(start.activity,0,true);
  const first=await submitArithmetic(start.activity,"12+7","19");
  const current=await route.read(f.scope,x.courseId,start.activity.id);
  expect(current.requirements[0]).toMatchObject({status:"needs_verification",observationId:first.observation.id,
    requirement:{revision:1,verification:{kind:"exact",status:"ready"}}});
  expect(current.summary.blocked).toBe(0);
  const next=await route.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,activityId:start.activity.id,
    expectedPathVersion:current.currentActivity!.pathVersion,observationId:first.observation.id,clientKey:randomUUID(),minutes:20});
  expect(next).toMatchObject({kind:"ready",requirementId:exact.id,action:"transfer_check"});
  if(next.kind!=="ready")throw new Error(JSON.stringify(next));
  expect(next.activity.id).not.toBe(start.activity.id);
  await compile(next.activity,1,true);
  const second=await submitArithmetic(next.activity,"22+7","29");
  expect(second.attempt.id).not.toBe(first.attempt.id);
  expect(second.attempt.problemId).not.toBe(first.attempt.problemId);
  expect(second.attempt.stemSnapshot).not.toBe(first.attempt.stemSnapshot);
  const verified=await route.read(f.scope,x.courseId,next.activity.id);
  expect(verified.requirements[0]).toMatchObject({status:"verified",observationId:second.observation.id,
    requirement:{revision:1,verification:{kind:"exact",status:"ready"}}});
  expect(verified.summary).toMatchObject({verified:1,blocked:0});
  expect(await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} AND kind='grade-observation'
    AND payload->>'observationId' IN (${first.observation.id},${second.observation.id})`).toHaveLength(0);
});
it("defaults suggested verification to unavailable until exact capability is enabled", async () => {
  const x=await setup(), nodeId=randomUUID();
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${x.sourceId}`;
  await createOpeningKnowledgeRepository(f.sql).replace(f.scope,x.courseId,{expectedVersion:0,sourceVersions:{[x.sourceId]:1},snapshot:{courseId:x.courseId,version:1,nodes:[{id:nodeId,courseId:x.courseId,label:"矩阵秩",kind:"concept",status:"supported",evidenceChunkIds:[x.chunkId]}],edges:[]}});
  expect((await x.route.read(f.scope,x.courseId)).suggestions[0]!.verification).toMatchObject({kind:"unavailable",status:"missing"});
  const enabled=createOpeningCourseRouteRepository(f.sql,{compilerEnabled:true,exactVerificationEnabled:true});
  expect((await enabled.read(f.scope,x.courseId)).suggestions[0]!.verification).toMatchObject({kind:"exact",status:"ready",exerciseKeys:[]});
});