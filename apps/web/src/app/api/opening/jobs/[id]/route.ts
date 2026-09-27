import { createOpeningTutorJobsRepository } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";

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
    const job = await createOpeningTutorJobsRepository(sql).get(scope, id);
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
    const repo = createOpeningTutorJobsRepository(sql);
    const job = await repo.cancel(scope, id);
    if (!job) {
      const existing = await repo.get(scope, id);
      if (!existing) return Response.json({ error: { code: "NOT_FOUND", message: "job not found" } }, { status: 404 });
      return Response.json(response(existing), { status: 409 });
    }
    return Response.json(response(job));
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
