import {
  jsonError,
  listDocumentPropertiesForPrincipal,
  mapDomainError,
  requirePrincipal,
} from "../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../server/runtime";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const properties = await listDocumentPropertiesForPrincipal(runtime, principal, id);
    return Response.json(properties);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
