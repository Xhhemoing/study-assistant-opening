import { randomUUID } from "node:crypto";
import { isSystemQueryPurpose, type EphemeralTurnInput, type EphemeralTurnResponse, type Scope } from "@aistudy/contracts";
import { EphemeralProvenanceError, type EphemeralProvenanceRepository } from "@aistudy/database";
import { assertEphemeralInput, ConversationPolicyError, type SystemQueryService } from "@aistudy/ai";
import { EphemeralServiceError } from "./ephemeral-error";

/** Fresh record lookup ignores old chat as an authority; only prepared provenance is durable. */
export async function replyEphemeralSystemQuery(deps: { systemQuery: SystemQueryService; provenance: EphemeralProvenanceRepository; requestId?: () => string },
  scope: Scope, input: EphemeralTurnInput, signal?: AbortSignal): Promise<EphemeralTurnResponse> {
  try { assertEphemeralInput(input); } catch (error) {
    if (error instanceof ConversationPolicyError) throw new EphemeralServiceError("VALIDATION", error.message, error.status);
    throw error;
  }
  if (!isSystemQueryPurpose(input) || !deps.systemQuery.enabled()) throw new EphemeralServiceError("SYSTEM_QUERY_DISABLED", "系统记录查询暂未开启。", 409);
  if (signal?.aborted) throw new EphemeralServiceError("ABORTED", "system query cancelled", 499);
  const requestId = deps.requestId?.() ?? `eph:${randomUUID()}`;
  const parentBudget = { id: `study-ephemeral:${scope.workspaceId}:${input.clientKey ?? requestId}` };
  const sourceId = input.sourceIds.length === 1 ? input.sourceIds[0] : undefined;
  const reply = await deps.systemQuery.reply(scope, { question: input.text, parentBudget, focus: { courseId: input.courseId, sourceId, physicalPage: input.currentPage } }, signal)
    .catch(() => { throw new EphemeralServiceError(signal?.aborted ? "ABORTED" : "SYSTEM_QUERY_UNAVAILABLE", "当前系统记录无法核实，请保留问题后重试。", signal?.aborted ? 499 : 503); });
  const historyInvalid = input.history.length > 0 && (input.historyPrivacyEpoch !== reply.privacyEpoch
    || await deps.provenance.resolveHistory(scope, input.history, reply.privacyEpoch) === null);
  if (signal?.aborted) throw new EphemeralServiceError("ABORTED", "system query cancelled", 499);
  if (!deps.provenance.recordQuery) throw new Error("query provenance unavailable");
  const provenanceId = await deps.provenance.recordQuery(scope, { requestId,
    privacyEpoch: reply.privacyEpoch, contextSourceRefs: reply.contextSourceRefs }).catch(error => {
      if (error instanceof EphemeralProvenanceError) throw new EphemeralServiceError(error.code, "隐私或材料状态已变化，请重新查询。", error.code === "NOT_FOUND" ? 404 : 409);
      throw error;
    });
  if (signal?.aborted) throw new EphemeralServiceError("ABORTED", "system query cancelled", 499);
  return { text: reply.text, systemQuery: reply.receipt, citedChunkIds: [], candidates: [], inputTokens: null, outputTokens: null, requestId: null,
    privacyEpoch: reply.privacyEpoch, historyDiscarded: historyInvalid, provenanceId, citations: [] };
}
