import { openingModelProbeInputSchema, uuidSchema } from "@aistudy/contracts";
import { probeModel } from "../../../../../../../../features/opening/settings/model-probe-service";
import { ApiError, jsonError, mapDomainError } from "../../../../../../../../features/auth/service";
import { readOpeningJsonBody } from "../../../../../../../../features/opening/request-body";
import { requireOpeningScope } from "../../../../../../../../features/opening/runtime";

export async function POST(request: Request, context: { params: Promise<{ id: string; modelId: string }> }) {
  let response: Response;
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const ids = await context.params;
    const body = openingModelProbeInputSchema.safeParse(await readOpeningJsonBody(request, 1024));
    if (!uuidSchema.safeParse(ids.id).success || !uuidSchema.safeParse(ids.modelId).success || !body.success) {
      throw new ApiError("VALIDATION", "模型或测试请求无效。", 422);
    }
    response = Response.json(await probeModel(sql, scope, ids, body.data.clientKey));
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
