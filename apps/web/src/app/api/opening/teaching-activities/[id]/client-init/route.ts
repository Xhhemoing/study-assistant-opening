import { activitySpecClientInitSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import {
  getTeachingContentService,
  requireOpeningScope,
} from "../../../../../../features/opening/runtime";

/**
 * Thin V2-10 wire: owned activity → redacted ActivitySpecClientInit.
 * Never returns unredacted answer_key plaintext.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const init = await getTeachingContentService(sql).getClientInit(scope, id);
    const body = activitySpecClientInitSchema.parse(init);
    return Response.json(body);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
