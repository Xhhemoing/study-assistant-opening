import { loadFeatureSwitches } from "@aistudy/config";
import { ApiError, jsonError, mapDomainError } from "../../../../../features/auth/service";
import { createConversationPlanService } from "../../../../../features/opening/planning/conversation-plan-service";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { requireOpeningScope } from "../../../../../features/opening/runtime";

async function run(request: Request, method: "inspect" | "propose") {
  let response: Response;
  try {
    const { sql, scope } = await requireOpeningScope(request);
    if (!loadFeatureSwitches().adaptivePlanning) throw new ApiError("NOT_FOUND", "对话计划草案尚未启用。", 404);
    const service = createConversationPlanService(sql);
    const result = method === "inspect"
      ? await service.inspect(scope, new URL(request.url).searchParams.get("candidateId"))
      : await service.propose(scope, await readOpeningJsonBody(request));
    response = Response.json(result, { status: method === "propose" && result.kind === "draft" ? 201 : 200 });
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const GET = (request: Request) => run(request, "inspect");
export const POST = (request: Request) => run(request, "propose");
