import { createAssistantProposalService } from "../../../../../../features/opening/assistant/proposal-service";
import { ApiError, jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";

/** The model can propose; only the authenticated learner can explicitly accept. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    if (["model", "worker"].includes(request.headers.get("x-opening-caller") ?? "")) throw new ApiError("WORKSPACE_FORBIDDEN", "proposal decisions require a user session", 403);
    const { scope, sql } = await requireOpeningScope(request);
    const id = (await context.params).id;
    const input = await readOpeningJsonBody(request);
    return Response.json({ proposal: await createAssistantProposalService(sql).decide(scope, id, input) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
