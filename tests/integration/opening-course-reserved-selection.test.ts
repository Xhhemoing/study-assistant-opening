import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readOpeningBackupRecords, createOpeningLearningGoalRepository, createOpeningTeachingContentRepository, createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { saveOpeningReservedCandidates, admitOpeningReservedCandidate, readOpeningReservedSupply, reserveOpeningCourseQuestion, issueOpeningReservedQuestion, type OpeningReservedPorts } from "../../packages/database/src/repositories/opening-course-reserved-selection";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { backupRows } from "./opening-backup-records-fixture";
import type { CourseRouteRequirementInput } from "@aistudy/contracts";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";

// Storage-boundary tests only. Raw rows are deliberately NOT trusted candidate
// admission, exposure-coverage evidence, ready eligibility or issuance evidence.
let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });

async function setup() {
  const courseId = randomUUID(), requirementId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${f.scope.workspaceId},'Private supply',${courseId})`;
  await f.sql`INSERT INTO course_requirements(id,workspace_id,owner_user_id,course_id,stable_skill_id,requirement_key,title,verification)
    VALUES(${requirementId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${randomUUID()},'addition','Addition','{}')`;
  const activityId = await insertTestTeachingActivity(f.sql, f.scope, courseId);
  return { courseId, requirementId, activityId };
}
async function insert(x: Awaited<ReturnType<typeof setup>>, workspaceId = f.scope.workspaceId) {
  const id = randomUUID(), keyId = randomUUID(), sourceId = randomUUID();
  // This shape fixture intentionally claims no existing source or publication.
  // A storage row is not a verified question: future admission must resolve refs.
  const identity = { identityRefId: id };
  const key = { keyRefId: keyId, identity, answer: "private-key-fixture" };
  await f.sql`INSERT INTO opening_course_reserved_questions(id,workspace_id,owner_user_id,course_id,requirement_id,requirement_revision,
    source_versions,identity_ref_id,identity_json,family_id,content_ref_id,key_ref_id,question_json,interaction_json,key_json)
    VALUES(${id},${workspaceId},${f.scope.ownerUserId},${x.courseId},${x.requirementId},1,
      ${f.sql.json({ [sourceId]: 1 })},${id},${f.sql.json(identity)},'fixture-family',${randomUUID()},${keyId},
      ${f.sql.json({ text: "private-prompt-fixture" })},${f.sql.json({ kind: "numeric" })},${f.sql.json(key)})`;
  return id;
}
it("creates only private supply and enforces same-workspace course/requirement foreign keys", async () => {
  const x = await setup(), id = await insert(x);
  const [row] = await f.sql`SELECT state,reserved_at,issued_at FROM opening_course_reserved_questions WHERE id=${id}`;
  expect(row).toMatchObject({ state: "available", reserved_at: null, issued_at: null });
  await expect(insert(x, f.otherScope.workspaceId)).rejects.toMatchObject({ code: "23503" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET requirement_id=${randomUUID()} WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
});
it("rejects incomplete reservation/issuance, wrong key identity and empty source snapshots", async () => {
  const x = await setup(), id = await insert(x);
  await expect(f.sql`UPDATE opening_course_reserved_questions SET state='reserved' WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET reserved_at=now(),reservation_key=${randomUUID()} WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET state='issued',issued_at=now() WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET state='revoked' WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET key_ref_id=${randomUUID()} WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET identity_json='{}' WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET source_versions='{}' WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
});
it("rolls back a failed reservation transaction without discarding immutable private content", async () => {
  const x = await setup(), id = await insert(x);
  await expect(f.sql.begin(async tx => {
    await tx`UPDATE opening_course_reserved_questions SET state='reserved',reservation_key=${randomUUID()},
      reserved_activity_id=${x.activityId},reserved_at=now() WHERE id=${id}`;
    throw new Error("consumer failed");
  })).rejects.toThrow("consumer failed");
  const [row] = await f.sql`SELECT state,reservation_key,reserved_activity_id,reserved_at,question_json,key_json
    FROM opening_course_reserved_questions WHERE id=${id}`;
  expect(row).toMatchObject({ state: "available", reservation_key: null, reserved_activity_id: null, reserved_at: null,
    question_json: { text: "private-prompt-fixture" }, key_json: { answer: "private-key-fixture" } });
});
it("does not include the new private table in the ordinary client backup", async () => {
  const x = await setup(); await insert(x);
  const backup = await readOpeningBackupRecords(f.sql, f.scope);
  const serialized = JSON.stringify(backup);
  expect(serialized).not.toContain("private-prompt-fixture");
  expect(serialized).not.toContain("private-key-fixture");
  expect(serialized).not.toContain("opening_course_reserved_questions");
});

