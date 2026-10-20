import {
  createDocumentForPrincipal,
  jsonError,
  listDocumentsForPrincipal,
  mapDomainError,
  requirePrincipal,
} from "../../../features/auth/service";
import { getAuthRuntime } from "../../../server/runtime";
import { openingContentDelivery } from "../../../features/opening/server/content-delivery";
import { contentDeliveryHeaders, contentDeliveryReleaseKey } from "../../../features/opening/content-delivery";

export async function GET(request: Request): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const key = contentDeliveryReleaseKey(request);
    const documents = await listDocumentsForPrincipal(runtime, principal);
    const delivery = openingContentDelivery(runtime.sql);
    const exposureReceipts = [];
    // This legacy list includes document blocks, so those bodies are actual delivery too.
    for (const document of documents) if (document.blocks.length) exposureReceipts.push(...await delivery.note({ workspaceId: principal.workspaceId, ownerUserId: principal.userId }, `${key}:${document.id}`, document));
    return Response.json({ documents, exposureReceipts }, { headers: contentDeliveryHeaders(exposureReceipts) });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const body = await request.json();
    const doc = await createDocumentForPrincipal(runtime, principal, body);
    return Response.json({ document: doc }, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
