import { teachingCommandResponseSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import {
  getTeachingCommandService,
  requireOpeningScope,
} from "../../../../../../../features/opening/runtime";
import { teachingLoopApiDenied } from "../../../../../../../server/opening-config";
import { readOpeningJsonBody } from "../../../../../../../features/opening/request-body";

/**
 * POST teaching commands (V2-12): why / rephrase / expand / example / skip / branch / return.
 * Returns discriminated success|conflict body (never LWW overwrite).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    // PR-H: server re-authorizes; a hidden UI is not the gate.
    const denied = teachingLoopApiDenied(scope.ownerUserId);
    if (denied) return denied;
    const { id } = await context.params;
    const body = await readOpeningJsonBody(request);
    const result = await getTeachingCommandService(sql).execute(scope, id, body);
    const parsed = teachingCommandResponseSchema.parse(result);
    const response = Response.json(parsed, {
      status: parsed.ok ? 200 : 409,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
