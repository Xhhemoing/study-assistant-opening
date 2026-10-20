import { expect, it, vi } from "vitest";
import type { AssistantProposalRecord, AssistantProposalTool, ProviderOutput } from "@aistudy/contracts";
import { ASSISTANT_PROPOSAL_TOOLS, runAssistantProposal } from "./assistant-proposal-agent";
const id = "00000000-0000-4000-8000-000000000001";
const fallback: AssistantProposalTool = { name: "propose_teaching_move", arguments: { courseId: id, topic: "练习线性组合" } };
const proposal = { id, tool: fallback, sourceTurnId: id, version: 0, status: "draft", basisVersion: "captured", createdAt: "2026-10-19T00:00:00Z", result: null, prepared: null } satisfies AssistantProposalRecord;
const output = (name: string, args: unknown): ProviderOutput => ({ text: "已经应用并掌握", citedChunkIds: [], candidates: [], inputTokens: 1, outputTokens: 1, requestId: null,
  toolCalls: [{ id: "tool1", name, arguments: JSON.stringify(args) }] });
it("native model tool output creates one actual draft and never consumes model prose as success", async () => {
  const propose = vi.fn(async () => proposal), callModel = vi.fn(async () => output("propose_teaching_move", { courseId: id, topic: "迁移检查" }));
  const result = await runAssistantProposal({ question: "接下来怎么学", fallback, propose, callModel });
  expect(result).toMatchObject({ mode: "native_tools", proposal: { status: "draft" } });
  expect(propose).toHaveBeenCalledWith({ name: "propose_teaching_move", arguments: { courseId: id, topic: "迁移检查" } });
  expect(ASSISTANT_PROPOSAL_TOOLS).toHaveLength(6);
  expect(ASSISTANT_PROPOSAL_TOOLS.some(tool => /accept|mastery|update_state/.test(tool.name))).toBe(false);
});
it.each([
  ["accept", {}], ["propose_teaching_move", { courseId: "00000000-0000-4000-8000-000000000002", topic: "foreign" }],
  ["propose_memory", { text: "already mastered", courseId: null }],
])("rejects off-intent or changed identity model tools %s and retains only the server-selected draft", async (name, args) => {
  const propose = vi.fn(async () => proposal);
  const result = await runAssistantProposal({ question: "练习", fallback, propose, callModel: async () => output(name, args) });
  expect(result.mode).toBe("deterministic"); expect(propose).toHaveBeenCalledExactlyOnceWith(fallback);
});
it("a cancelled provider response cannot create a late draft", async () => {
  const controller = new AbortController(), propose = vi.fn(async () => proposal);
  await expect(runAssistantProposal({ question: "练习", fallback, propose, signal: controller.signal,
    callModel: async () => { controller.abort(); return output(fallback.name, fallback.arguments); } })).rejects.toThrow("cancelled");
  expect(propose).not.toHaveBeenCalled();
});
