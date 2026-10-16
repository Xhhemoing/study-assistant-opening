import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { acceptOpeningPlan, createOpeningAdaptivePrefsRepository, createOpeningPlansRepository, createOpeningPlanningSettingsRepository,
  createOpeningTeachingActivitiesRepository, readOpeningCoachAcceptance, readOpeningLearnerSnapshotBase, undoOpeningCoachPlan } from "@aistudy/database";
import type { CoachPlanUndoInput, PlannedBlock, SuggestedTask } from "@aistudy/contracts";
import { suggestionIdentity, suggestionKey } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

let f: OpeningFixture;
const day = "2026-10-21", now = new Date(`${day}T08:00:00Z`);
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.sql`DELETE FROM opening_plan_drafts WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_plan_state WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_tasks WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`UPDATE workspace_preferences SET adaptive_planning=NULL WHERE workspace_id=${f.scope.workspaceId}`;
});
afterAll(async () => { await f?.close(); });
const block = (taskId: string, index: number, minutes: number): PlannedBlock => ({ taskId,
  start: new Date(Date.parse(`${day}T09:00:00Z`) + index * 30 * 60_000).toISOString(),
  end: new Date(Date.parse(`${day}T09:00:00Z`) + (index * 30 + minutes) * 60_000).toISOString(), reason: "规则草案" });

async function seed(enabled: boolean | null = true) {
  const source = await backupRows(f.sql, f.scope).source(); await backupRows(f.sql, f.scope).chunk(source);
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${f.scope.workspaceId},'Coach course',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
    VALUES (${randomUUID()},${f.scope.workspaceId},${courseId},'source',${source},'core',0,'course')`;
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, { weekOneMonday: "2026-10-19", timeZone: "Etc/UTC",
    periodTimes: { "1": { start: "13:00", end: "13:45" } }, dailyWindow: { start: "08:00", end: "12:00" },
    lunch: { start: "12:00", end: "13:00" }, dinner: { start: "17:30", end: "18:30" }, sleep: { start: "23:00", end: "07:00" } });
  await createOpeningAdaptivePrefsRepository(f.sql).patch(f.scope, { autonomy: "coach", coachBudgetMinutes: 60,
    ...(enabled === null ? {} : { coachAutoAcceptEnabled: enabled }) });
  const task = await createOpeningPlansRepository(f.sql).createTask(f.scope, { title: "原有任务", minutes: 20, dueAt: null, priority: 1, candidateId: null });
  const suggestion: SuggestedTask = { id: randomUUID(), key: suggestionKey(day, suggestionIdentity("weak_skill", courseId, "矩阵乘法")), kind: "weak_skill",
    title: "矩阵乘法讲练", minutes: 25, courseId, skillLabel: "矩阵乘法", reasonCode: "weak_skill", reason: "核对与练习" };
  const blocks = [block(task.id, 0, 20), block(suggestion.id, 1, 25)], draftId = randomUUID(), clientKey = randomUUID();
  const materials = Object.fromEntries((await readOpeningLearnerSnapshotBase(f.sql, f.scope)).courses.map(course => [course.courseId, course.materialRevision ?? ""]));
  await f.sql`INSERT INTO opening_plan_drafts(id,workspace_id,owner_user_id,day,base_version,blocks,unscheduled_task_ids,input_snapshot,
    hard_blocks_fingerprint,origin,suggested_tasks,strategy_version) VALUES (${draftId},${f.scope.workspaceId},${f.scope.ownerUserId},${day}::date,0,
      ${f.sql.json(blocks)},'[]'::jsonb,${f.sql.json({ tasks: [task], autoDraft: true, courseMaterialRevisions: materials })},'',
      'auto_draft',${f.sql.json([suggestion])},'adaptive-2')`;
  const accept = (sql: Sql = f.sql) => acceptOpeningPlan(sql, f.scope, { draftId, expectedBaseVersion: 0, clientKey }, now, { source: "coach", expectedDraftVersion: 0 });
  const undo: CoachPlanUndoInput = { date: day, acceptanceClientKey: clientKey, expectedAcceptedVersion: 1, clientKey: `undo:${clientKey}` };
  const start = (sql: Sql = f.sql) => createOpeningTeachingActivitiesRepository(sql).create(f.scope, { clientKey: `task:${suggestion.id}`, intentKind: "topic",
    intentSummary: suggestion.title, courseId, sourceIds: [source], createIntent: { source: "task", taskId: suggestion.id } });
  return { task, suggestion, draftId, clientKey, accept, undo, start };
}

