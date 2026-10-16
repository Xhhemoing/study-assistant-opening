import type { AcceptPlanInput, ConversationPlanInput, ConversationPlanResult, PlanDraft } from "@aistudy/contracts";
import { OpeningApiError } from "../client/api";

export type ConversationPlanApi = {
  inspectConversationPlan(candidateId: string): Promise<Extract<ConversationPlanResult, { kind: "clarification" }>>;
  proposeConversationPlan(input: ConversationPlanInput): Promise<ConversationPlanResult>;
  acceptPlan(input: AcceptPlanInput): Promise<PlanDraft>;
  rejectPlan(draftId: string): Promise<PlanDraft>;
};

export function supportsConversationPlan(api: object): api is ConversationPlanApi {
  return "inspectConversationPlan" in api && typeof api.inspectConversationPlan === "function"
    && "proposeConversationPlan" in api && typeof api.proposeConversationPlan === "function"
    && "acceptPlan" in api && typeof api.acceptPlan === "function"
    && "rejectPlan" in api && typeof api.rejectPlan === "function";
}

/** Unknown results retain the original intent; only an explicit retry sends it again. */
export function createConversationPlanController(api: ConversationPlanApi, key: () => string = () => crypto.randomUUID()) {
  let proposal: ConversationPlanInput | undefined;
  let acceptance: AcceptPlanInput | undefined;
  function knownFailure(error: unknown) {
    return error instanceof OpeningApiError && [400, 401, 403, 404, 409, 422].includes(error.status);
  }
  return {
    hasUnknownProposal: () => proposal !== undefined,
    hasUnknownAcceptance: () => acceptance !== undefined,
    async propose(input: Omit<ConversationPlanInput, "clientKey">) {
      proposal ??= { ...input, clientKey: key() };
      try {
        const result = await api.proposeConversationPlan(proposal);
        proposal = undefined;
        return result;
      } catch (error) {
        if (knownFailure(error)) proposal = undefined;
        throw error;
      }
    },
    async accept(draft: PlanDraft) {
      acceptance ??= { draftId: draft.id, expectedBaseVersion: draft.baseVersion,
        acceptSuggestedKeys: draft.suggestedTasks?.filter(item => draft.blocks.some(block => block.taskId === item.id)).map(item => item.key) ?? [], clientKey: key() };
      try {
        const result = await api.acceptPlan(acceptance);
        acceptance = undefined;
        return result;
      } catch (error) {
        if (knownFailure(error)) acceptance = undefined;
        throw error;
      }
    },
  };
}
