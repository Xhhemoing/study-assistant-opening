import { providerOutputSchema, type ProviderOutput } from "@aistudy/contracts";

export type ProviderTextDelta = (delta: string) => void | Promise<void>;

export class OpeningProviderStreamError extends Error {
  constructor(readonly code: "PROVIDER_RESPONSE" | "PROVIDER_REFUSAL", message: string) { super(message); }
}

async function deliverDelta(callback: ProviderTextDelta, delta: string, signal: AbortSignal) {
  let onAbort: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  });
  try { await Promise.race([callback(delta), interrupted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** Decode chat-completion SSE, retaining the trailing usage event before [DONE]. */
export async function readOpeningProviderStream(body: ReadableStream<Uint8Array>, options: {
  signal: AbortSignal; onChunk: () => void; onTextDelta?: ProviderTextDelta;
}): Promise<ProviderOutput> {
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", data: string[] = [], text = "", bytes = 0, done = false, stopped = false;
  let requestId: string | null = null, inputTokens: number | null = null, outputTokens: number | null = null;
  function invalid(message: string): never { throw new OpeningProviderStreamError("PROVIDER_RESPONSE", message); }
  const abort = () => { void reader.cancel(options.signal.reason).catch(() => undefined); };
  options.signal.addEventListener("abort", abort, { once: true });
  async function event() {
    if (!data.length) return;
    const payload = data.join("\n"); data = [];
    if (payload === "[DONE]") { if (!stopped) invalid("provider stream ended before a complete answer"); done = true; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { invalid("provider returned malformed stream JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("invalid provider stream event");
    const value = parsed as Record<string, unknown>;
    // Even an embedded rate-limit error follows a sent request; never release its reservation.
    if (value.error) invalid("provider stream failed");
    if (typeof value.id === "string") requestId = value.id;
    if (value.usage != null) {
      const usage = value.usage as Record<string, unknown>;
      for (const token of [usage.prompt_tokens, usage.completion_tokens]) {
        if (token != null && (typeof token !== "number" || !Number.isSafeInteger(token) || token < 0)) invalid("invalid provider stream usage");
      }
      inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
      outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
    }
    if (!Array.isArray(value.choices)) invalid("invalid provider stream choices");
    for (const raw of value.choices) {
      if (!raw || typeof raw !== "object") invalid("invalid provider stream choice");
      const choice = raw as Record<string, unknown>;
      if (choice.index !== 0) invalid("unexpected provider stream choice");
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta || typeof delta !== "object") invalid("invalid provider stream delta");
      if (delta.refusal) throw new OpeningProviderStreamError("PROVIDER_REFUSAL", "provider refused the request");
      if (delta.tool_calls || delta.function_call) invalid("unexpected streamed tool call");
      if (delta.content != null && typeof delta.content !== "string") invalid("invalid provider stream content");
      if (typeof delta.content === "string" && delta.content.length) {
        if (stopped) invalid("provider sent text after completing the answer");
        text += delta.content;
        if (text.length > 50_000) invalid("provider answer is too large");
        options.signal.throwIfAborted();
        if (options.onTextDelta) {
          try { await deliverDelta(options.onTextDelta, delta.content, options.signal); }
          catch (error) {
            if (options.signal.aborted) throw error;
            invalid("provider text delivery failed");
          }
        }
        options.signal.throwIfAborted();
      }
      if (choice.finish_reason != null) {
        if (choice.finish_reason !== "stop") invalid("provider did not finish the answer");
        stopped = true;
      }
    }
  }
  async function consume() {
    while (!done) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) return;
      const end = match.index;
      if (buffer[end] === "\r" && end === buffer.length - 1) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + (buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1));
      if (!line) await event();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  try {
    options.signal.throwIfAborted();
    while (!done) {
      const chunk = await reader.read();
      options.signal.throwIfAborted();
      if (chunk.done) break;
      if (!chunk.value.byteLength) continue;
      options.onChunk();
      bytes += chunk.value.byteLength;
      if (bytes > 8 * 1024 * 1024) invalid("provider stream is too large");
      buffer += decoder.decode(chunk.value, { stream: true });
      await consume();
    }
    if (!done) invalid("provider stream was interrupted");
    if (!text.trim()) invalid("provider returned an empty answer");
    const output = providerOutputSchema.safeParse({ text, citedChunkIds: [], candidates: [], requestId, inputTokens, outputTokens });
    if (!output.success) invalid("invalid provider stream output");
    return output.data;
  } finally {
    options.signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
