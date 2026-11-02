import { activitySpecSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getTeachingContentService, requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";

/** Explicitly adopt a saved answer-only revision; saving the document never publishes it. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const spec = await getTeachingContentService(sql).adoptReferenceRevision(scope, id, await readOpeningJsonBody(request));
    return Response.json(activitySpecSchema.parse(spec), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
