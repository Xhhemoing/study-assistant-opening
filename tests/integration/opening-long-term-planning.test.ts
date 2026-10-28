import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { createOpeningLongTermPlanningRepository, createOpeningPlanningSettingsRepository, createOpeningPlansRepository, createLearningGoalInTx,
  readLearningGoal, reserveOpeningLearningActivityBudget, readOpeningLearningCapacity, createCardRepository, writeLearningCardSession } from "@aistudy/database";
import { lockWorkspaceLearningHistory } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { createLongTermMaintenanceService } from "../../apps/web/src/features/opening/planning/long-term-maintenance-service";
import { backupRows } from "./opening-backup-records-fixture";

let f: OpeningFixture;
const date = "2026-11-02", now = new Date(`${date}T09:00:00Z`);
const settings = { weekOneMonday: "2026-09-07", periodTimes: {}, dailyWindow: { start: "08:00", end: "18:00" }, lunch: { start: "12:00", end: "13:00" }, dinner: { start: "18:00", end: "19:00" }, sleep: { start: "23:00", end: "07:00" }, timeZone: "UTC" };
beforeEach(async () => { f = await createOpeningFixture(); await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, settings); });
afterEach(async () => { await f?.close(); });
function repo() { return createOpeningLongTermPlanningRepository(f.sql, () => now); }
async function budget(minutes = 60, expectedRevision = 0) { return repo().command(f.scope, { action: "settings", dailyMinutes: minutes, bufferMinutes: 0, expectedRevision }); }
async function course() {
  const id = randomUUID(); await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${f.scope.workspaceId},'Managed course',${id})`;
  const goal = await f.sql.begin(tx => createLearningGoalInTx(tx, f.scope, { courseIds: [id], title: "Long-term", kind: "custom", targetDate: "2027-01-01", examDate: null,
    weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立完成实际要求", clientKey: randomUUID() }));
  return { id, goal };
}
async function task(courseId: string, minutes = 30) { return createOpeningPlansRepository(f.sql).createTask(f.scope, { courseId, title: "真实课程任务", minutes, dueAt: null, priority: 1, candidateId: null }); }
async function preview() {
  const result = await repo().command(f.scope, { action: "preview", date, expectedAcceptedVersion: 0, expectedBudgetRevision: 1, clientKey: randomUUID() });
  if (!result.draft) throw new Error("Expected executable draft");
  return result.draft;
}
it("allocates two courses under one cap, accepts once, and replays an unknown confirmation after a budget change", async () => {
  const a = await course(), b = await course(); await budget(); await task(a.id); await task(b.id); await task(a.id);
  const draft = await preview();
  expect(draft.blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60000, 0)).toBe(60);
  expect(await f.sql`SELECT * FROM opening_plan_state WHERE workspace_id=${f.scope.workspaceId} AND accepted_version>0`).toHaveLength(0);
  const command = { action: "confirm", draftId: draft.id, expectedBaseVersion: 0, clientKey: randomUUID() };
  const confirmed = await repo().command(f.scope, command); expect(confirmed.draft?.status).toBe("accepted");
  await budget(30, 1);
  expect((await repo().command(f.scope, command)).draft?.id).toBe(draft.id);
  const state = await createOpeningPlansRepository(f.sql).getToday(f.scope, date); expect(state?.blocks).toEqual(draft.blocks);
  expect((await repo().read(f.scope, date)).overcommittedMinutes).toBe(30);
});
it("rejects budget or goal changes between preview and first accept without touching accepted history", async () => {
  const c = await course(); await budget(); await task(c.id); const draft = await preview();
  await repo().lifecycle(f.scope, { goalId: c.goal.id, expectedRevision: c.goal.revision, lifecycle: "paused", acceptedPolicy: "keep" });
  await expect(repo().command(f.scope, { action: "confirm", draftId: draft.id, expectedBaseVersion: 0, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await readLearningGoal(f.sql, f.scope, c.goal.id))?.lifecycle).toBe("paused");
  expect(await f.sql`SELECT * FROM opening_plan_acceptances WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect((await repo().read(f.scope, date)).tasks[0]?.status).toBe("pending");
});
it("serializes concurrent cross-course activity reservations and rolls back the loser", async () => {
  await budget(30);
  const attempt = () => f.sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, f.scope);
    await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId} FOR UPDATE`;
    const id = randomUUID();
    await tx`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,status,intent_kind,intent_summary,client_key,create_intent)
      VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},'active','goal','Budget activity',${randomUUID()},'{}'::jsonb)`;
    await reserveOpeningLearningActivityBudget(tx, f.scope, { activityId: id, minutes: 20 }, now);
    return id;
  });
  const results = await Promise.allSettled([attempt(), attempt()]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect((await readOpeningLearningCapacity(f.sql, f.scope, now)).usedMinutes).toBe(20);
});
it("records a bounded card stop, preserves FSRS facts, and does not invent reviewed cards", async () => {
  await budget(); const card = await createCardRepository(f.sql).createCard({ workspaceId: f.scope.workspaceId, ownerUserId: f.scope.ownerUserId, front: "Q", back: "A" });
  const input = { action: "start", cardIds: [card.id], goalIds: [], budgetMinutes: 10, clientKey: randomUUID() };
  const session = await writeLearningCardSession(f.sql, f.scope, input, now);
  expect((await writeLearningCardSession(f.sql, f.scope, input, now)).activityId).toBe(session.activityId);
  await expect(writeLearningCardSession(f.sql, f.scope, { action: "stop", activityId: session.activityId, expectedRevision: 1, elapsedSeconds: 120, reviewedCardIds: [card.id], reason: "finished" }, new Date(now.getTime() + 180000))).rejects.toMatchObject({ code: "CONFLICT" });
  const stop = { action: "stop", activityId: session.activityId, expectedRevision: 1, elapsedSeconds: 90, reviewedCardIds: [], reason: "pause" };
  expect((await writeLearningCardSession(f.sql, f.scope, stop, new Date(now.getTime() + 180000))).elapsedSeconds).toBe(90);
  expect((await writeLearningCardSession(f.sql, f.scope, stop, new Date(now.getTime() + 180000))).revision).toBe(2);
  expect((await readOpeningLearningCapacity(f.sql, f.scope, now)).usedMinutes).toBe(1.5);
  expect(await f.sql`SELECT id FROM learning_events WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("keeps recovery activity and pending task references paired and deduplicates two activities serving the same task", async () => {
  const a = await course(), b = await course(); await budget(30);
  const otherTask = await task(b.id, 20), linked = await task(a.id, 20);
  const activity = async () => f.sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, f.scope);
    await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE`;
    const id = randomUUID();
    await tx`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,status,intent_kind,intent_summary,client_key,create_intent)
      VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},${a.id},'active','goal','Shared task activity',${randomUUID()},${tx.json({ source: "task", taskId: linked.id })})`;
    await reserveOpeningLearningActivityBudget(tx, f.scope, { activityId: id, minutes: 20 }, now);
    return id;
  });
  await activity(); const second = await activity();
  const overview = await repo().read(f.scope, date);
  expect(overview.committedMinutes).toBe(20);
  expect(overview.recovery).toMatchObject({ activityId: second, taskId: linked.id });
  await expect(repo().recover(f.scope, { action: "continue", activityId: second, taskId: otherTask.id, date, expectedAcceptedVersion: 0, expectedBudgetRevision: 1, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
});
it("does not let one archived linked course block the active course or receive new candidate blocks", async () => {
  const a = await course(), b = await course(); await budget();
  await f.sql`INSERT INTO course_goal_links(workspace_id,goal_id,course_id) VALUES(${f.scope.workspaceId},${a.goal.id},${b.id})`;
  const active = await task(a.id, 20), archived = await task(b.id, 20);
  await f.sql`UPDATE courses SET archived_at=now() WHERE id=${b.id}`;
  const draft = await preview();
  expect(draft.blocks.some(block => block.taskId === active.id)).toBe(true);
  expect(draft.blocks.some(block => block.taskId === archived.id)).toBe(false);
  await repo().command(f.scope, { action: "confirm", draftId: draft.id, expectedBaseVersion: 0, clientKey: randomUUID() });
  expect((await createOpeningPlansRepository(f.sql).getToday(f.scope, date))?.blocks.some(block => block.taskId === active.id)).toBe(true);
});
it("accepts an interval-driven maintenance task, enters the real course route, and shortens it without replacing the original", async () => {
  const c = await course(), rows = backupRows(f.sql, f.scope), sourceId = await rows.source(), chunkId = await rows.chunk(sourceId), requirementId = randomUUID();
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES(${f.scope.workspaceId},${c.id},'source',${sourceId},'core','course')`;
  await repo().lifecycle(f.scope, { goalId: c.goal.id, expectedRevision: 1, lifecycle: "maintenance", maintenanceIntervalDays: 14, acceptedPolicy: "keep" });
  await createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true }).confirm(f.scope, c.id, { expectedRevisions: [], confirmScope: true, requirements: [{
    id: requirementId, stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: "rank-maintenance", title: "秩与零空间", position: 0, mandatory: true,
    goalIds: [c.goal.id], prerequisiteIds: [], sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], origin: "confirmed",
    verification: { kind: "rubric", status: "ready", exerciseKeys: ["saved-rank-question"], rubric: "用列数减秩，说明依据", missingReasons: [] },
  }] });
  await budget(); const draft = await preview();
  expect(draft.suggestedTasks?.some(row => row.key.endsWith(`:maintenance:${c.goal.id}:${requirementId}`))).toBe(true);
  await repo().command(f.scope, { action: "confirm", draftId: draft.id, expectedBaseVersion: 0, clientKey: randomUUID() });
  const pending = (await repo().read(f.scope, date)).maintenanceTasks[0]!;
  const service = createLongTermMaintenanceService(f.sql, { OPENING_TEACHING_COMPILER_ENABLED: "1" });
  const first = await service.start(f.scope, { taskId: pending.taskId, expectedVersion: pending.version, clientKey: randomUUID() });
  expect(first.kind).toBe("ready"); if (first.kind !== "ready") throw new Error(JSON.stringify(first));
  expect(first.activity.courseId).toBe(c.id);
  expect(first.href).toBe(`/opening/courses/${c.id}/study?activity=${first.activity.id}`);
  const again = await service.start(f.scope, { taskId: pending.taskId, expectedVersion: pending.version, clientKey: randomUUID() });
  expect(again.kind === "ready" && again.activity.id).toBe(first.activity.id);
  const [before] = await f.sql`SELECT * FROM opening_teaching_activities WHERE id=${first.activity.id}`;
  const recovery = { action: "shorten", activityId: first.activity.id, taskId: pending.taskId, minutes: 5, date, expectedAcceptedVersion: 1, expectedBudgetRevision: 1, clientKey: randomUUID() };
  const management = createOpeningLongTermPlanningRepository(f.sql, () => now, { compilerEnabled: true });
  const shorter = await management.recover(f.scope, recovery);
  expect("activityId" in shorter && shorter.activityId).not.toBe(first.activity.id);
  expect(shorter).toEqual(await management.recover(f.scope, recovery));
  const [after] = await f.sql`SELECT * FROM opening_teaching_activities WHERE id=${first.activity.id}`;
  expect(after).toEqual(before);
  const created = await f.sql`SELECT create_intent,goal_json FROM opening_teaching_activities WHERE id=${"activityId" in shorter ? shorter.activityId : null}`;
  expect(created[0]!.create_intent.source).toBe("recovery");
  expect(created[0]!.create_intent.protocol).not.toBe("span-lesson-v1");
  expect(created[0]!.goal_json.courseRoute.requirementId).toBe(requirementId);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE kind='compile-teaching-unit' AND workspace_id=${f.scope.workspaceId}`).toHaveLength(2);
});
