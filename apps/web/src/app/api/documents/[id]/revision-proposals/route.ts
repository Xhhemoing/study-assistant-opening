import {
  createRevisionProposalForPrincipal,
  jsonError,
  listRevisionProposalsForPrincipal,
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
    return Response.json({ proposals: await listRevisionProposalsForPrincipal(runtime, principal, id) });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    return Response.json({ proposal: await createRevisionProposalForPrincipal(runtime, principal, id, await request.json()) }, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
