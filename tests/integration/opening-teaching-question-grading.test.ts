import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AiGradingProposal, LearningAttempt } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, createOpeningLearningRepository, createOpeningTeachingActivitiesRepository,
  createOpeningTeachingContentRepository, createOpeningTeachingHintRepository } from "@aistudy/database";
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

async function seed(withSource = false, prompt = "求二阶单位矩阵的秩。") {
  const base = await learningAttemptFixture(fixture), sourceIds = withSource ? [base.sourceId] : [];
  const activity = await createOpeningTeachingActivitiesRepository(fixture.sql).create(fixture.scope, {
    clientKey: randomUUID(), intentKind: "topic", intentSummary: "矩阵秩", courseId: base.courseId, sourceIds, createIntent: {},
  });
  const content = createOpeningTeachingContentRepository(fixture.sql), blockId = randomUUID(), answerId = randomUUID();
  const unit = await content.createUnit(fixture.scope, { title: "矩阵秩", blocks: [
    { id: blockId, type: "prompt", content: { text: prompt } },
    { id: answerId, type: "answer_key", content: { answer, rubric: ["列向量线性无关", "秩等于2"], hidden: true,
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
    independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes",
  } });
  const corrected = await f.learning.reviseObservation(fixture.scope, { rootObservationId: original.id, revisesObservationId: graded.id,
    expectedHead: graded.id, clientKey: randomUUID(), revisionKind: "replace", reason: "判错了",
    replacement: { answer: "2", outcome: "incorrect", assistance: "independent" } });
  expect(corrected.observation).toMatchObject({ outcome: "incorrect", revisesObservationId: graded.id });
  const [saved] = await fixture.sql`SELECT answer,outcome FROM opening_learning_observations WHERE id=${original.id}`;
  expect(saved).toMatchObject({ answer: "2", outcome: "unverified" });
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
  expect(graded.eligibility).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes", usableForCurrentVersion: "yes" });
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
  expect(graded.eligibility).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes" });
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
    workSourceId: f.sourceId, workSourceVersion: 1, physicalPage: 1 })).rejects.toMatchObject({ code: "VALIDATION" });
});
