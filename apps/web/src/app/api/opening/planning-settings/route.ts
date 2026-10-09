import { openingPlanningSettingsSchema } from "@aistudy/contracts";
import { createOpeningPlanningSettingsRepository } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";

async function handle(request: Request, write: boolean): Promise<Response> {
  let response: Response;
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const repo = createOpeningPlanningSettingsRepository(sql);
    if (write) {
      const body = await readOpeningJsonBody(request, 16_384);
      if (body === null) {
        await repo.set(scope, null);
      } else {
        await repo.set(scope, openingPlanningSettingsSchema.parse(body));
      }
    }
    response = Response.json(await repo.get(scope));
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const GET = (request: Request) => handle(request, false);
export const PUT = (request: Request) => handle(request, true);
