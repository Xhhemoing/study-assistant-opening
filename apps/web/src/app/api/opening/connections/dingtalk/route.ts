import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { createOpeningConnectionService } from "../../../../../features/opening/connections/service";

export async function POST(request: Request) {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    response = Response.json(await createOpeningConnectionService(sql).createDingtalk(scope, await readOpeningJsonBody(request, 16_384)), { status: 201 });
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
