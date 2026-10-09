import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import { createOpeningKnowledgeService } from "../../../../../../../features/opening/knowledge/service";

type Context = { params: Promise<{ id: string }> };

/** Enqueues job kind build-course-knowledge with payload { courseId }. */
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const courseId = (await context.params).id;
    const result = await createOpeningKnowledgeService(sql).rebuild(scope, courseId, await request.json());
    return Response.json(result);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
