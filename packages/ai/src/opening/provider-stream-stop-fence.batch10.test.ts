import { expect, it, vi } from "vitest";
import { readOpeningProviderStream } from "./provider-stream";

const event = (content: string | null, finishReason: "stop" | null) => `data: ${JSON.stringify({
  choices: [{ index: 0, delta: content == null ? {} : { content }, finish_reason: finishReason }],
})}\n\n`;
function memoryStream(text: string) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); }, cancel });
  return { body, cancel };
}

// Actual pure SSE reader and native in-memory Web Stream; no fetch or provider.
it("rejects nonempty text after stop before it reaches a second consumer callback", async () => {
  const { body, cancel } = memoryStream(event("accepted", "stop") + event("must-not-display", null) + "data: [DONE]\n\n");
  const delivered: string[] = [];
  await expect(readOpeningProviderStream(body, { signal: new AbortController().signal, onChunk: () => {},
    onTextDelta: text => { delivered.push(text); } })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE", message: "provider sent text after completing the answer" });
  expect(delivered).toEqual(["accepted"]); expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
});
it("permits an empty post-stop delta and trailing usage without a second consumer callback", async () => {
  const { body, cancel } = memoryStream(event("accepted", "stop") + event("", null)
    + 'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
  const delivered = vi.fn();
  expect(await readOpeningProviderStream(body, { signal: new AbortController().signal, onChunk: () => {}, onTextDelta: delivered }))
    .toMatchObject({ text: "accepted", inputTokens: 8, outputTokens: 3 });
  expect(delivered).toHaveBeenCalledExactlyOnceWith("accepted"); expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
});
