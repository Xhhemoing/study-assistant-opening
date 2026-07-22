import {
  jsonError,
  mapDomainError,
  registerUser,
  sessionCookieHeader,
} from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

export async function POST(request: Request): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const body = await request.json();
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
