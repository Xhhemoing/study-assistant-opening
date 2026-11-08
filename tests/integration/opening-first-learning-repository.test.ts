import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { addLocalDays, buildDecisionInput, captureNextLearningStep, NEXT_LEARNING_STEP_VERSION, planDay, resolveLocalDayBounds } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { createOpeningAdaptivePrefsRepository, createOpeningFirstLearningRepository, createOpeningTeachingActivitiesRepository,
  createOpeningLearnerStateService, createOpeningLearningDecisionsRepository, createOpeningLearningGoalRepository,
  listReadySourceIdsForCourse, readOpeningTeachingCompilerFocus, type FirstLearningInitializationInput } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningTeachingActivityService } from "../../apps/web/src/features/opening/teaching/activity-service";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`DELETE FROM opening_learning_decisions WHERE workspace_id=${fixture.scope.workspaceId}`;
  await fixture.sql`DELETE FROM opening_tasks WHERE workspace_id=${fixture.scope.workspaceId}`;
  await fixture.sql`DELETE FROM opening_teaching_activities WHERE workspace_id=${fixture.scope.workspaceId}`;
  await fixture.sql`DELETE FROM courses WHERE workspace_id=${fixture.scope.workspaceId}`;
  await fixture.sql`DELETE FROM workspace_preferences WHERE workspace_id=${fixture.scope.workspaceId}`;
});
afterAll(async () => { await fixture?.close(); });
const repository = () => createOpeningFirstLearningRepository(fixture.sql);
const decisions = () => createOpeningLearningDecisionsRepository(fixture.sql);
const receipts = (targetId: string) => decisions().list(fixture.scope, { layer: "activity", targetId });
function input(sourceIds: string[] = [], count = 10): FirstLearningInitializationInput {
  const startDate = "2026-10-21", planTimeZone = "Asia/Shanghai";
  return { intent: { clientKey: randomUUID(), topic: "线性代数", goal: "准备期末复习", targetDate: addLocalDays(startDate, count),
    minutes: 60, startTime: "19:00", timeZone: planTimeZone, sourceIds }, startDate, planTimeZone,
  days: Array.from({ length: count }, (_, index) => {
    const date = addLocalDays(startDate, index), bounds = resolveLocalDayBounds(date, planTimeZone);
    return { date, title: `线性代数 · 第 ${index + 1} 天`, minutes: 60, notBefore: bounds.dayStart.toISOString(),
      dueAt: new Date(bounds.nextDayStart.getTime() - 1).toISOString() };
  }) };
}
async function source(scope = fixture.scope) {
  const rows = backupRows(fixture.sql, scope), id = await rows.source(); await rows.chunk(id); return id;
}
async function counts() {
  const [row] = await fixture.sql`SELECT
    (SELECT count(*)::int FROM courses WHERE workspace_id=${fixture.scope.workspaceId}) AS courses,
    (SELECT count(*)::int FROM opening_teaching_activities WHERE workspace_id=${fixture.scope.workspaceId}) AS activities,
    (SELECT count(*)::int FROM opening_tasks WHERE workspace_id=${fixture.scope.workspaceId}) AS tasks,
    (SELECT count(*)::int FROM opening_jobs WHERE workspace_id=${fixture.scope.workspaceId}) AS jobs,
    (SELECT count(*)::int FROM opening_outbox WHERE workspace_id=${fixture.scope.workspaceId}) AS outbox`;
  return row;
}

