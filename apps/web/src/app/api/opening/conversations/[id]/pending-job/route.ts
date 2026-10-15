import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { getTutorJobService } from "../../../../../../features/opening/server/data-services";

type Params = { params: Promise<{ id: string }> };

/** Discover the latest active or outcome-unknown Tutor job in the caller's conversation. */
export async function GET(request: Request, context: Params): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const job = await getTutorJobService(sql).findPendingForConversation(
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
