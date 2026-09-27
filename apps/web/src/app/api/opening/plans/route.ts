import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const draft = await getPlanService(sql).proposePlan(scope, await readOpeningJsonBody(request));
    return Response.json(draft, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