it("atomically creates a course, goal, material membership, ten dated tasks and the first real compile job", async () => {
  const sourceId = await source(), request = input([sourceId]);
  const result = await repository().initialize(fixture.scope, request);
  expect(result).toMatchObject({ courseId: request.intent.clientKey, firstTaskId: result.tasks[0]!.id,
    startDate: "2026-10-21", endDate: "2026-10-30", legacy: false, replayed: false,
    activity: { courseId: request.intent.clientKey, generateStatus: "queued", contentVersion: 0 } });
  const saved = await receipts(result.activity.id), rule = captureNextLearningStep(buildDecisionInput({ observations: [], wantsFullExplanation: false }));
  const goal = (await createOpeningLearningGoalRepository(fixture.sql).list(fixture.scope, result.courseId!)).goals[0]!;
  const state = await createOpeningLearnerStateService(fixture.sql).read(fixture.scope);
  expect(state.features).toEqual([]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ layer: "activity", targetId: result.activity.id, parentDecisionId: null,
    selectedAction: rule.decision.activityKind, candidates: rule.candidates, stateVersion: state.stateVersion,
    policyVersion: `first-learning-1/${NEXT_LEARNING_STEP_VERSION}`, goalVersion: `goal:${goal.id}:v${goal.revision}:${goal.lifecycle}`,
    sourceVersions: { [sourceId]: [1] }, evidenceRefs: expect.arrayContaining([`source:${sourceId}:v1`]) });
  const [activityRow] = await fixture.sql`SELECT create_intent FROM opening_teaching_activities WHERE id=${result.activity.id}`;
  const { firstLearningPlan: plan, ...createIntent } = activityRow!.create_intent;
  expect(JSON.parse(saved[0]!.intentVersion)).toEqual({ protocol: "first-learning-1", courseId: result.courseId, goalId: goal.id, createIntent, plan });
  expect((await decisions().explain(fixture.scope, saved[0]!.id))).toMatchObject({ current: true, invalidationReasons: [] });
  expect(await decisions().explain(fixture.otherScope, saved[0]!.id)).toBeNull();
  expect(await decisions().explain({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, saved[0]!.id)).toBeNull();
  expect(result.tasks).toHaveLength(10);
  expect(result.tasks.every(task => task.courseId === result.courseId && task.origin === "course_seed" && task.notBefore)).toBe(true);
  expect(await listReadySourceIdsForCourse(fixture.sql, fixture.scope, result.courseId!)).toEqual([sourceId]);
  const prefs = await createOpeningAdaptivePrefsRepository(fixture.sql).get(fixture.scope);
  expect(prefs.prefs.courseGoals[result.courseId!]).toMatchObject({ targetDate: "2026-10-31", weeklyMinutes: 420, learningMode: "auto", revision: 1 });
  expect(await counts()).toEqual({ courses: 1, activities: 1, tasks: 10, jobs: 1, outbox: 1 });
  const [job] = await fixture.sql`SELECT kind,payload FROM opening_jobs WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect(job).toMatchObject({ kind: "compile-teaching-unit", payload: { activityId: result.activity.id, sourceIds: [sourceId] } });
  const today = planDay(result.tasks, [{ start: "2026-10-21T11:00:00.000Z", end: "2026-10-21T12:00:00.000Z", kind: "free" }],
    { localDate: request.startDate, timeZone: request.planTimeZone });
  expect(today.blocks.map(block => block.taskId)).toEqual([result.firstTaskId]);
  expect(today.unscheduledTaskIds).toEqual([]);
});

it("concurrent same-key requests return the one saved initialization", async () => {
  const request = input();
  const [first, second] = await Promise.all([repository().initialize(fixture.scope, request), repository().initialize(fixture.scope, request)]);
  expect(first.activity.id).toBe(second.activity.id); expect(first.firstTaskId).toBe(second.firstTaskId);
  expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
  expect(await receipts(first.activity.id)).toHaveLength(1);
  expect(await counts()).toEqual({ courses: 1, activities: 1, tasks: 10, jobs: 1, outbox: 1 });
});

it("resumes the original lesson from the first course-seed task without creating another lesson or compile job", async () => {
  const first = await repository().initialize(fixture.scope, input());
  const activities = createOpeningTeachingActivityService(fixture.sql, {});
  const intent = { clientKey: `task:${first.firstTaskId}`, intentKind: "goal", intentSummary: "client title ignored",
    createIntent: { source: "task", taskId: first.firstTaskId } };
  const resumed = await activities.create(fixture.scope, intent);
  expect(resumed.id).toBe(first.activity.id);
  expect(resumed.intentSummary).toBe(first.activity.intentSummary);
  expect((await activities.create(fixture.scope, intent)).id).toBe(first.activity.id);
  await expect(activities.create(fixture.otherScope, intent)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await counts()).toEqual({ courses: 1, activities: 1, tasks: 10, jobs: 1, outbox: 1 });
});

it("normalizes the course UUID for goal lookup and starts an imminent goal with the server's no-evidence teaching policy", async () => {
  const request = input([], 2); request.intent.clientKey = request.intent.clientKey.toUpperCase();
  const result = await repository().initialize(fixture.scope, request);
  expect(result.courseId).toBe(request.intent.clientKey.toLowerCase());
  expect(result.activity.courseId).toBe(result.courseId);
  const prefs = await createOpeningAdaptivePrefsRepository(fixture.sql).get(fixture.scope);
  expect(prefs.prefs.courseGoals[result.activity.courseId!]).toMatchObject({ targetDate: request.intent.targetDate });
  expect(await readOpeningTeachingCompilerFocus(fixture.sql, fixture.scope, result.activity.id)).toMatchObject({ learnerFocus: {
    skillLabel: request.intent.topic, activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null,
    recentAssistance: [], goalContext: { mode: "understand", reasonCode: "long_term", daysRemaining: 2 },
  } });
});

it.each(["version", "membership", "privacy"] as const)(
  "keeps uppercase source UUID receipts current on creation and replay, then invalidates %s changes", async kind => {
    const sourceId = await source(), submittedId = sourceId.toUpperCase(), request = input([submittedId], 1);
    const first = await repository().initialize(fixture.scope, request), saved = await receipts(first.activity.id);
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0]!.intentVersion).createIntent.sourceIds).toEqual([submittedId]);
    expect(saved[0]!.sourceVersions).toEqual({ [sourceId]: [1] });
    expect(first.activity.sourceIds).toEqual([sourceId]);
    expect((await createOpeningLearnerStateService(fixture.sql).read(fixture.scope)).features).toEqual([]);
    expect(await decisions().explain(fixture.scope, saved[0]!.id)).toMatchObject({ current: true, invalidationReasons: [] });
    const replay = await repository().initialize(fixture.scope, request);
    expect(replay).toMatchObject({ replayed: true, activity: { id: first.activity.id }, firstTaskId: first.firstTaskId });
    expect(await receipts(first.activity.id)).toEqual(saved);
    expect(await decisions().explain(fixture.scope, saved[0]!.id)).toMatchObject({ current: true, invalidationReasons: [] });
    expect(await counts()).toEqual({ courses: 1, activities: 1, tasks: 1, jobs: 1, outbox: 1 });
    // Identity normalization must not relax the submitted payload's replay contract.
    await expect(repository().initialize(fixture.scope, { ...request, intent: { ...request.intent, sourceIds: [sourceId] } }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    if (kind === "version") await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${sourceId}`;
    if (kind === "membership") await fixture.sql`DELETE FROM course_asset_memberships WHERE course_id=${first.courseId!} AND asset_id=${sourceId}`;
    if (kind === "privacy") await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${fixture.scope.workspaceId},${sourceId})`;
    expect(await decisions().explain(fixture.scope, saved[0]!.id)).toMatchObject({ current: false, invalidationReasons: ["source_changed"] });
    expect(await receipts(first.activity.id)).toEqual(saved);
  });

it("replays the saved calendar without restoring goals, memberships, task dates or course names changed by the learner", async () => {
  const sourceId = await source(), request = input([sourceId]);
  const first = await repository().initialize(fixture.scope, request);
  const saved = await receipts(first.activity.id);
  await fixture.sql`UPDATE courses SET title='用户改名',archived_at=now() WHERE id=${first.courseId!}`;
  await createOpeningAdaptivePrefsRepository(fixture.sql).patch(fixture.scope, { courseGoal: { courseId: first.courseId!, goal: null, expectedRevision: 1 } });
  await fixture.sql`DELETE FROM course_asset_memberships WHERE course_id=${first.courseId!}`;
  await fixture.sql`UPDATE opening_tasks SET status='done',title='用户修改',not_before='2027-01-01T00:00:00Z',version=version+1 WHERE id=${first.firstTaskId!}`;
  const second = await repository().initialize(fixture.scope, { ...request, startDate: "2026-11-04", days: [] }, { replayOnly: true });
  expect(second).toMatchObject({ firstTaskId: first.firstTaskId, startDate: first.startDate, endDate: first.endDate, replayed: true });
  expect(second.tasks[0]).toMatchObject({ title: "用户修改", status: "done", version: 2, notBefore: "2027-01-01T00:00:00.000Z" });
  expect((await createOpeningAdaptivePrefsRepository(fixture.sql).get(fixture.scope)).prefs.courseGoals[first.courseId!]).toBeUndefined();
  const [course] = await fixture.sql`SELECT title,archived_at FROM courses WHERE id=${first.courseId!}`;
  expect(course!.title).toBe("用户改名"); expect(course!.archived_at).not.toBeNull();
  const memberships = await fixture.sql`SELECT id FROM course_asset_memberships WHERE course_id=${first.courseId!}`;
  expect(memberships).toHaveLength(0);
  expect(await receipts(first.activity.id)).toEqual(saved);
  expect(await decisions().explain(fixture.scope, saved[0]!.id)).toMatchObject({ current: false,
    invalidationReasons: expect.arrayContaining(["goal_changed", "source_changed", "course_unavailable"]) });
  expect(await counts()).toEqual({ courses: 1, activities: 1, tasks: 10, jobs: 1, outbox: 1 });
});

it("does not let the same client key change the original goal", async () => {
  const request = input(); await repository().initialize(fixture.scope, request);
  await expect(repository().initialize(fixture.scope, { ...request, intent: { ...request.intent, minutes: 90 } })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await counts()).toMatchObject({ courses: 1, tasks: 10, jobs: 1 });
});

it.each(["foreign", "excluded", "not_uploaded"])("rejects %s source admission before creating any course, goal, task or activity", async kind => {
  const sourceId = await source(kind === "foreign" ? fixture.otherScope : fixture.scope);
  if (kind === "excluded") await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${fixture.scope.workspaceId},${sourceId})`;
  if (kind === "not_uploaded") await fixture.sql`UPDATE opening_sources SET upload_state='pending' WHERE id=${sourceId}`;
  await expect(repository().initialize(fixture.scope, input([sourceId]))).rejects.toMatchObject({ code: "VALIDATION" });
  expect(await counts()).toEqual({ courses: 0, activities: 0, tasks: 0, jobs: 0, outbox: 0 });
  expect((await createOpeningAdaptivePrefsRepository(fixture.sql).get(fixture.scope)).saved).toBe(false);
});

