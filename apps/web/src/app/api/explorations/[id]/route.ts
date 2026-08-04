import { getExplorationForPrincipal } from "../../../../features/auth/exploration-service";
import { jsonError, mapDomainError, requirePrincipal } from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Params): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const detail = await getExplorationForPrincipal(runtime, principal, id);
    return Response.json(detail);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
