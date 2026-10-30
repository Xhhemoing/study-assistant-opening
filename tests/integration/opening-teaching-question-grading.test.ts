import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AiGradingProposal, LearningAttempt, TeachingQuestionInteraction, TeachingMisconception } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, createOpeningLearningRepository, createOpeningTeachingActivitiesRepository,
  createOpeningTeachingContentRepository, createOpeningTeachingHintRepository, createOpeningTeachingCommandsRepository } from "@aistudy/database";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
const answer = "两列线性无关，所以秩为 2。";
const proposal: AiGradingProposal = { outcome: "correct", confidence: 0.93, questionMatch: true, feedback: answer,
  criteria: [{ label: "矩阵秩", verdict: "correct", feedback: "秩为2。" }] };

async function seed(withSource = false, prompt = "求二阶单位矩阵的秩。", interaction?: TeachingQuestionInteraction, misconceptions?: TeachingMisconception[], referenceAnswer = answer) {
  const base = await learningAttemptFixture(fixture), sourceIds = withSource ? [base.sourceId] : [];
  const activity = await createOpeningTeachingActivitiesRepository(fixture.sql).create(fixture.scope, {
    clientKey: randomUUID(), intentKind: "topic", intentSummary: "矩阵秩", courseId: base.courseId, sourceIds, createIntent: {},
  });
  const content = createOpeningTeachingContentRepository(fixture.sql), blockId = randomUUID(), answerId = randomUUID();
  const unit = await content.createUnit(fixture.scope, { title: "矩阵秩", blocks: [
    { id: blockId, type: "prompt", content: { text: prompt, ...(interaction ? { interaction } : {}) } },
    { id: answerId, type: "answer_key", content: { answer: referenceAnswer, rubric: ["列向量线性无关", "秩等于2"], hidden: true,
      ...(misconceptions ? { misconceptions } : {}),
      hints: { direction: "先考察列向量。", concept: "秩是线性无关列的最大数量。", firstStep: "写出第一列 (1,0)。" } } },
  ] });
  await content.publishActivitySpec(fixture.scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0,
    expectedRevisionNumber: 1, revisionNumber: 1,
    blockOrder: [{ blockId, position: 0, role: "prompt", blockType: "prompt" }, { blockId: answerId, position: 1, role: "answer_key", blockType: "answer_key" }],
    sourceRefs: withSource ? [{ sourceId: base.sourceId, chunkId: base.chunkId, version: 1 }] : [],
  });
  const learning = createOpeningLearningRepository(fixture.sql), service = createOpeningAttemptService(fixture.sql);
  const session = await learning.createSession(fixture.scope, { courseId: base.courseId, activityId: activity.id, skillLabel: "矩阵秩", sourceIds });
  const request = { sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId, contentVersion: 1 } };
  const start = () => service.create(fixture.scope, { ...request, clientKey: randomUUID() });
  const submit = (attempt: LearningAttempt) => service.submit(fixture.scope, attempt.id, {
    clientKey: randomUUID(), answer: "2", outcome: "unverified", assistance: "independent", verdictSource: "self_report",
  });
  const grader = createOpeningAiGradingRepository(fixture.sql);
  return { ...base, learning, activity, content, unit, blockId, answerId, sourceIds, session, request, start, submit, service, grader };
}

it("rejects a saved arithmetic item with a wrong reference before recording an attempt", async () => {
  const f = await seed(false, "计算 1/2+1/2", undefined, undefined, "2");
  await expect(f.start()).rejects.toMatchObject({ code: "VALIDATION" });
  expect(await fixture.sql`SELECT id FROM opening_learning_attempts WHERE session_id=${f.session.id}`).toHaveLength(0);
});

