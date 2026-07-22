import {
  getDocumentForPrincipal,
  jsonError,
  mapDomainError,
  requirePrincipal,
  updateDocumentForPrincipal,
} from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

type Params = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: Params,
): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const document = await getDocumentForPrincipal(runtime, principal, id);
    return Response.json({ document });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function PATCH(
  request: Request,
  context: Params,
): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const body = await request.json();
    const document = await updateDocumentForPrincipal(
      runtime,
      principal,
      id,
      body,
    );
    return Response.json({ document });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
