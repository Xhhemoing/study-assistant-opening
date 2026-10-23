import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { createLearnerStateReadService } from "../../../../../features/opening/teaching/learner-state-service";
import { createWeakPointsReadService } from "../../../../../features/opening/review/weak-points-service";

/** Aggregate complete qualified heads on the server; never expose the raw answer sequence here. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql, runtime } = await requireOpeningScope(request);
    const service = createWeakPointsReadService({
      readState: owner => createLearnerStateReadService(sql).read(owner, {}),
      listCourses: owner => runtime.courses.listCourses({ workspaceId: owner.workspaceId }),
    });
    return Response.json(await service.read(scope), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
