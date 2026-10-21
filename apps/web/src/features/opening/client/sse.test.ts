import { expect, it, vi } from "vitest";
import { readServerEvents } from "./sse";
import { createOpeningApi } from "./api";

const encoder = new TextEncoder();
const input = { text: "我的问题", sourceIds: [], mode: "listen" as const, history: [] };
const complete = { text: "最终回答", citedChunkIds: [], candidates: [], requestId: "request", inputTokens: 12, outputTokens: 8, privacyEpoch: 0, historyDiscarded: false };
function channel() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller; }, cancel }), {
    headers: { "content-type": "text/event-stream" },
  });
  return { response, writer, cancel, event: (event: string, body: unknown) => writer.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`)) };
}

it("decodes UTF-8 and CRLF split across arbitrary network chunks, including multiline data", async () => {
  const bytes = encoder.encode(": keepalive\r\nevent: delta\r\ndata: 中文\r\ndata: 第二行\r\n\r\n");
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }));
  const events = vi.fn();
  await readServerEvents(response, events);
  expect(events).toHaveBeenCalledExactlyOnceWith({ event: "delta", data: "中文\n第二行" });
});

it("shows ephemeral deltas while the POST is still open and returns only the validated complete response", async () => {
  const stream = channel();
  const transport = vi.fn<typeof fetch>().mockResolvedValue(stream.response);
  const api = createOpeningApi(transport);
  const delta = vi.fn();
  let finished = false;
  const result = api.replyEphemeral(input, undefined, delta).then(output => { finished = true; return output; });
  stream.event("delta", { delta: "先想一想 $x" });
  await vi.waitFor(() => expect(delta).toHaveBeenCalledWith("先想一想 $x"));
  expect(finished).toBe(false);
  expect(transport.mock.calls[0]?.[1]?.headers).toMatchObject({ accept: "text/event-stream" });
  stream.event("complete", complete);
  await expect(result).resolves.toMatchObject(complete);
  expect(stream.cancel).toHaveBeenCalledOnce();
  expect(transport).toHaveBeenCalledOnce();
});

it("does not replay a failed ephemeral POST or mistake a partial reply for completion", async () => {
  const stream = channel();
  const transport = vi.fn<typeof fetch>().mockResolvedValue(stream.response);
  const delta = vi.fn();
  const result = createOpeningApi(transport).replyEphemeral(input, undefined, delta);
  const rejected = expect(result).rejects.toMatchObject({ code: "STREAM_INCOMPLETE" });
  stream.event("delta", { delta: "还没写完" });
  stream.writer.close();
  await rejected;
  expect(delta).toHaveBeenCalledWith("还没写完");
  expect(transport).toHaveBeenCalledOnce();
});

it("reports SSE errors, and cancels a blocked reader on user abort without late deltas", async () => {
  const failed = channel();
  const rejected = expect(createOpeningApi(async () => failed.response).replyEphemeral(input, undefined, vi.fn()))
    .rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", message: "生成中断" });
  failed.event("error", { error: { code: "PROVIDER_TIMEOUT", message: "生成中断" } });
  await rejected;

  const stream = channel();
  const controller = new AbortController();
  const onDelta = vi.fn();
  const aborted = expect(createOpeningApi(async () => stream.response).replyEphemeral(input, controller.signal, onDelta))
    .rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(stream.response.body?.locked).toBe(true));
  controller.abort();
  await aborted;
  expect(stream.cancel).toHaveBeenCalledOnce();
  expect(onDelta).not.toHaveBeenCalled();
});

it("accepts JSON-only servers without retrying the submitted question", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(complete));
  const delta = vi.fn();
  await expect(createOpeningApi(transport).replyEphemeral(input, undefined, delta)).resolves.toMatchObject(complete);
  expect(delta).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledOnce();
});
