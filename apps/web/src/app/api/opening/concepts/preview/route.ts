import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { conceptPreviewService } from "../../../../../features/opening/concepts/preview-service";

export async function POST(request: Request) {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const result = await conceptPreviewService(sql).preview(scope, await readOpeningJsonBody(request));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = jsonError(mapDomainError(error));
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
