import { jsonError, mapDomainError } from "../../../../features/auth/service";
import {
  getTutorService,
  requireOpeningScope,
} from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { TutorServiceError } from "../../../../features/opening/tutor/tutor-service";
import { OpeningConversationError } from "@aistudy/database";
import { uuidSchema } from "@aistudy/contracts";
import { randomUUID } from "node:crypto";

function requestCorrelationId(request: Request): string {
  const value = request.headers.get("x-request-id");
  if (value === null) return randomUUID();
  if (!uuidSchema.safeParse(value).success) {
    throw new TutorServiceError("VALIDATION", "请求关联 ID 无效", 422);
  }
  return value;
}

function tutorError(error: unknown): Response {
  if (error instanceof TutorServiceError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof OpeningConversationError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      {
        status:
          error.code === "NOT_FOUND"
            ? 404
            : error.code === "CONFLICT"
              ? 409
              : 400,
      },
    );
  }
  return jsonError(mapDomainError(error));
}

export async function POST(request: Request): Promise<Response> {
  let correlationId: string | null = null;
  try {
    correlationId = requestCorrelationId(request);
    const { scope, sql } = await requireOpeningScope(request);
    const body = await readOpeningJsonBody(request);
    const result = await getTutorService(sql).submitTurn(scope, body);
    return Response.json(
      { jobId: result.jobId, turnId: result.turnId },
      { status: 201, headers: { "x-request-id": correlationId } },
    );
  } catch (error) {
    const response = tutorError(error);
    if (correlationId) response.headers.set("x-request-id", correlationId);
    return response;
  }
}
