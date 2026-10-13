import {
  interventionPrefsPatchSchema,
  interventionPrefsSchema,
  uuidSchema,
} from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { getInterventionSettingsService } from "../../../../features/opening/server/data-services";

function queryId(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key);
  if (raw == null || raw === "") return null;
  return uuidSchema.parse(raw);
}

async function handle(request: Request, write: boolean): Promise<Response> {
  let response: Response;
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const repo = getInterventionSettingsService(sql);
    const url = new URL(request.url);
    const courseId = queryId(url, "courseId");
    const activityId = queryId(url, "activityId");

    if (write) {
      const body = await readOpeningJsonBody(request, 16_384);
      if (courseId) {
        // Course overlay nest — partial patch or null to clear (no second settings product).
        if (body === null) {
          await repo.setCourseOverlay(scope, courseId, null);
        } else {
          await repo.setCourseOverlay(
            scope,
            courseId,
            interventionPrefsPatchSchema.parse(body),
          );
        }
      } else if (activityId) {
        // Session temp overlay on checkpoint — does not write-through to durable prefs.
        const expectedUpdatedAt = url.searchParams.get("expectedUpdatedAt") ?? undefined;
        if (body === null) {
          await repo.setSessionOverlay(scope, activityId, null, { expectedUpdatedAt });
        } else {
          await repo.setSessionOverlay(
            scope,
            activityId,
            interventionPrefsPatchSchema.parse(body),
            { expectedUpdatedAt },
          );
        }
      } else if (body === null) {
        await repo.setGlobal(scope, null);
      } else {
        await repo.setGlobal(scope, interventionPrefsSchema.parse(body));
      }
    }

    response = Response.json(
      await repo.resolve(scope, { courseId, activityId }),
    );
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const GET = (request: Request) => handle(request, false);
export const PUT = (request: Request) => handle(request, true);
