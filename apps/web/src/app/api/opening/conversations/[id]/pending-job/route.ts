import { createOpeningTutorJobsRepository } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";

type Params = { params: Promise<{ id: string }> };

/** Discover only an active pending Tutor job in the caller's conversation. */
export async function GET(request: Request, context: Params): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const job = await createOpeningTutorJobsRepository(sql).findPendingForConversation(
      scope,
      id,
    );
    return Response.json(
      job
        ? {
            id: job.id,
            status: job.status,
            error: job.error ? { message: job.error.message } : null,
            updatedAt: job.updatedAt,
          }
        : null,
    );
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
