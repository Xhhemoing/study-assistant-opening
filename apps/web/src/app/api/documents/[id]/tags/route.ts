import {
  getDocumentTagsForPrincipal,
  jsonError,
  mapDomainError,
  requirePrincipal,
  setDocumentTagsForPrincipal,
} from "../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../server/runtime";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const tags = await getDocumentTagsForPrincipal(runtime, principal, id);
    return Response.json({ tags });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function PUT(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const tags = await setDocumentTagsForPrincipal(
      runtime,
      principal,
      id,
      await request.json(),
    );
    return Response.json({ tags });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
