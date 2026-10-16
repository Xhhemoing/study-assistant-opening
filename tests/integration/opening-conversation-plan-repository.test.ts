import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { DEFAULT_OPENING_PLANNING_SETTINGS, type ConversationPlanMetadata, type PlanDraft } from "@aistudy/contracts";
import { createOpeningPlansRepository, createOpeningPlanningSettingsRepository, readOpeningConversationPlanningContext } from "@aistudy/database";
import { createConversationPlanService } from "../../apps/web/src/features/opening/planning/conversation-plan-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { insertCandidate, insertOwnedConversation, insertTurn } from "./opening-memory-candidate-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";

let f: OpeningFixture;
const date = "2026-10-16", now = new Date(`${date}T10:00:00.000Z`);
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.reset();
  await f.sql`DELETE FROM opening_plan_acceptances WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_plan_drafts WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_plan_state WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_tasks WHERE workspace_id=${f.scope.workspaceId}`;
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, { ...DEFAULT_OPENING_PLANNING_SETTINGS, timeZone: "UTC", weekOneMonday: "2026-10-12" });
});
afterAll(async () => { await f?.close(); });
async function pending(input: { minutes?: number | null; sourceId?: string; dueText?: string; title?: string } = {}) {
  const conversationId = await insertOwnedConversation(f.sql, f.scope);
  const sourceIds = input.sourceId ? [input.sourceId] : [];
  const sourceTurnId = await insertTurn(f.sql, f.scope, conversationId, { sourceIds });
  return insertCandidate(f.sql, f.scope, { conversationId, sourceTurnId, sourceIds,
    payload: { kind: "task", title: input.title ?? "对话练习", minutes: input.minutes === undefined ? 20 : input.minutes, dueText: input.dueText ?? "下周" } });
}
async function propose(id: string, extra: Record<string, unknown> = {}, sql = f.sql) {
  return createConversationPlanService(sql, { now: () => now }).propose(f.scope, { candidateId: id, expectedVersion: 0, date,
    expectedAcceptedVersion: 0, clientKey: `proposal:${id}`, courseId: null, ...extra });
}
function accept(draft: PlanDraft, sql = f.sql) {
  return createOpeningPlansRepository(sql, { now: () => now }).acceptPlan(f.scope, {
    draftId: draft.id, expectedBaseVersion: draft.baseVersion, clientKey: `accept:${draft.id}`,
  });
}
async function draftFor(id: string) {
  const result = await propose(id); expect(result.kind).toBe("draft");
  if (result.kind !== "draft") throw new Error("expected a conversation draft");
  return result.draft;
}
it("preserves accepted history and future blocks, then creates and consumes one agent task only on confirmation", async () => {
  const repo = createOpeningPlansRepository(f.sql);
  const historical = await repo.createTask(f.scope, { title: "已错过", minutes: 20, priority: 0, dueAt: null, candidateId: null });
  const future = await repo.createTask(f.scope, { title: "保留", minutes: 20, priority: 0, dueAt: null, candidateId: null });
  const baseline = [{ taskId: historical.id, start: `${date}T09:00:00.000Z`, end: `${date}T09:20:00.000Z`, reason: "历史" },
    { taskId: future.id, start: `${date}T15:00:00.000Z`, end: `${date}T15:20:00.000Z`, reason: "已确认" }];
  await f.sql`INSERT INTO opening_plan_state(workspace_id,day,accepted_version,accepted_blocks,hard_blocks_fingerprint)
    VALUES(${f.scope.workspaceId},${date}::date,1,${f.sql.json(baseline)},'')`;
  const id = await pending(), result = await propose(id, { expectedAcceptedVersion: 1 });
  expect(result.kind).toBe("draft"); if (result.kind !== "draft") return;
  expect(result.draft.origin).toBe("agent"); expect(result.draft.blocks).toEqual(expect.arrayContaining(baseline));
  expect(result.draft.blocks.filter(block => block.taskId === historical.id)).toHaveLength(1);
  expect(await f.sql`SELECT id FROM opening_tasks WHERE candidate_id=${id}`).toHaveLength(0);
  const accepted = await accept(result.draft); expect(accepted.status).toBe("accepted");
  const [task] = await f.sql`SELECT id,origin,due_at,due_text FROM opening_tasks WHERE candidate_id=${id}`;
  expect(task).toMatchObject({ origin: "agent", due_at: null, due_text: "下周" });
  const [candidate] = await f.sql`SELECT status,task_result_ref FROM opening_assistant_candidates WHERE id=${id}`;
  expect(candidate).toMatchObject({ status: "accepted", task_result_ref: { kind: "task", id: task!.id } });
  expect((await accept(result.draft)).id).toBe(accepted.id);
  const direct = await repo.createTask(f.scope, { title: "旧入口", minutes: 20, priority: 0, dueAt: null, candidateId: id });
  expect(direct.id).toBe(task!.id); expect(await f.sql`SELECT id FROM opening_tasks WHERE candidate_id=${id}`).toHaveLength(1);
});
it("does not create a task for clarification, rejection, or a foreign course", async () => {
  const id = await pending({ minutes: null });
  const result = await createConversationPlanService(f.sql, { now: () => now }).propose(f.scope, {
    candidateId: id, expectedVersion: 0, date, expectedAcceptedVersion: 0, clientKey: "clarification-key",
  });
  expect(result).toMatchObject({ kind: "clarification", missing: ["course", "minutes"] });
  expect(await f.sql`SELECT id FROM opening_tasks WHERE candidate_id=${id}`).toHaveLength(0);
  const foreignCourse = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${foreignCourse},${f.otherScope.workspaceId},'外域',${foreignCourse})`;
  await expect(propose(id, { minutes: 20, courseId: foreignCourse })).rejects.toMatchObject({ code: "CONFLICT" });
  const ready = await propose(id, { minutes: 20 }); if (ready.kind !== "draft") throw new Error("expected draft");
  await createOpeningPlansRepository(f.sql).rejectPlan(f.scope, ready.draft.id);
  expect(await f.sql`SELECT id FROM opening_tasks WHERE candidate_id=${id}`).toHaveLength(0);
  expect((await f.sql`SELECT status FROM opening_assistant_candidates WHERE id=${id}`)[0]!.status).toBe("pending");
});
it("rejects a forged stored duration atomically and an already consumed candidate cannot create a second task", async () => {
  const id = await pending(), draft = await draftFor(id);
  const [row] = await f.sql`SELECT input_snapshot,suggested_tasks,blocks FROM opening_plan_drafts WHERE id=${draft.id}`;
  const snapshot = row!.input_snapshot as { conversationPlan: ConversationPlanMetadata; tasks: { id: string; minutes: number }[] };
  const suggestions = row!.suggested_tasks as { minutes: number }[];
  const blocks = row!.blocks as PlanDraft["blocks"];
  await f.sql`UPDATE opening_plan_drafts SET input_snapshot=${f.sql.json({ ...snapshot, conversationPlan: { ...snapshot.conversationPlan, minutes: 25 },
    tasks: snapshot.tasks.map(task => task.id === snapshot.conversationPlan.taskId ? { ...task, minutes: 25 } : task) })},
    blocks=${f.sql.json(blocks.map(block => block.taskId === snapshot.conversationPlan.taskId ? { ...block, end: new Date(Date.parse(block.start) + 25 * 60_000).toISOString() } : block))},
    suggested_tasks=${f.sql.json(suggestions.map(item => ({ ...item, minutes: 25 })))} WHERE id=${draft.id}`;
  await expect(accept(draft)).rejects.toMatchObject({ code: "CONFLICT", reason: "source_unavailable" });
  expect(await f.sql`SELECT id FROM opening_tasks WHERE candidate_id=${id}`).toHaveLength(0);
  await createOpeningPlansRepository(f.sql).createTask(f.scope, { candidateId: id, title: "直接接受", minutes: 20, dueAt: null, priority: 0 });
  await expect(accept(draft)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_tasks WHERE candidate_id=${id}`).toHaveLength(1);
});
it("rejects a forged task snapshot and block duration that disagree with the confirmed conversation metadata", async () => {
  const id = await pending(), draft = await draftFor(id);
  const [row] = await f.sql`SELECT input_snapshot,blocks FROM opening_plan_drafts WHERE id=${draft.id}`;
  const snapshot = row!.input_snapshot as { conversationPlan: ConversationPlanMetadata; tasks: { id: string; minutes: number }[] };
  const blocks = row!.blocks as PlanDraft["blocks"];
  await f.sql`UPDATE opening_plan_drafts SET input_snapshot=${f.sql.json({ ...snapshot,
    tasks: snapshot.tasks.map(task => task.id === snapshot.conversationPlan.taskId ? { ...task, minutes: 30 } : task) })},
    blocks=${f.sql.json(blocks.map(block => block.taskId === snapshot.conversationPlan.taskId ? { ...block, end: new Date(Date.parse(block.start) + 30 * 60_000).toISOString() } : block))}
    WHERE id=${draft.id}`;
  await expect(accept(draft)).rejects.toMatchObject({ code: "CONFLICT", reason: "stale_version" });
  expect(await f.sql`SELECT id FROM opening_tasks WHERE candidate_id=${id}`).toHaveLength(0);
  expect((await f.sql`SELECT status FROM opening_assistant_candidates WHERE id=${id}`)[0]!.status).toBe("pending");
  expect((await f.sql`SELECT accepted_version FROM opening_plan_state WHERE workspace_id=${f.scope.workspaceId} AND day=${date}::date`)[0]?.accepted_version ?? 0).toBe(0);
});
it("revalidates source privacy on proposal and acceptance replay", async () => {
  const sourceId = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${f.scope.workspaceId},'source','text/plain',1,${"a".repeat(64)},1,'uploaded','ready')`;
  const id = await pending({ sourceId }), draft = await draftFor(id);
  await accept(draft);
  expect((await propose(id)).kind).toBe("draft");
  await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${sourceId})`;
  await expect(propose(id)).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(accept(draft)).rejects.toMatchObject({ code: "VALIDATION" });
  expect(await f.sql`SELECT id FROM opening_tasks WHERE candidate_id=${id}`).toHaveLength(1);
});

