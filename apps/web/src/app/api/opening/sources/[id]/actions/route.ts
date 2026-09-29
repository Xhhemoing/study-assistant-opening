import { sourceActionInputSchema, uuidSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { createOpeningSourceService } from "../../../../../../features/opening/sources/source-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const id = uuidSchema.parse((await context.params).id), input = sourceActionInputSchema.parse(await request.json());
    return Response.json(await createOpeningSourceService(sql).actOnSource(principal, id, input));
  } catch (error) { return jsonError(mapDomainError(error)); }
}
