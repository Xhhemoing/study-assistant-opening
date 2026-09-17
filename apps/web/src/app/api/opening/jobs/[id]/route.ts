import { createOpeningTutorJobsRepository } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";

type Params = { params: Promise<{ id: string }> };

/** Honest tutor job polling: actual status and error, no bodies or tokens. */
export async function GET(request: Request, context: Params): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const job = await createOpeningTutorJobsRepository(sql).get(scope, id);
    if (!job) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "job not found" } },
        { status: 404 },
      );
    }
    return Response.json({
      id: job.id,
      status: job.status,
      error: job.error,
      updatedAt: job.updatedAt,
    });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
