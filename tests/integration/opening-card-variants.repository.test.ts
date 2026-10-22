import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createCardRepository, createOpeningAiGradingRepository, createOpeningCardVariantRepository, gradeCardVariant } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => { await f.reset(); await f.sql`TRUNCATE cards,opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await f?.close(); });
const proposal = { prompt: "计算分数加法：2/3 + 1/3 等于多少？", referenceAnswer: "同分母分数分子相加，结果为1。",
  rubric: ["保留分母", "相加分子", "约分"], hints: { direction: "比较分母。", concept: "同分母分数相加。", firstStep: "把分子相加。" }, estimatedMinutes: 2 };
const repo = () => createOpeningCardVariantRepository(f.sql);

it("rejects a wrong arithmetic variant before publishing content or changing FSRS", async () => {
  const base = await learningAttemptFixture(f);
  const card = await createCardRepository(f.sql).createCard({ ...f.scope, courseId: base.courseId,
    reviewKind: "question", front: "1/2 + 1/2?", back: "同分母相加" });
  const begun = await repo().begin(f.scope, card.id);
  await expect(repo().complete(f.scope, card.id, begun.review.activity.id,
    { ...proposal, prompt: "计算 1/3+1/6", referenceAnswer: "1" })).rejects.toMatchObject({ code: "VALIDATION" });
  const current = await repo().read(f.scope, card.id, begun.review.activity.id);
  expect(current.clientInit).toBeNull();
  expect(current.activity.contentVersion).toBe(0);
  expect(await f.sql`SELECT id FROM learning_events WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});

async function seed(assistance: "independent" | "hinted" = "independent") {
  const base = await learningAttemptFixture(f), cards = createCardRepository(f.sql);
  const card = await cards.createCard({ ...f.scope, courseId: base.courseId, reviewKind: "question", skillLabel: "fractions", front: "1/2 + 1/2?", back: "同分母相加" });
  const begun = await repo().begin(f.scope, card.id);
  const ready = await repo().complete(f.scope, card.id, begun.review.activity.id, proposal);
  const session = await base.learning.createSession(f.scope, { courseId: base.courseId, activityId: ready.activity.id, skillLabel: "fractions", sourceIds: [] });
  const prompt = ready.clientInit!.blocks.find(block => block.role === "prompt")!;
  const attempt = await base.attempts.create(f.scope, { sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId: prompt.blockId, contentVersion: 1 } });
  const original = await base.learning.insertObservation(f.scope, { sessionId: session.id, activityId: ready.activity.id,
    courseId: base.courseId, skillLabel: "fractions", sourceIds: [], attemptId: attempt.id, problemId: attempt.problemId,
    answer: "1", outcome: "unverified", assistance, clientKey: randomUUID() });
  const grade = (outcome: "correct" | "incorrect" = "correct", confidence = 0.93) => createOpeningAiGradingRepository(f.sql).apply(f.scope,
    { observationId: original.id }, { outcome, questionMatch: true, confidence, feedback: "同分母保留分母，相加分子。",
      criteria: [{ label: "同分母分数相加", verdict: outcome, feedback: "检查分子相加。" }] }, "fixture");
  return { ...base, card, cards, ready, session, attempt, original, grade };
}

