import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Sql, TransactionSql } from "postgres";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningCourseReadySourcesRepository, readOpeningBackupRecords, createOpeningLearningGoalRepository, createOpeningTeachingContentRepository, createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { saveOpeningReservedCandidates, admitOpeningReservedCandidate, readOpeningReservedSupply, reserveOpeningCourseQuestion, issueOpeningReservedQuestion, type OpeningReservedPorts } from "../../packages/database/src/repositories/opening-course-reserved-selection";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { recordCourseQuestionExposure } from "../../packages/database/src/repositories/opening-course-question-exposure";
import { backupRows } from "./opening-backup-records-fixture";
import type { CourseRouteRequirementInput } from "@aistudy/contracts";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";

// Raw storage fixtures are deliberately NOT trusted candidate
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
  const purposes=createOpeningCourseReadySourcesRepository(f.sql);
  const pin=await purposes.readSourcePurposePin(scope,{activityId:start.activity.id,sourceIds:[freshSource],materialUse:'teaching'});
  const admission={assertPinnedContext:(tx:TransactionSql)=>purposes.assertSourcePurposePin(scope,pin,tx)};
  await saveOpeningReservedCandidates(f.sql,scope,start.activity.id,[candidate],admission);
  return {scope,courseId,sourceId:freshSource,goal,requirement,activity:start.activity,candidate,route,admission};
}
// Explicit SQL-consumer test port, NOT production coverage evidence.
// Real scanner genesis, missing-history and sticky-gap regressions below use no port.
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
  await expect(admitOpeningReservedCandidate(f.sql,x.scope,x.activity.id,{...pinned,requirementRevision:2},candidate,x.admission)).rejects.toMatchObject({code:'CONFLICT'});
  await expect(admitOpeningReservedCandidate(f.sql,x.scope,x.activity.id,{...pinned,sourceVersions:{[x.sourceId]:2}},candidate,x.admission)).rejects.toMatchObject({code:'CONFLICT'});
  const receipt=await admitOpeningReservedCandidate(f.sql,x.scope,x.activity.id,pinned,candidate,x.admission);
  expect(receipt).not.toBeNull();
  const [row]=await f.sql`SELECT id,identity_json,key_json FROM opening_course_reserved_questions WHERE id=${receipt!.privateRefId}`;
  expect(row!.identity_json).toMatchObject({reservedQuestionId:row!.id,requirementId:x.requirement.id,requirementRevision:1,familyId:'arithmetic:*'});
  expect(await admitOpeningReservedCandidate(f.sql,x.scope,x.activity.id,pinned,{...candidate,answer:'1'},x.admission)).toBeNull();
});
it("uses the real scanner to qualify a fresh genesis with fully enumerable history",async()=>{
  const x=await supplyFixture();
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:false});
  expect(await readOpeningReservedSupply(f.sql,x.scope,x.requirement)).toMatchObject({status:'ready',available:1});
  expect(await coverageInvalidated()).toEqual({complete:true,invalidated:false});
});
it("keeps missing history unknown and rejects forged or unsupported keys",async()=>{
  const x=await supplyFixture();
  expect(await saveOpeningReservedCandidates(f.sql,x.scope,x.activity.id,[{...x.candidate,text:'44+7',answer:'99'}],x.admission)).toBe(0);
  await expect(saveOpeningReservedCandidates(f.sql,x.scope,x.activity.id,[{...x.candidate,trusted:true}],x.admission)).rejects.toThrow();
  // Explicitly remove the trusted origin, as for pre-0109 workspaces. Empty
  // current history alone is not unknown when DB genesis and all surfaces exist.
  await f.sql`DELETE FROM opening_course_question_exposure_coverage WHERE workspace_id=${x.scope.workspaceId}`;
  expect(await readOpeningReservedSupply(f.sql,x.scope,x.requirement)).toMatchObject({status:'unknown',available:0});
  await expect(f.sql.begin(tx=>reserveOpeningCourseQuestion(tx,x.scope,x.requirement,x.activity.id,{kind:'new_question'})))
    .rejects.toMatchObject({code:'CONFLICT'});
  expect((await f.sql`SELECT state FROM opening_course_reserved_questions WHERE workspace_id=${x.scope.workspaceId}`)[0]!.state).toBe('available');
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${x.scope.workspaceId}`).toHaveLength(0);
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

// Ledger storage boundaries only: no scanner/coverage authority is simulated here.
async function insertExposure(overrides: { ownerUserId?: string; itemVersionId?: string; versions?: unknown; surfaceKey?: string; kind?: string; exact?: unknown; revision?: number } = {}) {
  const id=randomUUID(), surfaceKey=overrides.surfaceKey ?? `presented:${id}`;
  await f.sql`INSERT INTO opening_course_question_exposures(id,workspace_id,owner_user_id,surface_key,kind,exact_content,source_versions,item_version_id,history_revision)
    VALUES(${id},${f.scope.workspaceId},${overrides.ownerUserId ?? f.scope.ownerUserId},${surfaceKey},${overrides.kind ?? 'presented'},
      ${overrides.exact === undefined ? null : f.sql.json(overrides.exact as never)},${f.sql.json((overrides.versions ?? {}) as never)},
      ${overrides.itemVersionId ?? null},${overrides.revision ?? 0})`;
  return id;
}
it("creates empty private exposure slots, defaults incomplete and preserves historical source snapshots",async()=>{
  expect(await f.sql`SELECT protocol,history_revision,complete,invalidated,covered_surface_count FROM opening_course_question_exposure_coverage
    WHERE workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`)
    .toEqual([{protocol:'course-question-exposure-1',history_revision:'0',complete:false,invalidated:false,covered_surface_count:'0'}]);
  const sourceId=randomUUID(), versions={ [sourceId]: 1 }, id=await insertExposure({versions});
  const [stored]=await f.sql`SELECT exact_content,source_versions FROM opening_course_question_exposures WHERE id=${id}`;
  expect(stored).toMatchObject({exact_content:null,source_versions:versions});
  // A historical/deleted source ref remains a negative-exposure fact, not a live-source FK.
  const [index]=await f.sql`SELECT indexname FROM pg_indexes WHERE tablename='opening_course_question_exposures' AND indexname='opening_course_question_exposures_history_idx'`;
  expect(index?.indexname).toBe('opening_course_question_exposures_history_idx');
  const serialized=JSON.stringify(await readOpeningBackupRecords(f.sql,f.scope));
  expect(serialized).not.toContain('opening_course_question_exposures');
  expect(serialized).not.toContain('opening_course_question_exposure_coverage');
});
it("rejects cross-owner exposures and coverage, malformed facts and duplicate surfaces",async()=>{
  await expect(insertExposure({ownerUserId:f.otherScope.ownerUserId})).rejects.toMatchObject({code:'23514'});
  await expect(f.sql`INSERT INTO opening_course_question_exposure_coverage(workspace_id,owner_user_id,protocol,history_revision,covered_surface_count)
    VALUES(${f.scope.workspaceId},${f.otherScope.ownerUserId},'course-question-exposure-1',0,0)`).rejects.toMatchObject({code:'23514'});
  for(const patch of [{kind:'answer_key'},{surfaceKey:''},{exact:[]},{revision:-1},{versions:{bad:1}},{versions:{[randomUUID()]:-1}},{versions:{[randomUUID()]:'1'}}])
    await expect(insertExposure(patch)).rejects.toMatchObject({code:'23514'});
  await expect(f.sql`INSERT INTO opening_course_question_exposure_coverage(workspace_id,owner_user_id,protocol,history_revision,covered_surface_count)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},'course-question-exposure-1',0,0)`).rejects.toMatchObject({code:'23514'});
  await expect(f.sql`UPDATE opening_course_question_exposure_coverage SET owner_user_id=${f.otherScope.ownerUserId}
    WHERE workspace_id=${f.scope.workspaceId}`).rejects.toMatchObject({code:'23514'});
  const surfaceKey=randomUUID(); await insertExposure({surfaceKey});
  await expect(insertExposure({surfaceKey})).rejects.toMatchObject({code:'23505'});
  await expect(f.sql`INSERT INTO opening_course_question_exposure_coverage(workspace_id,owner_user_id,protocol,history_revision,covered_surface_count)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},'unknown-protocol',0,0)`).rejects.toMatchObject({code:'23514'});
  await expect(f.sql`INSERT INTO opening_course_question_exposure_coverage(workspace_id,owner_user_id,protocol,history_revision,covered_surface_count)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},'course-question-exposure-1',0,-1)`).rejects.toMatchObject({code:'23514'});
});
it("binds optional issued item to the same scope and does not rewrite old exposure history",async()=>{
  const x=await setup(), itemId=randomUUID(), otherActivity=await insertTestTeachingActivity(f.sql,f.otherScope);
  await f.sql`INSERT INTO opening_learning_item_versions(id,workspace_id,owner_user_id,course_id,activity_id,problem_id,source_id,source_version,stem_snapshot,artifact_kind)
    VALUES(${itemId},${f.otherScope.workspaceId},${f.otherScope.ownerUserId},NULL,${otherActivity},${randomUUID()},NULL,NULL,'historical question','unknown')`;
  await expect(insertExposure({itemVersionId:itemId})).rejects.toMatchObject({code:'23514'});
  const ownedItem=randomUUID();
  await f.sql`INSERT INTO opening_learning_item_versions(id,workspace_id,owner_user_id,course_id,activity_id,problem_id,source_id,source_version,stem_snapshot,artifact_kind)
    VALUES(${ownedItem},${f.scope.workspaceId},${f.scope.ownerUserId},${x.courseId},${x.activityId},${randomUUID()},NULL,NULL,'historical question','unknown')`;
  const id=await insertExposure({itemVersionId:ownedItem,exact:{question:'historical question',interaction:{kind:'text'},figures:[]}});
  await expect(f.sql`UPDATE opening_course_question_exposures SET exact_content=NULL WHERE id=${id}`).rejects.toMatchObject({code:'23514'});
  await expect(f.sql`UPDATE opening_course_question_exposures SET source_versions=${f.sql.json({[randomUUID()]:2})} WHERE id=${id}`).rejects.toMatchObject({code:'23514'});
  await f.sql`UPDATE opening_course_question_exposures SET surface_key=surface_key WHERE id=${id}`;
  await expect(f.sql.begin(async tx=>{
    await tx`DELETE FROM opening_course_question_exposures WHERE id=${id} AND workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
    throw new Error('privacy transaction rollback');
  })).rejects.toThrow('privacy transaction rollback');
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE id=${id}`).toHaveLength(1);
});

it("allows workspace cascade with live historical surfaces, rolls it back atomically and retains live scope guards",async()=>{
  const rows=backupRows(f.sql,f.scope),sourceId=await rows.source(),chunkId=await rows.chunk(sourceId);
  const conversationId=await rows.conversation(),turnId=await rows.turn(conversationId),cardId=randomUUID();
  const exposureId=await insertExposure({exact:{question:'presented question',interaction:{kind:'text'},figures:[]}});
  await f.sql`INSERT INTO cards(id,workspace_id,owner_user_id,front,back)
    VALUES(${cardId},${f.scope.workspaceId},${f.scope.ownerUserId},'presented question','saved answer')`;
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:false});
  await expect(f.sql.begin(async tx=>{
    await tx`DELETE FROM workspaces WHERE id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
    expect(await tx`SELECT workspace_id FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    expect(await tx`SELECT id FROM opening_sources WHERE id=${sourceId}`).toHaveLength(0);
    expect(await tx`SELECT id FROM opening_course_question_exposures WHERE id=${exposureId}`).toHaveLength(0);
    throw new Error('workspace cascade rollback');
  })).rejects.toThrow('workspace cascade rollback');
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:false});
  for(const [table,id] of [['opening_sources',sourceId],['opening_source_chunks',chunkId],['opening_turns',turnId],['cards',cardId],['opening_course_question_exposures',exposureId]])
    expect(await f.sql`SELECT id FROM ${f.sql(table!)} WHERE id=${id!}`).toHaveLength(1);
  await expect(insertExposure({ownerUserId:f.otherScope.ownerUserId})).rejects.toMatchObject({code:'23514'});
  await expect(f.sql`UPDATE opening_course_question_exposure_coverage SET owner_user_id=${f.otherScope.ownerUserId}
    WHERE workspace_id=${f.scope.workspaceId}`).rejects.toMatchObject({code:'23514'});
  // A live workspace still records ordinary historical loss before the parent is deleted.
  await f.sql`DELETE FROM opening_course_question_exposures WHERE id=${exposureId} AND workspace_id=${f.scope.workspaceId}`;
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:true});
  await f.sql`DELETE FROM workspaces WHERE id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
  expect(await f.sql`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT workspace_id FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_sources WHERE id=${sourceId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_source_chunks WHERE id=${chunkId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_turns WHERE id=${turnId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM cards WHERE id=${cardId}`).toHaveLength(0);
  expect((await f.sql`SELECT invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.otherScope.workspaceId}`)[0]!.invalidated).toBe(false);
});

