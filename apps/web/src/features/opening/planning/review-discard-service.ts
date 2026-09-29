import { z } from "zod";
import { candidateRefSchema } from "@aistudy/contracts";
import { discardOpeningAssistantTask, discardOpeningRetest, OpeningPlanError } from "@aistudy/database";
import { ApiError, jsonError, mapDomainError } from "../../auth/service";
import { requireOpeningScope } from "../runtime";
import { readOpeningJsonBody } from "../request-body";
const bodySchema = z.object({ candidateRef: candidateRefSchema, clientKey: z.string().min(8).max(200) }).strict();
export async function discardReviewCandidate(request: Request, id: string, origin: "assistant" | "retest"): Promise<Response> {
  try {
    if (["worker", "model"].includes(request.headers.get("x-opening-caller") ?? "")) throw new ApiError("WORKSPACE_FORBIDDEN", "a user decision is required", 403);
    const { sql, scope } = await requireOpeningScope(request);
    const { candidateRef: ref, clientKey } = bodySchema.parse(await readOpeningJsonBody(request));
    if (ref.id !== id || ref.origin !== origin || ref.kind !== (origin === "assistant" ? "task" : "retest")) throw new ApiError("VALIDATION", "candidate reference does not match this action", 400);
    const result = origin === "assistant" ? await discardOpeningAssistantTask(sql, scope, id) : await discardOpeningRetest(sql, scope, id, clientKey);
    return Response.json(result);
  } catch (error) {
    if (error instanceof OpeningPlanError) return jsonError(new ApiError(error.code, error.message, error.code === "NOT_FOUND" ? 404 : error.code === "VALIDATION" ? 400 : 409));
    return jsonError(mapDomainError(error));
  }
}