it("normalizes empty deadline notes and rejects notes beyond the task storage limit before any draft", async () => {
  const empty = await pending({ dueText: "" }), draft = await draftFor(empty);
  await accept(draft);
  expect((await f.sql`SELECT due_text FROM opening_tasks WHERE candidate_id=${empty}`)[0]!.due_text).toBeNull();
  const oversized = await pending({ dueText: "字".repeat(201) });
  await expect(propose(oversized)).rejects.toMatchObject({ code: "VALIDATION" });
  expect(await f.sql`SELECT id FROM opening_plan_drafts WHERE propose_client_key=${`proposal:${oversized}`}`).toHaveLength(0);
});

it("reports an occupied task request key as a conflict and rolls back candidate consumption", async () => {
  const id = await pending(), draft = await draftFor(id);
  await createOpeningPlansRepository(f.sql).createTask(f.scope, { title: "已占用的请求键", minutes: 10, priority: 0,
    dueAt: null, candidateId: null, clientKey: `conversation:${id}` });
  await expect(accept(draft)).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
  expect((await f.sql`SELECT status FROM opening_assistant_candidates WHERE id=${id}`)[0]!.status).toBe("pending");
  expect(await f.sql`SELECT id FROM opening_tasks WHERE candidate_id=${id}`).toHaveLength(0);
  expect((await f.sql`SELECT accepted_version FROM opening_plan_state WHERE workspace_id=${f.scope.workspaceId} AND day=${date}::date`)[0]?.accepted_version ?? 0).toBe(0);
});

