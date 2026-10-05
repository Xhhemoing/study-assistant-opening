import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { createOpeningConnectionService } from "../../../../../../features/opening/connections/service";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    await createOpeningConnectionService(sql).credential(scope, (await context.params).id, await readOpeningJsonBody(request, 16_384));
    response = new Response(null, { status: 204 });
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
