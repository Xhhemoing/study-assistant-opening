import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { getAiGradingService } from "../../../../../features/opening/learning/ai-grading-runtime";

export async function POST(request: Request): Promise<Response> {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const result = await getAiGradingService(sql).enqueue(scope, await readOpeningJsonBody(request));
    response = Response.json(result, { status: 202 });
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request): Promise<Response> {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const result = await getAiGradingService(sql).read(scope, { observationId: new URL(request.url).searchParams.get("observationId") as string });
    response = Response.json(result);
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
