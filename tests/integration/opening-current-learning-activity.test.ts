import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpeningPlansRepository, readOpeningCurrentLearningActivity } from "@aistudy/database";
import { taskItemSchema, type TeachingActivity } from "@aistudy/contracts";
import { openCourseStudy } from "../../apps/web/src/features/opening/courses/course-study-entry";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let f: OpeningFixture;
let courseId: string;
beforeEach(async () => {
  f = await createOpeningFixture(); courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Current selection',${courseId})`;
});
afterEach(async () => { await f?.close(); });
async function activity(options: { id?: string; course?: string; status?: string; at?: string; taskId?: string; placeholder?: boolean } = {}) {
  const id = options.id ?? randomUUID();
  await f.sql`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,status,intent_kind,intent_summary,
      content_version,client_key,create_intent,updated_at)
    VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},${options.course ?? courseId},${options.status ?? "active"},
      ${options.placeholder ? "course_continue" : "topic"},'Selector fixture',${options.placeholder ? 0 : 1},${randomUUID()},
      ${f.sql.json(options.taskId ? { source: "task", taskId: options.taskId } : {})},${options.at ?? "2026-11-01T00:00:00Z"})`;
  return id;
}
it("uses stable DESC id ties inside the course and never crosses scope or course", async () => {
  const [lowId, highId] = [randomUUID(), randomUUID()].sort();
  const low = await activity({ id: lowId });
  const high = await activity({ id: highId, status: "paused" });
  const foreignCourse = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${foreignCourse},${f.scope.workspaceId},'Other',${foreignCourse})`;
  await activity({ course: foreignCourse, at: "2026-11-02T00:00:00Z" });
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId)).toMatchObject({ activityId: high });
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { activityId: low })).toMatchObject({ activityId: low });
  expect(await readOpeningCurrentLearningActivity(f.sql, f.otherScope, courseId)).toBeNull();
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, foreignCourse, { activityId: high })).toBeNull();
});
it("does not substitute latest for missing, closed, placeholder or conflicting explicit identities", async () => {
  const old = await activity(), latest = await activity({ at: "2026-11-02T00:00:00Z" });
  const done = await activity({ status: "completed" }), skipped = await activity({ status: "skipped" }), shell = await activity({ placeholder: true });
  for (const activityId of [randomUUID(), done, skipped, shell]) expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { activityId })).toBeNull();
  const sessionId = randomUUID();
  await f.sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label)
    VALUES(${sessionId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${old},'Current')`;
  await f.sql`UPDATE opening_teaching_activities SET checkpoint_json=${f.sql.json({ spanLesson: { sessionId } })} WHERE id=${old}`;
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { sessionId })).toMatchObject({ activityId: old, sessionId });
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { activityId: latest, sessionId })).toBeNull();
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { sessionId: randomUUID() })).toBeNull();
});
it("projects actual task bindings into entry without falling back after conflict or closure", async () => {
  const plans = createOpeningPlansRepository(f.sql);
  const created = await plans.createTask(f.scope, { courseId, title: "Bound entry", minutes: 20, dueAt: null, priority: 1, candidateId: null });
  const bound = await activity({ taskId: created.id });
  await activity({ at: "2026-11-02T00:00:00Z" });
  const projection = async () => taskItemSchema.parse((await plans.listTasks(f.scope)).find(row => row.id === created.id));
  expect((await projection()).teachingTarget?.activityId).toBe(bound);
  const api = { listTasks: async () => ({ tasks: await plans.listTasks(f.scope) }), getTeachingActivity: vi.fn(async () => ({ id: bound, courseId, status: "active", intentKind: "topic", contentVersion: 1 }) as TeachingActivity),
    listTeachingActivities: vi.fn(async () => []), createTeachingActivity: vi.fn() };
  const options = { courseId, courseTitle: "Course", taskId: created.id, compilerEnabled: true, archived: false, sourceIds: [] };
  expect(await openCourseStudy(api, options)).toMatchObject({ kind: "activity", activity: { id: bound } });
  api.getTeachingActivity.mockClear();
  await f.sql`UPDATE opening_teaching_activities SET status='completed' WHERE id=${bound}`;
  expect(await projection()).toMatchObject({ teachingTargetUnavailable: "unavailable_binding" });
  expect((await projection()).teachingTarget).toBeUndefined();
  const before = await f.sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`;
  await expect(openCourseStudy(api, options)).rejects.toThrow("原任务与记录保留");
  await activity({ taskId: created.id });
  expect(await projection()).toMatchObject({ teachingTargetUnavailable: "conflicting_binding" });
  await expect(openCourseStudy(api, options)).rejects.toThrow("多个学习活动");
  expect(api.getTeachingActivity).not.toHaveBeenCalled(); expect(api.listTeachingActivities).not.toHaveBeenCalled(); expect(api.createTeachingActivity).not.toHaveBeenCalled();
  const after = await f.sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`;
  expect(after.filter(row => before.some(prior => prior.id === row.id))).toEqual(before);
});
it("omits both target fields for truly unbound tasks and ignores unauthorized bindings", async () => {
  const plans = createOpeningPlansRepository(f.sql);
  const task = await plans.createTask(f.scope, { courseId, title: "Unbound", minutes: 20, dueAt: null, priority: 1, candidateId: null });
  const foreign = randomUUID();
  await f.sql`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,status,intent_kind,intent_summary,client_key,create_intent)
    VALUES(${foreign},${f.otherScope.workspaceId},${f.otherScope.ownerUserId},'active','topic','Foreign',${randomUUID()},${f.sql.json({ source: "task", taskId: task.id })})`;
  const projected = (await plans.listTasks(f.scope)).find(row => row.id === task.id)!;
  expect(projected).not.toHaveProperty("teachingTarget"); expect(projected).not.toHaveProperty("teachingTargetUnavailable");
  const api = { listTasks: async () => ({ tasks: [projected] }), getTeachingActivity: vi.fn(), listTeachingActivities: vi.fn(async () => []),
    createTeachingActivity: vi.fn(async () => ({ id: randomUUID(), courseId }) as TeachingActivity) };
  await openCourseStudy(api, { courseId, courseTitle: "Course", taskId: task.id, compilerEnabled: true, archived: false, sourceIds: [] });
  expect(api.createTeachingActivity).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ clientKey: `task:${task.id}` }));
});
it("resolves a persisted older task target, blocks ambiguous/closed targets and performs no writes", async () => {
  const taskId = randomUUID();
  await f.sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,course_id,title,minutes,priority,status)
    VALUES(${taskId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},'Bound task',20,1,'pending')`;
  const old = await activity({ taskId }), newer = await activity({ at: "2026-11-02T00:00:00Z" });
  const before = await f.sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`;
  const jobs = await f.sql`SELECT * FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`;
  const prefs = await f.sql`SELECT * FROM workspace_preferences WHERE workspace_id=${f.scope.workspaceId}`;
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { taskId })).toMatchObject({ activityId: old });
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { taskId, activityId: newer })).toBeNull();
  expect(await f.sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`).toEqual(before);
  expect(await f.sql`SELECT * FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`).toEqual(jobs);
  expect(await f.sql`SELECT * FROM workspace_preferences WHERE workspace_id=${f.scope.workspaceId}`).toEqual(prefs);
  await f.sql`UPDATE opening_teaching_activities SET status='completed' WHERE id=${old}`;
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { taskId })).toBeNull();
  await activity({ taskId });
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { taskId })).toBeNull();
});
