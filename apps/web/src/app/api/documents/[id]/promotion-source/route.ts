import {
  getDocumentPromotionSourceForPrincipal,
  jsonError,
  mapDomainError,
  requirePrincipal,
} from "../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../server/runtime";

type Params = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: Params,
): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const promotion = await getDocumentPromotionSourceForPrincipal(
      runtime,
      principal,
      id,
    );
    return Response.json({ promotion });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
