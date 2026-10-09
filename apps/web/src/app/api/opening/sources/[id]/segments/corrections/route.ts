import { uuidSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import { createOpeningMediaSegmentsService } from "../../../../../../../features/opening/media/media-segments-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const id = uuidSchema.parse((await context.params).id);
    const body = await request.json();
    return Response.json(await createOpeningMediaSegmentsService(sql).applyCorrections(principal, id, body), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
