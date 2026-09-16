import { jsonError, mapDomainError } from "../../../../features/auth/service";
import {
  getTutorService,
  requireOpeningScope,
} from "../../../../features/opening/runtime";
import { TutorServiceError } from "../../../../features/opening/tutor/tutor-service";
import { OpeningConversationError } from "@aistudy/database";

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
      { status: error.code === "NOT_FOUND" ? 404 : 400 },
    );
  }
  return jsonError(mapDomainError(error));
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const body = await request.json();
    const result = await getTutorService(sql).submitTurn(scope, body, {
      authorizedChunks: [],
    });
    return Response.json(
      { jobId: result.jobId, turnId: result.turnId },
      { status: 201 },
    );
  } catch (error) {
    return tutorError(error);
  }
}
