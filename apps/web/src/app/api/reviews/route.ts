import {
  gradeReviewForPrincipal,
  listReviewQueueForPrincipal,
} from "../../../features/review/review-service";
import { jsonError, mapDomainError, requirePrincipal } from "../../../features/auth/service";
import { getAuthRuntime } from "../../../server/runtime";
import { openingContentDelivery } from "../../../features/opening/server/content-delivery";
import { contentDeliveryHeaders, contentDeliveryReleaseKey } from "../../../features/opening/content-delivery";

export async function GET(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const mode = new URL(request.url).searchParams.get("mode");
    const key = contentDeliveryReleaseKey(request);
    const result = await listReviewQueueForPrincipal(runtime, principal, mode ? { mode } : {});
    const exposureReceipts = await openingContentDelivery(runtime.sql).cards({ workspaceId: principal.workspaceId, ownerUserId: principal.userId }, key, result.items.map(item => item.card));
    return Response.json({ ...result, exposureReceipts }, { headers: contentDeliveryHeaders(exposureReceipts) });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const result = await gradeReviewForPrincipal(runtime, principal, await request.json());
    return Response.json(result, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
