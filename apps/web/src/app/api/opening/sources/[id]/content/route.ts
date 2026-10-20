import { z } from "zod";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { openingQueries } from "../../../../../../features/opening/server/data-services";
import { openingContentDelivery } from "../../../../../../features/opening/server/content-delivery";
import { contentDeliveryHeaders, contentDeliveryReleaseKey } from "../../../../../../features/opening/content-delivery";
const parameters = z.object({ version: z.coerce.number().int().nonnegative().optional(), page: z.coerce.number().int().positive().optional() });
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const id = z.string().uuid().parse((await context.params).id);
    const query = new URL(request.url).searchParams;
    const input = parameters.parse({ version: query.get("version") ?? undefined, page: query.get("page") ?? undefined });
    const key = contentDeliveryReleaseKey(request);
    const content = await openingQueries(sql).sourceContent(scope, id, input);
    const exposureReceipts = await openingContentDelivery(sql).source(scope, key, content);
    return Response.json({ ...content, exposureReceipts }, { headers: contentDeliveryHeaders(exposureReceipts) });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
