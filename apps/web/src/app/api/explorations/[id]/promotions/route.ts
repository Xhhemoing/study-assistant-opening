import {
  createPromotionForPrincipal,
  jsonError,
  listPromotionsForPrincipal,
  mapDomainError,
  requirePrincipal,
} from "../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../server/runtime";
type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Params) {
  try {
    const runtime = getAuthRuntime(),
      principal = await requirePrincipal(runtime, request),
      { id } = await context.params;
    return Response.json({
      promotions: await listPromotionsForPrincipal(runtime, principal, id),
    });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
export async function POST(request: Request, context: Params) {
  try {
    const runtime = getAuthRuntime(),
      principal = await requirePrincipal(runtime, request),
      { id } = await context.params;
    return Response.json(
      {
        promotion: await createPromotionForPrincipal(
          runtime,
          principal,
          id,
          await request.json(),
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
