import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { addLocalDays, planDay, resolveLocalDayBounds } from "@aistudy/domain";
import { createOpeningAdaptivePrefsRepository, createOpeningFirstLearningRepository, createOpeningTeachingActivitiesRepository,
  listReadySourceIdsForCourse, readOpeningTeachingCompilerFocus, type FirstLearningInitializationInput } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`DELETE FROM opening_tasks WHERE workspace_id=${fixture.scope.workspaceId}`;
  await fixture.sql`DELETE FROM opening_teaching_activities WHERE workspace_id=${fixture.scope.workspaceId}`;
  await fixture.sql`DELETE FROM courses WHERE workspace_id=${fixture.scope.workspaceId}`;
  await fixture.sql`DELETE FROM workspace_preferences WHERE workspace_id=${fixture.scope.workspaceId}`;
});
afterAll(async () => { await fixture?.close(); });
const repository = () => createOpeningFirstLearningRepository(fixture.sql);
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
    recentAssistance: [], goalContext: { mode: "exam", reasonCode: "deadline_near", daysRemaining: 2 },
  } });
});

it("replays the saved calendar without restoring goals, memberships, task dates or course names changed by the learner", async () => {
  const sourceId = await source(), request = input([sourceId]);
  const first = await repository().initialize(fixture.scope, request);
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
});
