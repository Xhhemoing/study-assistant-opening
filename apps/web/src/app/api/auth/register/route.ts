import {
  ApiError,
  jsonError,
  mapDomainError,
  registerUser,
  sessionCookieHeader,
} from "../../../../features/auth/service";
import {
  allowRegistration,
  isOpeningRelease,
} from "../../../../features/opening/access-policy";
import { getAuthRuntime } from "../../../../server/runtime";
import { enforceAuthRateLimit } from "../../../../server/auth-throttle";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";

export async function POST(request: Request): Promise<Response> {
  try {
    if (!allowRegistration({ openingRelease: isOpeningRelease() })) {
      return jsonError(
        new ApiError(
          "WORKSPACE_FORBIDDEN",
          "Public registration is disabled in opening release",
          403,
        ),
      );
    }
    const body = await readOpeningJsonBody(request, 8 * 1024);
    await enforceAuthRateLimit(request, body, "register");
    const runtime = getAuthRuntime();
    const result = await registerUser(runtime, body);
    return Response.json(
      { user: result.user },
      {
        status: 201,
        headers: {
          "Set-Cookie": sessionCookieHeader(
            runtime,
            result.token,
            result.expiresAt,
          ),
        },
      },
    );
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