it("automatically accepts once and undoes only untouched newly-created tasks without learner feedback", async () => {
  const seeded = await seed(); await seeded.accept();
  expect((await readOpeningCoachAcceptance(f.sql, f.scope, day, now))?.undoAvailable).toBe(true);
  await createOpeningAdaptivePrefsRepository(f.sql).patch(f.scope, { autonomy: "manual" });
  await seeded.accept(); // Exact receipt replay is valid after permission closes.
  const result = await undoOpeningCoachPlan(f.sql, f.scope, seeded.undo, now);
  expect(result).toMatchObject({ acceptedVersion: 2, blocks: [], closedTaskIds: [seeded.suggestion.id], replayed: false });
  expect(await undoOpeningCoachPlan(f.sql, f.scope, seeded.undo, now)).toEqual({ ...result, replayed: true });
  await expect(undoOpeningCoachPlan(f.sql, f.scope, { ...seeded.undo, expectedAcceptedVersion: 2 }, now)).rejects.toMatchObject({ code: "CONFLICT" });
  const rows = await f.sql`SELECT id,status,version,close_source FROM opening_tasks WHERE id IN (${seeded.task.id},${seeded.suggestion.id}) ORDER BY id`;
  expect(rows).toContainEqual({ id: seeded.task.id, status: "pending", version: 1, close_source: null });
  expect(rows).toContainEqual({ id: seeded.suggestion.id, status: "skipped", version: 2, close_source: "system" });
  expect(await f.sql`SELECT id FROM opening_plan_feedback WHERE task_id=${seeded.suggestion.id}`).toHaveLength(0);
  await expect(seeded.start()).rejects.toMatchObject({ code: "CONFLICT" });
});

it.each([false, null])("keeps historical/unenabled coach preferences advisory (%s)", async enabled => {
  const seeded = await seed(enabled);
  await expect(seeded.accept()).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_tasks WHERE id=${seeded.suggestion.id}`).toHaveLength(0);
});

it.each(["start", "defer", "done", "time"] as const)("refuses undo after %s without half-closing tasks", async mutation => {
  const seeded = await seed(); await seeded.accept();
  if (mutation === "start") await seeded.start();
  if (mutation === "defer") await createOpeningPlansRepository(f.sql).deferTask(f.scope, seeded.suggestion.id, { expectedVersion: 1, notBefore: "2026-10-22T00:00:00Z" });
  if (mutation === "done") await createOpeningPlansRepository(f.sql).updateTaskStatus(f.scope, seeded.suggestion.id, { expectedVersion: 1, status: "done", at: now.toISOString() });
  await expect(undoOpeningCoachPlan(f.sql, f.scope, seeded.undo, mutation === "time" ? new Date(`${day}T09:00:00Z`) : now)).rejects.toMatchObject({ code: "CONFLICT" });
  const [state] = await f.sql`SELECT accepted_version FROM opening_plan_state WHERE workspace_id=${f.scope.workspaceId} AND day=${day}::date`;
  expect(Number(state?.accepted_version)).toBe(1);
  const [manual] = await f.sql`SELECT status,version FROM opening_tasks WHERE id=${seeded.task.id}`;
  expect(manual).toEqual({ status: "pending", version: 1 });
});

it("rejects a forged creation map and a foreign undo scope", async () => {
  const seeded = await seed(); await seeded.accept();
  await f.sql`UPDATE opening_plan_acceptances SET created_task_versions=${f.sql.json({ [seeded.task.id]: 1, [seeded.suggestion.id]: 1 })}
    WHERE workspace_id=${f.scope.workspaceId} AND client_key=${seeded.clientKey}`;
  await expect(undoOpeningCoachPlan(f.sql, f.scope, seeded.undo, now)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(undoOpeningCoachPlan(f.sql, f.otherScope, seeded.undo, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("requires manual confirmation for an existing card review task or active task learning", async () => {
  const seeded = await seed();
  const cardKey = suggestionKey(day, suggestionIdentity("review_cards", null, null));
  await f.sql`UPDATE opening_tasks SET origin='planner',client_key=${cardKey} WHERE id=${seeded.task.id}`;
  await expect(seeded.accept()).rejects.toMatchObject({ code: "CONFLICT" });
  await f.sql`UPDATE opening_tasks SET origin='manual',client_key=NULL WHERE id=${seeded.task.id}`;
  await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, { clientKey: `task:${seeded.task.id}`, intentKind: "topic", intentSummary: "学习原任务",
    createIntent: { source: "task", taskId: seeded.task.id } });
  await expect(seeded.accept()).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_tasks WHERE id=${seeded.suggestion.id}`).toHaveLength(0);
});

