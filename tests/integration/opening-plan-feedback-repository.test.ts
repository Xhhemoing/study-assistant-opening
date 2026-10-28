import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository, createOpeningRetestActivityRepository, readOpeningPlanFeedbackSummary } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.reset();
  await f.sql`DELETE FROM opening_tasks WHERE workspace_id IN (${f.scope.workspaceId}, ${f.otherScope.workspaceId})`;
});
afterAll(async () => { await f?.close(); });
const at = "2000-01-01T00:00:00.000Z";
const later = "2099-01-01T00:00:00.000Z";
const createTask = () => createOpeningPlansRepository(f.sql).createTask(f.scope, {
  title: "反馈任务", minutes: 20, priority: 1, dueAt: null, candidateId: null,
});

it.each(["unchanged", "defer", "resume"] as const)("returns the current task for an uppercase UUID when applying %s", async action => {
  const task = await createTask(), plans = createOpeningPlansRepository(f.sql);
  if (action === "resume") await plans.deferTask(f.scope, task.id, { notBefore: later, expectedVersion: 1 });
  const result = await plans.deferTask(f.scope, task.id.toUpperCase(), {
    notBefore: action === "defer" ? later : null,
    expectedVersion: action === "resume" ? 2 : 1,
  });
  expect(result).toMatchObject({ id: task.id, version: action === "unchanged" ? 1 : action === "defer" ? 2 : 3 });
  expect(result.notBefore ?? null).toBe(action === "defer" ? later : null);
});

/** Fail after the real task/retest UPDATE, before the feedback INSERT. */
function failFeedback(sql: Sql): Sql {
  return new Proxy(sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => work(new Proxy(tx, {
      apply(query, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        if (args[0].join("?").includes("INSERT INTO opening_plan_feedback")) throw new Error("injected feedback failure");
        return Reflect.apply(query, thisArg, args);
      },
    })));
  } });
}

