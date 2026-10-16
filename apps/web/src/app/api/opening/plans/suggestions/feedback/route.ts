import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { submitOpeningSuggestionFeedback } from "../../../../../../features/opening/planning/suggestion-feedback-service";

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await submitOpeningSuggestionFeedback(sql, scope, await readOpeningJsonBody(request, 8_192)));
  } catch (error) { return jsonError(mapDomainError(error)); }
}
