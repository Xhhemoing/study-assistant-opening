import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningAssistantProposalsRepository, createOpeningPlanningSettingsRepository, createOpeningPlansRepository } from "@aistudy/database";
import type { AssistantProposalTool } from "@aistudy/contracts";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";
let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
async function setup() {
  const facts = await learningAttemptFixture(f), observation = await facts.submit(await facts.start(), { outcome: "incorrect" });
  const conversationId = await backupRows(f.sql, f.scope).conversation(), sourceTurnId = randomUUID();
  await f.sql`UPDATE opening_conversations SET course_id=${facts.courseId} WHERE id=${conversationId}`;
  await f.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,source_ids,source_versions)
    VALUES(${sourceTurnId},${f.scope.workspaceId},${conversationId},'user','请生成可确认的草稿','explain','complete',${[facts.sourceId]},${f.sql.json({ [facts.sourceId]: 1 })})`;
  return { ...facts, observation, sourceTurnId };
}
it.each(["propose_note", "propose_memory", "propose_card", "propose_teaching_move", "flag_dispute"] as const)("%s stays a draft until explicit acceptance and replays only once", async name => {
  const context = await setup(), repo = createOpeningAssistantProposalsRepository(f.sql);
  const tools: Record<typeof name, AssistantProposalTool> = {
    propose_note: { name: "propose_note", arguments: { title: "待确认笔记", text: "记录当前证据缺口" } },
    propose_memory: { name: "propose_memory", arguments: { text: "先提示再解释", courseId: context.courseId } },
    propose_card: { name: "propose_card", arguments: { observationId: context.observation.id, front: "1/2+1/2?", back: "1" } },
    propose_teaching_move: { name: "propose_teaching_move", arguments: { courseId: context.courseId, topic: "分数的迁移练习" } },
    flag_dispute: { name: "flag_dispute", arguments: { rootObservationId: context.observation.id, expectedHead: context.observation.id, reason: "原判断需要重新核实" } },
  };
  const input = { clientKey: randomUUID(), sourceTurnId: context.sourceTurnId, tool: tools[name] };
  const before = await f.sql`SELECT (SELECT count(*) FROM cards WHERE workspace_id=${f.scope.workspaceId}) AS cards,
    (SELECT count(*) FROM library_documents WHERE workspace_id=${f.scope.workspaceId}) AS notes,
    (SELECT count(*) FROM opening_memories WHERE workspace_id=${f.scope.workspaceId}) AS memories,
    (SELECT count(*) FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}) AS observations,
    (SELECT count(*) FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId}) AS activities`;
  const draft = await repo.propose(f.scope, input);
  expect(draft).toMatchObject({ status: "draft", version: 0, result: null });
  expect(await repo.propose(f.scope, input)).toEqual(draft);
  const after = await f.sql`SELECT (SELECT count(*) FROM cards WHERE workspace_id=${f.scope.workspaceId}) AS cards,
    (SELECT count(*) FROM library_documents WHERE workspace_id=${f.scope.workspaceId}) AS notes,
    (SELECT count(*) FROM opening_memories WHERE workspace_id=${f.scope.workspaceId}) AS memories,
    (SELECT count(*) FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}) AS observations,
    (SELECT count(*) FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId}) AS activities`;
  expect(after[0]).toEqual(before[0]);
  const decision = { action: "accept" as const, expectedVersion: 0, clientKey: randomUUID() };
  const accepted = await repo.decide(f.scope, draft.id, decision);
  expect(accepted).toMatchObject({ status: "accepted", version: 1, result: { id: expect.any(String) } });
  expect(await repo.decide(f.scope, draft.id, decision)).toEqual(accepted);
  await expect(repo.decide(f.scope, draft.id, { ...decision, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  if (name === "flag_dispute") {
    const [head] = await f.sql`SELECT outcome,verdict_source FROM opening_learning_observations WHERE id=${accepted.result!.id}`;
    expect(head).toMatchObject({ outcome: "unverified", verdict_source: "self_report" });
  }
  if (name === "propose_note") {
    const [origin] = await f.sql`SELECT context_source_refs FROM opening_note_provenance WHERE document_id=${accepted.result!.id}`;
    expect(origin!.context_source_refs).toEqual([{ sourceId: context.sourceId, sourceVersion: 1 }]);
  }
});
it("accepts an actual local PlanDraft with both draft and accepted-plan CAS", async () => {
  const context = await setup(), now = new Date("2026-10-19T10:00:00.000Z"), date = "2026-10-19";
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, { weekOneMonday: "2026-09-07", periodTimes: {}, dailyWindow: { start: "08:00", end: "18:00" },
    lunch: { start: "12:00", end: "13:00" }, dinner: { start: "18:00", end: "19:00" }, sleep: { start: "23:00", end: "07:00" }, timeZone: "UTC" });
  const plans = createOpeningPlansRepository(f.sql), task = await plans.createTask(f.scope, { title: "重排练习", minutes: 30, dueAt: null, priority: 1, candidateId: null });
  await f.sql`INSERT INTO opening_plan_state(workspace_id,day,accepted_version,accepted_blocks,hard_blocks_fingerprint)
    VALUES(${f.scope.workspaceId},${date}::date,1,${f.sql.json([{ taskId: task.id, start: `${date}T09:00:00.000Z`, end: `${date}T09:30:00.000Z`, reason: "原安排" }])},'prior')`;
  const repo = createOpeningAssistantProposalsRepository(f.sql, { now: () => now });
  const draft = await repo.propose(f.scope, { sourceTurnId: context.sourceTurnId, clientKey: randomUUID(), tool: { name: "propose_plan_change", arguments: { date, expectedAcceptedVersion: 1 } } });
  expect(draft.prepared?.draftId).toBeTruthy(); expect((await plans.getToday(f.scope, date))?.acceptedVersion).toBe(1);
  expect(draft.prepared?.preview).toMatchObject({ timeZone: "UTC", tasks: [{ id: task.id, title: "重排练习" }],
    previousBlocks: [{ taskId: task.id, start: `${date}T09:00:00.000Z` }] });
  expect(draft.prepared!.preview!.proposedBlocks.some(block => Date.parse(block.start) >= now.getTime())).toBe(true);
  await f.sql`UPDATE opening_plan_drafts SET blocks='[]'::jsonb WHERE id=${draft.prepared!.draftId}`;
  await expect(repo.decide(f.scope, draft.id, { action: "accept", expectedVersion: 0, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT", message: "plan preview differs from draft; regenerate before accepting" });
  expect((await plans.getToday(f.scope, date))?.acceptedVersion).toBe(1);
  await f.sql`UPDATE opening_plan_drafts SET blocks=${f.sql.json(draft.prepared!.preview!.proposedBlocks)} WHERE id=${draft.prepared!.draftId}`;
  const accepted = await repo.decide(f.scope, draft.id, { action: "accept", expectedVersion: 0, clientKey: randomUUID() });
  expect(accepted.result?.kind).toBe("plan"); expect((await plans.getToday(f.scope, date))?.acceptedVersion).toBe(2);
});
it("serializes competing confirmations, rejects cross-scope access and invalidates changed source versions", async () => {
  const context = await setup(), repo = createOpeningAssistantProposalsRepository(f.sql);
  const input = { sourceTurnId: context.sourceTurnId, clientKey: randomUUID(), tool: { name: "propose_note" as const, arguments: { title: "草稿", text: "待确认内容" } } };
  const draft = await repo.propose(f.scope, input);
  await expect(repo.decide(f.otherScope, draft.id, { action: "accept", expectedVersion: 0, clientKey: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const raced = await Promise.allSettled([repo.decide(f.scope, draft.id, { action: "accept", expectedVersion: 0, clientKey: randomUUID() }), repo.decide(f.scope, draft.id, { action: "reject", expectedVersion: 0, clientKey: randomUUID() })]);
  expect(raced.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const next = await repo.propose(f.scope, { ...input, clientKey: randomUUID() });
  await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${context.sourceId}`;
  await expect(repo.decide(f.scope, next.id, { action: "accept", expectedVersion: 0, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await repo.list(f.scope)).some(proposal => proposal.id === next.id)).toBe(false);
});
it("a cancelled worker lease or changed privacy cannot persist a late proposal", async () => {
  const context = await setup(), repo = createOpeningAssistantProposalsRepository(f.sql), jobId = randomUUID(), claimToken = randomUUID();
  const [source] = await f.sql`SELECT conversation_id FROM opening_turns WHERE id=${context.sourceTurnId}`;
  const assistantId = await backupRows(f.sql, f.scope).turn(String(source!.conversation_id), [context.sourceId]);
  await f.sql`INSERT INTO opening_tutor_jobs(id,workspace_id,conversation_id,user_turn_id,assistant_turn_id,status,mode,claim_token)
    VALUES(${jobId},${f.scope.workspaceId},${source!.conversation_id},${context.sourceTurnId},${assistantId},'cancelled','listen',${claimToken})`;
  const input = { sourceTurnId: context.sourceTurnId, clientKey: randomUUID(), tool: { name: "propose_note" as const, arguments: { title: "取消的草稿", text: "不得迟到保存" } } };
  await expect(repo.propose(f.scope, input, { jobLease: { jobId, claimToken } })).rejects.toMatchObject({ code: "CONFLICT" });
  const [owner] = await f.sql`SELECT privacy_epoch FROM workspaces WHERE id=${f.scope.workspaceId}`;
  await expect(repo.propose(f.scope, input, { expectedPrivacyEpoch: Number(owner!.privacy_epoch) + 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  const [count] = await f.sql`SELECT count(*)::int AS count FROM opening_assistant_proposals WHERE workspace_id=${f.scope.workspaceId}`;
  expect(count!.count).toBe(0);
});

it("finds old drafts behind processed records and pages every pending row without losing timestamp precision", async () => {
  const context = await setup(), repo = createOpeningAssistantProposalsRepository(f.sql);
  const draft = await repo.propose(f.scope, { sourceTurnId: context.sourceTurnId, clientKey: randomUUID(), tool: { name: "propose_note", arguments: { title: "旧建议", text: "仍待确认" } } });
  await f.sql`UPDATE opening_assistant_proposals SET created_at='2026-10-01T00:00:00.000001Z' WHERE id=${draft.id}`;
  await f.sql`INSERT INTO opening_assistant_proposals(id,workspace_id,owner_user_id,source_turn_id,client_key,intent,context_source_refs,basis_version,privacy_epoch,status,created_at)
    SELECT gen_random_uuid(),workspace_id,owner_user_id,source_turn_id,gen_random_uuid()::text,intent,context_source_refs,basis_version,privacy_epoch,'accepted','2026-10-02T00:00:00Z'
    FROM opening_assistant_proposals CROSS JOIN generate_series(1,45) WHERE id=${draft.id}`;
  expect((await repo.list(f.scope)).some(item => item.id === draft.id)).toBe(false);
  expect(await repo.listPending(f.scope)).toMatchObject({ total: 1, nextCursor: null, proposals: [{ id: draft.id }] });
  await f.sql`INSERT INTO opening_assistant_proposals(id,workspace_id,owner_user_id,source_turn_id,client_key,intent,context_source_refs,basis_version,privacy_epoch,created_at)
    SELECT gen_random_uuid(),workspace_id,owner_user_id,source_turn_id,gen_random_uuid()::text,intent,context_source_refs,basis_version,privacy_epoch,
      '2026-10-03T00:00:00Z'::timestamptz + (n / 3) * interval '1 microsecond'
    FROM opening_assistant_proposals CROSS JOIN generate_series(1,45) n WHERE id=${draft.id}`;
  const first = await repo.listPending(f.scope);
  expect(first.proposals).toHaveLength(40); expect(first.total).toBe(46); expect(first.nextCursor).not.toBeNull();
  const second = await repo.listPending(f.scope, { cursor: first.nextCursor! });
  expect(second.proposals).toHaveLength(6); expect(second.total).toBe(46); expect(second.nextCursor).toBeNull();
  expect(new Set([...first.proposals, ...second.proposals].map(item => item.id)).size).toBe(46);
  expect(await repo.countPending(f.scope)).toBe(46);
});

it("filters across all conversation turns and rejects foreign scope, malformed cursors, and revoked provenance", async () => {
  const context = await setup(), repo = createOpeningAssistantProposalsRepository(f.sql);
  const [source] = await f.sql`SELECT conversation_id FROM opening_turns WHERE id=${context.sourceTurnId}`;
  const conversationId = String(source!.conversation_id);
  const draft = await repo.propose(f.scope, { sourceTurnId: context.sourceTurnId, clientKey: randomUUID(), tool: { name: "propose_note", arguments: { title: "原对话建议", text: "检查归属" } } });
  const otherConversation = await backupRows(f.sql, f.scope).conversation();
  const nextTurn = randomUUID();
  await f.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status)
    VALUES(${nextTurn},${f.scope.workspaceId},${otherConversation},'user','另一个对话','explain','complete')`;
  await repo.propose(f.scope, { sourceTurnId: nextTurn, clientKey: randomUUID(), tool: { name: "propose_note", arguments: { title: "另一个建议", text: "不可混入" } } });
  await f.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,created_at)
    SELECT gen_random_uuid(),${f.scope.workspaceId},${conversationId},'user','后续消息','explain','complete',now() + n * interval '1 second' FROM generate_series(1,50) n`;
  expect(await repo.listPending(f.scope, { conversationId })).toMatchObject({ total: 1, proposals: [{ id: draft.id }] });
  expect(await repo.listPending(f.otherScope)).toMatchObject({ total: 0, proposals: [] });
  expect(await repo.listPending({ ...f.scope, ownerUserId: f.otherScope.ownerUserId })).toMatchObject({ total: 0, proposals: [] });
  await expect(repo.listPending(f.otherScope, { conversationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  for (const cursor of ["garbage", Buffer.from(JSON.stringify({ createdAt: "bad", id: draft.id })).toString("base64url"), "x".repeat(513)]) {
    await expect(repo.listPending(f.scope, { cursor })).rejects.toThrow();
  }
  const cursor = Buffer.from(JSON.stringify({ createdAt: "2099-01-01T00:00:00.000001Z", id: draft.id })).toString("base64url");
  expect(await repo.listPending(f.scope, { conversationId: otherConversation, cursor })).toMatchObject({ total: 1, proposals: [{ sourceTurnId: nextTurn }] });
  await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${context.sourceId})`;
  expect(await repo.listPending(f.scope, { conversationId })).toMatchObject({ total: 0, proposals: [] });
  expect(await repo.countPending(f.scope)).toBe(1);
  await f.sql`DELETE FROM opening_privacy_exclusions WHERE workspace_id=${f.scope.workspaceId} AND source_id=${context.sourceId}`;
  await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${context.sourceId}`;
  expect(await repo.listPending(f.scope, { conversationId })).toMatchObject({ total: 0, proposals: [] });
  expect(await repo.countPending(f.scope)).toBe(1);
  await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${f.scope.workspaceId}`;
  expect(await repo.countPending(f.scope)).toBe(0);
});
