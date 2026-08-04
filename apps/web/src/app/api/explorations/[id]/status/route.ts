import { setExplorationStatusForPrincipal } from "../../../../../features/auth/exploration-service";
import { jsonError, mapDomainError, requirePrincipal } from "../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../server/runtime";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Params): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const exploration = await setExplorationStatusForPrincipal(runtime, principal, id, await request.json());
    return Response.json({ exploration });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