it.each([false, true])("rejects a missing exact sealed visual chunk without substituting another page/chunk (same-page replacement=%s)", async replaceOnSamePage => {
  const f = await seed(true);
  await fixture.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${f.sourceId}`;
  await fixture.sql`UPDATE opening_source_chunks SET page=5,image_object_key=${`opening/sources/${f.sourceId}/v1`} WHERE id=${f.chunkId}`;
  await fixture.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text,image_object_key)
    VALUES(${f.sourceId},1,1,'另一页原生正文，保证同版本材料仍然ready。',NULL)`;
  const attempt = await f.start(), original = await f.submit(attempt);
  expect((await f.grader.context(fixture.scope, { observationId: original.id })).referenceSources).toContainEqual({ sourceId: f.sourceId, sourceVersion: 1, physicalPage: 5 });
  const [identity] = await fixture.sql`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${attempt.itemVersionId!}`;
  expect(identity!.evaluation_spec.sourceRefs).toContainEqual({ sourceId: f.sourceId, chunkId: f.chunkId, version: 1 });
  await fixture.sql`DELETE FROM opening_source_chunks WHERE id=${f.chunkId}`;
  if (replaceOnSamePage) await fixture.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text,image_object_key)
    VALUES(${f.sourceId},1,5,'同页新块不能代替封存题目引用的准确旧块。',${`opening/sources/${f.sourceId}/v1`})`;
  expect((await fixture.sql`SELECT version,parse_state FROM opening_sources WHERE id=${f.sourceId}`)[0]).toMatchObject({ version: 1, parse_state: "ready" });
  await expect(f.grader.context(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await fixture.sql`SELECT answer FROM opening_learning_observations WHERE id=${original.id}`)[0]!.answer).toBe(original.answer);
});

it("rejects a sealed visual chunk when its physical page is no longer locatable", async () => {
  const f = await seed(true);
  await fixture.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${f.sourceId}`;
  await fixture.sql`UPDATE opening_source_chunks SET image_object_key=${`opening/sources/${f.sourceId}/v1`} WHERE id=${f.chunkId}`;
  const attempt = await f.start(), original = await f.submit(attempt);
  expect((await f.grader.context(fixture.scope, { observationId: original.id })).referenceSources).toContainEqual({ sourceId: f.sourceId, sourceVersion: 1, physicalPage: 1 });
  await fixture.sql`UPDATE opening_source_chunks SET page=NULL WHERE id=${f.chunkId}`;
  await expect(f.grader.context(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "CONFLICT" });
});

it.each([false, true])("grades a canonical classroom question and preserves corrections (materials=%s)", async withSource => {
  const f = await seed(withSource), attempt = await f.start(), original = await f.submit(attempt);
  expect(attempt.problemId).toBeTruthy();
  expect(attempt.itemVersionId).toBeTruthy();
  expect(attempt.sourceIds).toEqual(f.sourceIds);
  expect((await f.service.getContext(fixture.scope, attempt.id)).attempt.contextAnchor).toMatchObject({
    blockId: f.blockId, contentVersion: 1, sourceId: null, sourceVersion: null,
  });
  const [item] = await fixture.sql`SELECT * FROM opening_learning_item_versions WHERE id=${attempt.itemVersionId!}`;
  expect(item).toMatchObject({ source_id: null, source_version: null, teaching_block_id: f.blockId, teaching_revision_id: expect.any(String) });
  const context = await f.grader.context(fixture.scope, { observationId: original.id });
  expect(context.stem).toBe("求二阶单位矩阵的秩。");
  expect(context.referenceText).toContain(answer);
  expect(context.referenceText).toContain("评分要点");
  const graded = await f.grader.apply(fixture.scope, { observationId: original.id }, proposal, "fixture");
  expect(graded).toMatchObject({ verdictSource: "ai_graded", outcome: "correct", eligibility: {
    independentAttempt: "yes", verifiedCorrect: "unknown", usableForCurrentVersion: "yes",
  } });
  const corrected = await f.learning.reviseObservation(fixture.scope, { rootObservationId: original.id, revisesObservationId: graded.id,
    expectedHead: graded.id, clientKey: randomUUID(), revisionKind: "replace", reason: "判错了",
    replacement: { answer: "2", outcome: "incorrect", assistance: "independent" } });
  expect(corrected.observation).toMatchObject({ outcome: "incorrect", revisesObservationId: graded.id });
  const [saved] = await fixture.sql`SELECT answer,outcome FROM opening_learning_observations WHERE id=${original.id}`;
  expect(saved).toMatchObject({ answer: "2", outcome: "unverified" });
});

const rankErrors: TeachingMisconception[] = [
  { id: "count_entries", manifestation: "把矩阵元素个数当成秩。", reason: "秩数的是线性无关的列，不是元素。", correction: "检查两列是否线性无关。" },
  { id: "equal_entries", manifestation: "因为两个非零元素都等于1，就认为只有一个独立方向。", reason: "列向量分量的位置也影响方向。", correction: "分别写出两个列向量，再检查倍数关系。" },
];

