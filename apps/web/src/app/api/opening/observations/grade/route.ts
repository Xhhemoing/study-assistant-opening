import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { getAiGradingService } from "../../../../../features/opening/learning/ai-grading-runtime";

export async function POST(request: Request): Promise<Response> {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const result = await getAiGradingService(sql).grade(scope, await readOpeningJsonBody(request), request.signal);
    response = Response.json(result);
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
