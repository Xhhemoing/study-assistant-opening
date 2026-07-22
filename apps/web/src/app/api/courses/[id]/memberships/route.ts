import {
  addMembershipForPrincipal,
  jsonError,
  mapDomainError,
  requirePrincipal,
} from "../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../server/runtime";

type Params = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: Params,
): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const body = await request.json();
    const membership = await addMembershipForPrincipal(
      runtime,
      principal,
      id,
      body,
    );
    return Response.json({ membership }, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
