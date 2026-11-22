import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { applyBitemporalCorrection, readMisconceptionRequest } from "../../../../../features/opening/public-try/v3-try-misconception-handoff";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { assertAuthorized } from "../../../../../lib/authorization";

export async function POST(request: Request): Promise<Response> {
  try {
    const { sql, scope, principal } = await requireOpeningScope(request);
    assertAuthorized(principal, "memory.decide", { type: "workspace", workspaceId: scope.workspaceId });
    const result = await applyBitemporalCorrection(sql, scope, await readMisconceptionRequest(request));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
