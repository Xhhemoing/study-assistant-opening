import { getRevisionProposalForPrincipal, jsonError, mapDomainError, requirePrincipal } from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    return Response.json({ proposal: await getRevisionProposalForPrincipal(runtime, principal, id) });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
