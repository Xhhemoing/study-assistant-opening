import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getObservationService, requireOpeningScope } from "../../../../../../features/opening/runtime";
import { openingContentDelivery } from "../../../../../../features/opening/server/content-delivery";
import { contentDeliveryHeaders, contentDeliveryReleaseKey } from "../../../../../../features/opening/content-delivery";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const key = contentDeliveryReleaseKey(request);
    const history = await getObservationService(sql).observationHistory(scope, (await context.params).id);
    const exposureReceipts = await openingContentDelivery(sql).history(scope, key, history.revisions);
    return Response.json({ ...history, exposureReceipts }, { headers: contentDeliveryHeaders(exposureReceipts) });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
