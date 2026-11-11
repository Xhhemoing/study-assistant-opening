import { expect, it, vi } from "vitest";
import { readOpeningProviderStream } from "./provider-stream";

const delta = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
const finish = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
function memoryStream(parts: string[]) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const part of parts) controller.enqueue(new TextEncoder().encode(delta(part)));
    controller.enqueue(new TextEncoder().encode(finish));
  } });
}

// Actual pure SSE reader. No fetch, network, receipt double, or provider invocation.
it("admits exactly 50,000 accumulated characters, including multibyte text, before finishing", async () => {
  const parts = ["a".repeat(49_999), "é"], delivered = vi.fn();
  const result = await readOpeningProviderStream(memoryStream(parts), { signal: new AbortController().signal,
    onChunk: () => {}, onTextDelta: delivered });
  expect(result.text).toBe(parts.join(""));
  expect(delivered.mock.calls).toEqual(parts.map(text => [text]));
});
it("withholds the entire delta that would exceed the accumulated answer limit, not just final success", async () => {
  const parts = ["a".repeat(49_999), "éx"], delivered: string[] = [];
  const outcome = await readOpeningProviderStream(memoryStream(parts), { signal: new AbortController().signal,
    onChunk: () => {}, onTextDelta: text => { delivered.push(text); } })
    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  expect(outcome).toMatchObject({ ok: false, error: { code: "PROVIDER_RESPONSE", message: "provider answer is too large" } });
  expect(delivered).toEqual([parts[0]]);
});
