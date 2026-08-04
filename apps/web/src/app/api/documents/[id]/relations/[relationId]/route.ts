import {
  deleteDocumentRelationForPrincipal,
  jsonError,
  mapDomainError,
  requirePrincipal,
  updateDocumentRelationForPrincipal,
} from "../../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../../server/runtime";

type Params = { params: Promise<{ id: string; relationId: string }> };

export async function PATCH(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id, relationId } = await context.params;
    const relation = await updateDocumentRelationForPrincipal(
      runtime,
      principal,
      id,
      relationId,
      await request.json(),
    );
    return Response.json({ relation });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function DELETE(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id, relationId } = await context.params;
    await deleteDocumentRelationForPrincipal(runtime, principal, id, relationId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
