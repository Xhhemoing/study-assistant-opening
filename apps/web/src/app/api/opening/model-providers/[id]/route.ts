import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { createProviderConfigService } from "../../../../../features/settings/provider-config-service";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const provider = await createProviderConfigService(sql).updateProvider(scope, (await context.params).id, await readOpeningJsonBody(request, 16_384));
    response = Response.json(provider);
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    await createProviderConfigService(sql).deleteProvider(scope, (await context.params).id);
    response = new Response(null, { status: 204 });
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
