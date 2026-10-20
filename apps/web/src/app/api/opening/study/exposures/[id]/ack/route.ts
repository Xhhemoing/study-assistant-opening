import { createOpeningStudyExposureService } from "../../../../../../../features/opening/study/exposure-service";
import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";

/** Acknowledgment is independent of release and cannot manufacture a help delivery. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const id = (await context.params).id;
    return Response.json(await createOpeningStudyExposureService(sql).acknowledge(scope, id));
  } catch (error) { return jsonError(mapDomainError(error)); }
}
