import { describe, expect, it, vi } from "vitest";
import { readOpeningProviderStream } from "./provider-stream";

const encoder = new TextEncoder();
const delta = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
const complete = delta("answer") + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(ok => { resolve = ok; }); return { promise, resolve }; }
function stream(text: string, cancel: (reason: unknown) => void | Promise<void> = () => {}) {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(text)); }, cancel });
  return body;
}
const options = (signal = new AbortController().signal) => ({ signal, onChunk: vi.fn() });

// In-memory Web Streams only; no fetch, provider, HTTP, or real service.
describe("provider stream asynchronous cleanup boundaries", () => {
  it.each(["success", "malformed"] as const)("awaits pending cancellation before settling %s and releasing reader lock", async kind => {
    const entered = deferred<void>(), permit = deferred<void>(), controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    const cancel = vi.fn(() => { entered.resolve(); return permit.promise; });
    const body = stream(kind === "success" ? complete : "data: {bad}\n\n", cancel);
    const request = readOpeningProviderStream(body, options(controller.signal));
    const settled = request.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    let done = false; void settled.then(() => { done = true; });
    try {
      const reached = await Promise.race([entered.promise.then(() => true), settled.then(() => false)]);
      expect(reached).toBe(true);
      expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]![1]);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(done).toBe(false); expect(body.locked).toBe(true);
    } finally { permit.resolve(); await settled; }
    expect(body.locked).toBe(false); expect(cancel).toHaveBeenCalledOnce();
    if (kind === "success") expect(await request).toMatchObject({ text: "answer" });
    else await expect(request).rejects.toMatchObject({ code: "PROVIDER_RESPONSE", message: "provider returned malformed stream JSON" });
  });
  it.each(["success", "malformed"] as const)("cancel rejection does not replace the %s result and still releases the lock", async kind => {
    const failure = new Error("synthetic cleanup failure");
    const body = stream(kind === "success" ? complete : "data: {bad}\n\n", async () => { throw failure; });
    const request = readOpeningProviderStream(body, options());
    if (kind === "success") {
      const result = await request.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
      expect(result).toMatchObject({ ok: true, value: { text: "answer" } });
    } else await expect(request).rejects.toMatchObject({ code: "PROVIDER_RESPONSE", message: "provider returned malformed stream JSON" });
    expect(body.locked).toBe(false);
  });
  it("an onChunk failure is propagated by identity after cancellation and listener removal", async () => {
    const controller = new AbortController(), failure = new Error("synthetic chunk observer failure");
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    const cancel = vi.fn(), body = stream(complete, cancel);
    await expect(readOpeningProviderStream(body, { signal: controller.signal, onChunk: () => { throw failure; } })).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
    expect(add).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]![1]);
  });
  it("consumer rejection is converted once and neither reader nor per-delta abort listeners remain", async () => {
    const controller = new AbortController(), failure = new Error("synthetic consumer failure");
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    const cancel = vi.fn(), body = stream(complete, cancel);
    await expect(readOpeningProviderStream(body, { signal: controller.signal, onChunk: () => {}, onTextDelta: async () => { throw failure; } }))
      .rejects.toMatchObject({ code: "PROVIDER_RESPONSE", message: "provider text delivery failed" });
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls.map(call => call[1])).toEqual([add.mock.calls[1]![1], add.mock.calls[0]![1]]);
  });
  it("does not deliver a second delta until the first consumer promise settles", async () => {
    const first = deferred<void>(), permit = deferred<void>(), controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    const body = stream(delta("first") + complete), received: string[] = [];
    const request = readOpeningProviderStream(body, { signal: controller.signal, onChunk: () => {}, onTextDelta: async text => {
      received.push(text); if (text === "first") { first.resolve(); await permit.promise; }
    } });
    const settled = request.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
      const arrival = await Promise.race([first.promise.then(() => true), settled.then(() => false)]); expect(arrival).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve)); expect(received).toEqual(["first"]); expect(body.locked).toBe(true);
    } finally { permit.resolve(); await settled; }
    expect(await request).toMatchObject({ text: "firstanswer" }); expect(received).toEqual(["first", "answer"]);
    expect(body.locked).toBe(false);
    expect(remove.mock.calls.map(call => call[1])).toEqual([add.mock.calls[1]![1], add.mock.calls[2]![1], add.mock.calls[0]![1]]);
  });
  it("a rejected underlying read retains its error identity and detaches the abort listener", async () => {
    const controller = new AbortController(), failure = new Error("synthetic read error");
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    const body = new ReadableStream<Uint8Array>({ start(value) { value.error(failure); } });
    await expect(readOpeningProviderStream(body, options(controller.signal))).rejects.toBe(failure);
    expect(body.locked).toBe(false);
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]![1]);
  });
  it("pre-aborted input cancels and unlocks without reading or invoking callbacks", async () => {
    const controller = new AbortController(), reason = new Error("synthetic pre-abort"); controller.abort(reason);
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    const cancel = vi.fn(), body = stream(complete, cancel), onChunk = vi.fn(), onTextDelta = vi.fn();
    await expect(readOpeningProviderStream(body, { signal: controller.signal, onChunk, onTextDelta })).rejects.toBe(reason);
    expect(onChunk).not.toHaveBeenCalled(); expect(onTextDelta).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]![1]);
  });
  it("abort during a pending reader.read preserves its reason and never starts text delivery", async () => {
    const controller = new AbortController(), reason = new Error("synthetic pending-read abort");
    const remove = vi.spyOn(controller.signal, "removeEventListener"), add = vi.spyOn(controller.signal, "addEventListener");
    const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ cancel }), onChunk = vi.fn(), onTextDelta = vi.fn();
    const request = readOpeningProviderStream(body, { signal: controller.signal, onChunk, onTextDelta });
    const settled = request.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    controller.abort(reason);
    await expect(request).rejects.toBe(reason); await settled;
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason); expect(body.locked).toBe(false);
    expect(onChunk).not.toHaveBeenCalled(); expect(onTextDelta).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]![1]);
  });
  it("invalid UTF-8 retains its decoder error when cancellation rejects and releases the lock", async () => {
    const cancelError = new Error("synthetic cancel rejection");
    const body = new ReadableStream<Uint8Array>({ start(value) { value.enqueue(new Uint8Array([0xff])); }, async cancel() { throw cancelError; } });
    const result = await readOpeningProviderStream(body, options()).then(() => null, error => error);
    expect(result).toBeInstanceOf(TypeError); expect(result).not.toBe(cancelError); expect(body.locked).toBe(false);
  });
  it("abort interrupts a pending consumer and removes both listeners without exposing a success", async () => {
    const controller = new AbortController(), reached = deferred<void>(), consumer = deferred<void>();
    const failure = new Error("synthetic abort reason");
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    const body = stream(complete), onTextDelta = vi.fn(() => { reached.resolve(); return consumer.promise; });
    const request = readOpeningProviderStream(body, { signal: controller.signal, onChunk: () => {}, onTextDelta });
    const settled = request.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
      const arrived = await Promise.race([reached.promise.then(() => true), settled.then(() => false)]);
      expect(arrived).toBe(true); controller.abort(failure);
      await expect(request).rejects.toBe(failure);
    } finally { consumer.resolve(); await settled; }
    expect(body.locked).toBe(false); expect(onTextDelta).toHaveBeenCalledOnce();
    expect(remove.mock.calls.map(call => call[1])).toEqual([add.mock.calls[1]![1], add.mock.calls[0]![1]]);
  });
});