it("rejects a new past-date intent and a foreign owner without partial initialization", async () => {
  await expect(repository().initialize(fixture.scope, input(), { replayOnly: true })).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(repository().initialize({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, input())).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await counts()).toEqual({ courses: 0, activities: 0, tasks: 0, jobs: 0, outbox: 0 });
});

it("preserves unrelated adaptive settings and rejects invalid saved preferences", async () => {
  await fixture.sql`INSERT INTO workspace_preferences(workspace_id,adaptive_planning)
    VALUES(${fixture.scope.workspaceId},${fixture.sql.json({ ...DEFAULT_OPENING_ADAPTIVE_PREFS, autonomy: "manual", coachBudgetMinutes: 90 })})`;
  await repository().initialize(fixture.scope, input([], 1));
  expect((await createOpeningAdaptivePrefsRepository(fixture.sql).get(fixture.scope)).prefs).toMatchObject({ autonomy: "manual", coachBudgetMinutes: 90 });
  await fixture.sql`UPDATE workspace_preferences SET adaptive_planning='{"broken":true}'::jsonb WHERE workspace_id=${fixture.scope.workspaceId}`;
  await expect(repository().initialize(fixture.scope, input([], 1))).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await counts()).toEqual({ courses: 1, activities: 1, tasks: 1, jobs: 1, outbox: 1 });
});

