import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import {
  getTeachingActivityService,
  requireOpeningScope,
} from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";

/**
 * Queue AI 主讲 generation for an owned activity that has no usable content.
 * The worker compiles, writes the unit's library blocks and publishes the
 * ActivitySpec; poll the activity / resume for generateStatus.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const body = await readOpeningJsonBody(request);
    const result = await getTeachingActivityService(sql).requestCompile(scope, id, body);
    return Response.json(result, { status: 202 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
