import { writingStartInputSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import {
  createWritingWorkspaceService,
  isOpeningWritingError,
  mapOpeningWritingErrorToResponse,
} from "../../../../features/opening/server/writing-workspace-service";

function withPrivateNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);

    let rawBody: unknown;
    try {
      rawBody = await readOpeningJsonBody(request);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return withPrivateNoStore(
          Response.json(
            { error: { code: "VALIDATION", message: "请求体不是有效的 JSON。" } },
            { status: 400 },
          ),
        );
      }
      throw error;
    }

    const parsed = writingStartInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      return withPrivateNoStore(
        Response.json(
          { error: { code: "VALIDATION", message: "创建写作工作区参数格式不正确。" } },
          { status: 400 },
        ),
      );
    }

    const workspace = await createWritingWorkspaceService(sql).start(scope, parsed.data);
    return withPrivateNoStore(Response.json(workspace, { status: 201 }));
  } catch (error) {
    if (isOpeningWritingError(error)) {
      return mapOpeningWritingErrorToResponse(error);
    }
    return withPrivateNoStore(jsonError(mapDomainError(error)));
  }
}
