import { teachingActivitySchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import {
  getTeachingActivityService,
  requireOpeningScope,
} from "../../../../../../features/opening/runtime";

/**
 * 「再学一节」: start the section after a completed activity. Idempotent — repeating
 * the request returns the same next section until that one is completed too.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const activity = teachingActivitySchema.parse(await getTeachingActivityService(sql).continueAfter(scope, id));
    return Response.json(activity, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
