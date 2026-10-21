import { uuidSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { requestOpeningSourceIndex } from "../../../../../../features/opening/sources/source-index-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const id = uuidSchema.parse((await context.params).id);
    return Response.json(await requestOpeningSourceIndex(sql, scope, id), { status: 202 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
