import { readOpeningAssistantReviewCandidates, readOpeningRetestReviewCandidates } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const [assistant, retests] = await Promise.all([
      readOpeningAssistantReviewCandidates(sql, scope),
      readOpeningRetestReviewCandidates(sql, scope),
    ]);
    const pendingAssistant = assistant.filter((candidate) => candidate.workspaceId === scope.workspaceId && candidate.status === "pending");
    return Response.json({ total: pendingAssistant.length + retests.length });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
