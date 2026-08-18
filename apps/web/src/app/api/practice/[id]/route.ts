import { startPracticeForPrincipal } from "../../../../features/practice/practice-service";
import { jsonError, mapDomainError, requirePrincipal } from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const result = await startPracticeForPrincipal(runtime, principal, id);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