it("restores the same hidden-answer variation and saves one FSRS event from an accepted answer", async () => {
  const s = await seed();
  const context = await createOpeningAiGradingRepository(f.sql).context(f.scope, { observationId: s.original.id });
  expect(context.referenceText).toContain(proposal.referenceAnswer);
  expect(context.referenceText).toContain("评分要点");
  for (const point of proposal.rubric) expect(context.referenceText).toContain(point);
  expect((await repo().begin(f.scope, s.card.id)).review.activity.id).toBe(s.ready.activity.id);
  expect(s.ready.clientInit!.blocks.find(block => block.role === "answer_key")!.content).toBeNull();
  await expect(s.cards.grade({ ...f.scope, cardId: s.card.id, grade: "easy", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(gradeCardVariant(f.sql, f.scope, s.card.id, s.original.id)).rejects.toMatchObject({ code: "CONFLICT" });
  const graded = await s.grade(), result = await gradeCardVariant(f.sql, f.scope, s.card.id, graded.id);
  expect(result).toMatchObject({ created: true, state: { reps: 1, lastGrade: "easy" }, event: { payload: { assisted: false } } });
  expect((await gradeCardVariant(f.sql, f.scope, s.card.id, graded.id)).created).toBe(false);
  const facts = await f.sql`SELECT id FROM opening_learning_observations WHERE client_key=${`card-review:${result.event.id}`}`;
  expect(facts).toHaveLength(0);
  const next = await repo().begin(f.scope, s.card.id);
  expect(next.review.activity.id).not.toBe(s.ready.activity.id);
  await expect(repo().complete(f.scope, s.card.id, next.review.activity.id, proposal)).rejects.toMatchObject({ code: "VALIDATION" });
});

it.each(["hinted", "slow", "wrong", "uncertain"] as const)("uses grading and real duration, preserving %s answers", async mode => {
  const s = await seed(mode === "hinted" ? "hinted" : "independent");
  if (mode === "slow") await f.sql`UPDATE opening_learning_attempts SET started_at=submitted_at-interval '5 minutes' WHERE id=${s.attempt.id}`;
  const graded = await s.grade(mode === "wrong" ? "incorrect" : "correct", mode === "uncertain" ? 0.4 : 0.93);
  if (mode === "uncertain") {
    await expect(gradeCardVariant(f.sql, f.scope, s.card.id, graded.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await s.cards.getState({ ...f.scope, cardId: s.card.id }))!.reps).toBe(0);
  } else expect((await gradeCardVariant(f.sql, f.scope, s.card.id, graded.id)).state.lastGrade).toBe(mode === "wrong" ? "again" : "hard");
});

it("rejects another card, owner, same-activity material question, and stale content without scheduling", async () => {
  const s = await seed(), graded = await s.grade();
  await expect(gradeCardVariant(f.sql, f.otherScope, s.card.id, graded.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const other = await s.cards.createCard({ ...f.scope, courseId: s.courseId, front: "另一题", back: "解答", reviewKind: "question" });
  await expect(gradeCardVariant(f.sql, f.scope, other.id, graded.id)).rejects.toMatchObject({ code: "CONFLICT" });
  // A material question can share a session/activity, but it is not the published variant.
  await f.sql`UPDATE opening_learning_sessions SET source_ids=${[s.sourceId]} WHERE id=${s.session.id}`;
  const unrelated = await s.attempts.create(f.scope, { sessionId: s.session.id, clientKey: randomUUID(), problem: {
    sourceId: s.sourceId, chunkId: s.chunkId, stemSnapshot: "任意旧题", artifactKind: "reference_item" } });
  const wrongIdentity = await s.learning.insertObservation(f.scope, { sessionId: s.session.id, courseId: s.courseId, activityId: s.ready.activity.id,
    sourceIds: [s.sourceId], skillLabel: "fractions", attemptId: unrelated.id, problemId: unrelated.problemId, answer: "1", outcome: "correct", assistance: "independent", clientKey: randomUUID() });
  const unrelatedGrade = await createOpeningAiGradingRepository(f.sql).apply(f.scope, { observationId: wrongIdentity.id }, {
    outcome: "correct", questionMatch: true, confidence: 0.93, feedback: "这道材料题答对了。", criteria: [{ label: "材料题答案", verdict: "correct", feedback: "符合题意。" }],
  }, "fixture");
  expect(unrelatedGrade).toMatchObject({ outcome: "correct", verdictSource: "ai_graded" });
  await expect(gradeCardVariant(f.sql, f.scope, s.card.id, unrelatedGrade.id)).rejects.toMatchObject({ code: "CONFLICT" });
  await repo().classify(f.scope, s.card.id, "question");
  await expect(gradeCardVariant(f.sql, f.scope, s.card.id, graded.id)).rejects.toMatchObject({ code: "CONFLICT" });
});

it("starts a new binding after privacy changes and never silently resends an unknown generation", async () => {
  const s = await seed();
  await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${f.scope.workspaceId}`;
  const next = await repo().begin(f.scope, s.card.id);
  expect(next.review.activity.id).not.toBe(s.ready.activity.id);
  await repo().fail(f.scope, s.card.id, next.review.activity.id, "unknown");
  expect((await repo().begin(f.scope, s.card.id, true)).review.activity.id).toBe(next.review.activity.id);
});

async function failedVariant() {
  const base = await learningAttemptFixture(f);
  const card = await createCardRepository(f.sql).createCard({ ...f.scope, courseId: base.courseId,
    reviewKind: "question", front: "1/2 + 1/2?", back: "同分母相加" });
  const first = await repo().begin(f.scope, card.id);
  await repo().fail(f.scope, card.id, first.review.activity.id, "failed");
  return { card, first };
}

it("restores a ready retry after an earlier failed generation on normal start", async () => {
  const { card, first } = await failedVariant();
  const retry = await repo().begin(f.scope, card.id, true);
  expect(retry.fresh).toBe(true);
  expect(retry.review.activity.id).not.toBe(first.review.activity.id);
  await repo().complete(f.scope, card.id, retry.review.activity.id, proposal);
  const restored = await repo().begin(f.scope, card.id);
  expect(restored).toMatchObject({ fresh: false, review: { activity: { id: retry.review.activity.id, generateStatus: "ready" } } });
});

it("keeps the failed generation without creating a retry on normal start", async () => {
  const { card, first } = await failedVariant();
  const restored = await repo().begin(f.scope, card.id);
  expect(restored).toMatchObject({ fresh: false, review: { activity: { id: first.review.activity.id, generateStatus: "failed" } } });
  const rows = await f.sql`SELECT id FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId}
    AND owner_user_id=${f.scope.ownerUserId} AND create_intent->>'cardId'=${card.id}`;
  expect(rows).toHaveLength(1);
});

it("keeps observation-created mistake cards in question review", async () => {
  const s = await seed(), graded = await s.grade("incorrect");
  const card = await s.cards.createCard({ ...f.scope, courseId: s.courseId, observationId: graded.id,
    front: "同分母分数相加", back: "先保留分母", reviewKind: "concept" });
  await expect(repo().classify(f.scope, card.id, "concept")).rejects.toMatchObject({ code: "CONFLICT" });
});

it("times the last changed answer instead of the first fast submission", async () => {
  const s = await seed();
  const revision = await s.learning.reviseObservation(f.scope, { rootObservationId: s.original.id, revisesObservationId: s.original.id,
    expectedHead: s.original.id, revisionKind: "replace", reason: "补充推导", clientKey: randomUUID(),
    replacement: { answer: "(2+1)/3 = 1", outcome: "unverified", assistance: "independent" } });
  await f.sql`UPDATE opening_learning_observations SET recorded_at=started_at+interval '5 minutes' WHERE id=${revision.headObservationId}`;
  const graded = await createOpeningAiGradingRepository(f.sql).apply(f.scope, { observationId: revision.headObservationId }, {
    outcome: "correct", questionMatch: true, confidence: 0.93, feedback: "同分母保留分母。", criteria: [{ label: "正确相加", verdict: "correct", feedback: "结果为1。" }],
  }, "fixture");
  expect((await gradeCardVariant(f.sql, f.scope, s.card.id, graded.id)).state.lastGrade).toBe("hard");
});