async function supplyFixture() {
  const courseId=randomUUID(), scope=f.scope, workspaceId=scope.workspaceId;
  const freshRows=backupRows(f.sql,scope);
  const freshSource=await freshRows.source("uploaded",1);
  await f.sql`UPDATE opening_sources SET mime='text/plain' WHERE id=${freshSource}`;
  const freshChunk=randomUUID();
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${freshChunk},${freshSource},1,1,'Arithmetic operations on rational numbers.')`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${workspaceId},'Arithmetic',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${workspaceId},${courseId},'source',${freshSource},'core','course')`;
  const goal=await createOpeningLearningGoalRepository(f.sql).create(scope,{clientKey:randomUUID(),courseIds:[courseId],title:"Arithmetic",kind:"custom",targetDate:null,examDate:null,weeklyMinutes:120,priority:1,learningMode:"understand",successCriteria:"Independent arithmetic"});
  const definition:CourseRouteRequirementInput={id:randomUUID(),stableSkillId:randomUUID(),knowledgeNodeId:null,requirementKey:'arithmetic',title:'Arithmetic',position:0,mandatory:true,goalIds:[goal.id],prerequisiteIds:[],sourceRefs:[{sourceId:freshSource,sourceVersion:1,chunkId:freshChunk}],verification:{kind:'exact',status:'missing',exerciseKeys:[],rubric:null,missingReasons:[]},origin:'confirmed'};
  const route=createOpeningCourseRouteRepository(f.sql,{compilerEnabled:true,exactVerificationEnabled:true});
  const confirmed=await route.confirm(scope,courseId,{expectedRevisions:[],requirements:[definition],confirmScope:true});
  const requirement=confirmed.requirements[0]!.requirement;
  const start=await route.start(scope,courseId,{goalId:goal.id,expectedGoalRevision:1,requirementId:requirement.id,expectedRequirementRevision:1,clientKey:randomUUID(),minutes:20});
  if(start.kind!=='ready')throw new Error('start failed');
  const candidate={text:'137*19',interaction:{kind:'numeric' as const},answer:'2603'};
  await saveOpeningReservedCandidates(f.sql,scope,start.activity.id,[candidate]);
  return {scope,courseId,sourceId:freshSource,goal,requirement,activity:start.activity,candidate,route};
}
// Explicit SQL-consumer test port, NOT production coverage evidence. Phase 2 owns
// the real ledger and presentation writers. Default production must remain unknown.
const isolatedExposure: OpeningReservedPorts = { readExposure: async () => ({coverage:"complete",exactExposed:false,familyExposed:false,reason:null}) };
it("under an explicit test exposure port, reserves and issues a real item/attempt with no public key",async()=>{
  const x=await supplyFixture();
  expect(await readOpeningReservedSupply(f.sql,x.scope,x.requirement,{kind:'new_question'},isolatedExposure)).toMatchObject({status:'ready',available:1});
  const before=await readOpeningBackupRecords(f.sql,x.scope);
  expect(JSON.stringify(before)).not.toContain(x.candidate.text);
  expect(JSON.stringify(before)).not.toContain(x.candidate.answer);
  await f.sql.begin(async tx=>{await lockWorkspaceLearningHistory(tx,x.scope);await reserveOpeningCourseQuestion(tx,x.scope,x.requirement,x.activity.id,{kind:'new_family',excludedFamilyIds:[]},isolatedExposure);});
  const content=createOpeningTeachingContentRepository(f.sql,isolatedExposure);
  const [one,two]=await Promise.all([content.getClientInit(x.scope,x.activity.id),content.getClientInit(x.scope,x.activity.id)]);
  expect(one?.blocks).toEqual(two?.blocks);
  expect(one?.blocks).toHaveLength(1);
  expect(one?.blocks[0]?.content).toMatchObject({text:x.candidate.text});
  expect(JSON.stringify(one)).not.toContain(x.candidate.answer);
  const [stored]=await f.sql`SELECT * FROM opening_course_reserved_questions WHERE workspace_id=${x.scope.workspaceId}`;
  expect(stored).toMatchObject({state:'issued',reserved_activity_id:x.activity.id});
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${x.scope.workspaceId}`).toHaveLength(1);
  const session=await createOpeningLearningRepository(f.sql).createSession(x.scope,{activityId:x.activity.id,courseId:x.courseId,skillLabel:'Arithmetic',sourceIds:[x.sourceId]});
  const again=await createOpeningLearningAttemptRepository(f.sql).create(x.scope,{sessionId:session.id,clientKey:randomUUID(),teachingBlock:{blockId:one!.blocks[0]!.blockId,contentVersion:1}});
  expect(again.itemVersionId).toBe(stored!.issued_item_version_id);
  expect(await readOpeningReservedSupply(f.sql,x.scope,x.requirement,{kind:'new_question'},isolatedExposure)).toMatchObject({status:'missing',available:0});
  expect(JSON.stringify(await readOpeningBackupRecords(f.sql,x.scope))).not.toContain(x.candidate.answer);
});
it("honors authoritative exposure without conflating same family and same question",async()=>{
  const x=await supplyFixture();
  const exposed: OpeningReservedPorts={readExposure:async()=>({coverage:'complete',exactExposed:true,familyExposed:false,reason:null})};
  expect(await readOpeningReservedSupply(f.sql,x.scope,x.requirement,{kind:'new_question'},exposed)).toMatchObject({status:'missing',available:0});
  const family: OpeningReservedPorts={readExposure:async()=>({coverage:'complete',exactExposed:false,familyExposed:true,reason:null})};
  expect(await readOpeningReservedSupply(f.sql,x.scope,x.requirement,{kind:'same_family',familyId:'arithmetic:*'},family)).toMatchObject({status:'ready',available:1});
  expect(await readOpeningReservedSupply(f.sql,x.scope,x.requirement,{kind:'new_family',excludedFamilyIds:[]},family)).toMatchObject({status:'missing',available:0});
});
it("pins admission to the real current requirement/source snapshot and returns a private row identity",async()=>{
  const x=await supplyFixture(), pinned={courseId:x.courseId,requirementId:x.requirement.id,requirementRevision:1,sourceVersions:{[x.sourceId]:1}};
  const candidate={text:'139*23',interaction:{kind:'numeric' as const},answer:'3197'};
  await expect(admitOpeningReservedCandidate(f.sql,x.scope,x.activity.id,{...pinned,requirementRevision:2},candidate)).rejects.toMatchObject({code:'CONFLICT'});
  await expect(admitOpeningReservedCandidate(f.sql,x.scope,x.activity.id,{...pinned,sourceVersions:{[x.sourceId]:2}},candidate)).rejects.toMatchObject({code:'CONFLICT'});
  const receipt=await admitOpeningReservedCandidate(f.sql,x.scope,x.activity.id,pinned,candidate);
  expect(receipt).not.toBeNull();
  const [row]=await f.sql`SELECT id,identity_json,key_json FROM opening_course_reserved_questions WHERE id=${receipt!.privateRefId}`;
  expect(row!.identity_json).toMatchObject({reservedQuestionId:row!.id,requirementId:x.requirement.id,requirementRevision:1,familyId:'arithmetic:*'});
  expect(await admitOpeningReservedCandidate(f.sql,x.scope,x.activity.id,pinned,{...candidate,answer:'1'})).toBeNull();
});
it("keeps missing history unknown and rejects forged or unsupported keys",async()=>{
  const x=await supplyFixture();
  expect(await saveOpeningReservedCandidates(f.sql,x.scope,x.activity.id,[{...x.candidate,text:'44+7',answer:'99'}])).toBe(0);
  await expect(saveOpeningReservedCandidates(f.sql,x.scope,x.activity.id,[{...x.candidate,trusted:true}])).rejects.toThrow();
  expect(await readOpeningReservedSupply(f.sql,x.scope,x.requirement)).toMatchObject({status:'unknown',available:0});
});
it("serializes racing reservations and rolls back a failed issue without half publication",async()=>{
  const x=await supplyFixture(),other=await insertTestTeachingActivity(f.sql,x.scope,x.courseId);
  await f.sql`UPDATE opening_teaching_activities SET goal_json=(SELECT goal_json FROM opening_teaching_activities WHERE id=${x.activity.id}),source_ids=ARRAY[${x.sourceId}]::uuid[] WHERE id=${other}`;
  const attempts=await Promise.allSettled([x.activity.id,other].map(activityId=>f.sql.begin(async tx=>{
    await lockWorkspaceLearningHistory(tx,x.scope);return reserveOpeningCourseQuestion(tx,x.scope,x.requirement,activityId,{kind:'new_question'},isolatedExposure);
  })));
  expect(attempts.filter(row=>row.status==='fulfilled')).toHaveLength(1);
  const [row]=await f.sql`SELECT reserved_activity_id FROM opening_course_reserved_questions WHERE workspace_id=${x.scope.workspaceId}`;
  await expect(f.sql.begin(async tx=>{await issueOpeningReservedQuestion(tx,x.scope,String(row!.reserved_activity_id),isolatedExposure);throw new Error('after issue');})).rejects.toThrow('after issue');
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${x.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM library_revisions WHERE workspace_id=${x.scope.workspaceId}`).toHaveLength(0);
  expect((await f.sql`SELECT state FROM opening_course_reserved_questions WHERE workspace_id=${x.scope.workspaceId}`)[0]!.state).toBe('reserved');
});
