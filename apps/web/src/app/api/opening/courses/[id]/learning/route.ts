import { uuidSchema } from "@aistudy/contracts";
import { ApiError, jsonError, mapDomainError } from "../../../../../../features/auth/service";
import {
  getLearningReadService,
  requireOpeningScope,
} from "../../../../../../features/opening/runtime";

type Params = { params: Promise<{ id: string }> };

function asApiError(error: unknown): ApiError {
  const mapped = mapDomainError(error);
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "UNAVAILABLE"
  ) {
    return new ApiError("CONFIGURATION", mapped.message, 503);
  }
  return mapped;
}

/** Owner-scoped course summary. Empty evidence is [], never seeded demo data. */
export async function GET(request: Request, context: Params): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const courseId = uuidSchema.parse(id);
    const summary = await getLearningReadService(sql).summarizeLearning(scope, courseId);
    return Response.json(summary);
  } catch (error) {
    return jsonError(asApiError(error));
  }
}
