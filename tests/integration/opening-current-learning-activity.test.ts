import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpeningPlansRepository, createOpeningSpanSessionRepository, createOpeningTeachingActivitiesRepository, readOpeningCurrentLearningActivity } from "@aistudy/database";
import { taskItemSchema, teachingActivitySchema, teachingActivityCreateInputSchema, type TeachingActivity } from "@aistudy/contracts";
import { DEFAULT_STUDY_SESSION_INTENT } from "@aistudy/domain";
import { openCourseStudy } from "../../apps/web/src/features/opening/courses/course-study-entry";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { currentCourseActivity, courseStudyActivities } from "../../apps/web/src/features/opening/courses/course-study-model";
import { navigateCourseStaticLesson } from "../../apps/web/src/features/opening/courses/course-study-workspace";
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
async function staticLesson() {
  const seeds = backupRows(f.sql, f.scope), sourceId = await seeds.source();
  await seeds.chunk(sourceId);
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  return createOpeningSpanSessionRepository(f.sql).create(f.scope, { courseId, sourceIds: [sourceId], clientKey: randomUUID(), intent: DEFAULT_STUDY_SESSION_INTENT });
}
async function readFootprint() {
  return {
    activities: await f.sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    sessions: await f.sql`SELECT * FROM opening_learning_sessions WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    jobs: await f.sql`SELECT * FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    outbox: await f.sql`SELECT * FROM opening_outbox WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    preferences: await f.sql`SELECT * FROM workspace_preferences WHERE workspace_id=${f.scope.workspaceId}`,
  };
}
it("recovers real owned static span through DB DTO, course selector, entry and workspace navigation without writes", async () => {
  const lesson = await staticLesson(), teaching = createOpeningTeachingActivitiesRepository(f.sql);
  await activity({ at: "2000-01-01T00:00:00Z" }); // An older compiled activity must not win.
  const before = await readFootprint();
  const dto = teachingActivitySchema.parse(await teaching.assertOwnedActivity(f.scope, lesson.activityId));
  expect(dto.staticLesson).toEqual({ protocol: "span-lesson-v1", sessionId: lesson.sessionId });
  const rows = (await teaching.listByOwner(f.scope)).map(row => teachingActivitySchema.parse(row));
  expect(currentCourseActivity(rows, courseId)).toEqual(dto);
  expect(courseStudyActivities(rows, courseId)[0]).toEqual(dto);
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId)).toEqual({ activityId: lesson.activityId, sessionId: lesson.sessionId, courseId });
  const api = { listTasks: vi.fn(async () => ({ tasks: [] })), listTeachingActivities: vi.fn(async () => rows),
    getTeachingActivity: vi.fn((id: string) => teaching.assertOwnedActivity(f.scope, id)), createTeachingActivity: vi.fn() };
  const options = { courseId, courseTitle: "Static span", compilerEnabled: true, archived: false, sourceIds: [] };
  const entry = await openCourseStudy(api, options);
  const href = `/opening/courses/${courseId}/study/span?lesson=${lesson.activityId}`;
  expect(entry).toEqual({ kind: "static-lesson", activity: dto, href });
  const navigate = vi.fn();
  expect(navigateCourseStaticLesson(entry, navigate)).toBe(true);
  expect(navigate).toHaveBeenCalledExactlyOnceWith(href);
  api.listTeachingActivities.mockClear();
  expect(await openCourseStudy(api, { ...options, activityId: lesson.activityId })).toEqual(entry);
  expect(api.listTeachingActivities).not.toHaveBeenCalled();
  expect(api.createTeachingActivity).not.toHaveBeenCalled();
  expect(await readFootprint()).toEqual(before);
  expect(teachingActivityCreateInputSchema.safeParse({ clientKey: randomUUID(), intentKind: "topic", intentSummary: "No qualification input", sourceIds: [], staticLesson: dto.staticLesson }).success).toBe(false);
});
it.each(["activity", "course", "workspace", "owner", "missing", "protocol"] as const)("does not project or restore static span with a %s mismatch", async mismatch => {
  const lesson = await staticLesson(), teaching = createOpeningTeachingActivitiesRepository(f.sql);
  if (mismatch === "missing") await f.sql`UPDATE opening_teaching_activities SET checkpoint_json=${f.sql.json({ spanLesson: { sessionId: randomUUID() } })} WHERE id=${lesson.activityId}`;
  else if (mismatch === "protocol") await f.sql`UPDATE opening_teaching_activities SET create_intent='{}'::jsonb WHERE id=${lesson.activityId}`;
  else if (mismatch === "activity") {
    const other = await activity();
    await f.sql`UPDATE opening_learning_sessions SET activity_id=${other} WHERE id=${lesson.sessionId}`;
  } else if (mismatch === "course") {
    const other = randomUUID();
    await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${other},${f.scope.workspaceId},'Other',${other})`;
    await f.sql`UPDATE opening_learning_sessions SET course_id=${other} WHERE id=${lesson.sessionId}`;
  } else if (mismatch === "workspace") await f.sql`UPDATE opening_learning_sessions SET workspace_id=${f.otherScope.workspaceId} WHERE id=${lesson.sessionId}`;
  else await f.sql`UPDATE opening_learning_sessions SET owner_user_id=${f.otherScope.ownerUserId} WHERE id=${lesson.sessionId}`;
  const before = await readFootprint();
  const dto = teachingActivitySchema.parse(await teaching.assertOwnedActivity(f.scope, lesson.activityId));
  expect(dto).not.toHaveProperty("staticLesson");
  const rows = await teaching.listByOwner(f.scope);
  expect(rows.find(row => row.id === lesson.activityId)).not.toHaveProperty("staticLesson");
  expect(currentCourseActivity(rows.filter(row => row.id === lesson.activityId), courseId)).toBeNull();
  expect(courseStudyActivities([dto], courseId)).toEqual([]);
  const navigate = vi.fn();
  expect(navigateCourseStaticLesson({ kind: "activity", activity: dto }, navigate)).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  await expect(teaching.assertOwnedActivity(f.otherScope, lesson.activityId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await readFootprint()).toEqual(before);
});
it("does not promote checkpoint-shaped legacy shells into static lesson qualification", async () => {
  const shell = await activity({ placeholder: true });
  await f.sql`UPDATE opening_teaching_activities SET checkpoint_json=${f.sql.json({ spanLesson: { sessionId: randomUUID() }, staticLesson: { protocol: "span-lesson-v1", sessionId: randomUUID() } })} WHERE id=${shell}`;
  const teaching = createOpeningTeachingActivitiesRepository(f.sql);
  const dto = await teaching.assertOwnedActivity(f.scope, shell);
  expect(dto).not.toHaveProperty("staticLesson");
  expect(currentCourseActivity(await teaching.listByOwner(f.scope), courseId)).toBeNull();
});
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