it("rolls back the course, goal and queued generation when a later daily task cannot be inserted", async () => {
  const request = input([], 2), collision = `first-learning:${request.intent.clientKey}:day:${request.days[1]!.date}`;
  await fixture.sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,title,minutes,priority,client_key)
    VALUES(${randomUUID()},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},'已有任务',60,1,${collision})`;
  await expect(repository().initialize(fixture.scope, request)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await counts()).toEqual({ courses: 0, activities: 0, tasks: 1, jobs: 0, outbox: 0 });
  expect((await createOpeningAdaptivePrefsRepository(fixture.sql).get(fixture.scope)).saved).toBe(false);
  expect(await fixture.sql`SELECT id FROM opening_learning_decisions WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
});

it("returns an old unbound activity as legacy without silently creating a course or new tasks", async () => {
  const request = input();
  const activity = await createOpeningTeachingActivitiesRepository(fixture.sql).create(fixture.scope, {
    clientKey: `first-learning:${request.intent.clientKey}:activity`, intentKind: "goal", intentSummary: request.intent.topic,
    sourceIds: [], createIntent: { source: "onboarding", ...request.intent },
  });
  const result = await repository().initialize(fixture.scope, request, { replayOnly: true });
  expect(result).toMatchObject({ courseId: null, activity: { id: activity.id }, tasks: [], firstTaskId: null, legacy: true, replayed: true });
  expect(await counts()).toEqual({ courses: 0, activities: 1, tasks: 0, jobs: 0, outbox: 0 });
  expect(await receipts(activity.id)).toEqual([]);
});

