import { randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpeningLearningGoalRepository, createOpeningLearningRepository, createOpeningTeachingContentRepository,
  createOpeningLearningAttemptRepository, createWorkspacePreferencesRepository, createOpeningCourseReadySourcesRepository, createOpeningTeachingActivitiesRepository } from "@aistudy/database";
import { createCourseRouteService } from "../../apps/web/src/features/opening/teaching/course-route-service";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createInlineAttemptPreparation } from "../../apps/web/src/features/opening/teaching/inline-attempt-prepare";
import { createInlineAttemptSubmission } from "../../apps/web/src/features/opening/teaching/inline-attempt-submission";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { createOpeningCourseRouteRetestRepository } from "../../packages/database/src/repositories/opening-course-route-retest";
import { saveOpeningReservedCandidates } from "../../packages/database/src/repositories/opening-course-reserved-selection";
import * as exposure from "../../packages/database/src/repositories/opening-course-question-exposure";
import * as starts from "../../packages/database/src/repositories/opening-course-route-reserved-start";
import { readOpeningLearningCapacity } from "../../packages/database/src/repositories/opening-learning-capacity";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { activitySpecClientInitSchema, courseRouteActionResultSchema, uuidSchema,
  type CourseRouteActionResult, type CourseRouteStart, type TeachingActivity } from "@aistudy/contracts";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
