import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import { parseCourseLearningSummaryRequest } from "../../../../../../../features/opening/learning/summary-page-service";
import { openingQueries } from "../../../../../../../features/opening/server/data-services";

/** Owner-scoped, fixed-snapshot group summary. Legacy /learning remains unchanged. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const input = parseCourseLearningSummaryRequest((await context.params).id, new URL(request.url).searchParams);
    return Response.json(await openingQueries(sql).courseLearningSummary(scope, input));
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
