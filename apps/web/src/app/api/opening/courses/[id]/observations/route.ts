import { uuidSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getLearningReadService, requireOpeningScope } from "../../../../../../features/opening/runtime";
import { openingContentDelivery } from "../../../../../../features/opening/server/content-delivery";
import { contentDeliveryHeaders, contentDeliveryReleaseKey } from "../../../../../../features/opening/content-delivery";

/** Includes withdrawal heads for history inspection; owner and course checks precede reads. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const courseId = uuidSchema.parse((await context.params).id);
    const key = contentDeliveryReleaseKey(request);
    const observations = await getLearningReadService(sql).listLearningObservations(scope, courseId);
    const exposureReceipts = await openingContentDelivery(sql).history(scope, key, observations);
    return Response.json(observations, { headers: contentDeliveryHeaders(exposureReceipts) });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
