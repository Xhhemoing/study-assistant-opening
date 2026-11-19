import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createLibraryRepository,
  createOpeningLearningRepository,
  createOpeningPlansRepository,
  createOpeningSpanSessionRepository,
  createOpeningTeachingActivitiesRepository,
  createOpeningWritingWorkspaceRepository,
  readOpeningCurrentLearningActivity,
  readOpeningCurrentLearningRecovery,
  readOpeningLearningAgenda,
  readOpeningWorkspaceActivityRecovery,
} from "@aistudy/database";
import {
  WRITING_META_PROPERTY_KEY,
  taskItemSchema,
  teachingActivitySchema,
  teachingActivityCreateInputSchema,
  type TeachingActivity,
} from "@aistudy/contracts";
import { DEFAULT_STUDY_SESSION_INTENT, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createSpanLessonSessionService } from "../../apps/web/src/features/opening/teaching/span/lesson-session-service";
import { openCourseStudy } from "../../apps/web/src/features/opening/courses/course-study-entry";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { currentCourseActivity, courseStudyActivities } from "../../apps/web/src/features/opening/courses/course-study-model";
import { pickCurrentTeachingActivity } from "../../apps/web/src/features/opening/teaching/today-activity";
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
async function staticLesson(retestId?: string, lessonCourseId = courseId) {
  const seeds = backupRows(f.sql, f.scope), sourceId = await seeds.source();
  await seeds.chunk(sourceId);
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${lessonCourseId},'source',${sourceId},'core','course')`;
  return createOpeningSpanSessionRepository(f.sql).create(f.scope, { courseId: lessonCourseId, sourceIds: [sourceId], clientKey: randomUUID(), intent: DEFAULT_STUDY_SESSION_INTENT, ...(retestId ? { retestId } : {}) });
}
async function readFootprint() {
  return {
    activities: await f.sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    retests: await f.sql`SELECT * FROM opening_retest_activities WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    sessions: await f.sql`SELECT * FROM opening_learning_sessions WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    jobs: await f.sql`SELECT * FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    outbox: await f.sql`SELECT * FROM opening_outbox WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    preferences: await f.sql`SELECT * FROM workspace_preferences WHERE workspace_id=${f.scope.workspaceId}`,
  };
}
const terminalRetestRecoveryCases = (["cancelled", "completed"] as const).flatMap(retestStatus =>
  (["active", "paused"] as const).flatMap(status => (["same", "other"] as const).map(course => ({ retestStatus, status, course }))));
it.each(terminalRetestRecoveryCases)("recovers older $course-course progress past a newer $status lesson with $retestStatus retest", async ({ retestStatus, status, course }) => {
  const retestId = randomUUID();
  await f.sql`INSERT INTO opening_retest_activities(id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version)
    VALUES(${retestId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},'accepted',2)`;
  const broken = await staticLesson(retestId);
  const fallbackCourseId = course === "same" ? courseId : randomUUID();
  if (course === "other") await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${fallbackCourseId},${f.scope.workspaceId},'Older course',${fallbackCourseId})`;
  const fallback = status === "active" ? await staticLesson(undefined, fallbackCourseId) : null;
  const fallbackId = fallback?.activityId ?? await activity({ course: fallbackCourseId, status: "paused" });
  await f.sql`UPDATE opening_teaching_activities SET updated_at='2026-11-01T00:00:00Z' WHERE id=${fallbackId}`;
  await f.sql`UPDATE opening_teaching_activities SET status=${status},updated_at='2026-11-03T00:00:00Z' WHERE id=${broken.activityId}`;
  await f.sql`UPDATE opening_retest_activities SET status=${retestStatus} WHERE id=${retestId}`;
  const before = await readFootprint();
  expect(await readOpeningCurrentLearningRecovery(f.sql, f.scope)).toEqual({ activityId: fallbackId, sessionId: fallback?.sessionId ?? null, courseId: fallbackCourseId });
  // Explicit identities remain the original activity; availability is owned by its reader.
  for (const reference of [{ activityId: broken.activityId }, { sessionId: broken.sessionId }]) {
    expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, reference, { spanOnly: true, retestId })).toEqual({ activityId: broken.activityId, sessionId: broken.sessionId, courseId });
  }
  const agenda = await f.sql.begin(tx => readOpeningLearningAgenda(tx, f.scope, courseId, broken.activityId));
  expect(agenda).toMatchObject({ activityId: broken.activityId, sessionId: broken.sessionId, pendingRetestId: retestId, status: retestStatus, resumable: false });
  const details = await createSpanLessonSessionService(f.sql).read(f.scope, courseId, broken.activityId, retestId);
  expect(details.session).toMatchObject({ activityId: broken.activityId, sessionId: broken.sessionId, retestId, status });
  await expect(createOpeningTeachingActivitiesRepository(f.sql).assertOwnedActivity(f.scope, broken.activityId)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await readFootprint()).toEqual(before);
});
it.each(["cancelled", "completed"] as const)("has no automatic recovery when the only lesson's retest is %s", async retestStatus => {
  const retestId = randomUUID();
  await f.sql`INSERT INTO opening_retest_activities(id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version)
    VALUES(${retestId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},'accepted',2)`;
  const lesson = await staticLesson(retestId);
  await f.sql`UPDATE opening_retest_activities SET status=${retestStatus} WHERE id=${retestId}`;
  const before = await readFootprint();
  expect(await readOpeningCurrentLearningRecovery(f.sql, f.scope)).toBeNull();
  expect((await createOpeningSpanSessionRepository(f.sql).get(f.scope, lesson.activityId))?.retestId).toBe(retestId);
  expect(await readFootprint()).toEqual(before);
});
it.each([
  { retestStatus: "cancelled", reference: "canonical", expected: "older" },
  { retestStatus: "completed", reference: "alias", expected: "older" },
  { retestStatus: "accepted", reference: "canonical", expected: "newer" },
  { retestStatus: "in_progress", reference: "alias", expected: "newer" },
] as const)("selects $expected activity for compiled route $reference reference with $retestStatus retest", async ({ retestStatus, reference, expected }) => {
  const retestId = randomUUID(), alias = randomUUID(), older = await activity({ status: "paused" });
  await f.sql`INSERT INTO opening_retest_activities(id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version,candidate_reference_id)
    VALUES(${retestId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},'Route skill','route-skill',${randomUUID()},${retestStatus},2,${alias})`;
  const newer = await activity({ at: "2026-11-03T00:00:00Z" });
  // The route start owner persists this context in goal_json, not spanLesson.
  const context = { goalId: randomUUID(), goalRevision: 1, requirementId: randomUUID(), requirementRevision: 1,
    stableSkillId: randomUUID(), requirementKey: "route-skill", action: "transfer_check", retestId: reference === "canonical" ? retestId : alias };
  await f.sql`UPDATE opening_teaching_activities SET create_intent=${f.sql.json({ kind: "course_route", goalId: context.goalId, requirementId: context.requirementId })},
    goal_json=${f.sql.json({ courseRoute: context })} WHERE id=${newer}`;
  const before = await readFootprint();
  expect(await readOpeningCurrentLearningRecovery(f.sql, f.scope)).toEqual({ activityId: expected === "older" ? older : newer, sessionId: null, courseId });
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { activityId: newer })).toEqual({ activityId: newer, sessionId: null, courseId });
  expect(await readFootprint()).toEqual(before);
});
it.each(["active", "paused"] as const)("restores a real %s delayed retest via DTO href and the actual lesson target reader", async status => {
  const retestId = randomUUID();
  await f.sql`INSERT INTO opening_retest_activities(id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version)
    VALUES(${retestId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},'accepted',2)`;
  const lesson = await staticLesson(retestId), sessions = createOpeningSpanSessionRepository(f.sql);
  const answer = await createOpeningLearningRepository(f.sql).insertObservation(f.scope, { sessionId: lesson.sessionId, courseId, skillLabel: SPAN_SKILL_LABEL,
    sourceIds: lesson.sourceIds, clientKey: randomUUID(), answer: "保留原复测作答", outcome: "unverified", assistance: "independent", verdictSource: "self_report", retestId });
  const saved = await sessions.save(f.scope, lesson.activityId, { expectedRevision: lesson.revision, intent: lesson.intent, moveId: lesson.moveId, status });
  const teaching = createOpeningTeachingActivitiesRepository(f.sql), dto = teachingActivitySchema.parse(await teaching.assertOwnedActivity(f.scope, lesson.activityId));
  expect(dto.staticLesson).toEqual({ protocol: "span-lesson-v1", sessionId: lesson.sessionId, retestId });
  const before = await readFootprint();
  expect(await readOpeningCurrentLearningRecovery(f.sql, f.scope)).toEqual({ activityId: lesson.activityId, sessionId: lesson.sessionId, courseId });
  const api = { listTasks: vi.fn(async () => ({ tasks: [] })), listTeachingActivities: () => teaching.listByOwner(f.scope), getTeachingActivity: vi.fn(), createTeachingActivity: vi.fn() };
  const entry = await openCourseStudy(api, { courseId, courseTitle: "Delayed", compilerEnabled: true, archived: false, sourceIds: [] });
  const href = `/opening/courses/${courseId}/study/span?lesson=${lesson.activityId}&retest=${retestId}`;
  expect(entry).toEqual({ kind: "static-lesson", activity: dto, href });
  const navigate = vi.fn(); expect(navigateCourseStaticLesson(entry, navigate)).toBe(true); expect(navigate).toHaveBeenCalledExactlyOnceWith(href);
  const params = new URL(href, "https://opening.test").searchParams;
  const details = await createSpanLessonSessionService(f.sql).read(f.scope, courseId, params.get("lesson"), params.get("retest"));
  expect(details.session).toEqual(saved); expect(details.observations.map(row => row.id)).toContain(answer.id);
  expect(details.observations.find(row => row.id === answer.id)?.answer).toBe("保留原复测作答");
  expect(api.createTeachingActivity).not.toHaveBeenCalled(); expect(await readFootprint()).toEqual(before);
  await f.sql`UPDATE opening_retest_activities SET status='cancelled' WHERE id=${retestId}`;
  const cancelled = await readFootprint();
  await expect(teaching.assertOwnedActivity(f.scope, lesson.activityId)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(openCourseStudy(api, { courseId, courseTitle: "Delayed", compilerEnabled: true, archived: false, sourceIds: [] })).rejects.toThrow("原延迟复测");
  expect(api.createTeachingActivity).not.toHaveBeenCalled(); expect(await readFootprint()).toEqual(cancelled);
});
it.each(["cancelled", "completed"] as const)("isolates an active/paused lesson with %s retest from another course's ordinary/static progress", async retestStatus => {
  const retestId = randomUUID();
  await f.sql`INSERT INTO opening_retest_activities(id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version)
    VALUES(${retestId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},'accepted',2)`;
  const broken = await staticLesson(retestId), brokenCourseId = courseId;
  const sessions = createOpeningSpanSessionRepository(f.sql), teaching = createOpeningTeachingActivitiesRepository(f.sql);
  const staticCourseId = randomUUID(), ordinaryCourseId = randomUUID();
  for (const id of [staticCourseId, ordinaryCourseId]) await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${f.scope.workspaceId},'Unaffected course',${id})`;
  courseId = staticCourseId; const valid = await staticLesson(); courseId = brokenCourseId;
  const ordinaryId = await activity({ course: ordinaryCourseId });
  const options = (id: string) => ({ courseId: id, courseTitle: "Isolation", compilerEnabled: true, archived: false, sourceIds: [] });
  const api = { listTasks: vi.fn(async () => ({ tasks: [] })), listTeachingActivities: () => teaching.listByOwner(f.scope),
    getTeachingActivity: (id: string) => teaching.assertOwnedActivity(f.scope, id), createTeachingActivity: vi.fn() };
  await f.sql`UPDATE opening_retest_activities SET status=${retestStatus} WHERE id=${retestId}`;
  for (const status of ["active", "paused"] as const) {
    const current = (await sessions.get(f.scope, broken.activityId))!;
    await sessions.save(f.scope, broken.activityId, { expectedRevision: current.revision, intent: current.intent, moveId: current.moveId, status });
    const before = await readFootprint();
    const rows = await teaching.listByOwner(f.scope);
    const unavailable = teachingActivitySchema.parse(rows.find(row => row.id === broken.activityId));
    expect(unavailable.staticLessonUnavailable).toBe("retest_unavailable");
    expect(unavailable).not.toHaveProperty("staticLesson");
    expect(unavailable.courseId).toBe(brokenCourseId);
    expect(teachingActivitySchema.safeParse({ ...unavailable, staticLesson: { protocol: "span-lesson-v1", sessionId: broken.sessionId } }).success).toBe(false);
    expect(teachingActivityCreateInputSchema.safeParse({ clientKey: randomUUID(), intentKind: "topic", intentSummary: "No unavailable input", createIntent: {}, staticLessonUnavailable: "retest_unavailable" }).success).toBe(false);
    const ordinary = await teaching.assertOwnedActivity(f.scope, ordinaryId);
    expect(await openCourseStudy(api, options(ordinaryCourseId))).toEqual({ kind: "activity", activity: ordinary });
    const validDto = await teaching.assertOwnedActivity(f.scope, valid.activityId);
    expect(await openCourseStudy(api, options(staticCourseId))).toEqual({ kind: "static-lesson", activity: validDto, href: `/opening/courses/${staticCourseId}/study/span?lesson=${valid.activityId}` });
    await expect(openCourseStudy(api, options(brokenCourseId))).rejects.toThrow("原延迟复测");
    await expect(openCourseStudy(api, { ...options(brokenCourseId), activityId: broken.activityId })).rejects.toThrow("原延迟复测");
    expect(api.createTeachingActivity).not.toHaveBeenCalled(); expect(await readFootprint()).toEqual(before);
  }
  // Terminal teaching history remains readable without the active-resume rejection.
  const paused = (await sessions.get(f.scope, broken.activityId))!;
  await sessions.save(f.scope, broken.activityId, { expectedRevision: paused.revision, intent: paused.intent, moveId: paused.moveId, status: "completed" });
  expect((await teaching.assertOwnedActivity(f.scope, broken.activityId)).status).toBe("completed");
});
it("rejects a persisted retest reference after its course identity no longer matches", async () => {
  const retestId = randomUUID();
  await f.sql`INSERT INTO opening_retest_activities(id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version)
    VALUES(${retestId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},'accepted',2)`;
  const lesson = await staticLesson(retestId);
  const other = randomUUID(); await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${other},${f.scope.workspaceId},'Other',${other})`;
  await f.sql`UPDATE opening_retest_activities SET course_id=${other} WHERE id=${retestId}`;
  const before = await readFootprint();
  await expect(createOpeningTeachingActivitiesRepository(f.sql).assertOwnedActivity(f.scope, lesson.activityId)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await readFootprint()).toEqual(before);
});
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
it("excludes card-session keys, cardReviewSession checkpoints, and legacy-course-continue keys even when create_intent is empty", async () => {
  const usable = await activity({ at: "2026-11-01T00:00:00Z" });
  const cardByKey = randomUUID(), cardByCheckpoint = randomUUID(), legacyByKey = randomUUID();
  await f.sql`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,status,intent_kind,intent_summary,content_version,client_key,create_intent,checkpoint_json,updated_at)
    VALUES
      (${cardByKey},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},'active','topic','Card key row',1,${`card-session:${randomUUID()}`},'{}'::jsonb,'{}'::jsonb,'2026-11-03T00:00:00Z'),
      (${cardByCheckpoint},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},'paused','topic','Card checkpoint row',1,${randomUUID()},'{}'::jsonb,${f.sql.json({ cardReviewSession: { elapsedSeconds: 0 } })},'2026-11-03T00:00:01Z'),
      (${legacyByKey},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},'active','course_continue','Legacy key row',1,${`legacy-course-continue:${courseId}`},'{}'::jsonb,'{}'::jsonb,'2026-11-03T00:00:02Z')`;
  const before = await readFootprint();
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId)).toEqual({ activityId: usable, sessionId: null, courseId });
  expect(await readOpeningCurrentLearningRecovery(f.sql, f.scope)).toEqual({ activityId: usable, sessionId: null, courseId });
  for (const excluded of [cardByKey, cardByCheckpoint, legacyByKey]) {
    expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { activityId: excluded })).toBeNull();
  }
  const rows = (await createOpeningTeachingActivitiesRepository(f.sql).listByOwner(f.scope)).map(row => teachingActivitySchema.parse(row));
  expect(currentCourseActivity(rows, courseId)?.id).toBe(usable);
  expect(pickCurrentTeachingActivity(rows)?.id).toBe(usable);
  expect(courseStudyActivities(rows, courseId).map(row => row.id)).toEqual([usable]);
  expect(await readFootprint()).toEqual(before);
});

