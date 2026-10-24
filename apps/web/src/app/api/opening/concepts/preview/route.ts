import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { conceptPreviewService } from "../../../../../features/opening/concepts/preview-service";
import { loadFeatureSwitches } from "@aistudy/config";

export async function POST(request: Request) {
  try {
    // Client capabilities are display-only, including stale tabs after shutdown.
    if (!loadFeatureSwitches().explorePreview) return Response.json({ error: { code: "FORBIDDEN", message: "Explore preview is disabled" } }, { status: 403, headers: { "Cache-Control": "no-store" } });
    const { scope, sql } = await requireOpeningScope(request);
    const result = await conceptPreviewService(sql).preview(scope, await readOpeningJsonBody(request));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = jsonError(mapDomainError(error));
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
