import { teachingCheckpointSaveResultSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import {
  getTeachingResumeService,
  requireOpeningScope,
} from "../../../../../../../features/opening/runtime";
import { teachingLoopApiDenied } from "../../../../../../../server/opening-config";
import { readOpeningJsonBody } from "../../../../../../../features/opening/request-body";

/**
 * POST teaching activity checkpoint (V2-14 / plan.md §6.3).
 * CAS on expectedVersion; merge preserves V2-11 prefs + V2-12 command keys.
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
    const result = await getTeachingResumeService(sql).saveCheckpoint(scope, id, body);
    const parsed = teachingCheckpointSaveResultSchema.parse(result);
    const response = Response.json(parsed, {
      status: parsed.ok ? 200 : 409,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
