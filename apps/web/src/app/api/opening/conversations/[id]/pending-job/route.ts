import { z } from "zod";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { getTutorJobService } from "../../../../../../features/opening/server/data-services";

type Params = { params: Promise<{ id: string }> };

const clientKeyQuerySchema = z.string().min(1).max(200).refine(value => value.trim().length > 0);

/** Discover the latest active or outcome-unknown Tutor job in the caller's conversation (or a specific clientKey's active job). */
export async function GET(request: Request, context: Params): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const rawClientKey = new URL(request.url).searchParams.get("clientKey");
    const clientKey = rawClientKey === null ? undefined : clientKeyQuerySchema.parse(rawClientKey);
    const job = await getTutorJobService(sql).findPendingForConversation(
      scope,
      id,
      clientKey,
    );
    return Response.json(
      job
        ? {
            id: job.id,
            status: job.status,
            error: job.error ? { message: job.error.message } : null,
            updatedAt: job.updatedAt,
            ...(clientKey && job.clientKey ? { clientKey: job.clientKey } : {}),
          }
        : null,
    );
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
