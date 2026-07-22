import {
  clearSessionCookieHeader,
  jsonError,
  logoutUser,
  mapDomainError,
  resolvePrincipal,
} from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

export async function POST(request: Request): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await resolvePrincipal(runtime, request);
    await logoutUser(runtime, principal);
    return Response.json(
      { ok: true },
      {
        status: 200,
        headers: {
          "Set-Cookie": clearSessionCookieHeader(runtime),
        },
      },
    );
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
