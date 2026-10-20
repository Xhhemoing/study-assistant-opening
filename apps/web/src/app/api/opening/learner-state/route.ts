import { z } from "zod";
import { createLearnerStateReadService } from "../../../../features/opening/teaching/learner-state-service";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
const querySchema = z.object({ courseId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict();
/** Live qualification read only: no repair and no learning mutation. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(await createLearnerStateReadService(sql).read(scope, input), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
