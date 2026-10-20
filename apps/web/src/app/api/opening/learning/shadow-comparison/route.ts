import { z } from "zod";
import { createLearnerShadowComparisonService } from "../../../../../features/opening/teaching/learner-shadow-service";
import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
const inputSchema = z.object({ courseId: z.string().uuid().optional() }).strict();

/** Owner-scoped experimental comparison. Never recomputes forecasts or changes learning facts. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const input = inputSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const report = await createLearnerShadowComparisonService(sql).read(scope, input);
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