it("filters unreadable writing activities across explicit and implicit recovery, course selectors, and teaching activity get/list with zero write side effects", async () => {
  const usableCourseActivity = await activity({ at: "2026-11-01T00:00:00Z" });
  const writing = createOpeningWritingWorkspaceRepository(f.sql);
  const teaching = createOpeningTeachingActivitiesRepository(f.sql);
  const library = createLibraryRepository(f.sql);

  const secretLabel = `B稿-待隐藏-${randomUUID().slice(0, 8)}`;
  const secretSentence = `SECRET_WRITING_RECOVERY_SENTENCE_${randomUUID()}`;
  const secretFeedback = `SECRET_WRITING_RECOVERY_FEEDBACK_${randomUUID()}`;

  const started = await writing.start(f.scope, {
    clientKey: `writing-recovery-filter-${randomUUID()}`,
    title: "课程内写作演练",
    initialText: secretSentence,
    variantLabel: "初稿",
    courseId,
  });
  const writingActivityId = started.activityId!;
  const docInit = started.currentDocumentId;

  const derivedA = await writing.command(f.scope, docInit, {
    action: "derive_variant",
    expectedRevisionNumber: 1,
    variantLabel: "A 稿",
    activityId: writingActivityId,
  });
  const docA = derivedA.workspace.currentDocumentId;

  const derivedB = await writing.command(f.scope, docInit, {
    action: "derive_variant",
    expectedRevisionNumber: 1,
    variantLabel: secretLabel,
    activityId: writingActivityId,
  });
  const docB = derivedB.workspace.currentDocumentId;
  const blockB = derivedB.workspace.currentVariant.focusBlockId!;

  await writing.command(f.scope, docB, {
    action: "record_feedback",
    expectedRevisionNumber: 1,
    targetBlockId: blockB,
    dimension: "argument",
    kind: "feedback",
    suggestionText: secretFeedback,
  });
  await writing.command(f.scope, docB, {
    action: "save_checkpoint",
    activityId: writingActivityId,
    focusBlockId: blockB,
    keptAsPreferred: true,
  });

  // Make the writing activity strictly newer than usableCourseActivity so implicit recovery would select it when readable
  await f.sql`UPDATE opening_teaching_activities SET updated_at='2026-11-05T00:00:00Z' WHERE id=${writingActivityId}`;
  expect(await readOpeningWorkspaceActivityRecovery(f.sql, f.scope)).toMatchObject({
    kind: "writing",
    activityId: writingActivityId,
    courseId,
    documentId: docB,
    variantLabel: secretLabel,
  });

  // Delete pinned target B; surviving A remains readable on its own document entry
  await library.softDeleteDocument({ workspaceId: f.scope.workspaceId, documentId: docB });
  const before = await readFootprint();

  // Explicit target references must fail closed (null / NOT_FOUND) and never substitute usableCourseActivity or docA
  expect(
    await readOpeningWorkspaceActivityRecovery(f.sql, f.scope, { activityId: writingActivityId }),
  ).toBeNull();
  expect(
    await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { activityId: writingActivityId }),
  ).toBeNull();
  expect(await teaching.get(f.scope, writingActivityId)).toBeNull();
  await expect(teaching.assertOwnedActivity(f.scope, writingActivityId)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });

  // Implicit recovery & listing omit the unreadable writing activity and fall back to usableCourseActivity
  const implicitWorkspaceRecovery = await readOpeningWorkspaceActivityRecovery(f.sql, f.scope);
  expect(implicitWorkspaceRecovery).toEqual({
    kind: "course",
    activityId: usableCourseActivity,
    sessionId: null,
    courseId,
  });
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId)).toEqual({
    activityId: usableCourseActivity,
    sessionId: null,
    courseId,
  });
  expect(await readOpeningCurrentLearningRecovery(f.sql, f.scope)).toEqual({
    activityId: usableCourseActivity,
    sessionId: null,
    courseId,
  });

  const listed = (await teaching.listByOwner(f.scope)).map(row => teachingActivitySchema.parse(row));
  expect(listed.map(row => row.id)).toEqual([usableCourseActivity]);
  expect(currentCourseActivity(listed, courseId)?.id).toBe(usableCourseActivity);
  expect(pickCurrentTeachingActivity(listed)?.id).toBe(usableCourseActivity);
  expect(courseStudyActivities(listed, courseId).map(row => row.id)).toEqual([usableCourseActivity]);

  const serialized = JSON.stringify({ implicitWorkspaceRecovery, listed });
  for (const forbidden of [writingActivityId, docB, blockB, secretLabel, secretSentence, secretFeedback]) {
    expect(serialized).not.toContain(forbidden);
  }

  // Surviving A 稿 still opens via its own document entry
  const viewA = await writing.getView(f.scope, docA);
  expect(viewA?.currentDocumentId).toBe(docA);
  expect(await readFootprint()).toEqual(before);
});

