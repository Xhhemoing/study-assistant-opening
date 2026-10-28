import { randomUUID } from "node:crypto";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import type { CourseRouteRequirementInput,CourseRouteActionResult,TeachingActivity } from "@aistudy/contracts";
import { createOpeningLearningGoalRepository,createOpeningLearningRepository,createOpeningAiGradingRepository,createOpeningSourceChunksRepository,
  createOpeningBudgetRepository,createOpeningPrivacyRepository,createOpeningTeachingContentRepository,createOpeningJobRepository } from "@aistudy/database";


import { createOpeningCourseSharedSkillRepository } from "../../packages/database/src/repositories/opening-course-shared-skill";
import { buildLongTermSuggestions } from "../../packages/database/src/repositories/opening-long-term-maintenance";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { validateBackupLearningLinks } from "../../packages/domain/src/opening/backup-learning-links";
import { normalizeOpeningImportedEvaluation } from "../../packages/database/src/repositories/opening-backup-evaluation";
import { readOpeningLearningCapacity } from "../../packages/database/src/repositories/opening-learning-capacity";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";


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
    evidenceConditions:{responseFormat:"text",timeLimitSeconds:null,assistance:"independent"},verification:{kind:"rubric",status:"ready",exerciseKeys:["saved-teaching-question"],rubric:"正确应用秩与零空间维数之和等于列数，并说明依据。",missingReasons:[]},origin:"confirmed"}));
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
async function mapped(){
 const source=await seed(),target=await seed(),activity=ready(await source.start()).activity;await compile(activity);
 const first=await answer(activity,0),second=await answer(activity,1),repository=createOpeningCourseSharedSkillRepository(f.sql);
 const command={action:"link" as const,sourceRequirementId:source.requirements[0]!.id,expectedSourceRevision:1,targetRequirementId:target.requirements[0]!.id,expectedTargetRevision:1,expectedLinkRevision:0,confirmed:true as const};
 return {source,target,activity,first,second,repository,command};
}
it("explicitly shares two actual independent questions across real courses and goals without adding activity, answer or budget",async()=>{
 const x=await mapped(),before=await readOpeningLearningCapacity(f.sql,f.scope),observations=await f.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}`;
 const value=await x.repository.command(f.scope,x.target.courseId,x.command);expect(value.links[0]).toMatchObject({active:true,effective:true,sourceRequirementRevision:1,targetRequirementRevision:2});expect(value.links[0]!.observationIds).toHaveLength(2);
 const route=await x.target.repo.read(f.scope,x.target.courseId);expect(route.requirements[0]).toMatchObject({status:"verified",requirement:{stableSkillId:x.source.requirements[0]!.stableSkillId,revision:2,goalIds:[x.target.goal.id]}});
 expect(route.requirements[0]!.sharedEvidence).toEqual(expect.arrayContaining([expect.objectContaining({sourceCourseId:x.source.courseId,sourceActivityId:x.activity.id,applicableGoalIds:[x.target.goal.id]})]));
 expect((await x.source.repo.read(f.scope,x.source.courseId)).requirements[0]!.requirement.goalIds).toEqual([x.source.goal.id]);
 expect((await readOpeningLearningCapacity(f.sql,f.scope)).usedMinutes).toBe(before.usedMinutes);expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
 expect(await f.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(observations.length);
 expect((await x.repository.command(f.scope,x.target.courseId,x.command)).links[0]!.revision).toBe(1);
 await expect(x.repository.command(f.otherScope,x.target.courseId,x.command)).rejects.toMatchObject({code:"NOT_FOUND"});
 const maintenanceGoal=await x.target.goals.update(f.scope,x.target.goal.id,{expectedRevision:1,lifecycle:"maintenance",maintenanceIntervalDays:7});
 const maintenance=await buildLongTermSuggestions(f.sql,f.scope,{date:before.localDate,timeZone:before.timeZone,now:new Date(),goals:[maintenanceGoal],tasks:[]});
 expect(maintenance.suggestions.filter(row=>row.courseId===x.target.courseId&&row.key.includes(":maintenance:"))).toEqual([]);
 const backup=await readOpeningBackupRecords(f.sql,f.scope),errors:string[]=[];
 validateBackupLearningLinks(backup.tables,errors,f.scope.ownerUserId);expect(errors).toEqual([]);
 const archivedLink=backup.tables.course_requirement_evidence_links.find(row=>row.id===value.links[0]!.id)!;
 expect(archivedLink).toMatchObject({active:true,source_requirement_id:x.source.requirements[0]!.id,target_requirement_id:x.target.requirements[0]!.id,source_requirement_revision:1,target_requirement_revision:2});
 expect(backup.tables.course_requirements.find(row=>row.id===x.target.requirements[0]!.id)!.evidence_conditions).toEqual(x.target.requirements[0]!.evidenceConditions);
 expect(normalizeOpeningImportedEvaluation("course_requirement_evidence_links",archivedLink)).toMatchObject({...archivedLink,active:false});
 expect(normalizeOpeningImportedEvaluation("course_requirements",backup.tables.course_requirements.find(row=>row.id===x.target.requirements[0]!.id)!)).toMatchObject({approved_at:null,evidence_conditions:x.target.requirements[0]!.evidenceConditions});
 const link=value.links[0]!;await x.repository.command(f.scope,x.target.courseId,{action:"unlink",linkId:link.id,expectedRevision:1});
 expect((await x.target.repo.read(f.scope,x.target.courseId)).requirements[0]!.status).toBe("unobserved");expect((await x.source.repo.read(f.scope,x.source.courseId)).requirements[0]!.status).toBe("verified");
});
it("drops shared evidence immediately when a real effective answer is retracted or source content disappears",async()=>{
 const x=await mapped();await x.repository.command(f.scope,x.target.courseId,x.command);
 const [root]=await f.sql`SELECT id,effective_head_id FROM opening_learning_observations WHERE attempt_id=${x.second.attempt.id} AND revision_kind='original'`;
 await reviseOpeningLearningObservation(f.sql,f.scope,{rootObservationId:String(root!.id),expectedHead:String(root!.effective_head_id),revisesObservationId:String(root!.effective_head_id),revisionKind:"retract",clientKey:randomUUID(),reason:"撤回不可靠记录"});
 expect((await x.target.repo.read(f.scope,x.target.courseId)).requirements[0]).toMatchObject({status:"needs_verification",sharedEvidence:[{observationId:x.first.observation.id}]});
 await f.sql`UPDATE opening_source_chunks SET text='',image_object_key=NULL WHERE id=${x.source.chunkId}`;
 const missing=(await x.target.repo.read(f.scope,x.target.courseId)).requirements[0]!;expect(missing.status).toBe("unobserved");expect(missing.sharedEvidence).toBeUndefined();
 expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE id=${x.activity.id}`).toHaveLength(1);
});
it("does not carry old standards to a new requirement revision or allow a different actual question format to borrow",async()=>{
 const x=await mapped();await x.repository.command(f.scope,x.target.courseId,x.command);
 await x.source.repo.confirm(f.scope,x.source.courseId,{expectedRevisions:[{id:x.source.requirements[0]!.id,revision:1}],requirements:[{...x.source.requirements[0]!,verification:{...x.source.requirements[0]!.verification,rubric:"改为独立完整证明"}}],confirmScope:true});
 expect((await x.target.repo.read(f.scope,x.target.courseId)).requirements[0]!.status).toBe("unobserved");
 await expect(x.repository.command(f.scope,x.target.courseId,{...x.command,expectedTargetRevision:2,expectedSourceRevision:2,expectedLinkRevision:1})).rejects.toMatchObject({code:"CONFLICT"});
 const other=await mapped();await other.source.repo.confirm(f.scope,other.source.courseId,{expectedRevisions:[{id:other.source.requirements[0]!.id,revision:1}],requirements:[{...other.source.requirements[0]!,evidenceConditions:{responseFormat:"numeric",timeLimitSeconds:null,assistance:"independent"}}],confirmScope:true});
 await expect(other.repository.command(f.scope,other.target.courseId,{...other.command,expectedSourceRevision:2})).rejects.toMatchObject({code:"CONFLICT"});
});
it("checks the actual saved response format instead of trusting equal declared conditions",async()=>{
 const source=await seed(),target=await seed(),repository=createOpeningCourseSharedSkillRepository(f.sql);
 for(const x of [source,target])await x.repo.confirm(f.scope,x.courseId,{expectedRevisions:[{id:x.requirements[0]!.id,revision:1}],requirements:[{...x.requirements[0]!,evidenceConditions:{responseFormat:"numeric",timeLimitSeconds:null,assistance:"independent"}}],confirmScope:true});
 const activity=ready(await source.repo.start(f.scope,source.courseId,{goalId:source.goal.id,expectedGoalRevision:1,requirementId:source.requirements[0]!.id,expectedRequirementRevision:2,clientKey:randomUUID(),minutes:20})).activity;
 await compile(activity);await answer(activity,0);await answer(activity,1);
 const result=await repository.command(f.scope,target.courseId,{action:"link",sourceRequirementId:source.requirements[0]!.id,expectedSourceRevision:2,targetRequirementId:target.requirements[0]!.id,expectedTargetRevision:2,expectedLinkRevision:0,confirmed:true});
 expect(result.links[0]).toMatchObject({active:true,effective:false,observationIds:[]});expect((await target.repo.read(f.scope,target.courseId)).requirements[0]!.status).toBe("unobserved");
});
