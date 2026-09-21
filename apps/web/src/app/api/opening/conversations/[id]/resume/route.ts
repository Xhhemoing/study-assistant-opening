import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import {
  getTutorService,
  requireOpeningScope,
} from "../../../../../../features/opening/runtime";
import { TutorServiceError } from "../../../../../../features/opening/tutor/tutor-service";
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

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const { scope, sql } = await requireOpeningScope(request);
    const url = new URL(request.url);
    const sourceIds = url.searchParams.getAll("sourceId");
    const pageRaw = url.searchParams.get("currentPage");
    const chunkId = url.searchParams.get("chunkId");
    const sticky =
      sourceIds.length || pageRaw || chunkId
        ? {
            sourceIds,
            currentPage: pageRaw ? Number(pageRaw) : null,
            chunkId,
          }
        : undefined;
    const resume = await getTutorService(sql).resumeConversation(scope, id, {
      sticky,
    });
    return Response.json(resume);
  } catch (error) {
    return tutorError(error);
  }
}
