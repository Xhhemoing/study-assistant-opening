import { getAuthRuntime } from "../../../../server/runtime";
import { jsonError, mapDomainError, requirePrincipal } from "../../../../features/auth/service";
import { countDueReviewsForPrincipal } from "../../../../features/review/review-service";

/** Metadata only. Opening navigation must never deliver card answers or record exposure. */
export async function GET(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    return Response.json(await countDueReviewsForPrincipal(runtime, principal), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
