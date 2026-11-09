import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CourseRouteRequirementInput, LearningGoal, Scope } from "@aistudy/contracts";
import {
  createCardRepository,
  createCourseMembershipRepository,
  createOpeningLearningGoalRepository,
  createOpeningLearningRepository,
  createOpeningLongTermPlanningRepository,
  createOpeningPlanningSettingsRepository,
  createOpeningPlansRepository,
  createOpeningTeachingContentRepository,
  readOpeningLearningCapacity,
  writeLearningCardSession,
} from "@aistudy/database";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { createOpeningCourseSharedSkillRepository } from "../../packages/database/src/repositories/opening-course-shared-skill";
import { refreshOpeningLearningEligibility } from "../../packages/database/src/repositories/opening-learning-eligibility";
import { learningTransactionClient } from "../../packages/database/src/repositories/opening-long-term-planning";
import { buildLongTermSuggestions } from "../../packages/database/src/repositories/opening-long-term-maintenance";
import { evaluateOpeningTeachingKeyAttempt } from "../../packages/database/src/repositories/opening-teaching-question-evaluation";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

// Parent 8383cf0d only: not acceptance of pending M2/300 or a release candidate.
// No model, mock summary, generated timetable or precomputed correctness result.
const date = "2030-11-02", now = new Date(`${date}T09:00:00Z`);
const settings = {
  weekOneMonday: "2030-09-02", periodTimes: {}, dailyWindow: { start: "08:00", end: "18:00" },
  lunch: { start: "12:00", end: "13:00" }, dinner: { start: "18:00", end: "19:00" },
  sleep: { start: "23:00", end: "07:00" }, timeZone: "UTC",
};
let f: OpeningFixture;
beforeEach(async () => {
  f = await createOpeningFixture();
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, settings);
});
afterEach(async () => { await f?.close(); });
const management = (clock = now) => createOpeningLongTermPlanningRepository(f.sql, () => clock);
const plans = () => createOpeningPlansRepository(f.sql);
const routes = () => createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
async function budget(minutes: number, clock = now) {
  await management(clock).command(f.scope, { action: "settings", dailyMinutes: minutes, bufferMinutes: 0, expectedRevision: 0 });
}
async function goal(courseIds: string[], scope = f.scope) {
  return createOpeningLearningGoalRepository(f.sql).create(scope, {
    courseIds, clientKey: randomUUID(), title: "独立解释并迁移", kind: "custom", targetDate: "2031-01-01",
    examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立完成不同题目",
  });
}
async function course(scope = f.scope) {
  const row = await createCourseMembershipRepository(f.sql).createCourse({ workspaceId: scope.workspaceId, title: "联合课程", slug: randomUUID() });
  return { id: row.id, goal: await goal([row.id], scope) };
}
async function task(courseId: string, minutes: number, extra = {}) {
  return plans().createTask(f.scope, { courseId, title: "真实任务", minutes, priority: 1, dueAt: null, candidateId: null, clientKey: randomUUID(), ...extra });
}
async function preview(expectedAcceptedVersion = 0) {
  const input = { action: "preview", date, expectedAcceptedVersion, expectedBudgetRevision: 1, clientKey: randomUUID() };
  const result = await management().command(f.scope, input);
  expect(result.draft).not.toBeNull();
  if (!result.draft) throw new Error("Expected executable joint draft");
  return { input, draft: result.draft };
}
async function confirm(draftId: string, expectedBaseVersion = 0) {
  return management().command(f.scope, { action: "confirm", draftId, expectedBaseVersion, clientKey: randomUUID() });
}
async function requirement(c: Awaited<ReturnType<typeof course>>, scope: Scope = f.scope) {
  const rows = backupRows(f.sql, scope), sourceId = await rows.source(), chunkId = await rows.chunk(sourceId);
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE id=${chunkId}`;
  await createCourseMembershipRepository(f.sql).addAssetMembership({ workspaceId: scope.workspaceId, courseId: c.id,
    assetType: "source", assetId: sourceId, role: "core", visibility: "course" });
  const input: CourseRouteRequirementInput = {
    id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: `fractions:${randomUUID()}`,
    title: "分数加法", position: 0, mandatory: true, goalIds: [c.goal.id], prerequisiteIds: [],
    sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], origin: "confirmed",
    evidenceConditions: { responseFormat: "numeric", timeLimitSeconds: null, assistance: "independent" },
    verification: { kind: "rubric", status: "ready", exerciseKeys: ["saved-fractions"], rubric: "通分相加并约分", missingReasons: [] },
  };
  await routes().confirm(scope, c.id, { expectedRevisions: [], requirements: [input], confirmScope: true });
  // Trusted persisted standard fixture, NOT a readiness claim accepted from HTTP.
  await f.sql`UPDATE course_requirements SET verification=${f.sql.json(input.verification)}
    WHERE id=${input.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  return { ...c, sourceId, chunkId, input };
}
async function sharedPair() {
  const source = await requirement(await course()), target = await requirement(await course());
  const command = { action: "link" as const, sourceRequirementId: source.input.id, expectedSourceRevision: 1,
    targetRequirementId: target.input.id, expectedTargetRevision: 1, expectedLinkRevision: 0, confirmed: true as const };
  return { source, target, command, repository: createOpeningCourseSharedSkillRepository(f.sql) };
}
async function savedQuestions(source: Awaited<ReturnType<typeof requirement>>, questionKind: "arithmetic" | "word_problem" = "arithmetic") {
  const started = await routes().start(f.scope, source.id, { goalId: source.goal.id, expectedGoalRevision: 1,
    requirementId: source.input.id, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  expect(started.kind).toBe("ready");
  if (started.kind !== "ready") throw new Error(JSON.stringify(started));
  const content = createOpeningTeachingContentRepository(f.sql);
  const questions = [
    { id: randomUUID(), answerId: randomUUID(), text: questionKind === "word_problem"
      ? "小明把 1/3 升和 1/4 升水倒入同一个空杯中，杯中共有多少升水？" : "计算 1/3 + 1/4", answer: "7/12" },
    { id: randomUUID(), answerId: randomUUID(), text: questionKind === "word_problem"
      ? "小明把 2/3 升和 1/6 升水倒入同一个空杯中，杯中共有多少升水？" : "计算 2/3 + 1/6", answer: "5/6" },
  ];
  const unit = await content.createUnit(f.scope, { title: "冻结的分数题", blocks: questions.flatMap(q => [
    { id: q.id, type: "prompt", content: { text: q.text, interaction: { kind: "numeric" } } },
    { id: q.answerId, type: "answer_key", content: { answer: q.answer, hidden: true } },
  ]) });
  await content.publishActivitySpec(f.scope, { activityId: started.activity.id, teachingUnitId: unit.id,
    expectedVersion: 0, expectedRevisionNumber: 1, revisionNumber: 1,
    blockOrder: questions.flatMap((q, i) => [
      { blockId: q.id, blockType: "prompt", role: "prompt", position: i * 2 },
      { blockId: q.answerId, blockType: "answer_key", role: "answer_key", position: i * 2 + 1 },
    ]), sourceRefs: [{ sourceId: source.sourceId, chunkId: source.chunkId, version: 1 }] });
  const learning = createOpeningLearningRepository(f.sql);
  const session = await learning.createSession(f.scope, { activityId: started.activity.id, courseId: source.id,
    skillLabel: "分数加法", sourceIds: [source.sourceId] });
  const attempts = createOpeningAttemptService(f.sql);
  async function submit(index: number, answer: string, evaluatorEra = false) {
    const attempt = await attempts.create(f.scope, { sessionId: session.id, clientKey: randomUUID(),
      teachingBlock: { blockId: questions[index]!.id, contentVersion: 1 } });
    const observation = await learning.insertObservation(f.scope, { attemptId: attempt.id, sessionId: session.id,
      courseId: source.id, skillLabel: "分数加法", sourceIds: [source.sourceId],
      problemId: attempt.problemId, answer, outcome: "unverified", assistance: "independent", clientKey: randomUUID() });
    if (evaluatorEra) {
      // Frozen evaluator-era persistence boundary, as in opening-teaching-question-deterministic.
      // Execute the actual evaluator against the saved attempt/key; never seed expected outcomes.
      await f.sql.begin(async tx => {
        const [row] = await tx`SELECT * FROM opening_learning_attempts WHERE id=${attempt.id}`;
        const evaluation = await evaluateOpeningTeachingKeyAttempt(tx, f.scope, row!, answer, []);
        if (!evaluation) throw new Error("Frozen numeric evaluator did not evaluate saved question");
        const { priorFeedback, ...receipt } = { ...evaluation, observationId: observation.id, attemptId: attempt.id,
          problemId: attempt.problemId!, itemVersionId: attempt.itemVersionId!, requirementKey: attempt.requirementKey!, evaluatedAt: observation.recordedAt! };
        await tx`UPDATE opening_learning_observations SET outcome=${evaluation.outcome},verdict_source='deterministic',
          assistance=${priorFeedback ? "hinted" : "independent"},server_evaluation=${tx.json(receipt)} WHERE id=${observation.id}`;
        await refreshOpeningLearningEligibility(tx, f.scope, [observation.id]);
      });
    }
    return { attempt, observation };
  }
  return { activity: started.activity, submit };
}

it("caps conflicting goals/courses once and preserves accepted history through archive, resume, cancellation, deferral and absence", async () => {
  const a = await course(), b = await course();
  await goal([a.id, b.id]); // Another goal does not create another daily budget.
  await budget(60);
  const first = await task(a.id, 30, { dueAt: `${date}T17:00:00Z` });
  const second = await task(b.id, 30), excess = await task(b.id, 30);
  const { input, draft } = await preview();
  expect(draft.blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60000, 0)).toBe(60);
  expect(new Set(draft.blocks.map(block => block.taskId)).size).toBe(2);
  expect(draft.blocks.some(block => block.taskId === first.id)).toBe(true);
  expect(draft.unscheduledTaskIds).toHaveLength(1);
  expect((await management().command(f.scope, input)).draft).toEqual(draft);
  expect(await plans().getToday(f.scope, date)).toBeNull();
  await confirm(draft.id);
  const accepted = await plans().getToday(f.scope, date), courses = createCourseMembershipRepository(f.sql);
  expect((await management().read(f.scope, date)).committedMinutes).toBe(60);
  await courses.setArchived({ ...f.scope, courseId: a.id, archived: true });
  await management().lifecycle(f.scope, { goalId: a.goal.id, expectedRevision: 1, lifecycle: "archived", acceptedPolicy: "keep" });
  expect(await plans().getToday(f.scope, date)).toEqual(accepted);
  await courses.setArchived({ ...f.scope, courseId: a.id, archived: false });
  await management().lifecycle(f.scope, { goalId: a.goal.id, expectedRevision: 2, lifecycle: "active", acceptedPolicy: "keep" });
  const full = await management().command(f.scope, { action: "preview", date, expectedAcceptedVersion: 1,
    expectedBudgetRevision: 1, clientKey: randomUUID() });
  expect(full.draft).toBeNull(); // A second preview cannot manufacture extra budget or tasks.
  expect(await plans().listTasks(f.scope)).toHaveLength(3);
  const deferred = await plans().deferTask(f.scope, first.id, { expectedVersion: 1, notBefore: "2030-11-05T09:00:00Z" });
  expect(deferred).toMatchObject({ dueAt: `${date}T17:00:00.000Z`, notBefore: "2030-11-05T09:00:00.000Z", status: "pending" });
  const cancelled = await plans().updateTaskStatus(f.scope, second.id, { expectedVersion: 1, status: "skipped", at: now.toISOString() });
  expect(cancelled.status).toBe("skipped");
  if (cancelled.version === undefined) throw new Error("Missing persisted task version");
  await expect(plans().deferTask(f.scope, second.id, { expectedVersion: cancelled.version, notBefore: null })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(plans().deferTask(f.otherScope, excess.id, { expectedVersion: 1, notBefore: null })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const tomorrow = await management().command(f.scope, { action: "preview", date: "2030-11-03", expectedAcceptedVersion: 0,
    expectedBudgetRevision: 1, clientKey: randomUUID() });
  expect(tomorrow.draft?.blocks.map(block => block.taskId)).toEqual([excess.id]);
  expect(await plans().getToday(f.scope, "2030-11-03")).toBeNull();
  const beforeAbsence = await plans().listTasks(f.scope);
  const late = management(new Date("2030-11-10T09:00:00Z"));
  await late.read(f.scope, date);
  await late.read(f.scope, "2030-11-10");
  expect(await plans().listTasks(f.scope)).toEqual(beforeAbsence);
  expect(await plans().getToday(f.scope, date)).toEqual(accepted);
  expect(await f.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});

it("suppresses and restores real maintenance suggestions through course and goal archive/resume with spare capacity", async () => {
  const c = await requirement(await course());
  await budget(60);
  await task(c.id, 20);
  const { draft } = await preview();
  await confirm(draft.id);
  const accepted = await plans().getToday(f.scope, date);
  await management().lifecycle(f.scope, { goalId: c.goal.id, expectedRevision: 1,
    lifecycle: "maintenance", maintenanceIntervalDays: 1, acceptedPolicy: "keep" });
  const expected = { key: `planner:${date}:maintenance:${c.goal.id}:${c.input.id}`,
    kind: "new_skill", courseId: c.id, requirementKey: c.input.requirementKey, minutes: 10 };
  async function suggestions() {
    const result = await management().command(f.scope, { action: "preview", date, expectedAcceptedVersion: 1,
      expectedBudgetRevision: 1, clientKey: randomUUID() });
    expect(result.overview).toMatchObject({ committedMinutes: 20, remainingMinutes: 40, acceptedVersion: 1 });
    expect(await plans().getToday(f.scope, date)).toEqual(accepted);
    expect(await plans().listTasks(f.scope)).toHaveLength(1); // Previews never materialize another task.
    return result.draft?.suggestedTasks ?? [];
  }
  expect(await suggestions()).toEqual([expect.objectContaining(expected)]);
  const courses = createCourseMembershipRepository(f.sql);
  await courses.setArchived({ ...f.scope, courseId: c.id, archived: true });
  expect(await suggestions()).toEqual([]);
  await courses.setArchived({ ...f.scope, courseId: c.id, archived: false });
  expect(await suggestions()).toEqual([expect.objectContaining(expected)]);
  await management().lifecycle(f.scope, { goalId: c.goal.id, expectedRevision: 2, lifecycle: "archived", acceptedPolicy: "keep" });
  expect(await suggestions()).toEqual([]);
  await management().lifecycle(f.scope, { goalId: c.goal.id, expectedRevision: 3,
    lifecycle: "maintenance", maintenanceIntervalDays: 1, acceptedPolicy: "keep" });
  expect(await suggestions()).toEqual([expect.objectContaining(expected)]);
  expect(await f.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});

it("shares persisted independent evidence without duplicating answers, maintenance tasks or capacity; source assets stay scoped", async () => {
  const x = await sharedPair(), actualNow = new Date();
  await budget(60, actualNow);
  const saved = await savedQuestions(x.source);
  const first = await saved.submit(0, "7/12", true), second = await saved.submit(1, "5/6", true);
  expect((await routes().read(f.scope, x.source.id)).requirements[0]!.status).toBe("verified");
  const capacity = await readOpeningLearningCapacity(f.sql, f.scope, actualNow);
  const facts = await f.sql`SELECT * FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`;
  const linked = await x.repository.command(f.scope, x.target.id, x.command);
  expect(linked.links[0]).toMatchObject({ active: true, effective: true });
  expect([...linked.links[0]!.observationIds].sort()).toEqual([first.observation.id, second.observation.id].sort());
  expect((await x.repository.command(f.scope, x.target.id, x.command)).links).toEqual(linked.links);
  const target = (await routes().read(f.scope, x.target.id)).requirements[0]!;
  expect(target).toMatchObject({ status: "verified", requirement: { goalIds: [x.target.goal.id] } });
  expect(target.sharedEvidence).toHaveLength(2);
  expect(await f.sql`SELECT * FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`).toEqual(facts);
  expect((await readOpeningLearningCapacity(f.sql, f.scope, actualNow)).usedMinutes).toBe(capacity.usedMinutes);
  const goals = createOpeningLearningGoalRepository(f.sql), maintenance: LearningGoal[] = [];
  for (const g of [x.source.goal, x.target.goal]) maintenance.push(await goals.update(f.scope, g.id,
    { expectedRevision: 1, lifecycle: "maintenance", maintenanceIntervalDays: 365 }));
  const suggestions = await buildLongTermSuggestions(f.sql, f.scope, { date: capacity.localDate, timeZone: capacity.timeZone,
    now: actualNow, goals: maintenance, tasks: await plans().listTasks(f.scope) });
  expect(suggestions.suggestions).toEqual([]); // Recent shared evidence is not another practice obligation.
  const courses = createCourseMembershipRepository(f.sql);
  await courses.addAssetMembership({ workspaceId: f.scope.workspaceId, courseId: x.target.id,
    assetType: "source", assetId: x.source.sourceId, role: "reference", visibility: "private" });
  await courses.removeAssetMembership({ workspaceId: f.scope.workspaceId, courseId: x.target.id, assetType: "source", assetId: x.source.sourceId });
  expect((await courses.listCourseAssets({ workspaceId: f.scope.workspaceId, courseId: x.source.id })).map(row => row.assetId)).toEqual([x.source.sourceId]);
  expect((await courses.listCourseAssets({ workspaceId: f.scope.workspaceId, courseId: x.target.id })).map(row => row.assetId)).toEqual([x.target.sourceId]);
  const foreign = await course(f.otherScope);
  await expect(courses.addAssetMembership({ workspaceId: f.otherScope.workspaceId, courseId: foreign.id,
    assetType: "source", assetId: x.source.sourceId, role: "core", visibility: "course" })).rejects.toMatchObject({ code: "CROSS_WORKSPACE_REFERENCE" });
  await expect(x.repository.command(f.otherScope, x.target.id, x.command)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await courses.setArchived({ ...f.scope, courseId: x.source.id, archived: true });
  expect((await routes().read(f.scope, x.target.id)).requirements[0]!.status).toBe("unobserved");
  await courses.setArchived({ ...f.scope, courseId: x.source.id, archived: false });
  expect((await routes().read(f.scope, x.target.id)).requirements[0]!.status).toBe("verified");
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  expect(await f.sql`SELECT id FROM opening_tasks WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});

it("does not turn unknown self reports or an explicit shared mapping into mastery", async () => {
  // A real word problem is outside the exact arithmetic evaluator's authority.
  // Keep the numeric interaction and correct saved keys; do not seed a verdict.
  const x = await sharedPair(), saved = await savedQuestions(x.source, "word_problem");
  const first = await saved.submit(0, "7/12"), second = await saved.submit(1, "5/6");
  for (const { observation } of [first, second]) {
    expect(observation).toMatchObject({ outcome: "unverified", verdictSource: "self_report",
      eligibility: { independentAttempt: "yes", verifiedCorrect: "unknown", usableForCurrentVersion: "yes" } });
    expect(observation.serverEvaluation ?? null).toBeNull();
  }
  const before = await readOpeningLearningCapacity(f.sql, f.scope);
  const linked = await x.repository.command(f.scope, x.target.id, x.command);
  expect(linked.links[0]).toMatchObject({ active: true, effective: false, observationIds: [] });
  for (const id of [x.source.id, x.target.id]) expect((await routes().read(f.scope, id)).requirements[0]!.status).not.toBe("verified");
  expect((await readOpeningLearningCapacity(f.sql, f.scope)).usedMinutes).toBe(before.usedMinutes);
  expect(await f.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(2);
});

// The shared integration DB also runs legacy restore tests with whole-table DELETE.
// Exercise real card writes and nested repository transactions, then roll back only
// this fixture: never delete append-only events or truncate another suite's facts.
async function withRolledBackCardFixture(run: () => Promise<void>) {
  const sql = f.sql, rollback = new Error("Rollback completed card fixture");
  const events = await sql`SELECT id FROM learning_events WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`;
  try {
    await expect(sql.begin(async tx => {
      f.sql = learningTransactionClient(tx);
      await run();
      throw rollback;
    })).rejects.toBe(rollback);
  } finally {
    f.sql = sql;
  }
  expect(await sql`SELECT id FROM learning_events WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`).toEqual(events);
}

it("deduplicates multi-goal shared-card work and budget, but never copies its grade into course evidence", async () => withRolledBackCardFixture(async () => {
  const x = await sharedPair(), actualNow = new Date();
  const startedAt = new Date(`${actualNow.toISOString().slice(0, 10)}T00:00:00.000Z`);
  // Keep the reservation on the same UTC day, with at least three real elapsed
  // fixture minutes even at 00:00; leave Date and PostgreSQL event clocks real.
  const clock = new Date(Math.max(actualNow.getTime(), startedAt.getTime() + 180000));
  await budget(30, clock);
  const cards = createCardRepository(f.sql), courses = createCourseMembershipRepository(f.sql);
  const card = await cards.createCard({ ...f.scope, front: "分数加法", back: "通分相加", courseId: x.source.id });
  for (const courseId of [x.source.id, x.target.id]) await courses.addAssetMembership({ workspaceId: f.scope.workspaceId,
    courseId, assetType: "card", assetId: card.id, role: "core", visibility: "course" });
  const initial = await cards.getState({ ...f.scope, cardId: card.id });
  if (!initial) throw new Error("Missing real initial SRS state");
  await cards.upsertState({ ...f.scope, state: { ...initial, dueAt: new Date(clock.getTime() - 3600000).toISOString() } });
  const queue = await cards.listQueue({ ...f.scope, mode: "auto", now: clock, today: clock.toISOString().slice(0, 10), timeZone: "UTC" });
  expect(queue.map(row => row.card.id)).toEqual([card.id]);
  const suggestions = await buildLongTermSuggestions(f.sql, f.scope, { date: clock.toISOString().slice(0, 10), timeZone: "UTC",
    now: clock, goals: [x.source.goal, x.target.goal], tasks: [] });
  expect(suggestions.suggestions.filter(row => row.kind === "review_cards")).toHaveLength(1);
  const input = { action: "start", cardIds: [card.id, card.id], goalIds: [x.source.goal.id, x.target.goal.id], budgetMinutes: 10, clientKey: randomUUID() };
  const session = await writeLearningCardSession(f.sql, f.scope, input, startedAt);
  expect((await writeLearningCardSession(f.sql, f.scope, input, startedAt)).activityId).toBe(session.activityId);
  expect(session.cardIds).toEqual([card.id]);
  expect((await readOpeningLearningCapacity(f.sql, f.scope, clock)).usedMinutes).toBe(10);
  await expect(writeLearningCardSession(f.sql, f.scope, { ...input, clientKey: randomUUID() }, clock)).rejects.toMatchObject({ code: "CONFLICT" });
  const grade = { ...f.scope, cardId: card.id, grade: "good" as const, idempotencyKey: randomUUID(), occurredAt: clock.toISOString(), now: clock };
  const graded = await cards.grade(grade);
  expect((await cards.grade(grade)).state).toEqual(graded.state);
  expect(graded.state.reps).toBe(initial.reps + 1);
  const stop = { action: "stop", activityId: session.activityId, expectedRevision: 1, elapsedSeconds: 90, reviewedCardIds: [card.id], reason: "finished" };
  expect((await writeLearningCardSession(f.sql, f.scope, stop, new Date(clock.getTime() + 1000))).reviewedCardIds).toEqual([card.id]);
  expect((await writeLearningCardSession(f.sql, f.scope, stop, new Date(clock.getTime() + 1000))).revision).toBe(2);
  expect((await readOpeningLearningCapacity(f.sql, f.scope, clock)).usedMinutes).toBe(1.5);
  expect(await f.sql`SELECT id FROM learning_events WHERE workspace_id=${f.scope.workspaceId} AND type='review'`).toHaveLength(1);
  expect(await f.sql`SELECT card_id FROM card_review_states WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  const observations = await f.sql`SELECT course_id,verdict_source,client_key FROM opening_learning_observations
    WHERE workspace_id=${f.scope.workspaceId}`;
  // The owning course gets its actual self-report, never a cloned target-course grade.
  expect(observations).toEqual([expect.objectContaining({ course_id: x.source.id, verdict_source: "self_report",
    client_key: `card-review:${graded.event.id}` })]);
  const state = await cards.getState({ ...f.scope, cardId: card.id });
  await management(clock).lifecycle(f.scope, { goalId: x.target.goal.id, expectedRevision: 1, lifecycle: "archived", acceptedPolicy: "keep" });
  await management(clock).lifecycle(f.scope, { goalId: x.target.goal.id, expectedRevision: 2, lifecycle: "active", acceptedPolicy: "keep" });
  await management(new Date(clock.getTime() + 14 * 86400000)).read(f.scope);
  expect(await cards.getState({ ...f.scope, cardId: card.id })).toEqual(state);
  for (const id of [x.source.id, x.target.id]) expect((await routes().read(f.scope, id)).requirements[0]!.status).toBe("unobserved");
}));
