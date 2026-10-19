import { expect, it } from "vitest";
import { assistantProposalCreateSchema, assistantProposalDecisionSchema } from "./assistant-proposals";
import { resolveComposerPurpose, isSystemQueryPurpose } from "./composer-purpose";
const id = "00000000-0000-4000-8000-000000000001";
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
