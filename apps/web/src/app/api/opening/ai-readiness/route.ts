import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { buildAiReadiness } from "../../../../features/opening/ai-readiness/ai-readiness-service";
import { requireOpeningScope } from "../../../../features/opening/runtime";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  let response: Response;
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const body = await buildAiReadiness(sql, scope);
    response = Response.json(body);
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
