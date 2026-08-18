import { listAssessmentForPrincipal } from "../../../features/assessment/assessment-service";
import { jsonError, mapDomainError, requirePrincipal } from "../../../features/auth/service";
import { getAuthRuntime } from "../../../server/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const syllabusPointId = new URL(request.url).searchParams.get("syllabusPointId");
    const result = await listAssessmentForPrincipal(
      runtime,
      principal,
      syllabusPointId ? { syllabusPointId } : {},
    );
    return Response.json(result);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
