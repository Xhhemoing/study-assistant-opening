import { expect, it } from "vitest";
import { assistantProposalCreateSchema, assistantProposalDecisionSchema, pendingAssistantProposalsQuerySchema, pendingAssistantProposalsResponseSchema } from "./assistant-proposals";
import { resolveComposerPurpose, isSystemQueryPurpose } from "./composer-purpose";
const id = "00000000-0000-4000-8000-000000000001";
it("bounds pending-list filters and requires an explicit total and cursor", () => {
  expect(pendingAssistantProposalsQuerySchema.parse({ conversationId: id, cursor: "abc_123-DEF" })).toEqual({ conversationId: id, cursor: "abc_123-DEF" });
  for (const input of [{ conversationId: "other" }, { cursor: "x".repeat(513) }, { cursor: "a/b" }, { ownerUserId: id }]) {
    expect(pendingAssistantProposalsQuerySchema.safeParse(input).success).toBe(false);
  }
  expect(pendingAssistantProposalsResponseSchema.parse({ proposals: [], nextCursor: null, total: 0 })).toEqual({ proposals: [], nextCursor: null, total: 0 });
  expect(pendingAssistantProposalsResponseSchema.safeParse({ proposals: [], nextCursor: null }).success).toBe(false);
});
it("routes all five semantic intents separately from disclosure authority", () => {
  for (const purpose of ["answer", "explain_state", "teach", "plan", "query"] as const) expect(resolveComposerPurpose({ purpose })).toBe(purpose);
  expect(isSystemQueryPurpose({ querySystem: true })).toBe(true); expect(isSystemQueryPurpose({ purpose: "explain_state" })).toBe(true);
  expect(isSystemQueryPurpose({ purpose: "teach" })).toBe(false);
  expect(() => resolveComposerPurpose({ purpose: "teach", querySystem: true })).toThrow("conflicting");
});
it("accepts six bounded proposal intents but rejects authority and mastery mutations", () => {
  const tools = [
    { name: "propose_teaching_move", arguments: { courseId: id, topic: "练习张成" } },
    { name: "propose_plan_change", arguments: { date: "2026-10-19", expectedAcceptedVersion: 0 } },
    { name: "propose_card", arguments: { observationId: id, front: "Q", back: "A" } },
    { name: "propose_note", arguments: { title: "笔记", text: "正文" } },
    { name: "propose_memory", arguments: { text: "偏好先给提示", courseId: null } },
    { name: "flag_dispute", arguments: { rootObservationId: id, expectedHead: id, reason: "原判定待核实" } },
  ];
  for (const tool of tools) {
    const input = { clientKey: "proposal-key", sourceTurnId: id, tool };
    expect(assistantProposalCreateSchema.safeParse(input).success).toBe(true);
    expect(assistantProposalCreateSchema.safeParse({ ...input, workspaceId: id }).success).toBe(false);
    expect(assistantProposalCreateSchema.safeParse({ ...input, tool: { ...tool, arguments: { ...tool.arguments, mastered: true } } }).success).toBe(false);
  }
  expect(assistantProposalDecisionSchema.safeParse({ expectedVersion: 0, action: "accept", clientKey: "accept-key" }).success).toBe(true);
  expect(assistantProposalDecisionSchema.safeParse({ expectedVersion: -1, action: "accept", clientKey: "accept-key" }).success).toBe(false);
});

it.each(["高数进度怎么样", "我高数进度怎么样", "我的练习情况", "当前任务", "明天计划", "今天的计划是什么", "我的课程列表", "高数进度、当前任务和测验情况"])("automatically requests bounded records for %s", text => {
  expect(isSystemQueryPurpose({ purpose: "answer", text })).toBe(true);
});
it.each(["请证明积分中值定理", "这道练习怎么做", "我今天练习积分", "积分怎么求", "高数应该怎么学", "帮我删除所有任务", "标记任务完成"])("keeps %s out of automatic reads", text => {
  expect(isSystemQueryPurpose({ purpose: "answer", text })).toBe(false);
});
it("uses prior user requests only to route follow-ups", () => {
  expect(isSystemQueryPurpose({ text: "那明天呢", history: [{ role: "user", text: "今天的计划是什么" }] })).toBe(true);
  expect(isSystemQueryPurpose({ text: "那明天呢", history: [{ role: "assistant", text: "今天计划已完成" }] })).toBe(false);
  expect(isSystemQueryPurpose({ purpose: "teach", text: "高数进度" })).toBe(false);
});
it("does not turn a math follow-up into a record query", () => {
  const history = [{ role: "user", text: "高数进度怎么样" }];
  expect(isSystemQueryPurpose({ text: "那这道题怎么做", history })).toBe(false);
  expect(isSystemQueryPurpose({ text: "我想练习一道积分题", history })).toBe(false);
});
it.each(["为什么这个级数收敛？", "为什么积分要加C？", "还有什么常用积分公式？", "那sin的导数是什么？"])("keeps a mathematical follow-up on the ordinary path: %s", text => {
  expect(isSystemQueryPurpose({ text, history: [{ role: "user", text: "高数进度怎么样" }] })).toBe(false);
});
