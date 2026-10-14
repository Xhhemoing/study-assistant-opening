import { loadFeatureSwitches } from "@aistudy/config";
import { conversationLearningPreviewInputSchema } from "@aistudy/contracts";
import { ApiError, jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { previewConversationLearningFromWorkspace } from "../../../../../features/opening/server/conversation-learning-service";

/**
 * POST /api/opening/learning-agent/preview
 * Read-only: no tasks, drafts, learning observations or accepted blocks are written.
 * Requires authenticated workspace and OPENING_ADAPTIVE_PLANNING=1.
 */
export async function POST(request: Request): Promise<Response> {
  let response: Response;
  try {
    const { sql, scope } = await requireOpeningScope(request);
    if (!loadFeatureSwitches().adaptivePlanning) {
      throw new ApiError("NOT_FOUND", "学习编排预览尚未启用。", 404);
    }
    const input = conversationLearningPreviewInputSchema.parse(await readOpeningJsonBody(request, 8_192));
    response = Response.json(await previewConversationLearningFromWorkspace(sql, scope, input));
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
