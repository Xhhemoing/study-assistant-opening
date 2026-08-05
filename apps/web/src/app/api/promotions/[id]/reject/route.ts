import {
  rejectPromotionForPrincipal,
  jsonError,
  mapDomainError,
  requirePrincipal,
} from "../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../server/runtime";
type Params = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Params) {
  try {
    const runtime = getAuthRuntime(),
      principal = await requirePrincipal(runtime, request),
      { id } = await context.params;
    return Response.json({
      promotion: await rejectPromotionForPrincipal(runtime, principal, id),
    });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