async function coverageInvalidated() {
  const [row]=await f.sql`SELECT complete,invalidated FROM opening_course_question_exposure_coverage
    WHERE workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
  return row;
}
it("rolls back source history invalidation with its transaction, then keeps deletion gaps sticky across scanner updates",async()=>{
  const rows=backupRows(f.sql,f.scope),sourceId=await rows.source(),chunkId=await rows.chunk(sourceId);
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:false});
  await expect(f.sql.begin(async tx=>{
    await tx`UPDATE opening_source_chunks SET text='changed historical question' WHERE id=${chunkId}`;
    expect((await tx`SELECT invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`)[0]!.invalidated).toBe(true);
    throw new Error('rollback history edit');
  })).rejects.toThrow('rollback history edit');
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:false});
  await f.sql`DELETE FROM opening_sources WHERE id=${sourceId} AND workspace_id=${f.scope.workspaceId}`;
  expect(await f.sql`SELECT id FROM opening_source_chunks WHERE id=${chunkId}`).toHaveLength(0);
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:true});
  // A simulated scanner metadata UPDATE cannot resurrect a gap. This is not a
  // completeness-positive fixture and never seeds complete=true as evidence.
  await f.sql`UPDATE opening_course_question_exposure_coverage SET invalidated=false,complete=true,history_revision=1,covered_surface_count=0
    WHERE workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:true});
  expect((await f.sql`SELECT invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.otherScope.workspaceId}`)[0]!.invalidated).toBe(false);
});
it.each(['text','image','delete'] as const)("invalidates a chunk %s change without cross-scope mutation",async change=>{
  const rows=backupRows(f.sql,f.scope),sourceId=await rows.source(),chunkId=await rows.chunk(sourceId);
  if(change==='text') await f.sql`UPDATE opening_source_chunks SET text='replaced question' WHERE id=${chunkId}`;
  else if(change==='image') await f.sql`UPDATE opening_source_chunks SET image_object_key='replaced/image' WHERE id=${chunkId}`;
  else await f.sql`DELETE FROM opening_source_chunks WHERE id=${chunkId}`;
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:true});
  expect((await f.sql`SELECT invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.otherScope.workspaceId}`)[0]!.invalidated).toBe(false);
});
it.each(['text','snapshot','delete'] as const)("invalidates a turn %s change while retaining the immutable history guard",async change=>{
  const rows=backupRows(f.sql,f.scope),conversation=await rows.conversation(),turn=await rows.turn(conversation);
  if(change==='text') await f.sql`UPDATE opening_turns SET text='edited question' WHERE id=${turn}`;
  else if(change==='snapshot') await f.sql`UPDATE opening_turns SET help_input_snapshot=${f.sql.json({question:'edited question'})} WHERE id=${turn}`;
  else await f.sql`DELETE FROM opening_turns WHERE id=${turn}`;
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:true});
});
it.each(['card_update','card_delete','help_delete','item_delete'] as const)("invalidates %s historical loss",async kind=>{
  const x=await setup();
  if(kind.startsWith('card')){
    const id=randomUUID();
    await f.sql`INSERT INTO cards(id,workspace_id,owner_user_id,front,back) VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},'saved question','saved answer')`;
    if(kind==='card_update') await f.sql`UPDATE cards SET front='edited question' WHERE id=${id}`;
    else await f.sql`DELETE FROM cards WHERE id=${id}`;
  }else if(kind==='item_delete'){
    const id=randomUUID();
    await f.sql`INSERT INTO opening_learning_item_versions(id,workspace_id,owner_user_id,course_id,activity_id,problem_id,source_id,source_version,stem_snapshot,artifact_kind)
      VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},${x.courseId},${x.activityId},${randomUUID()},NULL,NULL,'historical question','unknown')`;
    await f.sql`DELETE FROM opening_learning_item_versions WHERE id=${id}`;
  }else{
    const rows=backupRows(f.sql,f.scope),conversation=await rows.conversation(),turn=await rows.turn(conversation);
    const session=await createOpeningLearningRepository(f.sql).createSession(f.scope,{activityId:x.activityId,courseId:x.courseId,skillLabel:'Arithmetic',sourceIds:[]});
    const id=await rows.help(session.id,turn);
    await f.sql`DELETE FROM opening_help_exposures WHERE id=${id}`;
  }
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:true});
});
it("preserves library append-only rejection and rolls back the attempted invalidation",async()=>{
  const doc=randomUUID(),revision=randomUUID();
  await f.sql`INSERT INTO library_documents(id,workspace_id,title,lifecycle) VALUES(${doc},${f.scope.workspaceId},'History','candidate')`;
  await f.sql`INSERT INTO library_revisions(id,workspace_id,document_id,revision_number,title,lifecycle,blocks)
    VALUES(${revision},${f.scope.workspaceId},${doc},1,'History','candidate',${f.sql.json([])})`;
  await expect(f.sql`UPDATE library_revisions SET blocks=${f.sql.json([{text:'changed'}])} WHERE id=${revision}`).rejects.toMatchObject({code:'23000'});
  await expect(f.sql`DELETE FROM library_revisions WHERE id=${revision}`).rejects.toMatchObject({code:'23000'});
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:false});
});
type HistoryGapSurface = 'block' | 'problem' | 'checkpoint' | 'observation' | 'exposure';
async function seedHistoryGapSurface(surface: HistoryGapSurface, x: Awaited<ReturnType<typeof supplyFixture>>) {
  // A real server-persisted presentation precedes each destructive mutation.
  const surfaceKey=`presented:${randomUUID()}`;
  await f.sql.begin(tx=>recordCourseQuestionExposure(tx,f.scope,{surfaceKey,kind:'presented',text:'2+3',sourceVersions:{}}));
  const [exposure]=await f.sql`SELECT id FROM opening_course_question_exposures
    WHERE workspace_id=${f.scope.workspaceId} AND surface_key=${surfaceKey}`;
  const exposureId=String(exposure!.id);
  if(surface==='exposure') return {table:'opening_course_question_exposures',idColumn:'id',id:exposureId,column:'surface_key',json:false};
  if(surface==='checkpoint') return {table:'opening_teaching_activities',idColumn:'id',id:x.activity.id,column:'checkpoint_json',json:true};
  if(surface==='block'){
    const documentId=randomUUID(),id=randomUUID();
    await f.sql`INSERT INTO library_documents(id,workspace_id,title,lifecycle) VALUES(${documentId},${f.scope.workspaceId},'Presented content','candidate')`;
    await f.sql`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content)
      VALUES(${id},${f.scope.workspaceId},${documentId},'prompt',0,${f.sql.json({text:'2+3'})})`;
    return {table:'library_blocks',idColumn:'id',id,column:'content',json:true};
  }
  const session=await createOpeningLearningRepository(f.sql).createSession(f.scope,{activityId:x.activity.id,courseId:x.courseId,skillLabel:'Arithmetic',sourceIds:[x.sourceId]});
  const id=randomUUID();
  if(surface==='problem'){
    await f.sql`INSERT INTO opening_problem_refs(problem_id,workspace_id,session_id,source_id,source_version,stem_snapshot,artifact_kind)
      VALUES(${id},${f.scope.workspaceId},${session.id},${x.sourceId},1,'2+3','reference_item')`;
    return {table:'opening_problem_refs',idColumn:'problem_id',id,column:'stem_snapshot',json:false};
  }
  await f.sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},0) ON CONFLICT DO NOTHING`;
  await f.sql`INSERT INTO opening_learning_observations(id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,source_ids,
    answer,outcome,assistance,client_key,source_turn_ids,verdict_source,workspace_history_revision)
    VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},${session.id},${x.courseId},${x.activity.id},'Arithmetic',${[x.sourceId]},
      'historical answer','unverified','unknown',${id},${[]},'unknown',0)`;
  return {table:'opening_learning_observations',idColumn:'id',id,column:'answer',json:false};
}
it.each([
  ['block','update'],['block','delete'],['problem','update'],['problem','delete'],
  ['checkpoint','update'],['checkpoint','delete'],['observation','update'],['observation','delete'],['exposure','delete'],
] as const)("keeps %s %s history gaps sticky, scoped and transactional without granting unseen",async(surface,mutation)=>{
  const x=await supplyFixture(),target=await seedHistoryGapSurface(surface,x);
  // Start from real scanner-qualified history, not a hand-written complete flag.
  expect(await readOpeningReservedSupply(f.sql,f.scope,x.requirement)).toMatchObject({status:'ready',available:1});
  const mutate=async(db:Sql|TransactionSql)=>{
    if(mutation==='delete') await db`DELETE FROM ${db(target.table)} WHERE ${db(target.idColumn)}=${target.id} AND workspace_id=${f.scope.workspaceId}`;
    else await db`UPDATE ${db(target.table)} SET ${db(target.column)}=${target.json?db.json({text:'changed historical content'}):'changed historical content'}
      WHERE ${db(target.idColumn)}=${target.id} AND workspace_id=${f.scope.workspaceId}`;
  };
  // Even an UPDATE OF a guarded column must not invalidate when bytes are unchanged.
  await f.sql`UPDATE ${f.sql(target.table)} SET ${f.sql(target.column)}=${f.sql(target.column)}
    WHERE ${f.sql(target.idColumn)}=${target.id} AND workspace_id=${f.scope.workspaceId}`;
  expect(await coverageInvalidated()).toEqual({complete:true,invalidated:false});
  await expect(f.sql.begin(async tx=>{
    await mutate(tx);
    expect((await tx`SELECT invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`)[0]!.invalidated).toBe(true);
    throw new Error('history gap rollback');
  })).rejects.toThrow('history gap rollback');
  expect(await coverageInvalidated()).toEqual({complete:true,invalidated:false});
  await mutate(f.sql);
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:true});
  await f.sql`UPDATE opening_course_question_exposure_coverage SET invalidated=false,complete=true WHERE workspace_id=${f.scope.workspaceId}`;
  expect(await coverageInvalidated()).toEqual({complete:false,invalidated:true});
  expect((await f.sql`SELECT complete,invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.otherScope.workspaceId}`)[0])
    .toEqual({complete:false,invalidated:false});
  // The same production scanner must not recover deleted/changed history.
  expect(await readOpeningReservedSupply(f.sql,f.scope,x.requirement)).toMatchObject({status:'unknown',available:0});
  await expect(f.sql.begin(tx=>reserveOpeningCourseQuestion(tx,f.scope,x.requirement,x.activity.id,{kind:'new_question'})))
    .rejects.toMatchObject({code:'CONFLICT'});
  expect((await f.sql`SELECT state FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`)[0]!.state).toBe('available');
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("does not backfill pre-0109 workspaces when applying the real migration and seeds only later workspace births",async()=>{
  const schema=`reserved_genesis_${randomUUID().replaceAll('-','')}`;
  const body=await readFile(new URL('../../packages/database/src/migrations/0109_opening_course_reserved_questions.sql',import.meta.url),'utf8');
  await f.sql.begin(async tx=>{
    await tx`CREATE SCHEMA ${tx(schema)}`;
    await tx`SET LOCAL search_path TO ${tx(schema)}`;
    // Minimal prior storage surfaces only; the ENTIRE real 0109 is executed.
    await tx.unsafe(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE workspaces(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL);
      CREATE TABLE courses(id uuid,workspace_id uuid,UNIQUE(workspace_id,id));
      CREATE TABLE course_requirements(id uuid,workspace_id uuid,UNIQUE(workspace_id,id));
      CREATE TABLE opening_teaching_activities(id uuid PRIMARY KEY,workspace_id uuid,checkpoint_json jsonb);
      CREATE TABLE library_blocks(id uuid PRIMARY KEY,workspace_id uuid,content jsonb);
      CREATE TABLE opening_problem_refs(problem_id uuid PRIMARY KEY,workspace_id uuid,stem_snapshot text);
      CREATE TABLE opening_learning_observations(id uuid PRIMARY KEY,workspace_id uuid,answer text);
      CREATE TABLE opening_learning_item_versions(id uuid PRIMARY KEY,workspace_id uuid,owner_user_id uuid);
      CREATE TABLE library_revisions(id uuid PRIMARY KEY,workspace_id uuid,blocks jsonb);
      CREATE TABLE opening_sources(id uuid PRIMARY KEY,workspace_id uuid);
      CREATE TABLE opening_source_chunks(id uuid PRIMARY KEY,source_id uuid,text text,image_object_key text);
      CREATE TABLE opening_turns(id uuid PRIMARY KEY,workspace_id uuid,text text,help_input_snapshot jsonb);
      CREATE TABLE cards(id uuid PRIMARY KEY,workspace_id uuid,front text);
      CREATE TABLE opening_help_exposures(id uuid PRIMARY KEY,workspace_id uuid);`);
    const oldOwner=randomUUID(),oldWorkspace=randomUUID(),newOwner=randomUUID(),newWorkspace=randomUUID();
    await tx`INSERT INTO users(id) VALUES(${oldOwner}),(${newOwner})`;
    await tx`INSERT INTO workspaces(id,owner_user_id) VALUES(${oldWorkspace},${oldOwner})`;
    await tx.unsafe(body);
    expect(await tx`SELECT * FROM opening_course_question_exposure_coverage WHERE workspace_id=${oldWorkspace}`).toHaveLength(0);
    expect(await tx`UPDATE opening_course_question_exposure_coverage SET complete=false WHERE workspace_id=${oldWorkspace} RETURNING workspace_id`).toHaveLength(0);
    await tx.savepoint(async nested=>{
      await expect(nested`INSERT INTO opening_course_question_exposure_coverage(workspace_id,owner_user_id,protocol,history_revision,covered_surface_count)
        VALUES(${oldWorkspace},${oldOwner},'course-question-exposure-1',0,0)`).rejects.toMatchObject({code:'23514'});
      // Return a rejected savepoint to clear PostgreSQL's failed statement state.
      throw new Error('expected insert blocked');
    }).catch(error=>{expect(error.message).toBe('expected insert blocked');});
    await tx`INSERT INTO workspaces(id,owner_user_id) VALUES(${newWorkspace},${newOwner})`;
    expect(await tx`SELECT complete,invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${newWorkspace}`)
      .toEqual([{complete:false,invalidated:false}]);
    await tx`DROP SCHEMA ${tx(schema)} CASCADE`;
  });
});
