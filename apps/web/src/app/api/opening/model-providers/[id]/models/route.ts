import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { createProviderConfigService } from "../../../../../../features/settings/provider-config-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const model = await createProviderConfigService(sql).createModel(scope, (await context.params).id, await readOpeningJsonBody(request, 16_384));
    response = Response.json(model, { status: 201 });
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
