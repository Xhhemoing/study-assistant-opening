import {
  uuidSchema,
  writingCommandInputSchema,
  writingWorkspaceResponseSchema,
} from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import {
  createWritingWorkspaceService,
  isOpeningWritingError,
  mapOpeningWritingErrorToResponse,
} from "../../../../../features/opening/server/writing-workspace-service";

type Params = { params: Promise<{ documentId: string }> };

function withPrivateNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: Request, context: Params): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const { documentId } = await context.params;
    if (!uuidSchema.safeParse(documentId).success) {
      return withPrivateNoStore(
        Response.json(
          { error: { code: "VALIDATION", message: "笔记编号格式无效。" } },
          { status: 400 },
        ),
      );
    }

    const url = new URL(request.url);
    const focusBlockParam = url.searchParams.get("focusBlock");
    const activityParam = url.searchParams.get("activity");
    const requestedFocusBlockId = focusBlockParam && focusBlockParam.trim()
      ? focusBlockParam.trim()
      : null;
    if (requestedFocusBlockId && requestedFocusBlockId.length > 120) {
      return withPrivateNoStore(
        Response.json(
          { error: { code: "VALIDATION", message: "定位段落标识过长。" } },
          { status: 400 },
        ),
      );
    }
    const activityId = activityParam && activityParam.trim() ? activityParam.trim() : null;
    if (activityId && !uuidSchema.safeParse(activityId).success) {
      return withPrivateNoStore(
        Response.json(
          { error: { code: "VALIDATION", message: "活动编号格式无效。" } },
          { status: 400 },
        ),
      );
    }

    const view = await createWritingWorkspaceService(sql).getView(scope, documentId, {
      requestedFocusBlockId,
      activityId,
    });
    const payload = writingWorkspaceResponseSchema.parse(
      view ? { initialized: true, workspace: view } : { initialized: false, documentId },
    );
    return withPrivateNoStore(Response.json(payload, { status: 200 }));
  } catch (error) {
    if (isOpeningWritingError(error)) {
      return mapOpeningWritingErrorToResponse(error);
    }
    return withPrivateNoStore(jsonError(mapDomainError(error)));
  }
}

export async function POST(request: Request, context: Params): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const { documentId } = await context.params;
    if (!uuidSchema.safeParse(documentId).success) {
      return withPrivateNoStore(
        Response.json(
          { error: { code: "VALIDATION", message: "笔记编号格式无效。" } },
          { status: 400 },
        ),
      );
    }

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

    const parsed = writingCommandInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      return withPrivateNoStore(
        Response.json(
          { error: { code: "VALIDATION", message: "写作区指令格式不正确。" } },
          { status: 400 },
        ),
      );
    }

    const result = await createWritingWorkspaceService(sql).command(scope, documentId, parsed.data);
    return withPrivateNoStore(Response.json(result, { status: 200 }));
  } catch (error) {
    if (isOpeningWritingError(error)) {
      return mapOpeningWritingErrorToResponse(error);
    }
    return withPrivateNoStore(jsonError(mapDomainError(error)));
  }
}
