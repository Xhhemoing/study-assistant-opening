import { expect, it, vi } from "vitest";
import { readOpeningProviderStream } from "./provider-stream";

const delta = (index: number, content: string) => `data: ${JSON.stringify({ choices: [{ index, delta: { content }, finish_reason: null }] })}\n\n`;
const finish = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
function memoryStream(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); } });
}

// Actual SSE parser; synthetic in-memory bytes only, no fetch or provider.
it("admits consecutive index-zero choices and preserves the exact callback text", async () => {
  const delivered = vi.fn();
  const result = await readOpeningProviderStream(memoryStream(delta(0, "prefix") + delta(0, "continued") + finish), {
    signal: new AbortController().signal, onChunk: () => {}, onTextDelta: delivered,
  });
  expect(result.text).toBe("prefixcontinued");
  expect(delivered.mock.calls).toEqual([["prefix"], ["continued"]]);
});
it("rejects a nonzero choice before delivering its text even after a valid prefix", async () => {
  const delivered: string[] = [];
  const outcome = await readOpeningProviderStream(memoryStream(delta(0, "prefix") + delta(1, "foreign-choice") + finish), {
    signal: new AbortController().signal, onChunk: () => {}, onTextDelta: text => { delivered.push(text); },
  }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  expect(outcome).toMatchObject({ ok: false, error: { code: "PROVIDER_RESPONSE", message: "unexpected provider stream choice" } });
  expect(delivered).toEqual(["prefix"]);
});