it("reads bounded owned context without facts writes or source-derived task text", async () => {
  const id = await pending(); await accept(await draftFor(id));
  await f.sql`UPDATE opening_tasks SET priority=3 WHERE candidate_id=${id}`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${randomUUID()},${f.otherScope.workspaceId},'foreign-secret',${randomUUID()})`;
  for (let index = 0; index < 21; index++) await createOpeningPlansRepository(f.sql).createTask(f.scope, {
    title: `我的任务${index}`, minutes: 10, priority: 1, dueAt: null, candidateId: null,
  });
  const before = await f.sql`SELECT count(*)::int AS n FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}`;
  const context = await readOpeningConversationPlanningContext(f.sql, f.scope, now);
  expect(context).toMatchObject({ timeZone: "UTC", date, acceptedVersion: 1, truncated: true,
    learning: { status: "available", counts: { observations: 0, independentVerifiedCurrent: 0, unknownQualification: 0 } } });
  expect(context.tasks).toHaveLength(20); expect(JSON.stringify(context)).not.toContain("foreign-secret");
  expect(context.tasks[0]!.title).toBe("已确认学习任务"); expect(JSON.stringify(context)).not.toContain("对话练习");
  expect(JSON.stringify(context)).not.toContain(id);
  expect(await f.sql`SELECT count(*)::int AS n FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}`).toEqual(before);
  await expect(readOpeningConversationPlanningContext(f.sql, { ...f.scope, ownerUserId: f.otherScope.ownerUserId }, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it.each([false, true])("excludes source-revoked conversation drafts and dependent receipts from backup (accepted=%s)", async accepted => {
  const sourceId = randomUUID(), title = `private-draft-${randomUUID()}`;
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${f.scope.workspaceId},'Source','text/plain',1,${"b".repeat(64)},1,'uploaded','ready')`;
  const candidateId = await pending({ sourceId, title }), draft = await draftFor(candidateId);
  if (accepted) await accept(draft);
  const before = await readOpeningBackupRecords(f.sql, f.scope);
  expect(before.tables.opening_plan_drafts.some(row => row.id === draft.id)).toBe(true);
  expect(before.tables.opening_plan_acceptances.some(row => row.draft_id === draft.id)).toBe(accepted);
  await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${sourceId})`;
  const snapshot = await readOpeningBackupRecords(f.sql, f.scope);
  expect(snapshot.tables.opening_assistant_candidates.some(row => row.id === candidateId)).toBe(false);
  expect(snapshot.tables.opening_plan_drafts.some(row => row.id === draft.id)).toBe(false);
  expect(snapshot.tables.opening_plan_acceptances.some(row => row.draft_id === draft.id)).toBe(false);
  expect(snapshot.tables.opening_suggestion_feedback.some(row => row.draft_id === draft.id)).toBe(false);
  expect(JSON.stringify(snapshot.tables.opening_plan_drafts)).not.toContain(title);
  expect(JSON.stringify(snapshot.tables.opening_plan_drafts)).not.toContain(candidateId);
  if (accepted) {
    const task = snapshot.tables.opening_tasks.find(row => row.id === draft.suggestedTasks![0]!.id);
    expect(task).toMatchObject({ title, origin: "agent", candidate_id: null });
  } else {
    expect(snapshot.tables.opening_tasks.some(row => row.candidate_id === candidateId)).toBe(false);
    expect(JSON.stringify(snapshot.tables)).not.toContain(title);
  }
});

function beforeCommit(sql: Sql) {
  let release = () => undefined as void, entered = () => undefined as void;
  const opened = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  return { opened, release, sql: new Proxy(sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => { const result = await work(tx); entered(); await gate; return result; });
  } }) };
}
it("serializes actual overlapping direct and plan acceptance on the same candidate", async () => {
  const id = await pending(), draft = await draftFor(id);
  const a = await openRaceSession().ready, b = await openRaceSession().ready, barrier = beforeCommit(a.sql);
  const winner = track(accept(draft, barrier.sql)), pendingRequests: Promise<unknown>[] = [winner];
  try {
    await Promise.race([barrier.opened, winner.then(() => { throw new Error("winner bypassed barrier"); })]);
    const loser = track(createOpeningPlansRepository(b.sql).createTask(f.scope, { candidateId: id, title: "旧入口", minutes: 20, dueAt: null, priority: 0 }));
    pendingRequests.push(loser); await waitUntilBlocked(f.sql, b.pid, a.pid, "conversation plan/direct candidate");
    barrier.release(); const accepted = await winner, direct = await loser;
    expect(direct.id).toBe(accepted.suggestedTasks![0]!.id);
    expect(await f.sql`SELECT id FROM opening_tasks WHERE candidate_id=${id}`).toHaveLength(1);
  } finally { barrier.release(); await Promise.allSettled(pendingRequests); await closeRace(b.sql); await closeRace(a.sql); }
}, 15_000);
