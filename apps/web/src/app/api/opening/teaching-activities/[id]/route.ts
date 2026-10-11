import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import {
  getTeachingActivityService,
  requireOpeningScope,
} from "../../../../../features/opening/runtime";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const activity = await getTeachingActivityService(sql).get(scope, id);
    return Response.json(activity);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
