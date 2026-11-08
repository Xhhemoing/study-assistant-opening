import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readOpeningCurrentLearningActivity } from "@aistudy/database";
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
