import { memoryDecisionSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError, ApiError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { createOpeningMemoryService } from "../../../../../../features/opening/memory/memory-service";

/**
 * User decision route only. Session principal required — model/worker callers
 * without a user session are rejected (401). Explicit x-opening-caller model/worker → 403.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const caller = request.headers.get("x-opening-caller");
    if (caller === "model" || caller === "worker") {
      throw new ApiError("WORKSPACE_FORBIDDEN", "memory decisions require a user session", 403);
    }
    const { principal, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const body = memoryDecisionSchema.parse({ ...(await request.json()), id });
    const item = await createOpeningMemoryService(sql).decideMemory(principal, body);
    return Response.json(item);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
