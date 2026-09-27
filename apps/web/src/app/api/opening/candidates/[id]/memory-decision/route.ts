import { memoryCandidateDecisionSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError, ApiError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { createOpeningMemoryCandidateServiceFromSql } from "../../../../../../features/opening/memory/memory-candidate-service";

/**
 * User decision for an assistant memory candidate. Session required.
 * Explicit model/worker callers are rejected; the model cannot auto-confirm.
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
    const body = memoryCandidateDecisionSchema.parse({
      ...(await readOpeningJsonBody(request) as Record<string, unknown>),
      id,
    });
    const item = await createOpeningMemoryCandidateServiceFromSql(sql).decideCandidate(principal, body);
    return Response.json(item);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
