import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { getExplicitRegradeService } from "../../../../../features/opening/learning/explicit-regrade-runtime";

/** GET without a recovery key returns a fresh owner/head/version snapshot.
 * With clientKey it reads one exact consent version; it never repairs/enqueues. */
export async function GET(request: Request): Promise<Response> {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const service = getExplicitRegradeService(sql);
    const result = Object.keys(query).length === 1 && "observationId" in query
      ? { snapshot: await service.snapshot(scope, query.observationId!) } : await service.read(scope, query);
    response = Response.json(result, { status: "kind" in result && result.kind === "conflict" ? 409 : 200 });
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** Prepare only captures consent. Middleware supplies the existing CSRF boundary. */
export async function POST(request: Request): Promise<Response> {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const result = await getExplicitRegradeService(sql).prepare(scope, await readOpeningJsonBody(request));
    response = Response.json(result, { status: result.kind === "conflict" ? 409 : 200 });
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
