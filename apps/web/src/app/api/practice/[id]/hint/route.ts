import { requestHintForPrincipal } from "../../../../../features/practice/practice-service";
import { jsonError, mapDomainError, requirePrincipal } from "../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../server/runtime";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const result = await requestHintForPrincipal(runtime, principal, id, await request.json());
    return Response.json(result);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
