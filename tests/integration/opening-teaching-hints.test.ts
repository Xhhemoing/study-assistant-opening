import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningAiGradingRepository, createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository, createOpeningTeachingHintRepository, createOpeningLearningRepository, createOpeningLearnerStateService } from "@aistudy/database";
import { nextLearningStep } from "@aistudy/domain";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
const generatedHints = { direction: "先确定列向量是否线性无关。", concept: "矩阵的秩等于线性无关列的最大数量。", firstStep: "将第一列写为 (1,0)，再考察第二列。" };

async function seed(hints: unknown = generatedHints) {
  const base = await learningAttemptFixture(fixture);
  const activity = await createOpeningTeachingActivitiesRepository(fixture.sql).create(fixture.scope, {
    clientKey: randomUUID(), intentKind: "topic", intentSummary: "单位矩阵的秩", courseId: base.courseId, sourceIds: [base.sourceId], createIntent: {},
  });
  const content = createOpeningTeachingContentRepository(fixture.sql), blockId = randomUUID(), answerId = randomUUID();
  const unit = await content.createUnit(fixture.scope, { title: "矩阵秩", blocks: [
    { id: blockId, type: "prompt", content: { text: "求二阶单位矩阵的秩。" } },
    { id: answerId, type: "answer_key", content: { answer: "两列分别为 (1,0) 与 (0,1)，线性无关，所以秩为 2。", hidden: true, hints, citedChunkIds: [base.chunkId] } },
  ] });
  await content.publishActivitySpec(fixture.scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0,
    expectedRevisionNumber: unit.currentRevisionNumber, revisionNumber: unit.currentRevisionNumber,
    blockOrder: [{ blockId, position: 0, role: "prompt", blockType: "prompt" }, { blockId: answerId, position: 1, role: "answer_key", blockType: "answer_key" }],
    sourceRefs: [{ sourceId: base.sourceId, chunkId: base.chunkId, version: 1 }],
  });
  const session = await createOpeningLearningRepository(fixture.sql).createSession(fixture.scope, {
    courseId: base.courseId, activityId: activity.id, skillLabel: "矩阵秩", sourceIds: [base.sourceId],
  });
  const attempts = createOpeningAttemptService(fixture.sql);
  const attempt = await attempts.create(fixture.scope, { sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId, contentVersion: 1 },
    problem: { sourceId: base.sourceId, chunkId: base.chunkId, stemSnapshot: "求二阶单位矩阵的秩。", artifactKind: "reference_item" } });
  const submit = () => attempts.submit(fixture.scope, attempt.id, { clientKey: randomUUID(), answer: "2", outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
  const read = (level: 1 | 2 | 3 | 4) => createOpeningTeachingHintRepository(fixture.sql).read(fixture.scope, { attemptId: attempt.id, level });
  return { ...base, activity, blockId, answerId, unit, content, attempt, submit, read };
}

describe("generic teaching hint ledger", () => {
  it.each([false, true])("feeds a graded classroom answer into the next step and preserves help history (hinted=%s)", async hinted => {
    const f = await seed();
    if (hinted) await f.read(1);
    const original = await f.submit();
    const grader = createOpeningAiGradingRepository(fixture.sql);
    expect((await grader.context(fixture.scope, { observationId: original.id })).stem).toBe("求二阶单位矩阵的秩。");
    const graded = await grader.apply(fixture.scope, { observationId: original.id }, {
      outcome: "correct", questionMatch: true, confidence: 0.93,
      feedback: "二阶单位矩阵有两个线性无关的列，秩为2。",
      criteria: [{ label: "矩阵秩", verdict: "correct", feedback: "秩为2。" }],
    }, "test-grader");
    const state = await createOpeningLearnerStateService(fixture.sql).read(fixture.scope, { courseId: f.courseId });
    const feature = state.features.find(row => row.observationId === graded.id)!;
    expect(feature.eligibility).toMatchObject({ verifiedCorrect: "yes", usableForCurrentVersion: "yes", independentAttempt: hinted ? "no" : "yes" });
    expect(state.features.some(row => row.observationId === original.id)).toBe(false);
    const summary = state.summary.find(row => row.requirementKey === graded.requirementKey)!;
    expect(summary).toMatchObject({ sampleCount: 1, status: hinted ? "needs_check" : "observed_independent" });
    expect(nextLearningStep({ wantsFullExplanation: false, status: summary.status, observations: [{
      id: graded.id, skillLabel: graded.skillLabel, attemptedAt: graded.submittedAt ?? graded.occurredAt,
      problemId: graded.problemId ?? null, assistance: graded.assistance,
      independentAttempt: feature.eligibility.independentAttempt,
      verifiedCorrect: feature.eligibility.verifiedCorrect, usableForCurrentVersion: feature.eligibility.usableForCurrentVersion,
    }] }).activityKind).toBe(hinted ? "reduced_help_practice" : "transfer_check");
    const [saved] = await fixture.sql`SELECT answer,outcome FROM opening_learning_observations WHERE id=${original.id}`;
    expect(saved).toMatchObject({ answer: "2", outcome: "unverified" });
  });

  it("hides all generated stages until requested and releases each actual stage only once", async () => {
    const f = await seed();
    const init = await f.content.getClientInit(fixture.scope, f.activity.id);
    expect(JSON.stringify(init)).not.toContain(generatedHints.firstStep);
    expect(JSON.stringify(init)).not.toContain("所以秩为 2");
    await expect(f.read(4)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [first, replay] = await Promise.all([f.read(1), f.read(1)]);
    expect(first.text).toBe(generatedHints.direction);
    expect(first.exposureReceipt.id).toBe(replay.exposureReceipt.id);
    expect(first.exposureReceipt).toMatchObject({ origin: "assistant", supportDomain: "unknown", releasedAt: expect.any(String),
      contextAnchor: { activityId: f.activity.id, blockId: f.blockId, contentVersion: 1, attemptId: f.attempt.id, itemVersionId: f.attempt.itemVersionId } });
    expect((await f.read(2)).text).toBe(generatedHints.concept);
    expect((await f.read(3)).text).toBe(generatedHints.firstStep);
    const rows = await fixture.sql`SELECT level,kind,delivered,release_key FROM opening_help_exposures WHERE attempt_id=${f.attempt.id}`;
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.level === "hinted" && row.kind === "hint" && row.delivered === true)).toBe(true);
    const observation = await f.submit();
    const state = await createOpeningLearnerStateService(fixture.sql).read(fixture.scope, { courseId: f.courseId });
    expect(state.features.find(row => row.observationId === observation.id)?.eligibility.independentAttempt).toBe("no");
    const full = await f.read(4);
    expect(full).toMatchObject({ level: 4, referenceSourceId: f.sourceId, text: expect.stringContaining("所以秩为 2"),
      exposureReceipt: { origin: "history_solution", contextAnchor: { purpose: "history_solution" } } });
    const old = await f.content.getSubmittedAnswerKey(fixture.scope, f.activity.id, f.blockId, f.attempt.id);
    expect(old).toEqual({ answer: full.text, referenceSourceId: f.sourceId });
    const [count] = await fixture.sql`SELECT count(*)::int AS total FROM opening_help_exposures WHERE attempt_id=${f.attempt.id}`;
    expect(count?.total).toBe(4);
    const refreshed = await createOpeningLearnerStateService(fixture.sql).read(fixture.scope, { courseId: f.courseId });
    expect(refreshed.display.counts.retest).toBe(1);
    const [tasks] = await fixture.sql`SELECT count(*)::int AS total FROM opening_retest_activities WHERE workspace_id=${fixture.scope.workspaceId} AND course_id=${f.courseId}`;
    expect(tasks?.total).toBe(0);
  });

  it("does not fabricate legacy hints and still allows the original answer to be saved", async () => {
    const f = await seed(null);
    await expect(f.read(1)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("没有分级提示") });
    expect(await f.submit()).toMatchObject({ attemptId: f.attempt.id });
    expect((await f.read(4)).text).toContain("所以秩为 2");
    const rows = await fixture.sql`SELECT level FROM opening_help_exposures WHERE attempt_id=${f.attempt.id}`;
    expect(rows.map(row => row.level)).toEqual(["revealed"]);
  });

  it("fails closed for foreign ownership and changed source/content versions, including prior receipt replays", async () => {
    const f = await seed();
    await expect(createOpeningTeachingHintRepository(fixture.sql).read(fixture.otherScope, { attemptId: f.attempt.id, level: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const first = await f.read(1);
    await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
    await backupRows(fixture.sql, fixture.scope).chunk(f.sourceId, 2);
    await expect(f.read(1)).rejects.toMatchObject({ code: "CONFLICT" });
    await fixture.sql`UPDATE opening_sources SET version=1 WHERE id=${f.sourceId}`;
    await fixture.sql`UPDATE opening_teaching_activities SET content_version=2 WHERE id=${f.activity.id}`;
    await expect(f.read(2)).rejects.toMatchObject({ code: "CONFLICT" });
    await fixture.sql`UPDATE opening_teaching_activities SET content_version=1 WHERE id=${f.activity.id}`;
    await backupRows(fixture.sql, fixture.scope).exclude(f.sourceId);
    await expect(f.read(1)).rejects.toMatchObject({ code: "VALIDATION" });
    const rows = await fixture.sql`SELECT id FROM opening_help_exposures WHERE attempt_id=${f.attempt.id}`;
    expect(rows.map(row => row.id)).toEqual([first.exposureReceipt.id]);
  });
});
