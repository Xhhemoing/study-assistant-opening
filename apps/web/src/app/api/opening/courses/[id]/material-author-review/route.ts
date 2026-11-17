import { uuidSchema } from "@aistudy/contracts";
import { ApiError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import {
  disabledMaterialAuthorReviewManifestReader,
  loadMaterialAuthorReviewHost,
} from "../../../../../../features/opening/materials/server/material-author-review-host";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const messages: Record<number, string> = {
  400: "Invalid material review selection", 401: "Authentication required",
  404: "Material review not found", 409: "Material review is no longer available",
  503: "Material review temporarily unavailable",
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    // Authentication always precedes selectors; query/body cannot choose owner.
    const { sql, scope } = await requireOpeningScope(request);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => !["sourceId", "version"].includes(key))
      || query.getAll("sourceId").length !== 1 || query.getAll("version").length !== 1) {
      throw new ApiError("VALIDATION", messages[400]!, 400);
    }
    const courseId = uuidSchema.parse((await context.params).id);
    const sourceId = uuidSchema.parse(query.get("sourceId"));
    const rawVersion = query.get("version")!;
    const version = Number(rawVersion);
    if (!/^(0|[1-9]\d*)$/.test(rawVersion) || !Number.isSafeInteger(version) || version > 2_147_483_647) {
      throw new ApiError("VALIDATION", messages[400]!, 400);
    }
    const review = await loadMaterialAuthorReviewHost(sql, scope, { courseId, sourceId, version },
      disabledMaterialAuthorReviewManifestReader);
    return Response.json(review, { headers });
  } catch (error) {
    const mapped = mapDomainError(error);
    const status = mapped.status === 403 ? 404 : messages[mapped.status] ? mapped.status : 503;
    const code = status === 404 ? "NOT_FOUND" : status === 503 ? "UNAVAILABLE" : mapped.code;
    // Repository/parser/unexpected failures may contain IDs, SQL or raw data.
    return Response.json({ error: { code, message: messages[status] } }, { status, headers });
  }
}
