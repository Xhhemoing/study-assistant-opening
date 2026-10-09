import { uuidSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { createOpeningMediaSegmentsService } from "../../../../../../features/opening/media/media-segments-service";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const id = uuidSchema.parse((await context.params).id);
    return Response.json(await createOpeningMediaSegmentsService(sql).listSegments(principal, id), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
