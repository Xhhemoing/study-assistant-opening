import { getOpeningOnboardingStatus } from "../../../../features/opening/server/workspace-setup-service";
import { isOpeningRelease } from "../../../../features/opening/access-policy";
import {
  jsonError,
  mapDomainError,
  requirePrincipal,
  ApiError,
} from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const user = await runtime.identity.findUserById(principal.userId);
    if (!user) {
      throw new ApiError("NOT_FOUND", "User not found", 404);
    }
    const onboardingRequired = isOpeningRelease() && (await getOpeningOnboardingStatus(runtime.sql, { workspaceId: principal.workspaceId, ownerUserId: principal.userId })).needsOnboarding;
    return Response.json({
      onboardingRequired,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        workspaceId: principal.workspaceId,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
