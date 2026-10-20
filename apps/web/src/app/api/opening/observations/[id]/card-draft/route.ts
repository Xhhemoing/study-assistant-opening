import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getObservationService, requireOpeningScope } from "../../../../../../features/opening/runtime";
import { openingContentDelivery } from "../../../../../../features/opening/server/content-delivery";
import { contentDeliveryHeaders, contentDeliveryReleaseKey } from "../../../../../../features/opening/content-delivery";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const id = (await context.params).id;
    const key = contentDeliveryReleaseKey(request);
    const observations = getObservationService(sql);
    const draft = await observations.observationCardDraft(scope, id);
    const history = await observations.observationHistory(scope, id);
    const exposureReceipts = await openingContentDelivery(sql).history(scope, key, history.revisions.filter(row => row.id === history.headObservationId));
    return Response.json({ ...draft, exposureReceipts }, { headers: contentDeliveryHeaders(exposureReceipts) });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
