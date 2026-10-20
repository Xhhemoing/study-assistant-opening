import { describe, expect, it, vi } from "vitest";
import { createAssistantProposalClient } from "./assistant-proposal-client";

const id = "11111111-1111-4111-8111-111111111111";
const tool = { name: "propose_note" as const, arguments: { title: "Span", text: "检查全部坐标。" } };
const proposal = { id, sourceTurnId: id, tool, version: 0, status: "draft", createdAt: "2026-10-19T00:00:00Z", basisVersion: "state:1", result: null, prepared: null };
describe("assistant proposal client", () => {
  it("creates only a draft and preserves the same request identity on explicit retry", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ proposal }), { status: 200 }));
    const api = createAssistantProposalClient(transport);
    const input = { clientKey: "draft-request-1", sourceTurnId: id, tool };
    await api.proposeAssistantAction(input);
    await api.proposeAssistantAction(input);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.map(call => call[0])).toEqual(["/api/opening/assistant-proposals", "/api/opening/assistant-proposals"]);
    expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toEqual(input);
    expect(transport.mock.calls[0]![1]!.body).toEqual(transport.mock.calls[1]![1]!.body);
  });
  it("rejects invalid tool input before sending and never silently accepts on failure", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const api = createAssistantProposalClient(transport);
    await expect(api.proposeAssistantAction({ clientKey: "draft-request-1", sourceTurnId: id, tool: { name: "propose_note", arguments: { title: "", text: "body" } } })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("sends the displayed version on acceptance and surfaces a stale-state conflict", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: "CONFLICT", message: "学习状态已改变，请重新准备草稿" } }), { status: 409 }));
    const api = createAssistantProposalClient(transport);
    await expect(api.decideAssistantProposal(id, { expectedVersion: 3, action: "accept", clientKey: "same-decision-1" })).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toEqual({ expectedVersion: 3, action: "accept", clientKey: "same-decision-1" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not turn an unavailable list into no suggestions", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));
    await expect(createAssistantProposalClient(transport).listAssistantProposals()).rejects.toMatchObject({ status: 503 });
  });
});
