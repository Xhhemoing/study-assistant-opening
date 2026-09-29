import { OpeningNoteError } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { createOpeningSnippetService } from "../../../../features/opening/snippets/snippet-service";

export async function POST(request: Request): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const saved = await createOpeningSnippetService(sql).save(principal, await readOpeningJsonBody(request));
    return Response.json(saved, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = error instanceof OpeningNoteError
      ? Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "NOT_FOUND" ? 404 : 409 })
      : jsonError(mapDomainError(error));
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
