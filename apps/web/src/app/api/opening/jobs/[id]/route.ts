import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { getTutorJobService } from "../../../../../features/opening/server/data-services";

type Params = { params: Promise<{ id: string }> };

function response(job: { id: string; status: string; error: { message: string } | null; updatedAt: string }) {
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    updatedAt: job.updatedAt,
  };
}

/** Owner-scoped job polling and cancellation. Cancellation never claims provider termination. */
export async function GET(request: Request, context: Params): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const job = await getTutorJobService(sql).get(scope, id);
    if (!job) return Response.json({ error: { code: "NOT_FOUND", message: "job not found" } }, { status: 404 });
    return Response.json(response(job));
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function DELETE(request: Request, context: Params): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const result = await getTutorJobService(sql).cancel(scope, id);
    if (!result) return Response.json({ error: { code: "NOT_FOUND", message: "job not found" } }, { status: 404 });
    return Response.json(response(result.job), result.conflict ? { status: 409 } : undefined);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
