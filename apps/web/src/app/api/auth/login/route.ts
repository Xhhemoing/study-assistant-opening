import {
  jsonError,
  loginUser,
  mapDomainError,
  sessionCookieHeader,
} from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";
import { enforceAuthRateLimit } from "../../../../server/auth-throttle";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readOpeningJsonBody(request, 8 * 1024);
    await enforceAuthRateLimit(request, body, "login");
    const runtime = getAuthRuntime();
    const result = await loginUser(runtime, body);
    return Response.json(
      { user: result.user },
      {
        status: 200,
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
