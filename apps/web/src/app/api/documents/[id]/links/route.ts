import {
  indexDocumentLinksForPrincipal,
  jsonError,
  listKnowledgeLinksForPrincipal,
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
    const links = await listKnowledgeLinksForPrincipal(runtime, principal, id);
    return Response.json({ links });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const result = await indexDocumentLinksForPrincipal(
      runtime,
      principal,
      id,
      await request.json(),
    );
    return Response.json(result);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
