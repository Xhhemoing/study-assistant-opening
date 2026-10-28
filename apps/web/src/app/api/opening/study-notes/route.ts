import { createLearningAssetLinkService } from "../../../../features/opening/learning-links/learning-asset-link-service";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
export async function POST(request: Request) {
  let response: Response;
  try { const { sql, scope } = await requireOpeningScope(request); response = Response.json(await createLearningAssetLinkService(sql).note(scope, await readOpeningJsonBody(request, 131072))); }
  catch (reason) { response = jsonError(mapDomainError(reason)); }
  response.headers.set("Cache-Control", "no-store"); return response;
}
