import { uuidSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { createOpeningSourceService } from "../../../../../../features/opening/sources/source-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const id = uuidSchema.parse((await context.params).id);
    return Response.json(await createOpeningSourceService(sql).retryParse(principal, id));
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