it("excludes malformed writing checkpoints and partial manuscript metadata across get, listByOwner, and current/Today recovery while keeping ordinary writing-workgroup clientKey activities readable", async () => {
  const writing = createOpeningWritingWorkspaceRepository(f.sql);
  const teaching = createOpeningTeachingActivitiesRepository(f.sql);

  // GPT #2: Ordinary teaching activity created with clientKey = "writing-workgroup:..." (non-writing protocol, no writingWorkspace checkpoint)
  const ordinaryPrefixed = await teaching.create(f.scope, {
    clientKey: `writing-workgroup:${randomUUID()}`,
    courseId,
    intentKind: "topic",
    intentSummary: "普通主题学习（携带 writing-workgroup 前缀键）",
    createIntent: { intentKind: "topic" },
  });
  await f.sql`UPDATE opening_teaching_activities SET updated_at = '2026-11-01T00:00:00Z' WHERE id = ${ordinaryPrefixed.id}`;

  // GPT #1(a): Writing activity whose checkpoint retains valid activeDocumentId & matching workGroupId, but omits savedRevisionNumber
  const missingRevWorkspace = await writing.start(f.scope, {
    clientKey: `writing-malformed-ckpt-${randomUUID()}`,
    title: "缺版本号的写作活动",
    initialText: "第一段内容。",
    variantLabel: "初稿",
    courseId,
  });
  const missingRevActivityId = missingRevWorkspace.activityId!;
  await f.sql`
    UPDATE opening_teaching_activities
    SET checkpoint_json = jsonb_set(
          checkpoint_json,
          '{writingWorkspace}',
          (checkpoint_json->'writingWorkspace') - 'savedRevisionNumber'
        ),
        updated_at = '2026-11-06T00:00:00Z'
    WHERE id = ${missingRevActivityId}
  `;

  // GPT #1(b): Writing activity with a valid checkpoint, but manuscript metadata in library_properties retains only { workGroupId }
  const partialMetaWorkspace = await writing.start(f.scope, {
    clientKey: `writing-malformed-meta-${randomUUID()}`,
    title: "残缺元数据的写作活动",
    initialText: "第二篇初稿。",
    variantLabel: "初稿",
    courseId,
  });
  const partialMetaActivityId = partialMetaWorkspace.activityId!;
  const partialMetaDocId = partialMetaWorkspace.currentDocumentId;
  await f.sql`
    UPDATE library_properties
    SET value = ${f.sql.json({ workGroupId: partialMetaWorkspace.workGroupId })}
    WHERE workspace_id = ${f.scope.workspaceId}
      AND document_id = ${partialMetaDocId}
      AND key = ${WRITING_META_PROPERTY_KEY}
  `;
  await f.sql`
    UPDATE opening_teaching_activities
    SET updated_at = '2026-11-05T00:00:00Z'
    WHERE id = ${partialMetaActivityId}
  `;

  const before = await readFootprint();

  // Explicit lookups reject both malformed writing rows
  for (const malformedId of [missingRevActivityId, partialMetaActivityId]) {
    expect(await teaching.get(f.scope, malformedId)).toBeNull();
    await expect(teaching.assertOwnedActivity(f.scope, malformedId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { activityId: malformedId }),
    ).toBeNull();
    expect(
      await readOpeningWorkspaceActivityRecovery(f.sql, f.scope, { activityId: malformedId }),
    ).toBeNull();
  }

  // Ordinary activity carrying clientKey = "writing-workgroup:..." remains normally readable across get, listByOwner, and current/Today recovery
  const fetchedOrdinary = await teaching.get(f.scope, ordinaryPrefixed.id);
  expect(fetchedOrdinary?.id).toBe(ordinaryPrefixed.id);
  expect(fetchedOrdinary?.clientKey).toBe(ordinaryPrefixed.clientKey);

  const listed = (await teaching.listByOwner(f.scope)).map(row => teachingActivitySchema.parse(row));
  expect(listed.map(row => row.id)).toEqual([ordinaryPrefixed.id]);
  expect(currentCourseActivity(listed, courseId)?.id).toBe(ordinaryPrefixed.id);
  expect(pickCurrentTeachingActivity(listed)?.id).toBe(ordinaryPrefixed.id);

  // Implicit candidate selection skips both newer malformed writing activities and falls back to ordinaryPrefixed
  expect(await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId)).toEqual({
    activityId: ordinaryPrefixed.id,
    sessionId: null,
    courseId,
  });
  expect(
    await readOpeningCurrentLearningActivity(f.sql, f.scope, courseId, { activityId: ordinaryPrefixed.id }),
  ).toEqual({
    activityId: ordinaryPrefixed.id,
    sessionId: null,
    courseId,
  });
  expect(await readOpeningCurrentLearningRecovery(f.sql, f.scope)).toEqual({
    activityId: ordinaryPrefixed.id,
    sessionId: null,
    courseId,
  });
  expect(await readOpeningWorkspaceActivityRecovery(f.sql, f.scope)).toEqual({
    kind: "course",
    activityId: ordinaryPrefixed.id,
    sessionId: null,
    courseId,
  });

  expect(await readFootprint()).toEqual(before);
});