it.each(["count_entries", "foreign_error", undefined])("binds misconception %s to the saved question dictionary", async misconceptionId => {
  const f = await seed(false, undefined, undefined, rankErrors), original = await f.submit(await f.start());
  expect((await f.grader.context(fixture.scope, { observationId: original.id })).misconceptions).toEqual(rankErrors);
  expect(JSON.stringify(await f.content.getClientInit(fixture.scope, f.activity.id))).not.toContain("count_entries");
  const graded = await f.grader.apply(fixture.scope, { observationId: original.id }, { ...proposal, outcome: "incorrect", misconceptionId,
    criteria: [{ label: "秩的定义", verdict: "incorrect", feedback: "秩不是元素个数。" }] }, "fixture");
  expect(graded.aiEvaluation?.misconceptionId).toBe(misconceptionId === "count_entries" ? "count_entries" : "other");
  expect((await f.grader.context(fixture.scope, { observationId: original.id })).existing?.aiEvaluation?.misconceptionId).toBe(graded.aiEvaluation?.misconceptionId);
});

it.each(["correct", "unverified", "low_confidence"])("does not attach a diagnosed misconception to %s feedback", async mode => {
  const f = await seed(false, undefined, undefined, rankErrors), original = await f.submit(await f.start());
  const outcome = mode === "low_confidence" ? "incorrect" : mode as "correct" | "unverified";
  const graded = await f.grader.apply(fixture.scope, { observationId: original.id }, { ...proposal, outcome,
    confidence: mode === "low_confidence" ? 0.1 : 0.93, misconceptionId: "count_entries",
    criteria: [{ label: "定义", verdict: outcome, feedback: "核对定义。" }] }, "fixture");
  expect(graded.aiEvaluation?.misconceptionId).toBeNull();
});

it("ignores client prompt text, retains the full saved question, and replays the exact identity", async () => {
  const prompt = `\n${"已保存的题目条件。🧮".repeat(300)}求二阶单位矩阵的秩。\n`, f = await seed(true, prompt);
  const request = { ...f.request, problem: { sourceId: f.sourceId, stemSnapshot: "伪造题干：1+1?", artifactKind: "reference_item" } };
  const attempt = await f.service.create(fixture.scope, request), original = await f.submit(attempt);
  expect((await f.grader.context(fixture.scope, { observationId: original.id })).stem).toBe(prompt);
  expect(JSON.stringify(await f.content.getClientInit(fixture.scope, f.activity.id))).not.toContain(answer);
  await fixture.sql`UPDATE opening_teaching_activities SET content_version=2,status='completed' WHERE id=${f.activity.id}`;
  expect((await f.service.create(fixture.scope, request)).id).toBe(attempt.id);
  await expect(f.start()).rejects.toMatchObject({ code: "CONFLICT" });
  // A previously submitted answer still belongs to the immutable original question.
  expect((await f.grader.context(fixture.scope, { observationId: original.id })).referenceText).toContain(answer);
  await expect(f.service.create(fixture.scope, { ...request, problem: { ...request.problem, stemSnapshot: "changed" } })).rejects.toMatchObject({ code: "CONFLICT" });
});

it("keeps the same identity and prior help when the learner reopens a question", async () => {
  const f = await seed(), first = await f.start();
  await createOpeningTeachingHintRepository(fixture.sql).read(fixture.scope, { attemptId: first.id, level: 1 });
  const second = await f.start();
  expect(second.problemId).toBe(first.problemId);
  expect(second.itemVersionId).toBe(first.itemVersionId);
  const original = await f.submit(second), graded = await f.grader.apply(fixture.scope, { observationId: original.id }, proposal, "fixture");
  expect(graded.eligibility).toMatchObject({ independentAttempt: "no", verifiedCorrect: "unknown", usableForCurrentVersion: "yes" });
});

it("preserves delivered hints from pre-upgrade classroom attempts without a problem identity", async () => {
  const f = await seed(), legacy = await f.start();
  await fixture.sql`UPDATE opening_learning_attempts SET problem_id=NULL,item_version_id=NULL,
    context_anchor=context_anchor || '{"itemVersionId":null}'::jsonb WHERE id=${legacy.id}`;
  await fixture.sql`DELETE FROM opening_learning_item_versions WHERE id=${legacy.itemVersionId!}`;
  await fixture.sql`DELETE FROM opening_problem_refs WHERE problem_id=${legacy.problemId!}`;
  await createOpeningTeachingHintRepository(fixture.sql).read(fixture.scope, { attemptId: legacy.id, level: 1 });
  const current = await f.start(), original = await f.submit(current);
  expect(current.problemId).not.toBe(legacy.problemId);
  const graded = await f.grader.apply(fixture.scope, { observationId: original.id }, proposal, "fixture");
  expect(graded.eligibility).toMatchObject({ independentAttempt: "no", verifiedCorrect: "unknown" });
});

