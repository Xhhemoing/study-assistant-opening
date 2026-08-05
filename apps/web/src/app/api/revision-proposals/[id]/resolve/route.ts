import { jsonError, mapDomainError, requirePrincipal, resolveRevisionProposalForPrincipal } from "../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../server/runtime";

type Params = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    return Response.json(await resolveRevisionProposalForPrincipal(runtime, principal, id, await request.json()));
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
