import { randomUUID } from "node:crypto";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { nextLearningStep } from "@aistudy/domain";
import { createOpeningSpanTutorContextRepository } from "../../packages/database/src/repositories/opening-span-tutor-context";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { readOpeningLearningCapacity } from "../../packages/database/src/repositories/opening-learning-capacity";
import { createOpeningLearningDecisionsRepository } from "../../packages/database/src/repositories/opening-learning-decisions";
import * as decisionWriter from "../../packages/database/src/repositories/opening-learning-decisions";
import { readOpeningLearnerState } from "../../packages/database/src/repositories/opening-learner-state-read";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import type { CourseRouteRequirementInput,CourseRouteActionResult,TeachingActivity } from "@aistudy/contracts";
import { createOpeningLearningGoalRepository,createOpeningLearningRepository,createOpeningAiGradingRepository,createOpeningSourceChunksRepository,
  createOpeningBudgetRepository,createOpeningPrivacyRepository,createOpeningTeachingContentRepository,createOpeningJobRepository,createWorkspacePreferencesRepository,createOpeningRetestActivityRepository,createOpeningTeachingHintRepository,createOpeningSpanSessionRepository } from "@aistudy/database";
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
import { controlledCourseGrading } from "./opening-controlled-grade-fixture";
let f:OpeningFixture;
let gradingFixture:ReturnType<typeof controlledCourseGrading>;
beforeEach(async()=>{f=await createOpeningFixture();gradingFixture=controlledCourseGrading();vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED","1");vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED","0");});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await f?.close();});
const ready=(value:CourseRouteActionResult)=>{expect(value.kind).toBe("ready");if(value.kind!=="ready")throw new Error(JSON.stringify(value));return value;};
async function seed(count=1,sourceVersion=1){
  const courseId=randomUUID(),rows=backupRows(f.sql,f.scope),sourceId=await rows.source("uploaded",sourceVersion),chunkId=await rows.chunk(sourceId,sourceVersion);
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug)VALUES(${courseId},${f.scope.workspaceId},'Course route',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goals=createOpeningLearningGoalRepository(f.sql),goal=await goals.create(f.scope,{clientKey:randomUUID(),courseIds:[courseId],title:"掌握全课",kind:"custom",targetDate:null,
    examDate:null,weeklyMinutes:120,priority:1,learningMode:"understand",successCriteria:"各要求可独立解释并迁移"});
  const requirements:CourseRouteRequirementInput[]=Array.from({length:count},(_,position)=>({id:randomUUID(),stableSkillId:randomUUID(),knowledgeNodeId:null,requirementKey:`requirement:${position}`,
    title:`矩阵秩${position}`,position,mandatory:true,goalIds:[goal.id],prerequisiteIds:[],sourceRefs:[{sourceId,sourceVersion,chunkId}],
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
  if(assistance==="hinted")await createOpeningTeachingHintRepository(f.sql).read(f.scope,{attemptId:attempt.id,level:1});
  const original=await service.submit(f.scope,attempt.id,{clientKey:randomUUID(),answer:outcome==="correct"?String(columns-2):"-99",outcome:"unverified",assistance,verdictSource:"self_report"});
  const observation=grade?await gradingFixture.apply(createOpeningAiGradingRepository(f.sql),f.scope,{observationId:original.id},{outcome,confidence:.99,questionMatch:true,feedback:"按保存的秩与零空间标准核对。",criteria:[{label:"秩与零空间",verdict:outcome,feedback:"核对列数减秩。"}]},"controlled-fixture"):original;
  return {attempt,observation,session};
}
async function activityDecision(result:ReturnType<typeof ready>){
  const decisions=createOpeningLearningDecisionsRepository(f.sql),rows=await decisions.list(f.scope,{layer:"activity",targetId:result.activity.id});
  expect(rows).toHaveLength(1);const receipt=rows[0]!;
  expect(receipt).toMatchObject({selectedAction:result.action,parentDecisionId:null,policyVersion:"course-route-1"});
  expect(receipt.candidates).toContainEqual(expect.objectContaining({action:result.action,eligible:true}));
  expect(await decisions.get(f.scope,receipt.id)).toEqual(receipt);
  expect(await decisions.get(f.otherScope,receipt.id)).toBeNull();
  return receipt;
}
it.each(["correct","incorrect"] as const)("keeps actual AI-only %s feedback unknown without new activity or budget",async outcome=>{
  gradingFixture.restore();
  const x=await seed(),one=ready(await x.start());await compile(one.activity);
  const result=await answer(one.activity,0,outcome);
  expect(result.observation).toMatchObject({outcome,verdictSource:"ai_graded",eligibility:{verifiedCorrect:"unknown",policyVersion:"opening-evidence-v4",reasonCodes:expect.arrayContaining(["ai_evaluation_uncalibrated"])}});
  const snapshot=await x.repo.read(f.scope,x.courseId,one.activity.id),before=await readOpeningLearningCapacity(f.sql,f.scope);
  const activities=await f.sql`SELECT id,status FROM opening_teaching_activities WHERE course_id=${x.courseId} ORDER BY id`;
  const jobs=await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`;
  const request={goalId:x.goal.id,expectedGoalRevision:1,activityId:one.activity.id,expectedPathVersion:snapshot.currentActivity!.pathVersion,observationId:result.observation.id,clientKey:randomUUID(),minutes:20};
  expect(await x.repo.next(f.scope,x.courseId,request)).toMatchObject({kind:"choice",reason:"evidence_unknown"});
  expect(await x.repo.next(f.scope,x.courseId,request)).toMatchObject({kind:"choice",reason:"evidence_unknown"});
  expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(before.usedMinutes);
  expect(await f.sql`SELECT id,status FROM opening_teaching_activities WHERE course_id=${x.courseId} ORDER BY id`).toEqual(activities);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`).toEqual(jobs);
});
it("persists zero source versions through real course start and next without rolling back activities",async()=>{
  const x=await seed(1,0),one=ready(await x.start());
  expect((await activityDecision(one)).sourceVersions).toEqual({[x.sourceId]:[0]});
  expect(one.activity.sourceIds).toContain(x.sourceId);
  await compile(one.activity);const answered=await answer(one.activity,0,"incorrect");
  const snapshot=await x.repo.read(f.scope,x.courseId,one.activity.id);
  const next=ready(await x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,activityId:one.activity.id,
    expectedPathVersion:snapshot.currentActivity!.pathVersion,observationId:answered.observation.id,clientKey:randomUUID(),minutes:20}));
  expect(next.action).toBe("targeted_explain");
  expect((await activityDecision(next)).sourceVersions).toEqual({[x.sourceId]:[0]});
  expect(next.activity.sourceIds).toContain(x.sourceId);
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(2);
  const [origin]=await f.sql`SELECT status FROM opening_teaching_activities WHERE id=${one.activity.id}`;
  expect(origin!.status).toBe("completed");
});
it("captures course start inputs before writes and never recomputes or backfills replay receipts",async()=>{
  const x=await seed(2),key=randomUUID(),state=await f.sql.begin(tx=>readOpeningLearnerState(tx,f.scope,{courseId:x.courseId}));
  const one=ready(await x.start(0,key)),receipt=await activityDecision(one);
  expect(receipt.stateVersion).toBe(state.stateVersion);
  expect(receipt.sourceVersions).toEqual({[x.sourceId]:[1]});
  expect(receipt.evidenceRefs).toContain(`requirement:${x.requirements[0]!.id}:v1`);
  expect(receipt.candidates).toContainEqual(expect.objectContaining({eligible:false,reasonCodes:expect.arrayContaining(["explicit_requirement_not_selected"])}));
  expect(ready(await x.start(0,key)).activity.id).toBe(one.activity.id);
  expect(ready(await x.start()).activity.id).toBe(one.activity.id);
  await x.goals.update(f.scope,x.goal.id,{expectedRevision:1,successCriteria:"新标准"});
  await f.sql`UPDATE opening_sources SET version=2 WHERE id=${x.sourceId}`;
  expect(await createOpeningLearningDecisionsRepository(f.sql).get(f.scope,receipt.id)).toEqual(receipt);
  expect(await x.start(0,key)).toMatchObject({kind:"choice",reason:"evidence_changed"});
  expect(await createOpeningLearningDecisionsRepository(f.sql).list(f.scope,{layer:"activity",targetId:one.activity.id})).toEqual([receipt]);
  const old=await seed(),oldKey=randomUUID(),legacy=ready(await old.start(0,oldKey));
  await f.sql`DELETE FROM opening_learning_decisions WHERE target_id=${legacy.activity.id}`;
  expect(ready(await old.start(0,oldKey)).activity.id).toBe(legacy.activity.id);
  expect(ready(await old.start()).activity.id).toBe(legacy.activity.id);
  expect(await createOpeningLearningDecisionsRepository(f.sql).list(f.scope,{layer:"activity",targetId:legacy.activity.id})).toEqual([]);
});
it("rolls back course activity, compile, budget and origin completion when its decision write fails",async()=>{
  const x=await seed(),one=ready(await x.start());await compile(one.activity);const answered=await answer(one.activity,0,"incorrect");
  const snapshot=await x.repo.read(f.scope,x.courseId,one.activity.id);
  const before=await f.sql`SELECT id,status,path_version,goal_json FROM opening_teaching_activities WHERE course_id=${x.courseId}`;
  const jobs=await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`;
  const receipts=await f.sql`SELECT id FROM opening_learning_decisions WHERE workspace_id=${f.scope.workspaceId}`;
  const writer=vi.spyOn(decisionWriter,"recordOpeningLearningDecision").mockRejectedValueOnce(new Error("receipt write failed"));
  try{await expect(x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,activityId:one.activity.id,
    expectedPathVersion:snapshot.currentActivity!.pathVersion,observationId:answered.observation.id,clientKey:randomUUID(),minutes:20})).rejects.toThrow("receipt write failed");}
  finally{writer.mockRestore();}
  expect(await f.sql`SELECT id,status,path_version,goal_json FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toEqual(before);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`).toEqual(jobs);
  expect(await f.sql`SELECT id FROM opening_learning_decisions WHERE workspace_id=${f.scope.workspaceId}`).toEqual(receipts);
});
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
  const receipt=await activityDecision(next);expect(receipt.reasonCodes).toContain("entry:course-route-next");
  expect(receipt.evidenceRefs).toContain(`observation:${result.observation.id}`);
  const refreshed=await x.repo.read(f.scope,x.courseId,one.activity.id);
  expect(ready(await x.repo.next(f.scope,x.courseId,{...request,clientKey:randomUUID(),expectedPathVersion:refreshed.currentActivity!.pathVersion})).activity.id).toBe(next.activity.id);
  expect(await createOpeningLearningDecisionsRepository(f.sql).list(f.scope,{layer:"activity",targetId:next.activity.id})).toEqual([receipt]);
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(2);
});
it.each([false,true])("replaces same-action revised successors without refunding consumed history (consumed=%s)",async consumed=>{
  const x=await seed(2),one=ready(await x.start());await compile(one.activity);const first=await answer(one.activity,0,"incorrect");
  const request={goalId:x.goal.id,expectedGoalRevision:1,activityId:one.activity.id,expectedPathVersion:(await x.repo.read(f.scope,x.courseId,one.activity.id)).currentActivity!.pathVersion,
    observationId:first.observation.id,clientKey:randomUUID(),minutes:20};
  const old=ready(await x.repo.next(f.scope,x.courseId,request)),receipt=await activityDecision(old);
  let saved:Awaited<ReturnType<typeof answer>>|undefined;
  if(consumed){await compile(old.activity,1);saved=await answer(old.activity,0,"incorrect");}
  const unrelated=ready(await x.start(1));
  expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(60);
  const grading=createOpeningAiGradingRepository(f.sql),proposal={outcome:"incorrect" as const,confidence:.99,questionMatch:true,feedback:"重新核对原答案。",criteria:[{label:"秩",verdict:"incorrect" as const,feedback:"仍然错误。"}]};
  const correction={rootObservationId:first.observation.rootObservationId??first.observation.id,revisesObservationId:first.observation.id,expectedHead:first.observation.id,
    revisionKind:"replace" as const,reason:"更正原答案",clientKey:randomUUID(),replacement:{answer:"-98",outcome:"unverified" as const,assistance:"independent" as const}};
  const corrected=await reviseOpeningLearningObservation(f.sql,f.scope,correction);
  const revised=await gradingFixture.apply(grading,f.scope,{observationId:corrected.headObservationId},proposal,"controlled-fixture");
  expect(revised.id).not.toBe(first.observation.id);
  expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(consumed?60:40);
  expect((await x.repo.read(f.scope,x.courseId)).currentActivity?.id).not.toBe(old.activity.id);
  await expect(assertOpeningCourseRouteReady(f.sql,f.scope,old.activity.id)).rejects.toMatchObject({code:"CONFLICT"});
  await expect(assertOpeningCourseRouteReady(f.sql,f.scope,unrelated.activity.id)).resolves.not.toBeNull();
  expect(await x.repo.next(f.scope,x.courseId,request)).toMatchObject({kind:"choice",reason:"evidence_changed"});
  const freshRequest={...request,observationId:revised.id,expectedPathVersion:(await x.repo.read(f.scope,x.courseId,one.activity.id)).currentActivity!.pathVersion};
  const fresh=ready(await x.repo.next(f.scope,x.courseId,freshRequest));expect(fresh.action).toBe(old.action);expect(fresh.activity.id).not.toBe(old.activity.id);
  expect((await activityDecision(fresh)).evidenceRefs).toContain(`observation:${revised.id}`);
  expect(ready(await x.repo.next(f.scope,x.courseId,freshRequest)).activity.id).toBe(fresh.activity.id);
  expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(consumed?80:60);
  expect((await reviseOpeningLearningObservation(f.sql,f.scope,correction)).headObservationId).toBe(corrected.headObservationId);
  expect(await gradingFixture.apply(grading,f.scope,{observationId:corrected.headObservationId},proposal,"controlled-fixture")).toEqual(revised);
  expect(await createOpeningLearningDecisionsRepository(f.sql).get(f.scope,receipt.id)).toEqual(receipt);
  if(saved)expect((await createOpeningAttemptService(f.sql).getContext(f.scope,saved.attempt.id)).attempt.id).toBe(saved.attempt.id);
});
it.each([false,true])("shares released course reservations with the real span tutor budget (consumed=%s)",async consumed=>{
  const x=await seed(),one=ready(await x.start());await compile(one.activity);const first=await answer(one.activity,0,"incorrect");
  const old=ready(await x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,activityId:one.activity.id,
    expectedPathVersion:(await x.repo.read(f.scope,x.courseId,one.activity.id)).currentActivity!.pathVersion,
    observationId:first.observation.id,clientKey:randomUUID(),minutes:20}));
  const receipt=await activityDecision(old);
  if(consumed){await compile(old.activity,1);await answer(old.activity,0,"incorrect");}
  const [original]=await f.sql`SELECT goal_json FROM opening_teaching_activities WHERE id=${old.activity.id}`;
  await reviseOpeningLearningObservation(f.sql,f.scope,{rootObservationId:first.observation.rootObservationId??first.observation.id,
    revisesObservationId:first.observation.id,expectedHead:first.observation.id,revisionKind:"replace",reason:"更正原评价",clientKey:randomUUID(),
    replacement:{answer:"-98",outcome:"unverified",assistance:"independent"}});
  expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(consumed?40:20);
  await createWorkspacePreferencesRepository(f.sql).setLearningPreferences(f.scope,{assessmentEnabled:true,retestSuggestionsEnabled:true,automaticRemindersEnabled:false});
  const at=new Date().toISOString(),grant={enabled:true,dailyMinutes:40,revision:1,confirmedAt:at,updatedAt:at,expiresOn:null};
  await f.sql`UPDATE workspace_preferences SET adaptive_planning=${f.sql.json({...DEFAULT_OPENING_ADAPTIVE_PREFS,spanTutorGrants:{[x.courseId]:grant}})}::jsonb WHERE workspace_id=${f.scope.workspaceId}`;
  const tutor=createOpeningSpanTutorContextRepository(f.sql),request={courseId:x.courseId,sourceIds:[x.sourceId],sourceVersions:{[x.sourceId]:1},question:"继续学习"};
  const context=(await tutor.read(f.scope,request))!;expect(context).not.toBeNull();expect(context.intent.timeBudgetMinutes).toBe(20);
  const input={context,decision:nextLearningStep(context.decisionInput),operationId:`tutor-next:${randomUUID()}`};
  if(consumed){
    await expect(tutor.execute(f.scope,input)).rejects.toMatchObject({code:"CONFLICT",message:expect.stringContaining("预算不足")});
    expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(40);
    expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId} AND goal_json ? 'tutorBudget'`).toHaveLength(0);
  }else{
    const session=await tutor.execute(f.scope,input);
    const activity=await createOpeningSpanSessionRepository(f.sql).get(f.scope,session.activityId);
    expect(activity?.activityId).toBe(session.activityId);
    const [budget]=await f.sql`SELECT goal_json->'tutorBudget' AS receipt FROM opening_teaching_activities WHERE id=${session.activityId}`;
    expect(budget!.receipt).toMatchObject({minutes:20,grantRevision:1});
    expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(40);
    expect((await tutor.execute(f.scope,input)).activityId).toBe(session.activityId);
    expect(await createOpeningLearningDecisionsRepository(f.sql).list(f.scope,{layer:"activity",targetId:session.activityId})).toHaveLength(1);
    expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(3);
  }
  expect((await f.sql`SELECT goal_json FROM opening_teaching_activities WHERE id=${old.activity.id}`)[0]).toEqual(original);
  expect(await createOpeningLearningDecisionsRepository(f.sql).get(f.scope,receipt.id)).toEqual(receipt);
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
it("keeps a delayed retest separate from an active ordinary transfer check",async()=>{
  const x=await seed();await createWorkspacePreferencesRepository(f.sql).setLearningPreferences(f.scope,{assessmentEnabled:true,retestSuggestionsEnabled:true,automaticRemindersEnabled:false});
  const baseline=ready(await x.start());await compile(baseline.activity);const answered=await answer(baseline.activity);
  await ageBaseline(x.courseId);
  const ordinary=ready(await x.start());expect(ordinary.action).toBe("transfer_check");
  expect(ready(await x.start()).activity.id).toBe(ordinary.activity.id);
  const retests=createOpeningCourseRouteRetestRepository(f.sql),snapshot=await x.repo.read(f.scope,x.courseId,baseline.activity.id);
  const receipt=await retests.schedule(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,activityId:baseline.activity.id,
    expectedPathVersion:snapshot.currentActivity!.pathVersion,observationId:answered.observation.id,clientKey:randomUUID(),minutes:20});
  const task=await retests.readTask(f.scope,x.courseId,receipt.taskId);
  expect(task.managed).toBe(true);if(!task.managed)throw new Error("Expected managed retest");
  const request={goalId:task.goalId,expectedGoalRevision:task.expectedGoalRevision,requirementId:task.requirementId,
    expectedRequirementRevision:task.expectedRequirementRevision,taskId:task.taskId,expectedTaskVersion:task.expectedTaskVersion,
    clientKey:randomUUID(),minutes:task.minutes};
  const started=ready(await x.repo.start(f.scope,x.courseId,request));
  const retestDecision=await activityDecision(started);expect(retestDecision.reasonCodes).toContain("accepted_retest_transfer_check");
  expect(retestDecision.evidenceRefs).toContain(`retest:${receipt.retestId}`);
  expect(started.activity.id).not.toBe(ordinary.activity.id);
  expect(ready(await x.repo.start(f.scope,x.courseId,{...request,clientKey:randomUUID()})).activity.id).toBe(started.activity.id);
  expect(ready(await x.repo.start(f.scope,x.courseId,{...request,taskId:request.taskId.toUpperCase(),clientKey:randomUUID()})).activity.id).toBe(started.activity.id);
  expect(ready(await x.start()).activity.id).toBe(ordinary.activity.id);
  const [binding]=await f.sql`SELECT goal_json,create_intent FROM opening_teaching_activities WHERE id=${started.activity.id}`;
  expect(binding!.goal_json.courseRoute.retestId).toBe(receipt.retestId);
  expect(binding!.create_intent.taskId).toBe(receipt.taskId);
  await compile(started.activity,1);const result=await answer(started.activity);
  expect(result.observation.retestId).toBe(receipt.retestId);
  const [completed]=await f.sql`SELECT t.status AS task_status,r.status AS retest_status FROM opening_tasks t
    JOIN opening_retest_activities r ON r.task_id=t.id WHERE t.id=${receipt.taskId}`;
  expect(completed).toMatchObject({task_status:"done",retest_status:"completed"});
});
it.each(["passed","failed","assisted","assisted_failed","insufficient_evidence"] as const)("connects a real generic delayed retest %s to the actual next action",async branch=>{
  const assisted=branch==="assisted"||branch==="assisted_failed",failed=branch==="failed"||branch==="assisted_failed";
  const x=await delayedSeed(),result=await answer(x.started.activity,0,failed?"incorrect":"correct",assisted?"hinted":"independent",branch!=="insufficient_evidence");
  const snapshot=await x.repo.read(f.scope,x.courseId,x.started.activity.id);
  expect(snapshot.requirements[0]!.delayedCheck?.status).toBe(branch==="assisted_failed"?"failed":branch);
  const [fact]=await f.sql`SELECT retest_id,outcome,assistance FROM opening_learning_observations WHERE id=${result.observation.id}`;
  expect(fact).toMatchObject({retest_id:x.receipt.retestId,outcome:branch==="insufficient_evidence"?"unverified":failed?"incorrect":"correct",assistance:assisted?"hinted":"independent"});
  if(assisted)expect(await f.sql`SELECT id FROM opening_help_exposures WHERE attempt_id=${result.attempt.id} AND delivered=true`).toHaveLength(1);
  const before=await readOpeningLearningCapacity(f.sql,f.scope);
  expect(before.usedMinutes).toBe(40);
  const request={goalId:x.goal.id,expectedGoalRevision:1,activityId:x.started.activity.id,expectedPathVersion:snapshot.currentActivity!.pathVersion,
    observationId:result.observation.id,clientKey:randomUUID(),minutes:20};
  const next=await x.repo.next(f.scope,x.courseId,request);
  if(branch==="insufficient_evidence"){
    expect(next).toMatchObject({kind:"choice",reason:"evidence_unknown"});
    expect(await x.repo.next(f.scope,x.courseId,request)).toEqual(next);
    expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(before.usedMinutes);
    expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(2);
  }else{
    const successor=ready(next);expect(successor.action).toBe(failed?"targeted_explain":assisted?"reduced_help_practice":"comprehensive");
    await activityDecision(successor);
    expect(ready(await x.repo.next(f.scope,x.courseId,request)).activity.id).toBe(successor.activity.id);
    expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(before.usedMinutes+20);
    const [reservation]=await f.sql`SELECT goal_json->'learningBudget' AS budget FROM opening_teaching_activities WHERE id=${successor.activity.id}`;
    expect(reservation!.budget).toMatchObject({minutes:20,goalId:x.goal.id});
    expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(3);
    await compile(successor.activity,2);
    expect((await answer(successor.activity)).attempt.itemVersionId).not.toBe(result.attempt.itemVersionId);
    expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(before.usedMinutes+20);
  }
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
it.each(["cancel","snooze"] as const)("does not restore a %s delayed arrangement after baseline correction",async type=>{
  const x=await delayedSeed(),activities=createOpeningRetestActivityRepository(f.sql),until=new Date(Date.now()+86400000).toISOString();
  await activities.transition(f.scope,x.receipt.retestId,type==="cancel"?{type,at:new Date().toISOString()}:{type,until});
  const before=await f.sql`SELECT status,snoozed_until,task_id FROM opening_retest_activities WHERE id=${x.receipt.retestId}`;
  expect(before[0]!.status).toBe(type==="cancel"?"cancelled":"accepted");
  if(type==="snooze")expect(new Date(before[0]!.snoozed_until).toISOString()).toBe(until);
  const capacity=await readOpeningLearningCapacity(f.sql,f.scope),future=await readOpeningLearningCapacity(f.sql,f.scope,new Date(until));
  // Already-issued content retains today's reservation; only a snoozed pending task occupies the future day.
  expect(capacity.usedMinutes).toBe(40);expect(future.usedMinutes).toBe(type==="snooze"?20:0);
  const route=await x.repo.read(f.scope,x.courseId,x.started.activity.id);
  const nextRequest={goalId:x.goal.id,expectedGoalRevision:1,activityId:x.started.activity.id,expectedPathVersion:route.currentActivity!.pathVersion,
    observationId:null,clientKey:randomUUID(),minutes:20};
  expect(await x.repo.next(f.scope,x.courseId,nextRequest)).toMatchObject({kind:"choice",reason:type==="cancel"?"retest_cancelled":"evidence_unknown"});
  expect(await x.repo.next(f.scope,x.courseId,nextRequest)).toMatchObject({kind:"choice"});
  expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(capacity.usedMinutes);
  const tasks=await f.sql`SELECT status,version FROM opening_tasks WHERE id=${x.receipt.taskId}`;
  const fact=x.baselineAnswer.observation;
  await reviseOpeningLearningObservation(f.sql,f.scope,{rootObservationId:fact.rootObservationId??fact.id,revisesObservationId:fact.id,expectedHead:fact.id,
    revisionKind:"replace",reason:"核对原评价",clientKey:randomUUID(),replacement:{answer:fact.answer,outcome:"unverified",assistance:fact.assistance}});
  expect(await f.sql`SELECT status,snoozed_until,task_id FROM opening_retest_activities WHERE id=${x.receipt.retestId}`)
    .toEqual(before.map(row=>({...row,status:type==='snooze'?'invalidated':row.status})));
  expect(await f.sql`SELECT status,version FROM opening_tasks WHERE id=${x.receipt.taskId}`).toEqual(tasks);
  expect(await f.sql`SELECT id FROM opening_retest_activities WHERE course_id=${x.courseId}`).toHaveLength(1);
  expect(await x.retests.schedule(f.scope,x.courseId,x.request)).toMatchObject({retestId:x.receipt.retestId,taskId:x.receipt.taskId});
  expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(capacity.usedMinutes);
  expect((await readOpeningLearningCapacity(f.sql,f.scope,new Date(until))).usedMinutes).toBe(future.usedMinutes);
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
  const repairDecision=await activityDecision(repair);expect(repairDecision.reasonCodes).toContain("weak_explicit_prerequisite");
  expect(repairDecision.candidates).toContainEqual(expect.objectContaining({eligible:false,reasonCodes:expect.arrayContaining(["deferred_for_weak_prerequisite"])}));
  await compile(repair.activity,2);const firstCheck=await answer(repair.activity,0);
  const firstSnapshot=await x.repo.read(f.scope,x.courseId,repair.activity.id),practice=ready(await x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,
    activityId:repair.activity.id,expectedPathVersion:firstSnapshot.currentActivity!.pathVersion,observationId:firstCheck.observation.id,clientKey:randomUUID(),minutes:20}));
  expect(practice).toMatchObject({requirementId:x.requirements[0]!.id,action:"transfer_check"});
  await compile(practice.activity,3);const checked=await answer(practice.activity);
  const current=await x.repo.read(f.scope,x.courseId,practice.activity.id),returned=ready(await x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,
    activityId:practice.activity.id,expectedPathVersion:current.currentActivity!.pathVersion,observationId:checked.observation.id,clientKey:randomUUID(),minutes:20}));
  expect(returned).toMatchObject({requirementId:x.requirements[1]!.id,action:"return"});expect(returned.activity.id).not.toBe(repair.activity.id);
  expect((await activityDecision(returned)).reasonCodes).toContain("verified_prerequisite_return");
});
it("runs a separate comprehensive check for every requirement before an idempotent current-scope finish",async()=>{
  const x=await seed(2),a=ready(await x.start(0));await compile(a.activity,0);await answer(a.activity,0);await answer(a.activity,1);
  const b=ready(await x.start(1));await compile(b.activity,1);await answer(b.activity,0);const result=await answer(b.activity,1);
  async function next(activity:TeachingActivity,observationId:string){const current=await x.repo.read(f.scope,x.courseId,activity.id);return x.repo.next(f.scope,x.courseId,{goalId:x.goal.id,
    expectedGoalRevision:1,activityId:activity.id,expectedPathVersion:current.currentActivity!.pathVersion,observationId,clientKey:randomUUID(),minutes:20});}
  const first=ready(await next(b.activity,result.observation.id));expect(first).toMatchObject({action:"comprehensive",requirementId:x.requirements[0]!.id});
  expect((await activityDecision(first)).reasonCodes).toContain("current_scope_comprehensive_run");
  await compile(first.activity,3);const checkedA=await answer(first.activity);const second=ready(await next(first.activity,checkedA.observation.id));
  expect(second).toMatchObject({action:"comprehensive",requirementId:x.requirements[1]!.id});
  await activityDecision(second);
  await compile(second.activity,4);const checkedB=await answer(second.activity);
  expect(await next(second.activity,checkedB.observation.id)).toMatchObject({kind:"choice",reason:"course_complete"});
  expect(await next(second.activity,checkedB.observation.id)).toMatchObject({kind:"choice",reason:"course_complete"});
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(4);
});
it("makes a real saved submitted question usable only after explicit verification confirmation, without upgrading old answers",async()=>{
  const x=await seed();await x.repo.read(f.scope,x.courseId);const definition={...x.requirements[0]!,verification:{...x.requirements[0]!.verification,status:"needs_check" as const,exerciseKeys:[]}};
  await x.repo.confirm(f.scope,x.courseId,{expectedRevisions:[{id:definition.id,revision:1}],requirements:[definition],confirmScope:true});
  const started=ready(await x.repo.start(f.scope,x.courseId,{goalId:x.goal.id,expectedGoalRevision:1,requirementId:definition.id,expectedRequirementRevision:2,clientKey:randomUUID(),minutes:20}));
  await compile(started.activity);const helped=await answer(started.activity,1,"correct","hinted",false);
  const readOldHelp=async()=>({
    exposures:await f.sql`SELECT * FROM opening_help_exposures WHERE attempt_id=${helped.attempt.id} ORDER BY id`,
    observations:await f.sql`SELECT * FROM opening_learning_observations WHERE id=${helped.observation.id} OR root_observation_id=${helped.observation.id} ORDER BY id`,
  });
  const savedHelp=await readOldHelp();
  expect(savedHelp.exposures).toHaveLength(1);expect(savedHelp.exposures[0]).toMatchObject({delivered:true});
  expect(savedHelp.observations).toHaveLength(1);expect(savedHelp.observations[0]).toMatchObject({assistance:"hinted",outcome:"unverified",verdict_source:"self_report"});
  const answerA=await answer(started.activity,0,"correct","independent",false),verification=createOpeningCourseRouteVerificationRepository(f.sql);
  const unknown=await x.repo.read(f.scope,x.courseId,started.activity.id);
  const unknownRequest={goalId:x.goal.id,expectedGoalRevision:1,activityId:started.activity.id,expectedPathVersion:unknown.currentActivity!.pathVersion,
    observationId:answerA.observation.id,clientKey:randomUUID(),minutes:20};
  expect(unknown.requirements[0]).toMatchObject({status:"needs_verification",observationId:answerA.observation.id});
  const savedUnknown=await f.sql`SELECT * FROM opening_learning_observations WHERE id=${answerA.observation.id}`;
  const originalJobs=await f.sql`SELECT id,kind FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`;
  expect(await x.repo.next(f.scope,x.courseId,unknownRequest)).toMatchObject({kind:"choice",reason:"evidence_unknown"});
  expect(await x.repo.next(f.scope,x.courseId,unknownRequest)).toMatchObject({kind:"choice",reason:"evidence_unknown"});
  expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(20);
  const view=await verification.read(f.scope,x.courseId,started.activity.id);expect(view.available).toBe(true);expect(view.items).toHaveLength(2);
  const input={goalId:x.goal.id,expectedGoalRevision:1,activityId:started.activity.id,expectedContentVersion:1,requirementId:definition.id,expectedRequirementRevision:2,
    itemVersionIds:[answerA.attempt.itemVersionId!],confirmed:true as const};
  const confirmed=await verification.confirm(f.scope,x.courseId,input);expect(confirmed.requirements[0]).toMatchObject({status:"unobserved",requirement:{revision:3,verification:{status:"ready"}}});
  expect((await verification.confirm(f.scope,x.courseId,input)).requirements[0]!.requirement.revision).toBe(3);
  expect(view.items.find(item=>item.itemVersionId===answerA.attempt.itemVersionId)).toMatchObject({itemVersionId:answerA.attempt.itemVersionId,prompt:answerA.attempt.stemSnapshot,referenceText:expect.stringContaining("5 − 2 = 3")});
  expect(view.rubric).toBe(definition.verification.rubric);
  expect((await x.repo.read(f.scope,x.courseId)).requirements[0]).toMatchObject({status:"unobserved",requirement:{revision:3}});
  expect(await f.sql`SELECT id,kind FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`).toEqual(originalJobs);
  expect(await readOldHelp()).toEqual(savedHelp);
  expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(20);
  const startRequest={goalId:x.goal.id,expectedGoalRevision:1,requirementId:definition.id,expectedRequirementRevision:3,clientKey:randomUUID(),minutes:20};
  const fresh=ready(await x.repo.start(f.scope,x.courseId,startRequest));expect(fresh.activity.id).not.toBe(started.activity.id);
  expect(ready(await x.repo.start(f.scope,x.courseId,startRequest)).activity.id).toBe(fresh.activity.id);
  expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(40);
  await compile(fresh.activity,1);const checked=await answer(fresh.activity);
  expect(checked.attempt.itemVersionId).not.toBe(answerA.attempt.itemVersionId);
  expect(checked.attempt.stemSnapshot).not.toBe(answerA.attempt.stemSnapshot);
  expect(checked.attempt.courseRequirement).toMatchObject({id:definition.id,revision:3});
  const current=await x.repo.read(f.scope,x.courseId,fresh.activity.id);
  expect(current.requirements[0]).toMatchObject({status:"needs_verification",observationId:checked.observation.id});
  const nextRequest={goalId:x.goal.id,expectedGoalRevision:1,activityId:fresh.activity.id,expectedPathVersion:current.currentActivity!.pathVersion,
    observationId:checked.observation.id,clientKey:randomUUID(),minutes:20};
  const next=ready(await x.repo.next(f.scope,x.courseId,nextRequest));expect(next.action).toBe("transfer_check");
  expect((await activityDecision(next)).evidenceRefs).toContain(`observation:${checked.observation.id}`);
  expect(ready(await x.repo.next(f.scope,x.courseId,nextRequest)).activity.id).toBe(next.activity.id);
  expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(60);
  expect(await f.sql`SELECT * FROM opening_learning_observations WHERE id=${answerA.observation.id}`).toEqual(savedUnknown);
  expect(await readOldHelp()).toEqual(savedHelp);
  expect(await f.sql`SELECT id FROM opening_learning_observations WHERE root_observation_id=${answerA.observation.id} AND id<>${answerA.observation.id}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} AND kind='grade-observation'`).toHaveLength(0);
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
