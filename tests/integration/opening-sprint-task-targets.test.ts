import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { taskItemSchema, type Scope, type TaskItem, type TeachingActivityCreateInput, type TeachingLearnerFocus } from "@aistudy/contracts";
import { createOpeningFirstLearningRepository, createOpeningPlansRepository, createOpeningTeachingActivitiesRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { openCourseStudy } from "../../apps/web/src/features/courses/course-study-entry";
import { courseStudyStandaloneActivity, parseCourseStudyPracticeEntry } from "../../apps/web/src/features/courses/course-study-query";
import { sprintTaskHref } from "../../apps/web/src/features/opening/exam-sprint/sprint-plan-model";
import { buildStartLearningCreateInput } from "../../apps/web/src/features/opening/teaching/today-activity";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.reset();
  for (const scope of [f.scope, f.otherScope]) {
    await f.sql`DELETE FROM opening_tasks WHERE workspace_id=${scope.workspaceId}`;
    await f.sql`DELETE FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}`;
    await f.sql`DELETE FROM courses WHERE workspace_id=${scope.workspaceId}`;
    await f.sql`DELETE FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
  }
});
afterAll(async () => { await f?.close(); });
const plans = () => createOpeningPlansRepository(f.sql);
const teaching = () => createOpeningTeachingActivitiesRepository(f.sql);
const focus: TeachingLearnerFocus = { skillLabel: "矩阵", requirementKey: "matrix:v1", activityKind: "diagnose",
  reasonCode: "no_evidence", focusObservationId: null, recentAssistance: [], strategyVersion: "test" };
async function course(scope: Scope = f.scope) {
  const id = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${scope.workspaceId},'任务直达课程',${id})`;
  return id;
}
async function task(courseId: string) {
  return plans().createTask(f.scope, { title: "矩阵讲练", minutes: 20, dueAt: null, priority: 1, candidateId: null, courseId });
}
function input(selected: TaskItem): TeachingActivityCreateInput {
  return buildStartLearningCreateInput({ localDate: "", courseId: selected.courseId, taskId: selected.id, courseTitle: selected.title });
}
function options(courseId: string) {
  return { courseId, courseTitle: "任务直达课程", archived: false, teachingEnabled: true, compilerEnabled: true, sourceIds: [] };
}
function client() {
  return {
    listTasks: vi.fn(async () => ({ tasks: await plans().listTasks(f.scope) })),
    getTeachingActivity: vi.fn((id: string) => teaching().assertOwnedActivity(f.scope, id)),
    listTeachingActivities: vi.fn(() => teaching().listByOwner(f.scope)),
    // Real repository writes only; no Worker, provider or HTTP service is started by this suite.
    createTeachingActivity: vi.fn((request: TeachingActivityCreateInput) => teaching().create(f.scope, request, { enqueueCompile: true })),
  };
}
async function readTask(id: string) {
  const selected = (await plans().listTasks(f.scope)).find(row => row.id === id)!;
  return taskItemSchema.parse(selected);
}
async function counts() {
  const [row] = await f.sql`SELECT
    (SELECT count(*)::int FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId}) AS activities,
    (SELECT count(*)::int FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}) AS jobs,
    (SELECT count(*)::int FROM opening_outbox WHERE workspace_id=${f.scope.workspaceId}) AS outbox`;
  return row;
}

it("projects a real binding into a navigable URL, restores its checkpoint and leaves reads free of new jobs", async () => {
  const courseId = await course(), selected = await task(courseId), api = client();
  expect(await readTask(selected.id)).not.toHaveProperty("teachingTarget");
  expect(sprintTaskHref(selected)).toBe(`/opening/courses/${courseId}/study?task=${selected.id}`);
  const first = await openCourseStudy(api, { ...options(courseId), taskId: selected.id });
  expect(first.kind).toBe("activity");
  if (first.kind !== "activity") throw new Error("expected teaching activity");
  const checkpoint = { currentBlockId: randomUUID() };
  await f.sql`UPDATE opening_teaching_activities SET checkpoint_json=${f.sql.json(checkpoint)} WHERE id=${first.activity.id}`;
  const before = await counts(), projected = await readTask(selected.id);
  expect(projected.teachingTarget).toEqual({ activityId: first.activity.id, courseId, requirementKey: null });
  const url = new URL(sprintTaskHref(projected), "http://opening.test");
  const query = Object.fromEntries(url.searchParams);
  expect(parseCourseStudyPracticeEntry(query)).toEqual({});
  expect(courseStudyStandaloneActivity(query)).toBeUndefined();
  expect(await openCourseStudy(api, { ...options(courseId), taskId: query.task, activityId: query.activity }))
    .toMatchObject({ kind: "activity", activity: { id: first.activity.id, checkpointJson: checkpoint } });
  expect(await openCourseStudy(api, { ...options(courseId), taskId: selected.id, compilerEnabled: false }))
    .toMatchObject({ kind: "activity", activity: { id: first.activity.id } });
  expect(api.createTeachingActivity).toHaveBeenCalledOnce();
  expect(api.listTeachingActivities).not.toHaveBeenCalled();
  expect(await counts()).toEqual(before);
  expect(before).toEqual({ activities: 1, jobs: 1, outbox: 1 });
});

it("selects the current task continuation by persisted identity, not a completed root or a lookalike client key", async () => {
  const courseId = await course(), selected = await task(courseId), request = input(selected);
  const root = await teaching().create(f.scope, request);
  await f.sql`UPDATE opening_teaching_activities SET status='completed',updated_at='2099-01-01T00:00:00Z' WHERE id=${root.id}`;
  const next = await teaching().create(f.scope, request);
  await f.sql`UPDATE opening_teaching_activities SET status='paused' WHERE id=${next.id}`;
  await teaching().create(f.scope, { ...request, clientKey: `task:${selected.id}:next:${randomUUID()}`, createIntent: {} });
  const projected = await readTask(selected.id);
  expect(projected.teachingTarget?.activityId).toBe(next.id);
  // A task remains one row even when its activity history contains multiple entries.
  expect((await plans().listTasks(f.scope)).filter(row => row.id === selected.id)).toHaveLength(1);
  const api = client();
  expect(await openCourseStudy(api, { ...options(courseId), taskId: selected.id }))
    .toMatchObject({ kind: "activity", activity: { id: next.id, status: "paused" } });
  await expect(openCourseStudy(api, { ...options(courseId), taskId: selected.id, activityId: root.id })).rejects.toThrow("目标已变化");
  expect(api.createTeachingActivity).not.toHaveBeenCalled();
});

it("isolates owner, workspace and course and refuses client-key-only bindings", async () => {
  const courseId = await course(), wrongCourse = await course(), foreignCourse = await course(f.otherScope), selected = await task(courseId);
  const request = input(selected);
  await teaching().create(f.scope, { ...request, courseId: wrongCourse });
  await teaching().create(f.otherScope, { ...request, courseId: foreignCourse });
  await teaching().create(f.scope, { ...request, clientKey: `task:${selected.id}:next:${randomUUID()}`, createIntent: { taskId: selected.id } });
  const wrongOwner = await teaching().create(f.scope, { ...request, clientKey: `wrong-owner:${randomUUID()}` });
  await f.sql`UPDATE opening_teaching_activities SET owner_user_id=${f.otherScope.ownerUserId} WHERE id=${wrongOwner.id}`;
  expect(await readTask(selected.id)).not.toHaveProperty("teachingTarget");
  expect(await plans().listTasks(f.otherScope)).toEqual([]);
  expect(await plans().listTasks({ ...f.scope, ownerUserId: f.otherScope.ownerUserId })).toEqual([]);
  const api = client();
  await expect(openCourseStudy(api, { ...options(courseId), taskId: selected.id, activityId: wrongOwner.id })).rejects.toThrow("目标已变化");
  expect(api.getTeachingActivity).not.toHaveBeenCalled();
  expect(api.createTeachingActivity).not.toHaveBeenCalled();
});

it("omits a teaching target for card-review tasks even if a historical activity carries their task identity", async () => {
  const courseId = await course(), selected = await task(courseId);
  await teaching().create(f.scope, input(selected));
  await f.sql`UPDATE opening_tasks SET origin='planner',client_key='planner:2026-10-23:review_cards:none:none' WHERE id=${selected.id}`;
  const projected = await readTask(selected.id);
  expect(projected.suggestionKind).toBe("review_cards");
  expect(projected).not.toHaveProperty("teachingTarget");
  expect(sprintTaskHref(projected)).toBe("/opening/review?tab=cards");
  const api = client();
  expect(await openCourseStudy(api, { ...options(courseId), taskId: selected.id })).toMatchObject({ kind: "cards", task: { id: selected.id } });
  expect(api.getTeachingActivity).not.toHaveBeenCalled();
  expect(api.createTeachingActivity).not.toHaveBeenCalled();
});

it("projects the onboarding first-task shortcut while leaving later daily tasks lazily unbound", async () => {
  const first = await createOpeningFirstLearningRepository(f.sql).initialize(f.scope, {
    intent: { clientKey: randomUUID(), topic: "线性代数", goal: "矩阵学习", targetDate: "2026-10-23", minutes: 30,
      startTime: "19:00", timeZone: "Asia/Shanghai", sourceIds: [] },
    startDate: "2026-10-21", planTimeZone: "Asia/Shanghai", days: [
      { date: "2026-10-21", title: "首日讲练", minutes: 30, notBefore: "2026-10-20T16:00:00.000Z", dueAt: "2026-10-21T15:59:59.000Z" },
      { date: "2026-10-22", title: "第二日讲练", minutes: 30, notBefore: "2026-10-21T16:00:00.000Z", dueAt: "2026-10-22T15:59:59.000Z" },
    ],
  });
  await f.sql`UPDATE opening_tasks SET not_before=NULL WHERE id=${first.firstTaskId!}`;
  const projected = await readTask(first.firstTaskId!);
  expect(projected.teachingTarget).toEqual({ activityId: first.activity.id, courseId: first.courseId, requirementKey: null });
  expect(await readTask(first.tasks[1]!.id)).not.toHaveProperty("teachingTarget");
  const before = await counts(), api = client();
  expect(await openCourseStudy(api, { ...options(first.courseId!), taskId: projected.id, activityId: first.activity.id }))
    .toMatchObject({ kind: "activity", activity: { id: first.activity.id } });
  expect(api.createTeachingActivity).not.toHaveBeenCalled();
  expect(await counts()).toEqual(before);
});

it("keeps requirement provenance from the activity and rejects changed or missing target requirements", async () => {
  const courseId = await course(), selected = await task(courseId);
  await f.sql`UPDATE opening_tasks SET requirement_key='matrix:v1' WHERE id=${selected.id}`;
  const activity = await teaching().create(f.scope, { ...input(selected), goalJson: { learnerFocus: focus } });
  const api = client();
  expect((await readTask(selected.id)).teachingTarget?.requirementKey).toBe("matrix:v1");
  expect(await openCourseStudy(api, { ...options(courseId), taskId: selected.id, activityId: activity.id }))
    .toMatchObject({ kind: "activity", activity: { id: activity.id } });
  api.getTeachingActivity.mockClear();
  await f.sql`UPDATE opening_tasks SET requirement_key='matrix:v2' WHERE id=${selected.id}`;
  const changed = await readTask(selected.id);
  expect(changed.teachingTarget?.requirementKey).toBe("matrix:v1");
  expect(new URL(sprintTaskHref(changed), "http://opening.test").searchParams.has("activity")).toBe(false);
  await expect(openCourseStudy(api, { ...options(courseId), taskId: selected.id })).rejects.toThrow("学习要求已调整");
  await f.sql`UPDATE opening_tasks SET requirement_key='matrix:v1' WHERE id=${selected.id}`;
  for (const goal of [{}, { learnerFocus: { requirementKey: "matrix:v1" } }]) {
    await f.sql`UPDATE opening_teaching_activities SET goal_json=${f.sql.json(goal)} WHERE id=${activity.id}`;
    expect((await readTask(selected.id)).teachingTarget?.requirementKey).toBeNull();
    await expect(openCourseStudy(api, { ...options(courseId), taskId: selected.id, activityId: activity.id })).rejects.toThrow("学习要求已调整");
  }
  expect(api.getTeachingActivity).not.toHaveBeenCalled();
  expect(api.createTeachingActivity).not.toHaveBeenCalled();
});

it("revalidates task status and deferral from storage even when the caller holds a direct activity URL", async () => {
  const courseId = await course(), selected = await task(courseId), activity = await teaching().create(f.scope, input(selected));
  const api = client(), direct = { ...options(courseId), taskId: selected.id, activityId: activity.id };
  for (const status of ["done", "skipped"]) {
    await f.sql`UPDATE opening_tasks SET status=${status} WHERE id=${selected.id}`;
    await expect(openCourseStudy(api, direct)).rejects.toThrow("已结束");
  }
  await f.sql`UPDATE opening_tasks SET status='pending',not_before='2099-01-01T00:00:00Z' WHERE id=${selected.id}`;
  await expect(openCourseStudy(api, direct)).rejects.toThrow("尚未到开始时间");
  expect(api.getTeachingActivity).not.toHaveBeenCalled();
  // A past deadline does not make an unfinished task ineligible.
  await f.sql`UPDATE opening_tasks SET not_before=NULL,due_at='2000-01-01T00:00:00Z' WHERE id=${selected.id}`;
  expect(await openCourseStudy(api, direct)).toMatchObject({ kind: "activity", activity: { id: activity.id } });
  expect(api.createTeachingActivity).not.toHaveBeenCalled();
});

it.each(["completed", "skipped", "deleted", "reassociated", "archived"])("does not recreate or silently redirect a stale link after its target is %s", async change => {
  const courseId = await course(), selected = await task(courseId), activity = await teaching().create(f.scope, input(selected));
  const url = new URL(sprintTaskHref(await readTask(selected.id)), "http://opening.test");
  if (change === "deleted") await f.sql`DELETE FROM opening_teaching_activities WHERE id=${activity.id}`;
  else if (change === "reassociated") await teaching().associateCourse(f.scope, activity.id, { courseId: await course() });
  else if (change === "archived") await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
  else await f.sql`UPDATE opening_teaching_activities SET status=${change} WHERE id=${activity.id}`;
  expect(await readTask(selected.id)).not.toHaveProperty("teachingTarget");
  const api = client();
  await expect(openCourseStudy(api, { ...options(courseId), taskId: url.searchParams.get("task")!, activityId: url.searchParams.get("activity")! }))
    .rejects.toThrow("目标已变化");
  expect(api.getTeachingActivity).not.toHaveBeenCalled();
  expect(api.createTeachingActivity).not.toHaveBeenCalled();
});
