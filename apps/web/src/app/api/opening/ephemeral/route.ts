import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import {
  getEphemeralTutorService,
  requireOpeningScope,
} from "../../../../features/opening/runtime";
import { EphemeralServiceError } from "../../../../features/opening/tutor/ephemeral-service";
import { OpeningBudgetError } from "@aistudy/database";
import { OpeningModelRoutingError, OpeningProviderError } from "@aistudy/ai";

function ephemeralError(error: unknown): Response {
  if (error instanceof OpeningModelRoutingError) return Response.json({ error: { code: error.code, message: error.message } }, { status: 409 });
  if (error instanceof EphemeralServiceError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof OpeningProviderError) {
    const status = error.code === "PROVIDER_ABORTED" ? 499 : 503;
    return Response.json(
      { error: { code: error.code, message: "provider request failed" } },
      { status },
    );
  }
  if (error instanceof OpeningBudgetError) {
    const status = error.code === "BUDGET_EXCEEDED" ? 429 : error.code === "NOT_FOUND" ? 404 : 409;
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status },
    );
  }
  return jsonError(mapDomainError(error));
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const body = await readOpeningJsonBody(request);
    const output = await getEphemeralTutorService(sql).replyEphemeral(
      scope,
      body as never,
      request.signal,
    );
    return Response.json(output, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = ephemeralError(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
