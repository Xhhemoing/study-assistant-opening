import { uuidSchema } from "@aistudy/contracts";
import { getCourseForPrincipal, jsonError, mapDomainError, requirePrincipal } from "../../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../../server/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { createOpeningStudyPlanService } from "../../../../../../features/opening/planning/study-plan-service";

type Context = { params: Promise<{ id: string }> };

async function open(request: Request, context: Context) {
  const runtime = getAuthRuntime();
  const principal = await requirePrincipal(runtime, request);
  const courseId = uuidSchema.parse((await context.params).id);
  await getCourseForPrincipal(runtime, principal, courseId);
  const scope = { workspaceId: principal.workspaceId, ownerUserId: principal.userId };
  return { sql: runtime.sql, scope, courseId };
}

/** The course's lessons, when each is (or will be) taught, and whether the pace meets the target. */
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { sql, scope, courseId } = await open(request, context);
    return Response.json(await createOpeningStudyPlanService(sql).getCurrentView(scope, courseId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}

/** Start, change or stop the plan (`plan: null`); returns the updated view. */
export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    const { sql, scope, courseId } = await open(request, context);
    const service = createOpeningStudyPlanService(sql);
    await service.save(scope, courseId, await readOpeningJsonBody(request));
    return Response.json(await service.getCurrentView(scope, courseId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
