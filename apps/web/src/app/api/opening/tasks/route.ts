import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";

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
    const { task, replayed } = await getPlanService(sql).createTaskWithOutcome(
      scope,
      await readOpeningJsonBody(request),
    );
    // 201 = new task; 200 = same clientKey replayed the existing task.
    return Response.json(task, { status: replayed ? 200 : 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
