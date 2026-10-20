import { z } from "zod";
import { assistantProposalCreateSchema, assistantProposalDecisionSchema, assistantProposalRecordSchema,
  type AssistantProposalCreate, type AssistantProposalDecision } from "@aistudy/contracts";
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
    async proposeAssistantAction(input: AssistantProposalCreate) {
      return z.object({ proposal: assistantProposalRecordSchema }).parse(await request("/api/opening/assistant-proposals", assistantProposalCreateSchema.parse(input))).proposal;
    },
    async decideAssistantProposal(id: string, input: AssistantProposalDecision) {
      return z.object({ proposal: assistantProposalRecordSchema }).parse(await request(`/api/opening/assistant-proposals/${encodeURIComponent(id)}/decision`, assistantProposalDecisionSchema.parse(input))).proposal;
    },
  };
}
