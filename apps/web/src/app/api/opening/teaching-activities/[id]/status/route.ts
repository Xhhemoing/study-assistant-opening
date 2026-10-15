import { teachingActivitySchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import {
  getTeachingResumeService,
  requireOpeningScope,
} from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";

/**
 * PATCH teaching activity status; completion is terminal and does not imply mastery.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const body = await readOpeningJsonBody(request);
    const activity = await getTeachingResumeService(sql).setStatus(scope, id, body);
    const parsed = teachingActivitySchema.parse(activity);
    const response = Response.json(parsed);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
