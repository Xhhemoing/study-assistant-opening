import {
  createDocumentRelationForPrincipal,
  jsonError,
  listManagedDocumentRelationsForPrincipal,
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
    const relations = await listManagedDocumentRelationsForPrincipal(runtime, principal, id);
    return Response.json({ relations });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const relation = await createDocumentRelationForPrincipal(
      runtime,
      principal,
      id,
      await request.json(),
    );
    return Response.json({ relation }, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
