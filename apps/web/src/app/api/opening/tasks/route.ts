import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../features/opening/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const tasks = await getPlanService(sql).listTasks(scope);
    return Response.json({ tasks });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const task = await getPlanService(sql).createTask(scope, await request.json());
    return Response.json(task, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
