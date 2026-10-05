import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../../features/opening/request-body";
import { createProviderConfigService } from "../../../../../../../features/settings/provider-config-service";

export async function PUT(request: Request, context: { params: Promise<{ id: string; modelId: string }> }) {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const model = await createProviderConfigService(sql).updateModel(scope, (await context.params).modelId, await readOpeningJsonBody(request, 16_384));
    response = Response.json(model);
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string; modelId: string }> }) {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    await createProviderConfigService(sql).deleteModel(scope, (await context.params).modelId);
    response = new Response(null, { status: 204 });
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
