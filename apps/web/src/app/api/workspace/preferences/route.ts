import {
  getWorkspacePreferenceForPrincipal,
  getLearningPreferencesForPrincipal,
  jsonError,
  mapDomainError,
  requirePrincipal,
  setWorkspacePreferenceForPrincipal,
  setLearningPreferencesForPrincipal,
} from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const [defaultEntry, learningPreferences] = await Promise.all([
      getWorkspacePreferenceForPrincipal(runtime, principal),
      getLearningPreferencesForPrincipal(runtime, principal),
    ]);
    return Response.json({ defaultEntry, learningPreferences });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const body = await request.json();
    if (body && typeof body === "object" && "learningPreferences" in body) {
      const learningPreferences = await setLearningPreferencesForPrincipal(runtime, principal, body.learningPreferences);
      return Response.json({ learningPreferences });
    }
    const defaultEntry = await setWorkspacePreferenceForPrincipal(runtime, principal, body);
    return Response.json({ defaultEntry });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
