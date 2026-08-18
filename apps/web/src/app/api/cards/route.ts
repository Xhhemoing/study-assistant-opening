import { createCardForPrincipal, updateCardControlsForPrincipal } from "../../../features/review/review-service";
import { jsonError, mapDomainError, requirePrincipal } from "../../../features/auth/service";
import { getAuthRuntime } from "../../../server/runtime";

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const result = await createCardForPrincipal(runtime, principal, await request.json());
    return Response.json(result, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const result = await updateCardControlsForPrincipal(runtime, principal, await request.json());
    return Response.json(result);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

