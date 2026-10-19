import { randomUUID } from "node:crypto";
import { isSystemQueryPurpose, previousRecordQuestion, type EphemeralTurnInput, type EphemeralTurnResponse, type Scope } from "@aistudy/contracts";
import { EphemeralProvenanceError, SystemQueryPermissionError, type EphemeralProvenanceRepository } from "@aistudy/database";
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
  const sourceId = input.sourceSelection !== "none" && input.sourceIds.length === 1 ? input.sourceIds[0] : undefined;
  let historyInvalid = input.history.length > 0;
  const resolvePreviousQuestion = async (epoch: number) => {
    if (!input.history.length) return undefined;
    const valid = input.historyPrivacyEpoch === epoch && await deps.provenance.resolveHistory(scope, input.history, epoch) !== null;
    historyInvalid = !valid;
    return valid ? previousRecordQuestion(input.history) : undefined;
  };
  const reply = await deps.systemQuery.reply(scope, { question: input.text, parentBudget,
    resolvePreviousQuestion,
    focus: { courseId: input.courseId ?? input.contextAnchor?.courseId, sourceId, physicalPage: input.currentPage } }, signal)
    .catch(error => {
      if (error instanceof SystemQueryPermissionError) throw new EphemeralServiceError("SYSTEM_QUERY_FORBIDDEN", error.message, 403);
      if (signal?.aborted) throw new EphemeralServiceError("ABORTED", "system query cancelled", 499);
      if (error instanceof Error && /timed out|timeout/.test(error.message)) throw new EphemeralServiceError("SYSTEM_QUERY_TIMEOUT", "系统记录查询超时，请重试。", 504);
      throw new EphemeralServiceError("SYSTEM_QUERY_UNAVAILABLE", "当前系统记录无法核实，请保留问题后重试。", 503);
    });

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