it.each([undefined, 45])("creates and replays an unscheduled lesson with only an explicit daily budget (%s)", async dailyMinutes => {
  const scheduled = input();
  const request = { ...scheduled, intent: { ...scheduled.intent, startTime: null, minutes: 20,
    ...(dailyMinutes !== undefined ? { dailyMinutes } : {}) }, days: [] };
  const first = await repository().initialize(fixture.scope, request);
  expect(first).toMatchObject({ courseId: request.intent.clientKey, tasks: [], firstTaskId: null,
    startDate: request.startDate, endDate: request.startDate, legacy: false, replayed: false });
  const prefs = await createOpeningAdaptivePrefsRepository(fixture.sql).get(fixture.scope);
  expect(prefs.prefs.courseGoals[first.courseId!]).toMatchObject({ targetDate: request.intent.targetDate,
    weeklyMinutes: (dailyMinutes ?? 0) * 7 });
  const [activity] = await fixture.sql`SELECT intent_summary,goal_json,create_intent FROM opening_teaching_activities WHERE id=${first.activity.id}`;
  expect(activity!.goal_json.sessionMinutes).toBe(20);
  if (dailyMinutes === undefined) expect(activity!.goal_json).not.toHaveProperty("dailyMinutes");
  else expect(activity!.goal_json.dailyMinutes).toBe(dailyMinutes);
  expect(activity!.intent_summary).toContain("本次学习 20 分钟");
  expect(activity!.create_intent.firstLearningPlan.taskKeys).toEqual([]);
  const replay = await repository().initialize(fixture.scope, { ...request, startDate: "2026-11-04" }, { replayOnly: true });
  expect(replay).toMatchObject({ activity: { id: first.activity.id }, tasks: [], firstTaskId: null,
    startDate: request.startDate, endDate: request.startDate, replayed: true });
  expect(await counts()).toEqual({ courses: 1, activities: 1, tasks: 0, jobs: 1, outbox: 1 });
});

