import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningStudyPlansRepository,
  createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository,
} from "@aistudy/database";
import { addLocalDays, localDateKeyInZone } from "@aistudy/domain";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET as getStudyPlan, PUT as putStudyPlan } from "../../../apps/web/src/app/api/opening/courses/[id]/study-plan/route";
import { GET as getToday } from "../../../apps/web/src/app/api/opening/today/route";
import { GET as listTasks } from "../../../apps/web/src/app/api/opening/tasks/route";
import { PUT as putSettings } from "../../../apps/web/src/app/api/opening/planning-settings/route";
import { buildSeedSettings } from "../../../apps/web/src/features/opening/planning/seed-today-plan";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";

let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
const TZ = "Asia/Shanghai";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown, url = "https://localhost/api/opening/x") =>
  new Request(url, { method, headers: { cookie: f.cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const day0 = () => localDateKeyInZone(new Date(), TZ);

beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
beforeEach(async () => {
  await f.reset();
  await f.sql`TRUNCATE opening_teaching_activity_specs, opening_teaching_units, opening_teaching_activities, opening_learning_observations,
    opening_learning_attempts, opening_learning_sessions, library_blocks, library_revisions, library_documents RESTART IDENTITY CASCADE`;
  await f.sql`DELETE FROM opening_tasks WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM courses WHERE workspace_id IN (${f.scope.workspaceId}, ${f.otherScope.workspaceId})`;
  await f.sql`UPDATE workspace_preferences SET adaptive_planning=NULL WHERE workspace_id=${f.scope.workspaceId}`;
});
afterAll(async () => {
  setAuthRuntimeForTests(null); await runtime?.close();
  if (f) { await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`; await f.close(); }
});

/** Six slides with headings; ~1400 characters each, so two make a lesson. */
async function seedCourse() {
  const courseId = randomUUID(), sourceId = randomUUID();
  await f.sql`INSERT INTO courses (id, workspace_id, title, slug) VALUES (${courseId}, ${f.scope.workspaceId}, 'Math I', ${courseId})`;
  await f.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${f.scope.workspaceId}, 'unit8.pdf', 'application/pdf', 10, ${"b".repeat(64)}, 1, 'uploaded', 'ready')`;
  const headings = ["Jacobian", "Inverse Function Theorem", "Implicit Function Theorem", "Local Extrema", "Hessian Matrix", "Lagrange Multipliers"];
  const chunks: string[] = [];
  for (const [i, heading] of headings.entries()) {
    const [row] = await f.sql`INSERT INTO opening_source_chunks (source_id, source_version, page, text)
      VALUES (${sourceId}, 1, ${i + 1}, ${`${heading}\n${"theorem statement and example ".repeat(45)}`}) RETURNING id`;
    chunks.push(String(row!.id));
  }
  await f.sql`INSERT INTO course_asset_memberships (course_id, workspace_id, asset_type, asset_id, role, sort_order, visibility)
    VALUES (${courseId}, ${f.scope.workspaceId}, 'source', ${sourceId}, 'core', 0, 'private')`;
  await putSettings(req("PUT", buildSeedSettings(new Date())));
  return { courseId, sourceId, chunks };
}

type Task = { id: string; title: string; status: string; priority: number; studyPlan?: { kind: string; localDate: string; lessonNumbers: number[] } };
async function planTasks(date: string): Promise<Task[]> {
  const body = await (await listTasks(req("GET"))).json() as { tasks: Task[] };
  return body.tasks.filter((task) => task.studyPlan?.localDate === date).sort((a, b) => b.priority - a.priority);
}
const openToday = (date: string) => getToday(req("GET", undefined, `https://localhost/api/opening/today?date=${date}`));

/** A completed lesson for `taskId` that cited `chunkIds`, finished on `date`. */
async function completeLesson(courseId: string, sourceId: string, taskId: string, chunkIds: string[], date: string, wrong?: string) {
  const activities = createOpeningTeachingActivitiesRepository(f.sql);
  const activity = await activities.create(f.scope, { clientKey: `task:${taskId}`, intentKind: "goal", intentSummary: "lesson", courseId, sourceIds: [sourceId], createIntent: { intentKind: "goal", source: "task", taskId } });
  const content = createOpeningTeachingContentRepository(f.sql);
  const question = randomUUID();
  const unit = await content.createUnit(f.scope, { title: "lesson", blocks: [{ id: randomUUID(), type: "text", content: { text: "讲解" } }, { id: question, type: "prompt", content: { text: "题", citedChunkIds: [chunkIds[0]] } }] });
  await content.publishActivitySpec(f.scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0, revisionNumber: unit.currentRevisionNumber, expectedRevisionNumber: unit.currentRevisionNumber,
    blockOrder: [{ blockId: question, position: 0, blockType: "prompt", role: "prompt" as const }],
    sourceRefs: chunkIds.map((chunkId) => ({ sourceId, version: 1, chunkId })) });
  if (wrong) {
    const learning = createOpeningLearningRepository(f.sql);
    const session = await learning.createSession(f.scope, { activityId: activity.id, courseId, sourceIds: [sourceId], skillLabel: "lesson" });
    const attempt = await createOpeningLearningAttemptRepository(f.sql).create(f.scope, { sessionId: session.id, clientKey: `attempt-${randomUUID()}`, teachingBlock: { blockId: question, contentVersion: 1 }, problem: { sourceId, stemSnapshot: wrong, artifactKind: "reference_item" } });
    await learning.insertObservation(f.scope, { sessionId: session.id, attemptId: attempt.id, courseId, skillLabel: "lesson", sourceIds: [sourceId], answer: "原答案", outcome: "incorrect", assistance: "independent", clientKey: `answer-${randomUUID()}` });
    await f.sql`UPDATE opening_learning_attempts SET started_at=${`${date}T10:05:00+08:00`} WHERE id=${attempt.id}`;
  }
  await activities.setStatus(f.scope, activity.id, { status: "completed" });
  await f.sql`UPDATE opening_teaching_activities SET created_at=${`${date}T10:00:00+08:00`}, updated_at=${`${date}T11:00:00+08:00`} WHERE id=${activity.id}`;
  return activity.id;
}

describe("course study plan", () => {
  it("splits the material into lessons and shows when each is taught; foreign courses are refused", async () => {
    const { courseId } = await seedCourse();
    const empty = await (await getStudyPlan(req("GET"), ctx(courseId))).json();
    expect(empty).toMatchObject({ plan: null, noMaterial: false });
    expect(empty.lessons.map((l: { title: string; pageFrom: number; pageTo: number }) => [l.title, l.pageFrom, l.pageTo])).toEqual([
      ["Jacobian · Inverse Function Theorem", 1, 2], ["Implicit Function Theorem · Local Extrema", 3, 4], ["Hessian Matrix · Lagrange Multipliers", 5, 6],
    ]);
    const saved = await putStudyPlan(req("PUT", { plan: { lessonsPerDay: 2, lessonMinutes: 45, startDate: day0() }, targetDate: day0() }), ctx(courseId));
    expect(saved.status).toBe(200);
    const view = await saved.json();
    expect(view.lessons.map((l: { status: string; date: string }) => [l.status, l.date])).toEqual([
      ["today", day0()], ["today", day0()], ["planned", addLocalDays(day0(), 1)],
    ]);
    expect(view).toMatchObject({ behind: true, finishDate: addLocalDays(day0(), 1) });
    const foreign = randomUUID();
    await f.sql`INSERT INTO courses (id, workspace_id, title, slug) VALUES (${foreign}, ${f.otherScope.workspaceId}, 'Other', ${foreign})`;
    expect((await getStudyPlan(req("GET"), ctx(foreign))).status).toBe(403);
    expect((await putStudyPlan(req("PUT", { plan: { lessonsPerDay: 2, lessonMinutes: 45, startDate: day0() }, targetDate: null }), ctx(foreign))).status).toBe(403);
  });

  it("opening Today adds the day's lessons once, in material order, and later days put review and mistakes first", async () => {
    const { courseId, sourceId, chunks } = await seedCourse();
    const d1 = day0(), d2 = addLocalDays(d1, 1);
    await putStudyPlan(req("PUT", { plan: { lessonsPerDay: 2, lessonMinutes: 45, startDate: d1 }, targetDate: null }), ctx(courseId));
    expect((await (await openToday(d1)).json()).planTasksAdded).toBe(2);
    expect((await (await openToday(d1)).json()).planTasksAdded).toBeUndefined();
    const first = await planTasks(d1);
    expect(first.map((t) => [t.title, t.studyPlan?.kind, t.studyPlan?.lessonNumbers])).toEqual([
      ["Math I · 第 1 课：Jacobian · Inverse Function Theorem（第 1–2 页）", "lesson", [1]],
      ["Math I · 第 2 课：Implicit Function Theorem · Local Extrema（第 3–4 页）", "lesson", [2]],
    ]);
    // The lesson compiler gets exactly the task's pages for the chain's first lesson.
    const plans = createOpeningStudyPlansRepository(f.sql);
    const lessonOne = await completeLesson(courseId, sourceId, first[0]!.id, chunks.slice(0, 2), d1, "求雅可比行列式");
    expect(await plans.activityPlanSlot(f.scope, lessonOne)).toMatchObject({ kind: "lesson", chunkIds: chunks.slice(0, 2) });
    expect(await plans.activityPlanSlot(f.otherScope, lessonOne)).toBeNull();
    await f.sql`UPDATE opening_tasks SET status='done' WHERE id=${first[0]!.id}`;
    // Lesson 2 was not done: it carries over and is not issued again.
    expect((await (await openToday(d2)).json()).planTasksAdded).toBe(1);
    const second = await planTasks(d2);
    expect(second).toHaveLength(1);
    expect(second[0]!.title).toBe("Math I · 复习：第 1 课 + 1 道错题");
    const [slot] = await f.sql`SELECT plan_slot FROM opening_tasks WHERE id=${second[0]!.id}`;
    expect(slot!.plan_slot).toMatchObject({ kind: "review", lessonIndexes: [0], chunkIds: [chunks[0], chunks[1]] });
    expect(slot!.plan_slot.note).toContain("求雅可比行列式");
  });

  it("stopping the plan stops new lessons; tasks already issued stay", async () => {
    const { courseId } = await seedCourse();
    const d1 = day0();
    await putStudyPlan(req("PUT", { plan: { lessonsPerDay: 1, lessonMinutes: 30, startDate: d1 }, targetDate: null }), ctx(courseId));
    await openToday(d1);
    const stopped = await (await putStudyPlan(req("PUT", { plan: null, targetDate: null }), ctx(courseId))).json();
    expect(stopped.plan).toBeNull();
    expect((await (await openToday(addLocalDays(d1, 1))).json()).planTasksAdded).toBeUndefined();
    expect(await planTasks(d1)).toHaveLength(1);
  });
});