it("rejects copied question IDs, mutable problem upserts, foreign owners and missing source provenance", async () => {
  const f = await seed(true), attempt = await f.start();
  await expect(f.service.create(fixture.scope, { sessionId: f.session.id, clientKey: randomUUID(), problemId: attempt.problemId })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(f.learning.upsertProblemRef(fixture.scope, { sessionId: f.session.id, problemId: attempt.problemId!, sourceId: f.sourceId,
    sourceVersion: 1, physicalPage: null, chunkId: null, stemSnapshot: "forged", artifactKind: "reference_item" })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(f.service.create(fixture.otherScope, f.request)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const empty = await f.learning.createSession(fixture.scope, { courseId: f.courseId, activityId: f.activity.id, skillLabel: "矩阵秩", sourceIds: [] });
  await expect(f.service.create(fixture.scope, { ...f.request, sessionId: empty.id })).rejects.toMatchObject({ code: "CONFLICT" });
  const original = await f.submit(attempt);
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  await expect(f.grader.context(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "CONFLICT" });
  await fixture.sql`UPDATE opening_sources SET version=1 WHERE id=${f.sourceId}`;
  await backupRows(fixture.sql, fixture.scope).exclude(f.sourceId);
  await expect(f.grader.apply(fixture.scope, { observationId: original.id }, proposal, "fixture")).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("requires a real saved question revision for source-free eligibility and exports that identity", async () => {
  const f = await seed(), attempt = await f.start(), original = await f.submit(attempt);
  const { tables } = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(tables.opening_problem_refs.find(row => row.problem_id === attempt.problemId)).toMatchObject({
    source_id: null, source_version: null, teaching_block_id: f.blockId, teaching_revision_id: expect.any(String),
  });
  expect(tables.opening_learning_item_versions.find(row => row.id === attempt.itemVersionId)).toMatchObject({
    source_id: null, teaching_block_id: f.blockId, teaching_revision_id: expect.any(String),
  });
  // Even matching forged snapshots cannot stand in for the immutable revision.
  await fixture.sql`UPDATE opening_problem_refs SET stem_snapshot='forged' WHERE problem_id=${attempt.problemId!}`;
  await fixture.sql`UPDATE opening_learning_item_versions SET stem_snapshot='forged' WHERE id=${attempt.itemVersionId!}`;
  await expect(f.grader.context(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "CONFLICT" });
});


it("rejects original classroom material as a work photo while retaining legitimate photo regrading", async () => {
  const f = await seed(true), original = await f.submit(await f.start());
  await expect(f.grader.context(fixture.scope, { observationId: original.id,
    workSourceId: f.sourceId, workSourceVersion: 1, physicalPage: 1 })).rejects.toMatchObject({ code: "VALIDATION" });
  const photoId = await backupRows(fixture.sql, fixture.scope).source();
  await fixture.sql`UPDATE opening_sources SET mime='image/png',parse_state='not_started' WHERE id=${photoId}`;
  const work = { workSourceId: photoId, workSourceVersion: 1, physicalPage: 1 };
  const graded = await f.grader.apply(fixture.scope, { observationId: original.id, ...work }, { ...proposal, transcription: "秩为2" }, "fixture");
  expect(graded.sourceIds).toContain(photoId);
  const correction = await f.learning.reviseObservation(fixture.scope, { rootObservationId: original.id, revisesObservationId: graded.id,
    expectedHead: graded.id, clientKey: randomUUID(), revisionKind: "replace", reason: "再检查一次照片",
    replacement: { answer: "秩为2", outcome: "unverified", assistance: "unknown" } });
  expect((await f.grader.context(fixture.scope, { observationId: correction.headObservationId, ...work })).workSource?.id).toBe(photoId);
  await expect(f.grader.context(fixture.scope, { observationId: correction.headObservationId,
    workSourceId: f.sourceId, workSourceVersion: 1, physicalPage: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
});

it("keeps choice options in the canonical question and preserves optional teaching feedback", async () => {
  const f = await seed(false, "二阶单位矩阵的秩是多少？", { kind: "choice", options: [{ id: "A", label: "1" }, { id: "B", label: "2" }] });
  const attempt = await f.start(), original = await f.submit(attempt);
  const [problem] = await fixture.sql`SELECT stem_snapshot FROM opening_problem_refs WHERE problem_id=${attempt.problemId!}`;
  expect(problem!.stem_snapshot).toContain("A. 1\nB. 2");
  const followUp = { prompt: "三阶单位矩阵的秩？", options: [{ id: "A", label: "2" }, { id: "B", label: "3" }], answerId: "B", explanation: "三列线性无关，所以秩为3。" };
  const saved = await f.grader.apply(fixture.scope, { observationId: original.id }, { ...proposal, followUp }, "fixture");
  expect(saved.aiEvaluation?.followUp).toEqual(followUp);
  expect(saved.answer).toBe(original.answer);
  await fixture.sql`UPDATE opening_learning_item_versions SET stem_snapshot='二阶单位矩阵的秩是多少？' WHERE id=${attempt.itemVersionId!}`;
  await expect(f.grader.context(fixture.scope, { observationId: saved.id })).rejects.toMatchObject({ code: "CONFLICT" });
});

it("keeps the unit in numeric question identity", async () => {
  const f = await seed(false, "这条边长多少？", { kind: "numeric", unit: "cm" });
  const original = await f.submit(await f.start());
  expect((await f.grader.context(fixture.scope, { observationId: original.id })).stem).toBe("这条边长多少？\n单位：cm");
});

it("records confusion once without rewriting the lesson, changing its versions or submitting an answer", async () => {
  const f = await seed(), repo = createOpeningTeachingCommandsRepository(fixture.sql);
  const request = { clientKey: randomUUID(), kind: "confused" as const, blockId: f.blockId, expectedVersion: 1 };
  const first = await repo.executeCommand(fixture.scope, f.activity.id, request);
  expect(first).toMatchObject({ ok: true, contentVersion: 1, pathVersion: 1, checkpointJson: { confusionCount: 1 }, assist: { kind: "confused" } });
  expect(await repo.executeCommand(fixture.scope, f.activity.id, request)).toMatchObject({ ok: true, replayed: true, checkpointJson: { confusionCount: 1 } });
  const [stored] = await fixture.sql`SELECT content_version,checkpoint_json FROM opening_teaching_activities WHERE id=${f.activity.id}`;
  expect(stored!.checkpoint_json.confusionCount).toBe(1);
  expect(stored!.checkpoint_json.lastConfusion.blockId).toBe(f.blockId);
  const [attempts] = await fixture.sql`SELECT count(*)::int AS count FROM opening_learning_attempts WHERE session_id=${f.session.id}`;
  expect(attempts!.count).toBe(0);
});

it("automatically assigns an unscoped lesson once and respects an existing course", async () => {
  const repo = createOpeningTeachingActivitiesRepository(fixture.sql);
  const activity = await repo.create(fixture.scope, { clientKey: randomUUID(), intentKind: "topic", intentSummary: "向量的小练习", sourceIds: [], createIntent: {} });
  const first = await repo.associateCourse(fixture.scope, activity.id, { auto: true });
  expect(first.courseId).toBeTruthy();
  expect((await repo.associateCourse(fixture.scope, activity.id, { auto: true })).courseId).toBe(first.courseId);
  const [course] = await fixture.sql`SELECT title FROM courses WHERE id=${first.courseId!} AND workspace_id=${fixture.scope.workspaceId}`;
  expect(course!.title).toBe("向量的小练习");
  await expect(repo.associateCourse(fixture.otherScope, activity.id, { auto: true })).rejects.toThrow();
});

it("infers a unique material course but isolates ambiguous material associations", async () => {
  const base = await learningAttemptFixture(fixture), repo = createOpeningTeachingActivitiesRepository(fixture.sql);
  await fixture.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
    VALUES(${fixture.scope.workspaceId},${base.courseId},'source',${base.sourceId},'reference',0,'private')`;
  const create = () => repo.create(fixture.scope, { clientKey: randomUUID(), intentKind: "topic", intentSummary: "向量", sourceIds: [base.sourceId], createIntent: {} });
  const unique = await create();
  expect((await repo.associateCourse(fixture.scope, unique.id, { auto: true })).courseId).toBe(base.courseId);
  const otherCourseId = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${otherCourseId},${fixture.scope.workspaceId},'Another course',${otherCourseId})`;
  await fixture.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
    VALUES(${fixture.scope.workspaceId},${otherCourseId},'source',${base.sourceId},'reference',0,'private')`;
  const ambiguous = await create();
  const [first, repeat] = await Promise.all([repo.associateCourse(fixture.scope, ambiguous.id, { auto: true }), repo.associateCourse(fixture.scope, ambiguous.id, { auto: true })]);
  expect(first.courseId).toBe(repeat.courseId);
  expect([base.courseId, otherCourseId]).not.toContain(first.courseId);
  const [membership] = await fixture.sql`SELECT asset_id FROM course_asset_memberships WHERE course_id=${first.courseId!}`;
  expect(membership!.asset_id).toBe(base.sourceId);
});
