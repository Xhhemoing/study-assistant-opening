import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { openingQueries } from "../../../../features/opening/server/data-services";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const queries = openingQueries(sql);
    const [assistant, retests] = await Promise.all([
      queries.assistantReviewCandidates(scope),
      queries.retestReviewCandidates(scope),
    ]);
    const pendingAssistant = assistant.filter((candidate) => candidate.workspaceId === scope.workspaceId && candidate.status === "pending");
    return Response.json({ total: pendingAssistant.length + retests.length });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