const ready = (result: CourseRouteActionResult) => {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error(JSON.stringify(result));
  return result;
};
// Only explicit metadata paths may contain answer-like digits inside UUIDs.
// Never exempt UUID-shaped strings in prompt bodies, feedback, hints or checkpoints.
function assertNoPrivateKey(value: unknown, answer: string, path = ''): void {
  if (typeof value === 'string') {
    const metadata = /^(result\.requirementId|result\.activity\.(id|workspaceId|ownerUserId|courseId|sourceIds\.\d+)|init\.(id|activityId|teachingUnitId|documentId)|init\.(blocks|blockOrder)\.\d+\.blockId|init\.sourceRefs\.\d+\.(sourceId|chunkId))$/;
    if (metadata.test(path) && uuidSchema.safeParse(value).success) return;
    const href = path === 'result.href' ? /^\/opening\/courses\/([^/]+)\/study\?activity=(.+)$/.exec(value) : null;
    if (href && uuidSchema.safeParse(href[1]).success && uuidSchema.safeParse(href[2]).success) return;
    if (path === 'result.activity.clientKey' && value.startsWith('course-route-task:')
      && uuidSchema.safeParse(value.slice('course-route-task:'.length)).success) return;
    expect(value, path).not.toContain(answer);
  } else if (typeof value === 'number') expect(String(value), path).not.toContain(answer);
  else if (Array.isArray(value)) value.forEach((entry, index) => assertNoPrivateKey(entry, answer, `${path}.${index}`));
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    expect(key, `${path}.${key}`).not.toMatch(/^(?:answer|key)(?:$|_|[A-Z])/);
    expect(key, path).not.toContain(answer);
    assertNoPrivateKey(entry, answer, path ? `${path}.${key}` : key);
  }
}
function assertPrivatePromptOnly(result: unknown, init: unknown, answer: string) {
  // Parse the original values, not a stripped/projected copy: unknown API fields
  // must still fail even if their value does not contain the answer's digits.
  courseRouteActionResultSchema.parse(result);
  activitySpecClientInitSchema.parse(init);
  assertNoPrivateKey({ result, init }, answer);
}
// Synthetic PG fixture. Only successful eligibility tests replace the exposure
// reader; no production coverage marker, provider, paid API or model is created.
async function setup(candidate = { text: '137*19', answer: '2603' }, phase = (_name: string) => {}) {
  phase('setup.source-and-course');
  const rows = backupRows(f.sql, f.scope), sourceId = await rows.source("uploaded", 1), chunkId = randomUUID(), courseId = randomUUID();
  await f.sql`UPDATE opening_sources SET mime='text/plain' WHERE id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text) VALUES(${chunkId},${sourceId},1,1,'Rational arithmetic.')`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Arithmetic',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  phase('setup.goal');
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [courseId], title: 'Arithmetic', kind: 'custom',
    targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1, learningMode: 'understand', successCriteria: 'Independent arithmetic' });
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true, exactVerificationEnabled: true });
  phase('setup.route.confirm');
  const snapshot = await route.confirm(f.scope, courseId, { expectedRevisions: [], confirmScope: true, requirements: [{ id: randomUUID(), stableSkillId: randomUUID(),
    knowledgeNodeId: null, requirementKey: 'arithmetic', title: 'Arithmetic', position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [],
    sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], verification: { kind: 'exact', status: 'missing', exerciseKeys: [], rubric: null, missingReasons: [] }, origin: 'confirmed' }] });
  const requirement = snapshot.requirements[0]!.requirement;
  const base: CourseRouteStart = { goalId: goal.id, expectedGoalRevision: 1, requirementId: requirement.id, expectedRequirementRevision: 1, minutes: 20, clientKey: randomUUID() };
  phase('setup.route.start-origin');
  const origin = ready(await route.start(f.scope, courseId, base)).activity;
  phase('setup.publish-baseline');
  await publishBaseline(origin, sourceId);
  phase('setup.session-and-attempt');
  const session = await createOpeningLearningRepository(f.sql).createSession(f.scope, { activityId: origin.id, courseId, sourceIds: [sourceId], skillLabel: 'Arithmetic' });
  const spec = (await createOpeningTeachingContentRepository(f.sql).getActivitySpec(f.scope, origin.id))!;
  const attempts = createOpeningLearningAttemptRepository(f.sql);
  const attempt = await attempts.create(f.scope, { sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId: spec.blockOrder[0]!.blockId, contentVersion: 1 } });
  phase('setup.attempt.submit-baseline');
  const observation = await createOpeningAttemptService(f.sql).submit(f.scope, attempt.id, { clientKey: randomUUID(), answer: '7', outcome: 'unverified', assistance: 'independent', verdictSource: 'self_report' });
  phase('setup.age-baseline-and-preferences');
  await f.sql`UPDATE opening_learning_attempts SET started_at=started_at-interval '4 days',submitted_at=submitted_at-interval '4 days' WHERE id=${attempt.id}`;
  await f.sql`UPDATE opening_learning_observations SET started_at=started_at-interval '4 days',submitted_at=submitted_at-interval '4 days',recorded_at=recorded_at-interval '4 days',occurred_at=occurred_at-interval '4 days' WHERE id=${observation.id}`;
  await createWorkspacePreferencesRepository(f.sql).setLearningPreferences(f.scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const retests = createOpeningCourseRouteRetestRepository(f.sql, { exactVerificationEnabled: true });
  phase('setup.retests.schedule');
  const receipt = await retests.schedule(f.scope, courseId, { goalId: goal.id, expectedGoalRevision: 1, activityId: origin.id, expectedPathVersion: 1, observationId: observation.id, clientKey: randomUUID(), minutes: 20 });
  phase('setup.retests.read-task');
  const task = await retests.readTask(f.scope, courseId, receipt.taskId);
  if (!task.managed) throw new Error('missing managed task');
  const input = { ...base, taskId: task.taskId, expectedTaskVersion: task.expectedTaskVersion, clientKey: randomUUID() };
  phase('setup.read-purpose-pin');
  const purposes = createOpeningCourseReadySourcesRepository(f.sql), pin = await purposes.readSourcePurposePin(f.scope, { activityId: origin.id, materialUse: 'teaching' });
  phase('setup.save-reserved-candidates');
  await saveOpeningReservedCandidates(f.sql, f.scope, origin.id, [{ ...candidate, interaction: { kind: 'numeric' } }],
    { assertPinnedContext: tx => purposes.assertSourcePurposePin(f.scope, pin, tx) });
  const service = createCourseRouteService(f.sql, { OPENING_TEACHING_COMPILER_ENABLED: '1' });
  phase('setup.read-capacity');
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
it.each([['2603', 'correct'], ['2604', 'incorrect'], ['not a number', 'unverified']] as const)('real caller grades %s as %s after durable prompt-only issuance', async (submitted, expected) => {
  const x = await setup();
  const result = ready(await x.service.start(f.scope, x.courseId, x.input));
  expect(result.activity.contentVersion).toBe(1);
  expect(await f.sql`SELECT state FROM opening_course_reserved_questions WHERE course_id=${x.courseId}`).toEqual([{ state: 'issued' }]);
  const init = await createOpeningTeachingContentRepository(f.sql).getClientInit(f.scope, result.activity.id);
  expect(init?.blocks[0]?.content).toMatchObject({ text: '137*19' });
  assertPrivatePromptOnly(result, init, '2603');
  const [attempt] = await f.sql`SELECT a.id,a.requirement_key,v.evaluation_spec FROM opening_learning_attempts a
    JOIN opening_learning_item_versions v ON v.id=a.item_version_id WHERE a.activity_id=${result.activity.id}`;
  expect(attempt).toMatchObject({ requirement_key: 'arithmetic', evaluation_spec: { courseRequirement: {
    id: x.requirement.id, revision: 1, stableSkillId: x.requirement.stableSkillId, requirementKey: 'arithmetic' } } });
  const canonical = await createOpeningLearningAttemptRepository(f.sql).get(f.scope, String(attempt!.id));
  expect(canonical?.reservedRetestQualification).toMatchObject({ eligible: false,
    reasons: expect.arrayContaining([{ code: 'independent_blind_solve_missing', message: expect.any(String) },
      { code: 'stable_identity_missing', message: expect.any(String) }]) });
  assertNoPrivateKey(canonical?.reservedRetestQualification, '2603');
  expect(await f.sql`SELECT id FROM opening_learning_observations WHERE course_id=${x.courseId}`).toHaveLength(1); // issuance alone is no mastery evidence
  const answer = await createOpeningAttemptService(f.sql).submit(f.scope, String(attempt!.id), {
    clientKey: randomUUID(), answer: submitted, outcome: 'unverified', assistance: 'independent', verdictSource: 'self_report' });
  expect(answer.retestId).toBeTruthy();
  expect(answer.outcome).toBe(expected);
  if (expected !== 'unverified') {
    expect(answer).toMatchObject({ verdictSource: 'deterministic', assistance: 'hinted', eligibility: { independentAttempt: 'no' } });
    expect(answer.serverEvaluation).toMatchObject({ decision: expected, evaluatorVersion: 'teaching-key-exact-v1' });
    assertNoPrivateKey(answer.serverEvaluation, '2603');
  }
  const feedback = await createOpeningTeachingContentRepository(f.sql).getClientInit(f.scope, result.activity.id);
  assertPrivatePromptOnly(result, feedback, '2603');
});
it('real inline preparation and submission resume the sole issued attempt with an explained unavailable qualification', async () => {
  const x = await setup(), issued = ready(await x.service.start(f.scope, x.courseId, x.input));
  const content = (await createOpeningTeachingContentRepository(f.sql).getClientInit(f.scope, issued.activity.id))!;
  const service = createOpeningAttemptService(f.sql);
  const client = {
    createSession: (input: Parameters<ReturnType<typeof createOpeningLearningRepository>['createSession']>[1]) =>
      createOpeningLearningRepository(f.sql).createSession(f.scope, input),
    createAttempt: (input: unknown) => service.create(f.scope, input),
    submitAttempt: (id: string, input: unknown) => service.submit(f.scope, id, input),
  };
  const input = { activityId: issued.activity.id, courseId: x.courseId, blockId: content.blockOrder[0]!.blockId,
    contentVersion: 1, sourceIds: [x.sourceId], prompt: '137*19', skillLabel: 'Arithmetic' };
  let checkpoint: import('../../apps/web/src/features/opening/teaching/inline-attempt-prepare').InlineAttemptPreparationCheckpoint | undefined;
  const prepared = await createInlineAttemptPreparation(input, client, { onCheckpoint: value => { checkpoint = value; } }).prepare();
  expect(prepared.reservedRetestQualification).toMatchObject({ eligible: false });
  const submitted = await createInlineAttemptSubmission({ ...input, answer: '2603' }, client, { preparation: checkpoint }).submit();
  expect(submitted.attemptId).toBe(prepared.id);
  expect(submitted.observation).toMatchObject({ outcome: 'correct', assistance: 'hinted', eligibility: { independentAttempt: 'no' } });
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${issued.activity.id}`).toHaveLength(1);
});
it.each(['hinted', 'revealed'] as const)('never upgrades a reserved submission after %s assistance', async assistance => {
  const x = await setup(), issued = ready(await x.service.start(f.scope, x.courseId, x.input));
  const [attempt] = await f.sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${issued.activity.id}`;
  const observation = await createOpeningAttemptService(f.sql).submit(f.scope, String(attempt!.id), {
    clientKey: randomUUID(), answer: '2603', outcome: 'correct', assistance, verdictSource: 'self_report',
  });
  expect(observation.eligibility?.independentAttempt).toBe('no');
  // Existing reserved verdicts carry the conservative hinted marker even for
  // declared reveal; neither marker may become independent evidence.
  expect(observation.assistance).not.toBe('independent');
  const restored = await createOpeningLearningAttemptRepository(f.sql).get(f.scope, String(attempt!.id));
  expect(restored?.reservedRetestQualification?.eligible).toBe(false);
});
it('accepts UUID metadata containing answer digits but detects private fields and visible-body leaks', async () => {
  const x = await setup(), result = ready(await x.service.start(f.scope, x.courseId, x.input));
  const init = await createOpeningTeachingContentRepository(f.sql).getClientInit(f.scope, result.activity.id);
  if (!init) throw new Error('missing client init');
  const publicInit = structuredClone(init);
  publicInit.sourceRefs[0]!.chunkId = '7f02603b-68d7-4281-888f-3b8b7b7c9ccd';
  expect(() => assertPrivatePromptOnly(result, publicInit, '2603')).not.toThrow();
  for (const content of [
    { text: '137*19', answer: '2603' }, { text: '137*19', key: { answer: '2603' } },
    { text: '137*19', key_json: { answer: '2603' } }, { text: '137*19', keyRefId: randomUUID() },
    { text: '137*19', answer: publicInit.sourceRefs[0]!.chunkId }, { text: '137*19', body: 2603 },
    { text: '137*19 = 2603' }, { text: '137*19', body: '2603' },
    { text: '137*19', feedback: 'The answer is 2603.' }, { text: '137*19', hints: ['2603'] },
    { text: publicInit.sourceRefs[0]!.chunkId }, // UUID shape is not a body exemption.
  ]) {
    const leaked = structuredClone(publicInit);
    leaked.blocks[0]!.content = content;
    expect(() => assertPrivatePromptOnly(result, leaked, '2603')).toThrow();
  }
  expect(() => assertPrivatePromptOnly({ ...result, answer: 'redacted' }, publicInit, '2603')).toThrow();
  expect(() => assertPrivatePromptOnly(result, { ...publicInit, key: 'redacted' }, '2603')).toThrow();
});
it.each([
  ['1+2*3+3', '10', 'correct'], ['1+2*3+3', '127', 'incorrect'],
  ['$1*2*3+4$', '10', 'correct'], ['$1*2*3+4$', '127', 'incorrect'],
  ['$$1*2*3+4$$', '10', 'correct'], ['$$1*2*3+4$$', '127', 'incorrect'],
  ['1*2*3+4', '10', 'unverified'], ['1*2*3+4', '127', 'unverified'],
  ['- 3 + 4', '1', 'unverified'], ['(1+\n1)-1', '1', 'unverified'],
] as const)('real caller respects immutable published Markdown %j for %s → %s', async (text, submitted, expected) => {
  const key = text.includes('1*2*3') || text === '1+2*3+3' ? '10' : '1';
  const x = await setup({ text, answer: key });
  const issued = ready(await x.service.start(f.scope, x.courseId, x.input));
  const content = createOpeningTeachingContentRepository(f.sql);
  const init = await content.getClientInit(f.scope, issued.activity.id);
  expect(init?.blocks[0]?.content).toMatchObject({ text });
  expect(init?.blocks).toHaveLength(1);
  const [attempt] = await f.sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${issued.activity.id}`;
  const result = await createOpeningAttemptService(f.sql).submit(f.scope, String(attempt!.id), {
    clientKey: randomUUID(), answer: submitted, outcome: 'unverified', assistance: 'independent', verdictSource: 'self_report' });
  expect(result.outcome).toBe(expected);
  if (expected === 'unverified') {
    expect(result.verdictSource).not.toBe('deterministic');
    expect(result.serverEvaluation).toBeUndefined();
  } else {
    expect(result).toMatchObject({ verdictSource: 'deterministic', assistance: 'hinted', eligibility: { independentAttempt: 'no' } });
    expect(result.serverEvaluation).toMatchObject({ evaluatorVersion: 'teaching-key-exact-v1', specVersion: 'teaching-key-v1',
      decision: expected, outcome: expected, reasonCodes: [expected === 'correct' ? 'teaching_key_match' : 'teaching_key_mismatch'] });
    expect(result.serverEvaluation).not.toHaveProperty('answer');
    expect(result.serverEvaluation).not.toHaveProperty('keyRef');
  }
  const feedback = await content.getClientInit(f.scope, issued.activity.id);
  expect(feedback?.blocks[0]?.content).toMatchObject({ text });
  expect(feedback?.blocks).toHaveLength(1);
});
it.each(['requirement', 'source', 'purpose_cas', 'purpose', 'task_version', 'protocol'] as const)('rejects reserved submission after %s changes without recording an answer', async changed => {
  const check = async (phase = (_name: string) => {}) => {
    const x = await setup(undefined, phase);
    phase('start.reserved-issuance');
    const issued = ready(await x.service.start(f.scope, x.courseId, x.input));
    phase('read-issued-attempt');
    const [attempt] = await f.sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${issued.activity.id}`;
    phase(`change.${changed}`);
    if (changed === 'requirement') await f.sql`UPDATE course_requirements SET revision=revision+1 WHERE id=${x.requirement.id}`;
    if (changed === 'source') await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${x.sourceId}`;
    if (changed === 'purpose_cas') await f.sql`UPDATE course_asset_memberships SET updated_at=updated_at+interval '1 microsecond' WHERE course_id=${x.courseId}`;
    if (changed === 'purpose') await f.sql`UPDATE course_asset_memberships SET purpose='reference' WHERE course_id=${x.courseId}`;
    if (changed === 'task_version') await f.sql`UPDATE opening_tasks SET version=version+1 WHERE id=${x.input.taskId}`;
    if (changed === 'protocol') await f.sql`UPDATE opening_retest_activities SET learning_protocol=jsonb_set(learning_protocol,'{stableSkillId}',to_jsonb(${randomUUID()}::text)) WHERE task_id=${x.input.taskId}`;
    phase('submit.expected-rejection');
    await expect(createOpeningAttemptService(f.sql).submit(f.scope, String(attempt!.id), {
      clientKey: randomUUID(), answer: '2603', outcome: 'unverified', assistance: 'independent', verdictSource: 'self_report',
    })).rejects.toMatchObject({ code: changed === 'source' ? 'VALIDATION' : 'CONFLICT' });
    phase('assert.no-answer-recorded');
    expect(await f.sql`SELECT id FROM opening_learning_observations WHERE activity_id=${issued.activity.id}`).toHaveLength(0);
  };
  if (changed === 'purpose') await withRouteLockDiagnostics('purpose', check);
  else await check();
});
type RouteLockDiagnostics = { context: string; phase: string; observer: Sql };
// One preconnected read-only observer per diagnosed case. No polling, sleeps,
// business-table writes or held test locks; all samples are non-atomic evidence.
async function withRouteLockDiagnostics(context: string, run: (phase: (name: string) => void) => Promise<void>) {
  const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? '', process.env.OPENING_TEST_DB);
  const observer = postgres(url.toString(), { max: 1, connect_timeout: 2,
    connection: { default_transaction_read_only: true, statement_timeout: 2000 } });
  const diagnostic = { context, phase: 'observer.connect', observer };
  const lifecycle = (event: string) => console.error(`[route-${context}-lifecycle]`, JSON.stringify({ event, at: new Date().toISOString() }));
  const originalSql = f.sql, originalClose = f.close;
  f.close = async () => {
    lifecycle('fixture.close.begin');
    try { await originalClose(); } finally { lifecycle('fixture.close.end'); }
  };
  try {
    try { await observer`SELECT pg_backend_pid()`; }
    catch (error) { console.error(`[route-${context}-observer-connect-failed]`, JSON.stringify({ code: (error as { code?: string })?.code ?? 'unknown' })); }
    f.sql = routeLockDiagnosedSql(originalSql, diagnostic);
    await run(name => { diagnostic.phase = name; lifecycle(name); });
  } finally {
    lifecycle(`case.end:${diagnostic.phase}`);
    f.sql = originalSql;
    try { await observer.end({ timeout: 2 }); }
    catch (error) { console.error(`[route-${context}-observer-close-failed]`, JSON.stringify({ code: (error as { code?: string })?.code ?? 'unknown' })); }
    lifecycle('observer.close.end');
  }
}
async function sampleRouteLocks(diagnostic: RouteLockDiagnostics, requester: { pid: number }, relations: string[]) {
  const { observer } = diagnostic, started = Date.now();
  try {
    const [sample] = await observer`SELECT clock_timestamp()::text AS sampled_at, pg_backend_pid() AS observer_pid,
      pg_blocking_pids(${requester.pid}) AS blocking_pids,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'pid',l.pid,'relation',n.nspname || '.' || c.relname,'relation_owner',pg_get_userbyid(c.relowner),
        'mode',l.mode,'granted',l.granted,
        'candidate',l.pid IS DISTINCT FROM ${requester.pid} AND l.granted AND l.mode NOT IN ('AccessShareLock','RowShareLock'),
        'backend_type',a.backend_type,'state',a.state,'xact_start',a.xact_start::text,
        'query_start',a.query_start::text,'wait_event_type',a.wait_event_type,'wait_event',a.wait_event,
        'query',substring(a.query FROM '^[[:space:]]*([[:alpha:]]+)') || ' [redacted]') ORDER BY c.relname,l.pid,l.mode)
        FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='relation' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND n.nspname=current_schema() AND c.relname IN ${observer(relations)}), '[]'::jsonb) AS locks,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'pid',a.pid,'backend_type',a.backend_type,'state',a.state,'xact_start',a.xact_start::text,
        'query_start',a.query_start::text,'state_change',a.state_change::text,
        'wait_event_type',a.wait_event_type,'wait_event',a.wait_event,
        'query',substring(a.query FROM '^[[:space:]]*([[:alpha:]]+)') || ' [redacted]') ORDER BY a.pid)
        FROM pg_stat_activity a WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()
          AND (a.state IS DISTINCT FROM 'idle' OR a.pid=${requester.pid})), '[]'::jsonb) AS activity`;
    return { ...sample, elapsed_ms: Date.now() - started };
  } catch (error) {
    return { diagnostic_error: (error as { code?: string })?.code ?? 'unknown', elapsed_ms: Date.now() - started };
  }
}
// Preserve lazy query execution and then/catch/finally behavior. Take the pre
// sample only when the original lock query is consumed, never at construction.
function routeLockDiagnosedSql(db: Sql | TransactionSql, diagnostic: RouteLockDiagnostics, requester?: { pid: number; began_at: string }): Sql {
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key === 'begin') return (...args: unknown[]) => Reflect.apply((target as Sql).begin, target, [
        ...args.slice(0, -1), async (tx: TransactionSql) => {
          const [backend] = await tx<{ pid: number; began_at: string }[]>`SELECT pg_backend_pid() AS pid, clock_timestamp()::text AS began_at`;
          const result = (args.at(-1) as (tx: TransactionSql) => unknown)(routeLockDiagnosedSql(tx, diagnostic, backend!) as unknown as TransactionSql);
          return Array.isArray(result) ? Promise.all(result) : result;
        },
      ]);
      return Reflect.get(target, key, receiver);
    },
    apply(target, receiver, args) {
      const query = Reflect.apply(target, receiver, args);
      const text = Array.isArray(args[0]) && 'raw' in args[0] ? args[0].join('?').replace(/\s+/g, ' ').trim() : '';
      const lock = /^LOCK TABLE (.+) IN SHARE ROW EXCLUSIVE MODE NOWAIT$/i.exec(text);
      if (!lock || !requester) return query;
      let observed: Promise<unknown> | undefined;
      const observe = () => observed ??= (async () => {
        const phase = diagnostic.phase, relations = lock[1]!.split(',').map(name => name.trim());
        const before = await sampleRouteLocks(diagnostic, requester, relations);
        console.error(`[route-${diagnostic.context}-lock-before]`, JSON.stringify({ phase, requester,
          requested_query: text, requested_mode: 'ShareRowExclusiveLock', before }));
        const requestedAt = new Date().toISOString();
        try {
          return await query;
        } catch (error) {
          const pgError = error as { code?: string; message?: string };
          if (pgError.code === '55P03') {
            const failedAt = new Date().toISOString();
            const after = await sampleRouteLocks(diagnostic, requester, relations);
            console.error(`[route-${diagnostic.context}-lock-diagnostic]`, JSON.stringify({ phase, requester,
              requested_at: requestedAt, failed_at: failedAt,
              error: { code: pgError.code, failed_relation: /could not obtain lock on relation "([a-z_]+)"/.exec(pgError.message ?? '')?.[1] ?? null },
              requested_query: text, requested_mode: 'ShareRowExclusiveLock', before, after,
              visibility: 'Same test database/current schema only; observer privileges apply. Before/after samples are non-atomic, not failure-time proof. NOWAIT need not leave a wait row. Queries retain command only.',
              holder_assessment: 'Incompatible granted candidates at sample time only; failure-time natural holder UNKNOWN.',
            }));
          }
          throw error; // Preserve the exact original error; never retry or replace it.
        }
      })();
      return new Proxy(query, {
        get(original, key, receiver) {
          if (key === 'then') return (...args: Parameters<Promise<unknown>['then']>) => observe().then(...args);
          if (key === 'catch') return (...args: Parameters<Promise<unknown>['catch']>) => observe().catch(...args);
          if (key === 'finally') return (...args: Parameters<Promise<unknown>['finally']>) => observe().finally(...args);
          return Reflect.get(original, key, receiver);
        },
      });
    },
  }) as Sql;
}
it('samples around a controlled NOWAIT conflict without treating candidates as historical holders', async () => {
  const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? '', process.env.OPENING_TEST_DB);
  const holder = postgres(url.toString(), { max: 1 });
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Diagnostic-mechanism check only, never evidence for a natural CI holder.
  // Keep this existing synthetic holder alive through both samples; no sleep/retry.
  try {
    await holder.begin(async tx => {
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      await tx`LOCK TABLE opening_learning_observations IN ROW EXCLUSIVE MODE`;
      let queryError: unknown;
      try {
        await withRouteLockDiagnostics('controlled', async phase => {
          phase('controlled.lock');
          await f.sql.begin(async requester => {
            const query = requester`LOCK TABLE opening_learning_observations IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
            // The transaction must propagate the diagnosed query's rejection unchanged.
            await query.finally(() => {}).catch(error => { queryError = error; throw error; });
          });
        });
        throw new Error('expected the controlled NOWAIT conflict');
      } catch (error) {
        expect(error).toBe(queryError);
        expect(error).toBeInstanceOf(postgres.PostgresError);
        expect(error).toMatchObject({ code: '55P03' });
      }
      const diagnostics = output.mock.calls.filter(([label]) => label === '[route-controlled-lock-diagnostic]');
      expect(diagnostics).toHaveLength(1);
      const [label, raw] = diagnostics[0]!;
      expect(label).toBe('[route-controlled-lock-diagnostic]');
      const sample = JSON.parse(String(raw));
      expect(sample.error).toEqual({ code: '55P03', failed_relation: 'opening_learning_observations' });
      expect(sample.requested_mode).toBe('ShareRowExclusiveLock');
      expect(sample.phase).toBe('controlled.lock');
      for (const snapshot of [sample.before, sample.after]) {
        expect(snapshot.observer_pid).not.toBe(sample.requester.pid);
        expect(snapshot.observer_pid).not.toBe(backend!.pid);
        expect(snapshot.locks).toEqual(expect.arrayContaining([expect.objectContaining({
          pid: backend!.pid, relation: 'public.opening_learning_observations', relation_owner: expect.any(String),
          mode: 'RowExclusiveLock', granted: true, candidate: true, query: 'LOCK [redacted]',
        })]));
        expect(snapshot.activity).toEqual(expect.arrayContaining([expect.objectContaining({
          pid: backend!.pid, state: 'idle in transaction', query: 'LOCK [redacted]',
        })]));
        expect(snapshot.blocking_pids).toEqual(expect.any(Array));
        expect(snapshot.diagnostic_error).toBeUndefined();
      }
      expect(sample.before.observer_pid).toBe(sample.after.observer_pid);
      expect(sample.holder_assessment).toContain('failure-time natural holder UNKNOWN');
    });
  } finally {
    await holder.end({ timeout: 2 });
    output.mockRestore();
  }
});
it.each(['unsupported', 'interaction', 'spec', 'other_key', 'bad_key', 'stale_issued', 'shadow_body'] as const)('withholds deterministic authority for %s private content', async changed => {
  const check = async (phase = (_name: string) => {}) => {
    const x = await setup(undefined, phase);
    phase('start.reserved-issuance');
    const issued = ready(await x.service.start(f.scope, x.courseId, x.input));
    phase('private-content.mutation-and-submit');
    const [attempt] = await f.sql`SELECT a.*,v.teaching_revision_id FROM opening_learning_attempts a JOIN opening_learning_item_versions v ON v.id=a.item_version_id WHERE a.activity_id=${issued.activity.id}`;
    const submit = () => createOpeningAttemptService(f.sql).submit(f.scope, String(attempt!.id), {
      clientKey: randomUUID(), answer: '2603', outcome: 'unverified', assistance: 'independent', verdictSource: 'self_report',
    });
    if (changed === 'spec') await f.sql`UPDATE opening_learning_item_versions SET evaluation_spec=jsonb_set(evaluation_spec,'{activityId}',to_jsonb(${randomUUID()}::text)) WHERE id=${attempt!.item_version_id}`;
    if (changed === 'stale_issued') {
      await expect(f.sql`UPDATE opening_course_reserved_questions SET issued_item_version_id=NULL WHERE course_id=${x.courseId}`).rejects.toMatchObject({ code: '23514' });
      return;
    }
    if (changed === 'bad_key') {
      await expect(f.sql`UPDATE opening_course_reserved_questions SET key_json=jsonb_set(key_json,'{answer}','"2604"') WHERE course_id=${x.courseId}`).rejects.toThrow('reserved question content is immutable');
      return;
    }
    if (changed === 'other_key') await f.sql`UPDATE opening_learning_item_versions SET evaluation_spec=evaluation_spec||'{"id":"caller-chosen-key","itemVersionId":"caller-chosen-item"}'::jsonb WHERE id=${attempt!.item_version_id}`;
    if (changed === 'unsupported') {
      await expect(f.sql`UPDATE library_revisions SET blocks=jsonb_set(blocks,'{0,content,text}','"137^19"') WHERE id=${attempt!.teaching_revision_id}`).rejects.toThrow('library_revisions is append-only');
      return;
    }
    if (changed === 'interaction' || changed === 'shadow_body') {
      const path = changed === 'interaction' ? '{0,content,interaction}' : '{0,content,figure}';
      await expect(f.sql`UPDATE library_revisions SET blocks=jsonb_set(blocks,${path}::text[],'"untrusted"') WHERE id=${attempt!.teaching_revision_id}`).rejects.toThrow('library_revisions is append-only');
      return;
    }
    const result = await submit();
    expect(result.outcome).toBe('unverified');
    expect(result.verdictSource).not.toBe('deterministic');
  };
  if (changed === 'other_key') await withRouteLockDiagnostics('other-key', check);
  else await check();
});
it('replays one verdict without jobs or budget changes and never upgrades a later submission to independent', async () => {
  const x = await setup(), issued = ready(await x.service.start(f.scope, x.courseId, x.input));
  const [attempt] = await f.sql`SELECT * FROM opening_learning_attempts WHERE activity_id=${issued.activity.id}`;
  const service = createOpeningAttemptService(f.sql), input = { clientKey: randomUUID(), answer: '2603', outcome: 'unverified', assistance: 'independent', verdictSource: 'self_report' };
  const capacity = await readOpeningLearningCapacity(f.sql, f.scope);
  const jobs = await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`;
  const reservations = await f.sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`;
  const first = await service.submit(f.scope, String(attempt!.id), input);
  expect((await service.submit(f.scope, String(attempt!.id), input)).id).toBe(first.id);
  await expect(service.submit(f.otherScope, String(attempt!.id), input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(first).toMatchObject({ outcome: 'correct', assistance: 'hinted', eligibility: { independentAttempt: 'no' } });
  // A completed retest still refuses NEW preparation; only the acknowledged
  // submit key replays. The live inline caller resumes before submission above.
  await expect(service.create(f.scope, { sessionId: attempt!.session_id, clientKey: randomUUID(),
    teachingBlock: attempt!.create_intent.teachingBlock })).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(service.submit(f.scope, String(attempt!.id), { ...input, clientKey: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await f.sql`SELECT id FROM opening_learning_observations WHERE activity_id=${issued.activity.id}`).toHaveLength(1);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`).toEqual(jobs);
  expect(await f.sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`).toEqual(reservations);
  expect((await readOpeningLearningCapacity(f.sql, f.scope)).usedMinutes).toBe(capacity.usedMinutes);
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
  assertPrivatePromptOnly(a, init, '2603');
  assertPrivatePromptOnly(b, init, '2603');
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
it.each(['receipt', 'existing'] as const)('rejects a pre-private delayed activity without an original pin at the %s recovery entrance', async entrance => {
  const x = await setup();
  const [retest] = await f.sql`SELECT id FROM opening_retest_activities WHERE task_id=${x.input.taskId}`;
  const [origin] = await f.sql`SELECT goal_json FROM opening_teaching_activities WHERE id=${x.origin.id}`;
  // Historical shape: a task-linked compiled activity, never a private reservation,
  // receipt or issued item. Do not manufacture this by stripping a new issued row.
  const legacy = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, {
    clientKey: entrance === 'receipt' ? `course-route-task:${x.input.taskId}` : randomUUID(),
    intentKind: 'goal', intentSummary: 'Legacy delayed arithmetic', courseId: x.courseId, sourceIds: [x.sourceId],
    createIntent: { kind: 'course_route', source: 'task', taskId: x.input.taskId, goalId: x.input.goalId, requirementId: x.requirement.id },
    goalJson: { courseRoute: { ...origin!.goal_json.courseRoute, action: 'transfer_check', retestId: retest!.id },
      learningBudget: origin!.goal_json.learningBudget },
  });
  await publishBaseline(legacy, x.sourceId);
  const facts = async () => ({
    activities: await f.sql`SELECT id,goal_json FROM opening_teaching_activities WHERE course_id=${x.courseId} ORDER BY id`,
    privateRows: await f.sql`SELECT * FROM opening_course_reserved_questions WHERE course_id=${x.courseId}`,
    bodies: await f.sql`SELECT id,blocks FROM library_revisions WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    attempts: await f.sql`SELECT id FROM opening_learning_attempts WHERE course_id=${x.courseId} ORDER BY id`,
    exposures: await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    jobs: await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    capacity: await readOpeningLearningCapacity(f.sql, f.scope),
  });
  const before = await facts();
  await expect(x.service.start(f.scope, x.courseId, x.input)).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(x.service.start(f.scope, x.courseId, { ...x.input, expectedTaskVersion: x.input.expectedTaskVersion + 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
  await f.sql`UPDATE course_asset_memberships SET updated_at=updated_at+interval '1 microsecond' WHERE course_id=${x.courseId}`;
  await expect(x.service.start(f.scope, x.courseId, x.input)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await facts()).toEqual(before);
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
