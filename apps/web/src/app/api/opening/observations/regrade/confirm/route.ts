import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { getExplicitRegradeService } from "../../../../../../features/opening/learning/explicit-regrade-runtime";

/** Valid consent and the unique durable job commit together. Only the worker spends. */
export async function POST(request: Request): Promise<Response> {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const result = await getExplicitRegradeService(sql).confirm(scope, await readOpeningJsonBody(request));
    response = Response.json(result, { status: result.kind === "conflict" ? 409 : 202 });
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