function beforeCommit(sql: Sql) {
  let release = () => undefined as void, enter = () => undefined as void;
  const opened = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const gated = new Proxy(sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => { const result = await work(tx); enter(); await gate; return result; });
  } });
  return { sql: gated, opened, release };
}

it.each(["undo", "start"] as const)("serializes %s first against the competing learning/undo transaction", async first => {
  const seeded = await seed(); await seeded.accept();
  const a = await openRaceSession().ready, b = await openRaceSession().ready, barrier = beforeCommit(a.sql);
  const winner = track<unknown>(first === "undo" ? undoOpeningCoachPlan(barrier.sql, f.scope, seeded.undo, now) : seeded.start(barrier.sql));
  const pending: Promise<unknown>[] = [winner];
  try {
    await Promise.race([barrier.opened, winner.then(() => { throw new Error("transaction bypassed the commit barrier"); })]);
    const loser = track<unknown>(first === "undo" ? seeded.start(b.sql) : undoOpeningCoachPlan(b.sql, f.scope, seeded.undo, now));
    pending.push(loser);
    await waitUntilBlocked(f.sql, b.pid, a.pid, `coach ${first} first`);
    barrier.release(); await winner;
    await expect(loser).rejects.toMatchObject({ code: "CONFLICT" });
  } finally { barrier.release(); await Promise.allSettled(pending); await closeRace(b.sql); await closeRace(a.sql); }
}, 15_000);

it.each(["coach", "learner"] as const)("commits only one acceptance when %s wins the real confirmation race", async first => {
  const seeded = await seed();
  const a = await openRaceSession().ready, b = await openRaceSession().ready, barrier = beforeCommit(a.sql);
  const manual = (sql: Sql) => acceptOpeningPlan(sql, f.scope, { draftId: seeded.draftId, expectedBaseVersion: 0, clientKey: `learner:${seeded.clientKey}` }, now);
  const winner = track(first === "coach" ? seeded.accept(barrier.sql) : manual(barrier.sql));
  const pending: Promise<unknown>[] = [winner];
  try {
    await Promise.race([barrier.opened, winner.then(() => { throw new Error("transaction bypassed the commit barrier"); })]);
    const loser = track(first === "coach" ? manual(b.sql) : seeded.accept(b.sql));
    pending.push(loser);
    await waitUntilBlocked(f.sql, b.pid, a.pid, `coach/learner ${first} first`);
    barrier.release(); await winner;
    await expect(loser).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT client_key FROM opening_plan_acceptances WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
    expect(await f.sql`SELECT id FROM opening_tasks WHERE id=${seeded.suggestion.id}`).toHaveLength(1);
  } finally { barrier.release(); await Promise.allSettled(pending); await closeRace(b.sql); await closeRace(a.sql); }
}, 15_000);

const taskRaces = (["done", "defer"] as const).flatMap(action => (["undo", "mutation"] as const).map(first => ({ action, first })));
it.each(taskRaces)("serializes undo against $action with $first winning", async ({ action, first }) => {
  const seeded = await seed(); await seeded.accept();
  const a = await openRaceSession().ready, b = await openRaceSession().ready, barrier = beforeCommit(a.sql);
  const mutate = (sql: Sql) => action === "done"
    ? createOpeningPlansRepository(sql).updateTaskStatus(f.scope, seeded.suggestion.id, { status: "done", expectedVersion: 1, at: now.toISOString() })
    : createOpeningPlansRepository(sql).deferTask(f.scope, seeded.suggestion.id, { notBefore: "2026-10-22T00:00:00Z", expectedVersion: 1 });
  const winner = track<unknown>(first === "undo" ? undoOpeningCoachPlan(barrier.sql, f.scope, seeded.undo, now) : mutate(barrier.sql));
  const pending: Promise<unknown>[] = [winner];
  try {
    await Promise.race([barrier.opened, winner.then(() => { throw new Error("transaction bypassed the commit barrier"); })]);
    const loser = track<unknown>(first === "undo" ? mutate(b.sql) : undoOpeningCoachPlan(b.sql, f.scope, seeded.undo, now));
    pending.push(loser);
    await waitUntilBlocked(f.sql, b.pid, a.pid, `undo/${action} ${first} first`);
    barrier.release(); await winner;
    await expect(loser).rejects.toMatchObject({ code: "CONFLICT" });
    const [task] = await f.sql`SELECT status,version,close_source FROM opening_tasks WHERE id=${seeded.suggestion.id}`;
    expect(Number(task?.version)).toBe(2);
    expect(task?.close_source).toBe(first === "undo" ? "system" : action === "done" ? "learner" : null);
  } finally { barrier.release(); await Promise.allSettled(pending); await closeRace(b.sql); await closeRace(a.sql); }
}, 15_000);
