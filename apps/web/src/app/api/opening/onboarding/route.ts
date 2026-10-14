import { getOpeningOnboardingStatus, completeOpeningOnboarding } from "../../../../features/opening/server/workspace-setup-service";
import { openingOnboardingInputSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError, ApiError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { mapRepoError } from "../../../../features/opening/planning/plan-service";
export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await getOpeningOnboardingStatus(sql, scope), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(mapRepoError(error))); }
}
export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const input = openingOnboardingInputSchema.parse(await readOpeningJsonBody(request, 8192));
    return Response.json(await completeOpeningOnboarding(sql, scope, input), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(mapDomainError(error instanceof RangeError ? new ApiError("VALIDATION", error.message, 400) : mapRepoError(error)));
  }
}
