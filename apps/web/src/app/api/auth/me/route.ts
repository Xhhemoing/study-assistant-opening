import {
  jsonError,
  mapDomainError,
  requirePrincipal,
  ApiError,
} from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

export async function GET(request: Request): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const user = await runtime.identity.findUserById(principal.userId);
    if (!user) {
      throw new ApiError("NOT_FOUND", "User not found", 404);
    }
    return Response.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        workspaceId: principal.workspaceId,
      },
    });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
