import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { createOpeningConnectionService } from "../../../../../../features/opening/connections/service";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    await createOpeningConnectionService(sql).unavailable(scope, (await context.params).id, await readOpeningJsonBody(request, 16_384));
    throw new Error("unavailable connector returned unexpectedly");
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
