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
    const status =
      error.code === "NOT_FOUND" ? 404 : error.code === "VALIDATION" ? 400 : 409;
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status },
    );
  }
  return jsonError(mapDomainError(error));
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const rows = await getTutorService(sql).listConversations(scope);
    return Response.json(rows);
  } catch (error) {
    return tutorError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const body = await request.json();
    const created = await getTutorService(sql).createConversation(scope, body);
    return Response.json(created, { status: 201 });
  } catch (error) {
    return tutorError(error);
  }
}