it.each(["version", "membership", "privacy", "upload", "goal", "goal-archive", "goal-unlink", "course-archive", "intent"] as const)(
  "revalidates %s from persisted scoped inputs without rewriting the first receipt", async kind => {
    const sourceId = await source(), request = input([sourceId], 1);
    const first = await repository().initialize(fixture.scope, request), saved = (await receipts(first.activity.id))[0]!;
    const captured = JSON.parse(saved.intentVersion);
    if (kind === "version") await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${sourceId}`;
    if (kind === "membership") await fixture.sql`DELETE FROM course_asset_memberships WHERE course_id=${first.courseId!} AND asset_id=${sourceId}`;
    if (kind === "privacy") await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${fixture.scope.workspaceId},${sourceId})`;
    if (kind === "upload") await fixture.sql`UPDATE opening_sources SET upload_state='pending' WHERE id=${sourceId}`;
    if (kind === "goal" || kind === "goal-archive") await createOpeningLearningGoalRepository(fixture.sql).update(fixture.scope, captured.goalId,
      { expectedRevision: 1, ...(kind === "goal" ? { weeklyMinutes: 90 } : { lifecycle: "archived" as const }) });
    if (kind === "goal-unlink") {
      const other = await repository().initialize(fixture.scope, input([], 1));
      await createOpeningLearningGoalRepository(fixture.sql).update(fixture.scope, captured.goalId,
        { expectedRevision: 1, courseIds: [other.courseId!] });
    }
    if (kind === "course-archive") await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${first.courseId!}`;
    if (kind === "intent") await fixture.sql`UPDATE opening_teaching_activities SET create_intent=jsonb_set(create_intent,'{topic}','"用户新主题"'::jsonb) WHERE id=${first.activity.id}`;
    // Caller-supplied historical versions cannot override these trusted reads.
    const explanation = await decisions().explain(fixture.scope, saved.id, { goalVersion: saved.goalVersion,
      intentVersion: saved.intentVersion, policyVersion: saved.policyVersion });
    expect(explanation).toMatchObject({ current: false, invalidationReasons: expect.arrayContaining([
      ["version", "membership", "privacy", "upload"].includes(kind) ? "source_changed"
        : kind.startsWith("goal") ? "goal_changed" : kind === "intent" ? "intent_changed" : "course_unavailable",
    ]) });
    expect(await receipts(first.activity.id)).toEqual([saved]);
  });

it.each(["first-learning-1/next-learning-step-1", "first-learning-1/next-learning-step-2",
  "first-learning-1/next-learning-step-3", "first-learning-1/next-learning-step-4", "first-learning-1/next-learning-step-5"])(
  "revalidates canonical policy rather than trusting caller-supplied historical %s", async policyVersion => {
    const first = await repository().initialize(fixture.scope, input([], 1));
    const saved = (await receipts(first.activity.id))[0]!;
    await fixture.sql`UPDATE opening_learning_decisions SET receipt=jsonb_set(receipt,'{policyVersion}',
      ${fixture.sql.json(policyVersion)}::jsonb) WHERE id=${saved.id}`;
    const historical = { ...saved, policyVersion };
    const rawReceipts = await fixture.sql`SELECT * FROM opening_learning_decisions WHERE id=${saved.id}`;
    expect(await decisions().get(fixture.scope, saved.id)).toEqual(historical);
    expect(await decisions().explain(fixture.scope, saved.id, { goalVersion: historical.goalVersion,
      intentVersion: historical.intentVersion, policyVersion: historical.policyVersion }))
      .toMatchObject({ decision: historical, current: false, invalidationReasons: ["policy_changed"] });
    expect(await receipts(first.activity.id)).toEqual([historical]);
    expect(await fixture.sql`SELECT * FROM opening_learning_decisions WHERE id=${saved.id}`).toEqual(rawReceipts);
  });

it.each(["first-learning-1/next-learning-step-0", "first-learning-1/next-learning-step-7",
  "first-learning-1/next-learning-step-06", "first-learning-1/unknown"])(
  "reads unknown %s conservatively without rewriting receipts or initialization facts", async policyVersion => {
    const sourceId = await source(), request = input([sourceId], 1);
    const first = await repository().initialize(fixture.scope, request), saved = (await receipts(first.activity.id))[0]!;
    expect(saved.policyVersion).toBe("first-learning-1/next-learning-step-6");
    const facts = async () => ({ counts: await counts(),
      activities: await fixture.sql`SELECT * FROM opening_teaching_activities WHERE id=${first.activity.id}`,
      tasks: await fixture.sql`SELECT * FROM opening_tasks WHERE course_id=${first.courseId!} ORDER BY id`,
      sources: await listReadySourceIdsForCourse(fixture.sql, fixture.scope, first.courseId!),
    });
    const before = await facts();
    expect(before.sources).toEqual([sourceId]);
    await fixture.sql`UPDATE opening_learning_decisions SET receipt=jsonb_set(receipt,'{policyVersion}',
      ${fixture.sql.json(policyVersion)}::jsonb) WHERE id=${saved.id}`;
    const historical = { ...saved, policyVersion };
    const rawReceipts = await fixture.sql`SELECT * FROM opening_learning_decisions WHERE id=${saved.id}`;
    expect(await decisions().get(fixture.scope, saved.id)).toEqual(historical);
    expect(await decisions().explain(fixture.otherScope, saved.id)).toBeNull();
    for (const versions of [undefined, { goalVersion: historical.goalVersion,
      intentVersion: historical.intentVersion, policyVersion }]) {
      expect(await decisions().explain(fixture.scope, saved.id, versions)).toMatchObject({
        decision: historical, current: false, invalidationReasons: ["policy_version_not_revalidated"],
      });
    }
    const replay = await repository().initialize(fixture.scope, request, { replayOnly: true });
    expect(replay).toMatchObject({ replayed: true, activity: { id: first.activity.id }, firstTaskId: first.firstTaskId });
    expect(await facts()).toEqual(before);
    expect(await receipts(first.activity.id)).toEqual([historical]);
    expect(await fixture.sql`SELECT * FROM opening_learning_decisions WHERE id=${saved.id}`).toEqual(rawReceipts);
  });

it("does not treat another initialization's unobserved materials as missing from this receipt", async () => {
  const first = await repository().initialize(fixture.scope, input([await source()], 1));
  const saved = (await receipts(first.activity.id))[0]!;
  await repository().initialize(fixture.scope, input([await source()], 1));
  expect(await decisions().explain(fixture.scope, saved.id)).toMatchObject({ current: true, invalidationReasons: [] });
});

it("does not backfill an older saved course initialization without a receipt", async () => {
  const request = input([], 1), first = await repository().initialize(fixture.scope, request);
  await fixture.sql`DELETE FROM opening_learning_decisions WHERE target_id=${first.activity.id}`;
  const replay = await repository().initialize(fixture.scope, { ...request, startDate: "2026-11-04", days: [] }, { replayOnly: true });
  expect(replay).toMatchObject({ activity: { id: first.activity.id }, replayed: true, legacy: false, firstTaskId: first.firstTaskId });
  expect(await receipts(first.activity.id)).toEqual([]);
});

it("rolls back the receipt together with the course, goal, tasks and compile enqueue on transaction failure", async () => {
  const failing = new Proxy(fixture.sql, { get(target, key, receiver) {
    if (key === "begin") return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => {
      await callback(tx);
      expect(await tx`SELECT id FROM opening_learning_decisions WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(1);
      throw new Error("injected before commit");
    });
    return Reflect.get(target, key, receiver);
  } }) as Sql;
  await expect(createOpeningFirstLearningRepository(failing).initialize(fixture.scope, input([], 2))).rejects.toThrow("injected before commit");
  expect(await counts()).toEqual({ courses: 0, activities: 0, tasks: 0, jobs: 0, outbox: 0 });
  expect(await fixture.sql`SELECT id FROM opening_learning_decisions WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
  expect((await createOpeningLearningGoalRepository(fixture.sql).list(fixture.scope)).goals).toEqual([]);
  expect((await createOpeningAdaptivePrefsRepository(fixture.sql).get(fixture.scope)).saved).toBe(false);
});

it("rejects seeded days in an unscheduled intent before creating any data", async () => {
  const request = input();
  await expect(repository().initialize(fixture.scope, { ...request, intent: { ...request.intent, startTime: null } }))
    .rejects.toMatchObject({ code: "VALIDATION" });
  expect(await counts()).toEqual({ courses: 0, activities: 0, tasks: 0, jobs: 0, outbox: 0 });
});
