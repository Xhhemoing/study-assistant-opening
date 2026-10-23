import { getAuthRuntime } from "../../../../../server/runtime";
import { jsonError, mapDomainError, requirePrincipal } from "../../../../../features/auth/service";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { preparePhotoPractice } from "../../../../../features/opening/practice/photo-practice-service";

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    return Response.json(await preparePhotoPractice(runtime, principal, await readOpeningJsonBody(request)), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
