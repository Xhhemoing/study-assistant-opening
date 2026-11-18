import { assetGraphQuerySchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import {
  createAssetGraphService,
  isOpeningAssetGraphError,
} from "../../../../../features/opening/server/asset-graph-service";

const MAX_ASSET_GRAPH_QUERY_BYTES = 16_384;

function withPrivateNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);

    let rawBody: unknown;
    try {
      rawBody = await readOpeningJsonBody(request, MAX_ASSET_GRAPH_QUERY_BYTES);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return withPrivateNoStore(
          Response.json(
            { error: { code: "VALIDATION", message: "请求体不是有效的 JSON。" } },
            { status: 400 },
          ),
        );
      }
      throw err;
    }

    const parsed = assetGraphQuerySchema.safeParse(rawBody);
    if (!parsed.success) {
      return withPrivateNoStore(
        Response.json(
          { error: { code: "VALIDATION", message: "查询参数格式不正确，请调整筛选条件后再试。" } },
          { status: 400 },
        ),
      );
    }

    const service = createAssetGraphService(sql);
    const page = await service.query(scope, parsed.data);
    return withPrivateNoStore(Response.json(page, { status: 200 }));
  } catch (error) {
    if (isOpeningAssetGraphError(error)) {
      if (error.code === "CURSOR_STALE") {
        return withPrivateNoStore(
          Response.json(
            { error: { code: "CURSOR_STALE", message: error.message } },
            { status: 409 },
          ),
        );
      }
      if (error.code === "NOT_FOUND") {
        return withPrivateNoStore(
          Response.json(
            { error: { code: "NOT_FOUND", message: "请求的资源不可用。" } },
            { status: 404 },
          ),
        );
      }
      if (error.code === "VALIDATION") {
        return withPrivateNoStore(
          Response.json(
            { error: { code: "VALIDATION", message: error.message } },
            { status: 400 },
          ),
        );
      }
      if (error.code === "CONFLICT") {
        return withPrivateNoStore(
          Response.json(
            { error: { code: "CONFLICT", message: error.message } },
            { status: 409 },
          ),
        );
      }
    }
    return withPrivateNoStore(jsonError(mapDomainError(error)));
  }
}
