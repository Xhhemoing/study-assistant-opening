import {
  getWorkspacePreferenceForPrincipal,
  jsonError,
  mapDomainError,
  requirePrincipal,
  setWorkspacePreferenceForPrincipal,
} from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const defaultEntry = await getWorkspacePreferenceForPrincipal(runtime, principal);
    return Response.json({ defaultEntry });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const body = await request.json();
    const defaultEntry = await setWorkspacePreferenceForPrincipal(runtime, principal, body);
    return Response.json({ defaultEntry });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
