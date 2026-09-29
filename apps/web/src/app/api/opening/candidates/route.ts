import { readOpeningAssistantReviewCandidates } from "@aistudy/database";
import { assistantCandidateSchema, type AssistantCandidateRecord } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";

/** Pending assistant candidates for the current owner only (M01/P02 consume them later). */
export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const candidates = (await readOpeningAssistantReviewCandidates(sql, scope)).filter(
      (candidate) => candidate.workspaceId === scope.workspaceId,
    );
    const response: AssistantCandidateRecord[] = [];
    for (const candidate of candidates) {
      const payload = assistantCandidateSchema.safeParse(candidate.payload);
      if (!payload.success) continue;
      response.push({
        id: candidate.id,
        workspaceId: candidate.workspaceId,
        version: 0,
        candidate: payload.data,
        sourceTurnId: candidate.sourceTurnId,
        sourceIds: candidate.sourceIds,
        status: candidate.status === "discarded" ? "rejected" : candidate.status,
        createdAt: candidate.createdAt,
      });
    }
    return Response.json(response);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
