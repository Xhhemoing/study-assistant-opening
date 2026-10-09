import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { createOpeningKnowledgeService } from "../../../../../../features/opening/knowledge/service";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const courseId = (await context.params).id;
    const record = await createOpeningKnowledgeService(sql).get(scope, courseId);
    return Response.json(record);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const courseId = (await context.params).id;
    const record = await createOpeningKnowledgeService(sql).replace(scope, courseId, await request.json());
    return Response.json(record);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
