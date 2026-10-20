import {
  jsonError,
  listRevisionsForPrincipal,
  mapDomainError,
  requirePrincipal,
} from "../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../server/runtime";
import { openingContentDelivery } from "../../../../../features/opening/server/content-delivery";
import { contentDeliveryHeaders, contentDeliveryReleaseKey } from "../../../../../features/opening/content-delivery";

type Params = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: Params,
): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const key = contentDeliveryReleaseKey(request);
    const revisions = await listRevisionsForPrincipal(runtime, principal, id);
    const delivery = openingContentDelivery(runtime.sql);
    const exposureReceipts = [];
    for (const revision of revisions) exposureReceipts.push(...await delivery.note({ workspaceId: principal.workspaceId, ownerUserId: principal.userId }, `${key}:${revision.revisionNumber}`, { id, currentRevisionNumber: revision.revisionNumber }));
    return Response.json({ revisions, exposureReceipts }, { headers: contentDeliveryHeaders(exposureReceipts) });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
