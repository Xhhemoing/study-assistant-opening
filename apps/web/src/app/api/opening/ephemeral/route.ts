import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import {
  getEphemeralTutorService,
  requireOpeningScope,
} from "../../../../features/opening/runtime";
import { EphemeralServiceError } from "../../../../features/opening/tutor/ephemeral-service";
import { OpeningModelRoutingError, OpeningProviderError } from "@aistudy/ai";
import { isOpeningDataError } from "../../../../features/opening/server/data-services";

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
  if (isOpeningDataError(error, "budget")) {
    const status = error.code === "BUDGET_EXCEEDED" || error.code === "REQUEST_CAP_EXCEEDED" ? 429 : error.code === "NOT_FOUND" ? 404 : 409;
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
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      const encoder = new TextEncoder(), abort = new AbortController();
      let closed = false;
      const stop = () => abort.abort();
      request.signal.addEventListener("abort", stop, { once: true });
      if (request.signal.aborted) stop();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: string, data: unknown) => {
            if (!closed && !abort.signal.aborted) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          void (async () => {
            try {
              const output = await getEphemeralTutorService(sql).replyEphemeral(scope, body as never, abort.signal,
                delta => send("delta", { delta }));
              send("complete", output);
            } catch (error) {
              const response = ephemeralError(error);
              send("error", await response.json());
            } finally {
              request.signal.removeEventListener("abort", stop);
              if (!closed) { closed = true; controller.close(); }
            }
          })();
        },
        cancel() { closed = true; stop(); request.signal.removeEventListener("abort", stop); },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
    }
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
