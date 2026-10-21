import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInput } from "@aistudy/contracts";
import { createOpeningProvider, openingProviderRequestBody } from "./provider";

const input: ProviderInput = { instruction: "Teach", text: "Explain", chunks: [], mode: "explain", maxOutputTokens: 100,
  mediaCapability: "text_only", imageParts: [], outputFormat: "markdown" };
const encoder = new TextEncoder();
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const delta = (content: string) => event({ id: "stream-1", choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const stop = event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const usage = event({ choices: [], usage: { prompt_tokens: 24, completion_tokens: 8 } });
const done = "data: [DONE]\r\n\r\n";
function harness(idleTimeoutMs = 60_000) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const provider = createOpeningProvider({ baseUrl: "https://model.example", apiKey: "key", model: "model", fetchImpl, idleTimeoutMs });
  return { provider, cancel, fetchImpl, write: (value: string | Uint8Array) => controller.enqueue(typeof value === "string" ? encoder.encode(value) : value), close: () => controller.close() };
}
afterEach(() => vi.useRealTimers());

describe("direct Markdown streaming", () => {
  it("sends an unwrapped streaming request and decodes UTF-8, CRLF, multiline events and trailing usage", async () => {
    const h = harness(), received: string[] = [];
    const pending = h.provider.complete(input, undefined, async text => { received.push(text); });
    const raw = ": heartbeat\r\n\r\n" + delta("你好 **World**\n$1+1=2$")
      + "data: {\r\ndata: \"choices\": [{\"index\":0,\"delta\":{\"content\":\"!\"}}]}\r\n\r\n" + stop + usage + done;
    for (const byte of encoder.encode(raw)) h.write(new Uint8Array([byte]));
    const output = await pending;
    expect(received).toEqual(["你好 **World**\n$1+1=2$", "!"]);
    expect(output).toMatchObject({ text: received.join(""), requestId: "stream-1", inputTokens: 24, outputTokens: 8, candidates: [], citedChunkIds: [] });
    const request = JSON.parse(h.fetchImpl.mock.calls[0]![1].body);
    expect(request).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(request.response_format).toBeUndefined();
    expect(request.messages[0].content).toContain("直接输出 Markdown");
    expect(h.cancel).toHaveBeenCalledOnce();
  });

  it("preserves JSON/tool non-stream requests and leaves absent stream usage unknown", async () => {
    expect(openingProviderRequestBody({ ...input, outputFormat: "json" }, { model: "model" })).toMatchObject({ response_format: { type: "json_object" } });
    const h = harness();
    h.write(delta("answer") + stop + done);
    expect(await h.provider.complete(input)).toMatchObject({ text: "answer", inputTokens: null, outputTokens: null });
  });

  it.each([
    ["early EOF", delta("partial")],
    ["missing stop", delta("partial") + done],
    ["empty answer", stop + done],
    ["truncation", delta("partial") + event({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }) + done],
    ["embedded rate limit", delta("partial") + event({ error: { code: 429, message: "late failure" } })],
    ["malformed event", "data: {bad}\n\n"],
    ["tool call", event({ choices: [{ index: 0, delta: { tool_calls: [{}] } }] })],
  ])("does not turn %s into a complete answer", async (_name, raw) => {
    const h = harness(); h.write(raw); h.close();
    await expect(h.provider.complete(input)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE", requestSent: true });
  });

  it("treats a streamed refusal as a sent failure", async () => {
    const h = harness(); h.write(event({ choices: [{ index: 0, delta: { refusal: "refused" } }] }));
    await expect(h.provider.complete(input)).rejects.toMatchObject({ code: "PROVIDER_REFUSAL", requestSent: true });
    expect(h.cancel).toHaveBeenCalledOnce();
  });

  it("cancels the body when delivering a delta fails", async () => {
    const h = harness(); h.write(delta("partial"));
    await expect(h.provider.complete(input, undefined, async () => { throw new Error("Redis unavailable"); }))
      .rejects.toMatchObject({ code: "PROVIDER_RESPONSE", requestSent: true });
    expect(h.cancel).toHaveBeenCalledOnce();
  });

  it("resets the 60-second idle deadline for arriving bytes, even before a full SSE event", async () => {
    vi.useFakeTimers();
    const h = harness(), received: string[] = [];
    const pending = h.provider.complete(input, undefined, text => { received.push(text); });
    await vi.advanceTimersByTimeAsync(59_000);
    h.write("data: "); await vi.advanceTimersByTimeAsync(59_000);
    h.write(delta("answer").slice(6)); await vi.advanceTimersByTimeAsync(59_000);
    h.write(stop + usage + done);
    expect(await pending).toMatchObject({ text: "answer", outputTokens: 8 });
    expect(received).toEqual(["answer"]);
  });

  it("times out stalled streams and stalled async delivery without returning partial success", async () => {
    vi.useFakeTimers();
    for (const stallCallback of [false, true]) {
      const h = harness();
      const pending = h.provider.complete(input, undefined, stallCallback ? () => new Promise<void>(() => undefined) : undefined);
      const failed = expect(pending).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", requestSent: true });
      h.write(delta("partial")); await vi.advanceTimersByTimeAsync(60_000);
      await failed;
      expect(h.cancel).toHaveBeenCalledOnce();
    }
  });

  it("distinguishes caller cancellation after a partial answer from idle timeout", async () => {
    const h = harness(), caller = new AbortController();
    h.write(delta("partial"));
    const pending = h.provider.complete(input, caller.signal, () => caller.abort());
    await expect(pending).rejects.toMatchObject({ code: "PROVIDER_ABORTED", requestSent: true });
    expect(h.cancel).toHaveBeenCalledOnce();
  });
});
