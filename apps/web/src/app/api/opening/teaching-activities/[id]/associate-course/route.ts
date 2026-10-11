import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import {
  getTeachingActivityService,
  requireOpeningScope,
} from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const body = await readOpeningJsonBody(request);
    const updated = await getTeachingActivityService(sql).associateCourse(scope, id, body);
    return Response.json(updated);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
