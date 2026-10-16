import { openingAdaptivePrefsPatchSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { getAdaptivePrefsService } from "../../../../features/opening/server/data-services";

/** Autonomy mode, coach budget and course goals. Planning only reads them while OPENING_ADAPTIVE_PLANNING is on. */
async function handle(request: Request, write: boolean): Promise<Response> {
  let response: Response;
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const repo = getAdaptivePrefsService(sql);
    response = Response.json(write
      ? await repo.patch(scope, openingAdaptivePrefsPatchSchema.parse(await readOpeningJsonBody(request, 32_768)))
      : await repo.get(scope));
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const GET = (request: Request) => handle(request, false);
export const PATCH = (request: Request) => handle(request, true);
