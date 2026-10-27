import { createLearningAssetLinkService } from "../../../../features/opening/learning-links/learning-asset-link-service";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
async function handle(request: Request) {
  let response: Response;
  try { const { sql, scope } = await requireOpeningScope(request), service = createLearningAssetLinkService(sql);
    if (request.method === "GET") { const params = new URL(request.url).searchParams; response = Response.json(await service.list(scope, { assetType: params.get("assetType"), assetId: params.get("assetId") })); }
    else { const input = await readOpeningJsonBody(request, 32768); response = Response.json(request.method === "PATCH" ? await service.detach(scope, input) : await service.create(scope, input)); }
  } catch (reason) { response = jsonError(mapDomainError(reason)); }
  response.headers.set("Cache-Control", "no-store"); return response;
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
