import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderInput } from "@aistudy/contracts";
import { createCardRepository, createOpeningAiGradingRepository, createOpeningBudgetRepository, createOpeningCardVariantRepository,
  createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository, createOpeningTeachingHintRepository, gradeCardVariant } from "@aistudy/database";
import { createOpeningAiGradingService } from "../../packages/ai/src/opening/ai-grading-service";
import { createModelGateway } from "../../packages/ai/src/opening/model-gateway";
import { scopeBudget } from "../../apps/worker/src/runtime/model-gateway";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const proposal = { prompt: "What limit defines the derivative of f at x?", referenceAnswer: "The limit of the difference quotient as h tends to zero, when it exists.",
  rubric: ["Form the difference quotient", "Take its limit"], estimatedMinutes: 2,
  hints: { direction: "Compare nearby values.", concept: "A derivative is a limit of slopes.", firstStep: "Write the difference quotient." } };
const grading = { outcome: "correct", confidence: .95, questionMatch: true, feedback: "The quotient and limit match the generated question.",
  criteria: [{ label: "Definition", verdict: "correct", feedback: "Uses the difference quotient and limit." }] };

async function visualVariant() {
  const base = await learningAttemptFixture(f), rows = backupRows(f.sql, f.scope), photoId = await rows.source();
  await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${base.sourceId}`;
  await f.sql`UPDATE opening_source_chunks SET image_object_key=${`opening/sources/${base.sourceId}/v1`} WHERE id=${base.chunkId}`;
  await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text,image_object_key)
    VALUES(${base.sourceId},1,2,'Another scanned page',${`opening/sources/${base.sourceId}/v1`})`;
  await f.sql`UPDATE opening_sources SET mime='image/png' WHERE id=${photoId}`;
  await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text,image_object_key)
    VALUES(${photoId},1,1,'PRIVATE_OLD_STUDENT_PHOTO_IS_NOT_A_REFERENCE',${`opening/sources/${photoId}/v1`})`;
  const originalAttempt = await base.start();
  const original = await base.learning.insertObservation(f.scope, { sessionId: base.sessionId, courseId: base.courseId, skillLabel: "fractions",
    sourceIds: [base.sourceId], attemptId: originalAttempt.id, problemId: originalAttempt.problemId, answer: "Wrong original answer", outcome: "incorrect", assistance: "independent", clientKey: randomUUID() },
  { workSource: { id: photoId, version: 1, physicalPage: 1 } });
  const cards = createCardRepository(f.sql), card = await cards.createCard({ ...f.scope, courseId: base.courseId, skillLabel: "derivatives", reviewKind: "question",
    front: "What is a derivative?", back: "Historical feedback", observationId: original.id });
  const variants = createOpeningCardVariantRepository(f.sql), begun = await variants.begin(f.scope, card.id);
  const ready = await variants.complete(f.scope, card.id, begun.review.activity.id, proposal);
  const sources = [base.sourceId, photoId].sort();
  const session = await base.learning.createSession(f.scope, { activityId: ready.activity.id, courseId: base.courseId, skillLabel: "derivatives", sourceIds: sources });
  const blockId = ready.clientInit!.blocks.find(block => block.role === "prompt")!.blockId;
  const start = () => base.attempts.create(f.scope, { sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId, contentVersion: ready.activity.contentVersion } });
  const attempt = await start();
  const submit = () => base.learning.insertObservation(f.scope, { sessionId: session.id, activityId: ready.activity.id, courseId: base.courseId, skillLabel: "derivatives",
    sourceIds: sources, attemptId: attempt.id, problemId: attempt.problemId, answer: "lim (f(x+h)-f(x))/h as h tends to zero, if it exists.", outcome: "unverified", assistance: "independent", clientKey: randomUUID() });
  const repository = createOpeningAiGradingRepository(f.sql), budget = createOpeningBudgetRepository(f.sql, { envCapCents: 10000 });
  const complete = vi.fn(async (_input: ProviderInput) => ({ text: JSON.stringify(grading), inputTokens: 100, outputTokens: 100, citedChunkIds: [], candidates: [], requestId: null }));
  const gateway = createModelGateway({ resolve: async () => ({ provider: { complete }, inputCentsPerMillion: 100, outputCentsPerMillion: 100,
    modelSnapshot: { id: "controlled", providerId: "fixture", modelName: "controlled", inputCentsPerMillion: 100, outputCentsPerMillion: 100 } }) });
  const images = vi.fn(async () => { throw new Error("The text-generated variant has no original question image to load"); });
  const service = createOpeningAiGradingService({ repository, gateway, budget: scope => scopeBudget(budget, scope), images });
  return { ...base, sources, photoId, original, cards, card, ready, session, blockId, attempt, start, submit, repository, service, complete, images };
}

it("grades a text-generated variant from scanned/photo lineage without treating the old student's photo as its reference", async () => {
  const x = await visualVariant(), observation = await x.submit();
  const [before] = await f.sql`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${x.attempt.itemVersionId!}`;
  const refs = x.sources.map(sourceId => ({ sourceId, version: 1 }));
  expect(before!.evaluation_spec.sourceRefs).toEqual(expect.arrayContaining(refs));
  const context = await x.repository.context(f.scope, { observationId: observation.id });
  expect(context).toMatchObject({ stem: proposal.prompt, sourceIds: x.sources, sourceVersions: Object.fromEntries(x.sources.map(id => [id, 1])), referenceSources: [] });
  expect(context.referenceText).toContain(proposal.referenceAnswer);
  expect(context.referenceText).not.toContain("PRIVATE_OLD_STUDENT_PHOTO");
  const graded = await x.service.grade(f.scope, { observationId: observation.id });
  expect(graded).toMatchObject({ outcome: "correct", sourceIds: x.sources });
  expect(x.images).not.toHaveBeenCalled();
  expect(x.complete.mock.calls[0]![0]).toMatchObject({ imageParts: [], mediaCapability: "text_only" });
  expect((await gradeCardVariant(f.sql, f.scope, x.card.id, graded.id)).state.reps).toBe(1);
  expect((await f.sql`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${x.attempt.itemVersionId!}`)[0]).toEqual(before);
  expect((await f.sql`SELECT source_refs FROM opening_teaching_activity_specs WHERE activity_id=${x.ready.activity.id}`)[0]!.source_refs).toEqual(expect.arrayContaining(refs));
});

it("grades an already-issued immutable variant after its activity moves on without rewriting the old source refs", async () => {
  const x = await visualVariant(), observation = await x.submit();
  const [before] = await f.sql`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${x.attempt.itemVersionId!}`;
  await f.sql`UPDATE opening_teaching_activities SET status='completed',content_version=content_version+1 WHERE id=${x.ready.activity.id}`;
  expect((await x.repository.context(f.scope, { observationId: observation.id })).referenceSources).toEqual([]);
  expect((await x.service.grade(f.scope, { observationId: observation.id })).outcome).toBe("correct");
  expect((await f.sql`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${x.attempt.itemVersionId!}`)[0]).toEqual(before);
});

it("keeps generic study attempt and hint version fences after the scanned lineage source advances", async () => {
  const x = await visualVariant();
  await f.sql`UPDATE opening_sources SET version=2 WHERE id=${x.sourceId}`;
  await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text,image_object_key)
    VALUES(${x.sourceId},2,1,'New source revision',${`opening/sources/${x.sourceId}/v2`})`;
  await expect(x.start()).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(createOpeningTeachingHintRepository(f.sql).read(f.scope, { attemptId: x.attempt.id, level: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
});

it("still rejects privacy exclusions and another owner for a visual-lineage variant", async () => {
  const x = await visualVariant(), observation = await x.submit();
  await expect(x.repository.context(f.otherScope, { observationId: observation.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await backupRows(f.sql, f.scope).exclude(x.photoId);
  await expect(x.cards.getCard({ ...f.scope, cardId: x.card.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(x.repository.context(f.scope, { observationId: observation.id })).rejects.toBeDefined();
  expect(x.complete).not.toHaveBeenCalled();
});

it("does not waive an ordinary teaching question's explicit scanned chunk locator", async () => {
  const x = await visualVariant();
  const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, { courseId: x.courseId, clientKey: randomUUID(), intentKind: "topic",
    intentSummary: "Ordinary teaching", sourceIds: [x.sourceId], createIntent: {} });
  const content = createOpeningTeachingContentRepository(f.sql), blockId = randomUUID(), answerId = randomUUID();
  const unit = await content.createUnit(f.scope, { title: "Ordinary question", blocks: [
    { id: blockId, type: "prompt", content: { text: proposal.prompt } }, { id: answerId, type: "answer_key", content: { answer: proposal.referenceAnswer, hidden: true } }] });
  await content.publishActivitySpec(f.scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0, expectedRevisionNumber: 1, revisionNumber: 1,
    blockOrder: [{ blockId, blockType: "prompt", role: "prompt", position: 0 }, { blockId: answerId, blockType: "answer_key", role: "answer_key", position: 1 }],
    sourceRefs: [{ sourceId: x.sourceId, version: 1, page: 1, chunkId: x.chunkId }] });
  const session = await x.learning.createSession(f.scope, { activityId: activity.id, courseId: x.courseId, skillLabel: "derivatives", sourceIds: [x.sourceId] });
  const attempt = await x.attempts.create(f.scope, { sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId, contentVersion: 1 } });
  const observation = await x.learning.insertObservation(f.scope, { sessionId: session.id, activityId: activity.id, courseId: x.courseId, skillLabel: "derivatives",
    sourceIds: [x.sourceId], attemptId: attempt.id, problemId: attempt.problemId, answer: "A limit", outcome: "unverified", assistance: "independent", clientKey: randomUUID() });
  expect((await x.repository.context(f.scope, { observationId: observation.id })).referenceSources).toEqual([{ sourceId: x.sourceId, sourceVersion: 1, physicalPage: 1 }]);
  await f.sql`DELETE FROM opening_source_chunks WHERE id=${x.chunkId}`;
  await expect(x.repository.context(f.scope, { observationId: observation.id })).rejects.toMatchObject({ code: "CONFLICT" });
});
