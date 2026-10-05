import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { createOpeningConnectionService } from "../../../../features/opening/connections/service";

export async function GET(request: Request) {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    response = Response.json(await createOpeningConnectionService(sql).list(scope));
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
