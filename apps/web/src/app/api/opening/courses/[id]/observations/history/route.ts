import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import { parseCourseLearningHistoryRequest } from "../../../../../../../features/opening/learning/history-service";
import { openingQueries } from "../../../../../../../features/opening/server/data-services";
import { openingContentDelivery } from "../../../../../../../features/opening/server/content-delivery";
import { contentDeliveryHeaders, contentDeliveryReleaseKey } from "../../../../../../../features/opening/content-delivery";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const input = parseCourseLearningHistoryRequest((await context.params).id, new URL(request.url).searchParams);
    const key = contentDeliveryReleaseKey(request);
    const history = await openingQueries(sql).courseLearningHistory(scope, input);
    const exposureReceipts = await openingContentDelivery(sql).history(scope, key, history.observations);
    return Response.json({ ...history, exposureReceipts }, { headers: contentDeliveryHeaders(exposureReceipts) });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
