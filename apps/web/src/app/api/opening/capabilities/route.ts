import { ApiError, jsonError, mapDomainError, requirePrincipal } from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";
import { openingCapabilitiesResponse } from "../../../../server/opening-config";

/**
 * PR-H: secret-free capabilities for the browser. Values come from server
 * switches at request time, so one image behaves per environment.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    let userId: string | null = null;
    try {
      userId = (await requirePrincipal(getAuthRuntime(), request)).userId;
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "UNAUTHENTICATED")) throw error;
    }
    const response = Response.json(openingCapabilitiesResponse(userId));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
