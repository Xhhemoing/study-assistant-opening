import { z } from "zod";
import { assistantProposalCreateSchema, assistantProposalDecisionSchema, assistantProposalRecordSchema,
  pendingAssistantProposalsQuerySchema, pendingAssistantProposalsResponseSchema,
  type AssistantProposalCreate, type AssistantProposalDecision, type PendingAssistantProposalsQuery } from "@aistudy/contracts";
import { OpeningApiError } from "./api";

export function createAssistantProposalClient(fetchImpl: typeof fetch = fetch) {
  async function request(path: string, body?: unknown) {
    const response = await fetchImpl(path, { method: body === undefined ? "GET" : "POST", cache: "no-store",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ message: z.string(), code: z.string().optional() }) }).safeParse(value);
      throw new OpeningApiError(response.status, parsed.success ? parsed.data.error.message : "建议暂时无法处理，请重新读取。", parsed.success ? parsed.data.error.code ?? null : null);
    }
    return value;
  }
  return {
    async listAssistantProposals() {
      return z.object({ proposals: z.array(assistantProposalRecordSchema) }).parse(await request("/api/opening/assistant-proposals")).proposals;
    },
    async listPendingAssistantProposals(input: PendingAssistantProposalsQuery = {}) {
      const query = pendingAssistantProposalsQuerySchema.parse(input);
      const params = new URLSearchParams({ status: "draft" });
      if (query.conversationId) params.set("conversationId", query.conversationId);
      if (query.cursor) params.set("cursor", query.cursor);
      return pendingAssistantProposalsResponseSchema.parse(await request(`/api/opening/assistant-proposals?${params}`));
    },
    async proposeAssistantAction(input: AssistantProposalCreate) {
      const proposal = z.object({ proposal: assistantProposalRecordSchema }).parse(await request("/api/opening/assistant-proposals", assistantProposalCreateSchema.parse(input))).proposal;
      if (typeof window !== "undefined") window.dispatchEvent(new Event("opening:reviews-changed"));
      return proposal;
    },
    async decideAssistantProposal(id: string, input: AssistantProposalDecision) {
      const proposal = z.object({ proposal: assistantProposalRecordSchema }).parse(await request(`/api/opening/assistant-proposals/${encodeURIComponent(id)}/decision`, assistantProposalDecisionSchema.parse(input))).proposal;
      if (typeof window !== "undefined") window.dispatchEvent(new Event("opening:reviews-changed"));
      return proposal;
    },
  };
}
