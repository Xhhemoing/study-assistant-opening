import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { createProviderConfigService } from "../../../../features/settings/provider-config-service";

export async function GET(request: Request) {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    response = Response.json(await createProviderConfigService(sql).overview(scope));
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: Request) {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const provider = await createProviderConfigService(sql).createProvider(scope, await readOpeningJsonBody(request, 16_384));
    response = Response.json(provider, { status: 201 });
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