it("records server-owned metadata with the resulting version and server time, without an observation", async () => {
  const task = await createTask(), plans = createOpeningPlansRepository(f.sql);
  await f.sql`UPDATE opening_tasks SET origin='planner', requirement_key='req:matrix',
    client_key='planner:2026-10-16:weak_skill:course:hash' WHERE id=${task.id}`;
  const before = Date.now();
  await plans.updateTaskStatus(f.scope, task.id, { status: "skipped", expectedVersion: 1, at, feedback: { reason: "too_hard" } });
  const [event] = await f.sql`SELECT * FROM opening_plan_feedback WHERE task_id=${task.id}`;
  expect(event).toMatchObject({ workspace_id: f.scope.workspaceId, owner_user_id: f.scope.ownerUserId,
    task_id: task.id, task_version: 2, action: "skipped", reason: "too_hard", origin: "planner",
    requirement_key: "req:matrix", suggestion_kind: "weak_skill" });
  expect(new Date(event!.recorded_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
  expect(await f.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});

it("keeps legacy OCC and same-status no-op semantics, including terminal task corrections", async () => {
  const task = await createTask(), plans = createOpeningPlansRepository(f.sql);
  await plans.updateTaskStatus(f.scope, task.id, { status: "done", expectedVersion: 1, at });
  await expect(plans.updateTaskStatus(f.scope, task.id, { status: "done", expectedVersion: 1, at })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await plans.updateTaskStatus(f.scope, task.id, { status: "done", expectedVersion: 2, at })).toMatchObject({ version: 2 });
  await plans.updateTaskStatus(f.scope, task.id, { status: "skipped", expectedVersion: 2, at });
  expect(await f.sql`SELECT action, reason, task_version FROM opening_plan_feedback WHERE task_id=${task.id} ORDER BY task_version`)
    .toEqual([{ action: "done", reason: null, task_version: 2 }, { action: "skipped", reason: null, task_version: 3 }]);
  await expect(plans.deferTask(f.scope, task.id, { notBefore: later, expectedVersion: 3 })).rejects.toMatchObject({ code: "CONFLICT" });
});

it("distinguishes deferral/resumption and ignores unchanged values after checking OCC", async () => {
  const task = await createTask(), plans = createOpeningPlansRepository(f.sql);
  expect(await plans.deferTask(f.scope, task.id, { notBefore: null, expectedVersion: 1 })).toMatchObject({ version: 1 });
  expect(await plans.deferTask(f.scope, task.id, { notBefore: later, expectedVersion: 1, feedback: { reason: "time_short" } })).toMatchObject({ version: 2, notBefore: later });
  expect(await plans.deferTask(f.scope, task.id, { notBefore: later, expectedVersion: 2 })).toMatchObject({ version: 2 });
  await expect(plans.deferTask(f.scope, task.id, { notBefore: later, expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  await plans.deferTask(f.scope, task.id, { notBefore: null, expectedVersion: 2 });
  expect(await f.sql`SELECT action, reason FROM opening_plan_feedback WHERE task_id=${task.id} ORDER BY task_version`)
    .toEqual([{ action: "deferred", reason: "time_short" }, { action: "resumed", reason: null }]);
});

it.each(["done", "deferred"] as const)("rolls back the real task mutation if %s feedback cannot be saved", async action => {
  const task = await createTask(), plans = createOpeningPlansRepository(failFeedback(f.sql));
  await expect(action === "done"
    ? plans.updateTaskStatus(f.scope, task.id, { status: "done", expectedVersion: 1, at })
    : plans.deferTask(f.scope, task.id, { notBefore: later, expectedVersion: 1 })).rejects.toThrow("injected feedback failure");
  expect((await createOpeningPlansRepository(f.sql).listTasks(f.scope))[0]).toMatchObject({ status: "pending", version: 1 });
  expect((await createOpeningPlansRepository(f.sql).listTasks(f.scope))[0]).not.toHaveProperty("notBefore");
  expect(await f.sql`SELECT id FROM opening_plan_feedback WHERE task_id=${task.id}`).toHaveLength(0);
});

it("rolls back a linked retest transition and keeps its projection on deferral", async () => {
  const task = await createTask(), courseId = randomUUID(), candidateId = randomUUID();
  await f.sql`INSERT INTO courses(id, workspace_id, title, slug) VALUES (${courseId}, ${f.scope.workspaceId}, 'Feedback retest', ${courseId})`;
  await f.sql`INSERT INTO opening_jobs(id, workspace_id, owner_user_id, key, kind, payload, state, privacy_epoch)
    VALUES (${candidateId}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, ${`retest:${candidateId}`}, 'retest',
      ${f.sql.json({ prompt: "Try again" })}, 'succeeded', 0)`;
  const activities = createOpeningRetestActivityRepository(f.sql);
  const activity = await activities.createProposed(f.scope, { activityId: randomUUID(), cycleId: randomUUID(),
    taskId: task.id, candidateId, courseId, skillLabel: "matrix", requirementKey: null,
    proposedAt: at, recommendedAt: at, notBeforeAt: null, scheduledStartAt: null, deadlineAt: null });
  await activities.accept(f.scope, activity.activityId, task.id, at);
  await expect(createOpeningPlansRepository(failFeedback(f.sql)).updateTaskStatus(f.scope, task.id,
    { status: "done", expectedVersion: 1, at })).rejects.toThrow("injected feedback failure");
  expect(await f.sql`SELECT status FROM opening_retest_activities WHERE id=${activity.activityId}`).toEqual([{ status: "accepted" }]);
  expect(await createOpeningPlansRepository(f.sql).deferTask(f.scope, task.id, { notBefore: later, expectedVersion: 1 }))
    .toMatchObject({ retest: { activityId: activity.activityId } });
});

it("matches a hand-counted half-open window, keeps missing/declined reasons distinct and excludes foreign events", async () => {
  const plans = createOpeningPlansRepository(f.sql);
  const [skip, missing, declined, hard, atEnd, beforeStart] = await Promise.all(Array.from({ length: 6 }, createTask));
  await plans.updateTaskStatus(f.scope, skip!.id, { status: "skipped", expectedVersion: 1, at, feedback: { reason: "time_short" } });
  await plans.deferTask(f.scope, missing!.id, { notBefore: later, expectedVersion: 1 });
  await plans.deferTask(f.scope, declined!.id, { notBefore: later, expectedVersion: 1, feedback: { reason: "prefer_not_say" } });
  await plans.deferTask(f.scope, hard!.id, { notBefore: later, expectedVersion: 1, feedback: { reason: "too_hard" } });
  await plans.deferTask(f.scope, hard!.id, { notBefore: null, expectedVersion: 2 });
  await plans.updateTaskStatus(f.scope, atEnd!.id, { status: "done", expectedVersion: 1, at });
  await plans.updateTaskStatus(f.scope, beforeStart!.id, { status: "skipped", expectedVersion: 1, at, feedback: { reason: "other" } });
  await f.sql`UPDATE opening_plan_feedback SET recorded_at='2026-10-12T12:00:00Z' WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`UPDATE opening_plan_feedback SET recorded_at='2026-10-10T00:00:00Z' WHERE task_id=${skip!.id}`;
  await f.sql`UPDATE opening_plan_feedback SET recorded_at='2026-10-17T00:00:00Z' WHERE task_id=${atEnd!.id}`;
  await f.sql`UPDATE opening_plan_feedback SET recorded_at='2026-10-09T23:59:59Z' WHERE task_id=${beforeStart!.id}`;
  const foreign = await plans.createTask(f.otherScope, { title: "Foreign", minutes: 20, priority: 1, dueAt: null, candidateId: null });
  await plans.updateTaskStatus(f.otherScope, foreign.id, { status: "done", expectedVersion: 1, at });
  await f.sql`UPDATE opening_plan_feedback SET recorded_at='2026-10-12T12:00:00Z' WHERE task_id=${foreign.id}`;
  const summary = await readOpeningPlanFeedbackSummary(f.sql, f.scope, new Date("2026-10-10T00:00:00Z"), new Date("2026-10-17T00:00:00Z"));
  expect(summary.actions).toEqual({ done: 0, skipped: 1, deferred: 3, resumed: 1 });
  expect(summary.reasons).toEqual({ eligible: 4, supplied: 2, declined: 1, missing: 1, coverage: 0.5,
    counts: { time_short: 1, too_hard: 1, too_easy: 0, not_relevant: 0, other: 0 } });
});

it("returns NOT_FOUND for foreign tasks and isolates feedback summaries", async () => {
  const task = await createTask(), plans = createOpeningPlansRepository(f.sql);
  await expect(plans.updateTaskStatus(f.otherScope, task.id, { status: "done", expectedVersion: 1, at })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(plans.deferTask(f.otherScope, task.id, { notBefore: later, expectedVersion: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await plans.updateTaskStatus(f.scope, task.id, { status: "done", expectedVersion: 1, at });
  const summary = await readOpeningPlanFeedbackSummary(f.sql, f.otherScope, new Date(0), new Date(later));
  expect(summary.actions).toEqual({ done: 0, skipped: 0, deferred: 0, resumed: 0 });
  expect(summary.reasons.coverage).toBeNull();
});
