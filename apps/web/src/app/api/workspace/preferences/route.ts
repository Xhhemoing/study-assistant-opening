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
  let phase: "runtime" | "principal" | "body" | "save" | "response" = "runtime";
  let saveCompleted = false;
  try {
    const runtime = getAuthRuntime();
    phase = "principal";
    const principal = await requirePrincipal(runtime, request);
    phase = "body";
    const body = await request.json();
    phase = "save";
    const result = body && typeof body === "object" && "learningPreferences" in body
      ? { learningPreferences: await setLearningPreferencesForPrincipal(runtime, principal, body.learningPreferences) }
      : { defaultEntry: await setWorkspacePreferenceForPrincipal(runtime, principal, body) };
    saveCompleted = true;
    phase = "response";
    const response = Response.json(result);
    if (request.signal.aborted) console.warn("WORKSPACE_PREFERENCES_PUT", { at: new Date().toISOString(), phase, status: response.status, requestAborted: true, saveCompleted });
    return response;
  } catch (error) {
    const mapped = mapDomainError(error);
    // Fixed classifications only: never log the body, principal, message, stack or credentials.
    if (mapped.status >= 500 || request.signal.aborted) console.error("WORKSPACE_PREFERENCES_PUT", {
      at: new Date().toISOString(), phase, status: mapped.status, code: mapped.code, requestAborted: request.signal.aborted, saveCompleted,
    });
    return jsonError(mapped);
  }
}
