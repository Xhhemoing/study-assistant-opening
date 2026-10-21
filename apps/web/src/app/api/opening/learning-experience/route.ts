import { submitOpeningLearningExperience } from "../../../../features/opening/planning/learning-experience-service";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await submitOpeningLearningExperience(sql, scope, await readOpeningJsonBody(request, 2_048)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
