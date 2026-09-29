import { courseLearningPreferencesUpdateSchema, uuidSchema } from "@aistudy/contracts";
import { readLearningPreferences, setCourseLearningPreferences } from "@aistudy/database";
import { getCourseForPrincipal, jsonError, mapDomainError, requirePrincipal } from "../../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../../server/runtime";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const courseId = uuidSchema.parse((await context.params).id);
    await getCourseForPrincipal(runtime, principal, courseId);
    const learningPreferences = await readLearningPreferences(runtime.sql,
      { workspaceId: principal.workspaceId, ownerUserId: principal.userId }, courseId);
    return Response.json({ learningPreferences });
  } catch (error) { return jsonError(mapDomainError(error)); }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const courseId = uuidSchema.parse((await context.params).id);
    await getCourseForPrincipal(runtime, principal, courseId);
    const body = courseLearningPreferencesUpdateSchema.parse(await request.json());
    const learningPreferences = await setCourseLearningPreferences(runtime.sql,
      { workspaceId: principal.workspaceId, ownerUserId: principal.userId }, courseId, body);
    return Response.json({ learningPreferences });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
