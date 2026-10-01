import { OpeningModelRoutingError } from "@aistudy/ai";
import { OpeningModelConfigurationError } from "@aistudy/config";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { readAiSettings, saveAiSettings } from "../../../../features/settings/ai-settings-service";

function settingsError(error: unknown): Response {
  if (error instanceof OpeningModelRoutingError || error instanceof OpeningModelConfigurationError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error instanceof OpeningModelRoutingError ? 409 : 503 });
  }
  return jsonError(mapDomainError(error));
}
async function handle(request: Request, write: boolean): Promise<Response> {
  let response: Response;
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const result = write ? await saveAiSettings(sql, scope, await readOpeningJsonBody(request, 16_384)) : await readAiSettings(sql, scope);
    response = Response.json(result);
  } catch (error) { response = settingsError(error); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
export const GET = (request: Request) => handle(request, false);
export const PUT = (request: Request) => handle(request, true);
