import { readOpeningCourseLearningSummary } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import { parseCourseLearningSummaryRequest } from "../../../../../../../features/opening/learning/summary-page-service";

/** Owner-scoped, fixed-snapshot group summary. Legacy /learning remains unchanged. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const input = parseCourseLearningSummaryRequest((await context.params).id, new URL(request.url).searchParams);
    return Response.json(await readOpeningCourseLearningSummary(sql, scope, input));
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
