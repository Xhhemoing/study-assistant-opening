import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpeningLearningGoalRepository, createOpeningLearningRepository, createOpeningTeachingContentRepository,
  createOpeningLearningAttemptRepository, createWorkspacePreferencesRepository, createOpeningCourseReadySourcesRepository } from "@aistudy/database";
import { createCourseRouteService } from "../../apps/web/src/features/opening/teaching/course-route-service";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { createOpeningCourseRouteRetestRepository } from "../../packages/database/src/repositories/opening-course-route-retest";
import { saveOpeningReservedCandidates } from "../../packages/database/src/repositories/opening-course-reserved-selection";
import * as exposure from "../../packages/database/src/repositories/opening-course-question-exposure";
import * as starts from "../../packages/database/src/repositories/opening-course-route-reserved-start";
import { readOpeningLearningCapacity } from "../../packages/database/src/repositories/opening-learning-capacity";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import type { CourseRouteActionResult, CourseRouteStart, TeachingActivity } from "@aistudy/contracts";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
const ready = (result: CourseRouteActionResult) => {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error(JSON.stringify(result));
  return result;
};
// Synthetic PG fixture. Only successful eligibility tests replace the exposure
// reader; no production coverage marker, provider, paid API or model is created.
async function setup() {
  const rows = backupRows(f.sql, f.scope), sourceId = await rows.source("uploaded", 1), chunkId = randomUUID(), courseId = randomUUID();
  await f.sql`UPDATE opening_sources SET mime='text/plain' WHERE id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text) VALUES(${chunkId},${sourceId},1,1,'Rational arithmetic.')`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Arithmetic',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [courseId], title: 'Arithmetic', kind: 'custom',
    targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1, learningMode: 'understand', successCriteria: 'Independent arithmetic' });
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true, exactVerificationEnabled: true });
  const snapshot = await route.confirm(f.scope, courseId, { expectedRevisions: [], confirmScope: true, requirements: [{ id: randomUUID(), stableSkillId: randomUUID(),
    knowledgeNodeId: null, requirementKey: 'arithmetic', title: 'Arithmetic', position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [],
    sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], verification: { kind: 'exact', status: 'missing', exerciseKeys: [], rubric: null, missingReasons: [] }, origin: 'confirmed' }] });
  const requirement = snapshot.requirements[0]!.requirement;
  const base: CourseRouteStart = { goalId: goal.id, expectedGoalRevision: 1, requirementId: requirement.id, expectedRequirementRevision: 1, minutes: 20, clientKey: randomUUID() };
  const origin = ready(await route.start(f.scope, courseId, base)).activity;
  await publishBaseline(origin, sourceId);
  const session = await createOpeningLearningRepository(f.sql).createSession(f.scope, { activityId: origin.id, courseId, sourceIds: [sourceId], skillLabel: 'Arithmetic' });
  const spec = (await createOpeningTeachingContentRepository(f.sql).getActivitySpec(f.scope, origin.id))!;
  const attempts = createOpeningLearningAttemptRepository(f.sql);
  const attempt = await attempts.create(f.scope, { sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId: spec.blockOrder[0]!.blockId, contentVersion: 1 } });
  const observation = await createOpeningAttemptService(f.sql).submit(f.scope, attempt.id, { clientKey: randomUUID(), answer: '7', outcome: 'unverified', assistance: 'independent', verdictSource: 'self_report' });
  await f.sql`UPDATE opening_learning_attempts SET started_at=started_at-interval '4 days',submitted_at=submitted_at-interval '4 days' WHERE id=${attempt.id}`;
  await f.sql`UPDATE opening_learning_observations SET started_at=started_at-interval '4 days',submitted_at=submitted_at-interval '4 days',recorded_at=recorded_at-interval '4 days',occurred_at=occurred_at-interval '4 days' WHERE id=${observation.id}`;
  await createWorkspacePreferencesRepository(f.sql).setLearningPreferences(f.scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const retests = createOpeningCourseRouteRetestRepository(f.sql, { exactVerificationEnabled: true });
  const receipt = await retests.schedule(f.scope, courseId, { goalId: goal.id, expectedGoalRevision: 1, activityId: origin.id, expectedPathVersion: 1, observationId: observation.id, clientKey: randomUUID(), minutes: 20 });
  const task = await retests.readTask(f.scope, courseId, receipt.taskId);
  if (!task.managed) throw new Error('missing managed task');
  const input = { ...base, taskId: task.taskId, expectedTaskVersion: task.expectedTaskVersion, clientKey: randomUUID() };
  const purposes = createOpeningCourseReadySourcesRepository(f.sql), pin = await purposes.readSourcePurposePin(f.scope, { activityId: origin.id, materialUse: 'teaching' });
  await saveOpeningReservedCandidates(f.sql, f.scope, origin.id, [{ text: '137*19', interaction: { kind: 'numeric' }, answer: '2603' }],
    { assertPinnedContext: tx => purposes.assertSourcePurposePin(f.scope, pin, tx) });
  const service = createCourseRouteService(f.sql, { OPENING_TEACHING_COMPILER_ENABLED: '1' });
  const capacityBefore = await readOpeningLearningCapacity(f.sql, f.scope);
  return { courseId, sourceId, requirement, origin, input, service, capacityBefore };
}
async function publishBaseline(activity: TeachingActivity, sourceId: string) {
  const documentId = randomUUID(), revisionId = randomUUID(), unitId = randomUUID(), prompt = randomUUID(), answer = randomUUID();
  const blocks = [{ id: prompt, type: 'prompt', position: 0, content: { text: '3+4', interaction: { kind: 'numeric' } } },
    { id: answer, type: 'answer_key', position: 1, content: { text: '7' } }];
  await f.sql`INSERT INTO library_documents(id,workspace_id,title,lifecycle,current_revision_number) VALUES(${documentId},${f.scope.workspaceId},'Baseline','published',1)`;
  await f.sql`INSERT INTO library_revisions(id,workspace_id,document_id,revision_number,title,lifecycle,reason,blocks) VALUES(${revisionId},${f.scope.workspaceId},${documentId},1,'Baseline','published','fixture',${f.sql.json(blocks)})`;
  for (const block of blocks) await f.sql`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content) VALUES(${block.id},${f.scope.workspaceId},${documentId},${block.type},${block.position},${f.sql.json(block.content)})`;
  await f.sql`INSERT INTO opening_teaching_units(id,workspace_id,owner_user_id,title,document_id,current_revision_number) VALUES(${unitId},${f.scope.workspaceId},${f.scope.ownerUserId},'Baseline',${documentId},1)`;
  await f.sql`INSERT INTO opening_teaching_activity_specs(id,workspace_id,owner_user_id,activity_id,teaching_unit_id,document_id,revision_number,block_order,source_refs,version)
    VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},${activity.id},${unitId},${documentId},1,
    ${f.sql.json([{ blockId: prompt, blockType: 'prompt', role: 'prompt', position: 0 }, { blockId: answer, blockType: 'answer_key', role: 'answer_key', position: 1 }])},${f.sql.json([{ sourceId, version: 1 }])},1)`;
  await f.sql`UPDATE opening_teaching_activities SET content_version=1,generate_status='needs_check' WHERE id=${activity.id}`;
}
function qualifyTestOnly() {
  return vi.spyOn(exposure, 'readCourseQuestionExposure').mockResolvedValue({ coverage: 'complete', exactExposed: false, familyExposed: false, reason: null });
}
async function noPublication(x: Awaited<ReturnType<typeof setup>>) {
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(1);
  expect(await f.sql`SELECT state FROM opening_course_reserved_questions WHERE course_id=${x.courseId}`).toEqual([{ state: 'available' }]);
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE course_id=${x.courseId}`).toHaveLength(1);
  expect(await f.sql`SELECT id FROM library_revisions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  expect((await readOpeningLearningCapacity(f.sql, f.scope)).usedMinutes).toBe(x.capacityBefore.usedMinutes);
}
it.each(['missing', 'invalidated'] as const)('real service rejects %s default coverage without reservation or publication', async coverage => {
  const x = await setup();
  if (coverage === 'missing') await f.sql`DELETE FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`;
  else await f.sql`UPDATE opening_course_question_exposure_coverage SET invalidated=true WHERE workspace_id=${f.scope.workspaceId}`;
  await expect(x.service.start(f.scope, x.courseId, x.input)).rejects.toMatchObject({ code: 'CONFLICT' });
  await noPublication(x);
});
it('uses the unmodified durable reader to issue only when real PG genesis and history qualify', async () => {
  const x = await setup();
  const result = ready(await x.service.start(f.scope, x.courseId, x.input));
  expect(result.activity.contentVersion).toBe(1);
  expect(await f.sql`SELECT state FROM opening_course_reserved_questions WHERE course_id=${x.courseId}`).toEqual([{ state: 'issued' }]);
  const init = await createOpeningTeachingContentRepository(f.sql).getClientInit(f.scope, result.activity.id);
  expect(init?.blocks[0]?.content).toMatchObject({ text: '137*19' });
  expect(JSON.stringify([result, init])).not.toContain('2603');
  const [attempt] = await f.sql`SELECT a.id,a.requirement_key,v.evaluation_spec FROM opening_learning_attempts a
    JOIN opening_learning_item_versions v ON v.id=a.item_version_id WHERE a.activity_id=${result.activity.id}`;
  expect(attempt).toMatchObject({ requirement_key: 'arithmetic', evaluation_spec: { courseRequirement: {
    id: x.requirement.id, revision: 1, stableSkillId: x.requirement.stableSkillId, requirementKey: 'arithmetic' } } });
  expect(await f.sql`SELECT id FROM opening_learning_observations WHERE course_id=${x.courseId}`).toHaveLength(1); // issuance alone is no mastery evidence
  const answer = await createOpeningAttemptService(f.sql).submit(f.scope, String(attempt!.id), {
    clientKey: randomUUID(), answer: '2603', outcome: 'unverified', assistance: 'independent', verdictSource: 'self_report' });
  expect(answer.retestId).toBeTruthy();
  // Existing shared evaluator requires a public answerBlockId. This caller
  // cannot fix that out-of-scope grading gap or promote issuance into mastery.
  expect(answer.outcome).toBe('unverified');
});
it('explicit real service start issues once across concurrent clicks and replays, without exposing the private key', async () => {
  const x = await setup(); qualifyTestOnly();
  const [a, b] = await Promise.all([x.service.start(f.scope, x.courseId, x.input), x.service.start(f.scope, x.courseId, { ...x.input, clientKey: randomUUID() })]);
  const one = ready(a), two = ready(b);
  expect(one.activity.id).toBe(two.activity.id);
  expect(one.activity.contentVersion).toBe(1);
  expect(ready(await x.service.start(f.scope, x.courseId, { ...x.input, taskId: x.input.taskId.toUpperCase() })).activity.id).toBe(one.activity.id);
  const content = createOpeningTeachingContentRepository(f.sql), init = await content.getClientInit(f.scope, one.activity.id);
  expect(init?.blocks).toHaveLength(1);
  expect(init?.blocks[0]?.content).toMatchObject({ text: '137*19' });
  expect(JSON.stringify([a, b, init])).not.toContain('2603');
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${one.activity.id}`).toHaveLength(1);
  expect(await f.sql`SELECT state FROM opening_course_reserved_questions WHERE course_id=${x.courseId}`).toEqual([{ state: 'issued' }]);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE kind='compile-teaching-unit' AND payload->>'activityId'=${one.activity.id}`).toHaveLength(0);
  expect((await x.service.read(f.scope, x.courseId)).requirements[0]!.reservedSupply).toMatchObject({ status: 'unknown', available: 0 });
  await expect(x.service.start(f.scope, x.courseId, { ...x.input, expectedTaskVersion: x.input.expectedTaskVersion + 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
  await f.sql`UPDATE course_asset_memberships SET updated_at=updated_at+interval '1 microsecond' WHERE course_id=${x.courseId}`;
  await expect(x.service.start(f.scope, x.courseId, x.input)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${one.activity.id}`).toHaveLength(1);
});
it('rejects wrong course/owner before selecting private supply', async () => {
  const x = await setup(), reader = qualifyTestOnly();
  await expect(x.service.start(f.otherScope, x.courseId, x.input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(x.service.start(f.scope, randomUUID(), x.input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(reader).not.toHaveBeenCalled();
  await noPublication(x);
});
it.each(['empty', 'exposed_family', 'task_version'] as const)('refuses %s before producing an empty or replacement activity', async reason => {
  const x = await setup();
  if (reason === 'empty') await f.sql`DELETE FROM opening_course_reserved_questions WHERE course_id=${x.courseId}`;
  if (reason === 'exposed_family') vi.spyOn(exposure, 'readCourseQuestionExposure').mockResolvedValue({ coverage: 'complete', exactExposed: false, familyExposed: true, reason: null });
  const request = reason === 'task_version' ? { ...x.input, expectedTaskVersion: x.input.expectedTaskVersion + 1 } : x.input;
  await expect(x.service.start(f.scope, x.courseId, request)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${x.courseId}`).toHaveLength(1);
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE course_id=${x.courseId}`).toHaveLength(1);
  expect(await f.sql`SELECT id FROM library_revisions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  expect((await readOpeningLearningCapacity(f.sql, f.scope)).usedMinutes).toBe(x.capacityBefore.usedMinutes);
});
it('rolls back a stale original purpose CAS after capture', async () => {
  const x = await setup(); qualifyTestOnly();
  const original = starts.prepareCourseReservedStart;
  vi.spyOn(starts, 'prepareCourseReservedStart').mockImplementation(async (...args) => {
    const pin = await original(...args);
    await f.sql`UPDATE course_asset_memberships SET updated_at=updated_at+interval '1 microsecond' WHERE course_id=${x.courseId}`;
    return pin;
  });
  await expect(x.service.start(f.scope, x.courseId, x.input)).rejects.toMatchObject({ code: 'CONFLICT' });
  await noPublication(x);
});
it('rolls back all issued bodies, attempts and exposures when the final presentation write fails', async () => {
  const x = await setup(); qualifyTestOnly();
  const record = exposure.recordCourseQuestionExposure;
  vi.spyOn(exposure, 'recordCourseQuestionExposure').mockImplementation(async (...args) => {
    await record(...args);
    throw new Error('presentation failed');
  });
  await expect(x.service.start(f.scope, x.courseId, x.input)).rejects.toThrow('presentation failed');
  await noPublication(x);
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it('does not consume a private pending reservation through default GET', async () => {
  const x = await setup();
  await f.sql`UPDATE opening_course_reserved_questions SET state='reserved',reservation_key=${`course-reserved:${x.origin.id}`},
    reserved_activity_id=${x.origin.id},reserved_at=now() WHERE course_id=${x.courseId}`;
  await expect(createOpeningTeachingContentRepository(f.sql).getClientInit(f.scope, x.origin.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await f.sql`SELECT state FROM opening_course_reserved_questions WHERE course_id=${x.courseId}`).toEqual([{ state: 'reserved' }]);
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE course_id=${x.courseId}`).toHaveLength(1);
});
it('rolls back reservation and bodies when issuance qualification changes', async () => {
  const x = await setup();
  vi.spyOn(exposure, 'readCourseQuestionExposure')
    .mockResolvedValueOnce({ coverage: 'complete', exactExposed: false, familyExposed: false, reason: null })
    .mockResolvedValue({ coverage: 'unknown', exactExposed: false, familyExposed: false, reason: 'coverage changed' });
  await expect(x.service.start(f.scope, x.courseId, x.input)).rejects.toMatchObject({ code: 'CONFLICT' });
  await noPublication(x);
});
