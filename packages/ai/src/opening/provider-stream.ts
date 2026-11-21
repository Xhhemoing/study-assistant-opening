import { providerOutputSchema, type ProviderOutput } from "@aistudy/contracts";
import { parseProviderUsage, type ParsedProviderUsage } from "./usage";

export const onFailedResponseUsage = Symbol("onFailedResponseUsage");
export type FailedResponseUsage = Pick<ProviderOutput, "requestId" | "cachedInputTokens"> & {
  inputTokens: number;
  outputTokens: number;
};
export type ProviderTextDelta = ((delta: string) => void | Promise<void>) & {
  [onFailedResponseUsage]?: (usage: FailedResponseUsage) => void;
};

export class OpeningProviderStreamError extends Error {
  constructor(readonly code: "PROVIDER_RESPONSE" | "PROVIDER_REFUSAL", message: string) { super(message); }
}

function hasGeneratedDelta(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || !("delta" in raw) || !raw.delta || typeof raw.delta !== "object") return false;
  return Object.entries(raw.delta).some(([key, value]) =>
    key !== "role" && value != null && value !== "" && (!Array.isArray(value) || value.length > 0));
}

function hasGeneratedContent(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || !("delta" in raw) || !raw.delta || typeof raw.delta !== "object") return false;
  const delta = raw.delta as Record<string, unknown>;
  return typeof delta.content === "string" && delta.content.length > 0;
}

function maxReportedTokens(previous: number | null | undefined, next: number | null): number | null {
  return next === null ? previous ?? null : Math.max(previous ?? 0, next);
}

function boundFailedRequestId(requestId: string | null): string | null {
  return requestId && requestId.length > 200 ? null : requestId;
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
  let requestId: string | null = null;
  let highestUsage: ParsedProviderUsage | null = null;
  let outputAfterLastUsage = false;
  let hasEmittedOutput = false;
  let hasEmittedContent = false;
  let hasValidUsage = false;
  let invalidTrailer = false;
  let answerFailure: OpeningProviderStreamError | undefined;
  function invalid(message: string): never { throw new OpeningProviderStreamError("PROVIDER_RESPONSE", message); }
  const abort = () => { void reader.cancel(options.signal.reason).catch(() => undefined); };
  options.signal.addEventListener("abort", abort, { once: true });
  async function event() {
    if (!data.length) return;
    const payload = data.join("\n"); data = [];
    if (payload === "[DONE]") { if (!stopped && !answerFailure) invalid("provider stream ended before a complete answer"); done = true; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { invalid("provider returned malformed stream JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("invalid provider stream event");
    const value = parsed as Record<string, unknown>;
    // A new delta invalidates prior interim usage unless a subsequent valid
    // monotonic cumulative usage frame covers the newly emitted output.
    if (Array.isArray(value.choices) && value.choices.some(hasGeneratedDelta)) {
      hasEmittedOutput = true;
      if (value.choices.some(hasGeneratedContent)) hasEmittedContent = true;
      outputAfterLastUsage = true;
      hasValidUsage = false;
    }
    // Even an embedded rate-limit error follows a sent request; never release its reservation.
    if (value.error) invalid("provider stream failed");
    if (typeof value.id === "string") requestId = value.id;
    if (!Array.isArray(value.choices)) invalid("invalid provider stream choices");
    const [firstChoice] = value.choices;
    const terminal = !stopped && value.choices.length === 1 && firstChoice?.index === 0
      && typeof firstChoice.finish_reason === "string" && firstChoice.finish_reason.length > 0;
    if (value.usage != null) {
      const parsedUsage = parseProviderUsage(value.usage, { clamp: false });
      if (!parsedUsage) invalid("invalid provider stream usage");
      // Some providers end a refusal with a usage-only event and [DONE],
      // without emitting a finish reason.
      const trailer = value.choices.length === 0 && (stopped || answerFailure?.code === "PROVIDER_REFUSAL");
      if (!stopped || trailer) {
        const prevOutput = highestUsage?.outputTokens ?? null;
        const nextInput = maxReportedTokens(highestUsage?.inputTokens, parsedUsage.inputTokens);
        const zeroOutputAfterEmittedOutput = hasEmittedOutput && parsedUsage.outputTokens === 0;
        const nonMonotonicOutputAfterEmittedOutput = hasEmittedOutput
          && prevOutput !== null && parsedUsage.outputTokens !== null
          && parsedUsage.outputTokens < prevOutput;
        if ((zeroOutputAfterEmittedOutput || nonMonotonicOutputAfterEmittedOutput)
          && (hasEmittedContent || !hasValidUsage || outputAfterLastUsage)) {
          invalidTrailer = true;
        }
        const monotonicOutput = parsedUsage.outputTokens !== null
          && (prevOutput === null
            || (outputAfterLastUsage ? parsedUsage.outputTokens > prevOutput : parsedUsage.outputTokens >= prevOutput))
          && (!hasEmittedOutput || parsedUsage.outputTokens > 0);
        highestUsage = {
          inputTokens: nextInput,
          outputTokens: maxReportedTokens(prevOutput, parsedUsage.outputTokens),
          cachedInputTokens: maxReportedTokens(highestUsage?.cachedInputTokens, parsedUsage.cachedInputTokens),
        };
        if (!invalidTrailer && nextInput !== null && monotonicOutput) {
          outputAfterLastUsage = false;
          if (terminal || trailer) hasValidUsage = true;
        }
      }
    }
    for (const raw of value.choices) {
      if (answerFailure && stopped) break;
      if (!raw || typeof raw !== "object") invalid("invalid provider stream choice");
      const choice = raw as Record<string, unknown>;
      if (choice.index !== 0) invalid("unexpected provider stream choice");
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (delta?.refusal) answerFailure ??= new OpeningProviderStreamError("PROVIDER_REFUSAL", "provider refused the request");
      if (answerFailure) {
        // Refusal stops answer delivery immediately. The existing stream limit
        // and abort signal still apply while waiting for the accounting trailer.
        if (terminal) stopped = true;
        continue;
      }
      if (choice.finish_reason != null && choice.finish_reason !== "stop") {
        // Keep consuming the bounded stream so a trailing accounting frame is retained.
        answerFailure = new OpeningProviderStreamError("PROVIDER_RESPONSE", "provider did not finish the answer");
        stopped = true;
        break;
      }
      if (!delta || typeof delta !== "object") invalid("invalid provider stream delta");
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
      if (choice.finish_reason === "stop") stopped = true;
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
  function usageSnapshot(): ParsedProviderUsage {
    const { inputTokens = null, outputTokens = null, cachedInputTokens = null } = highestUsage ?? {};
    return { inputTokens, outputTokens, cachedInputTokens: cachedInputTokens === null || inputTokens === null
      ? cachedInputTokens : Math.min(cachedInputTokens, inputTokens) };
  }
  function authoritativeUsage(): ParsedProviderUsage {
    if (outputAfterLastUsage || invalidTrailer) {
      return { inputTokens: null, outputTokens: null, cachedInputTokens: null };
    }
    return usageSnapshot();
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
    if (answerFailure) throw answerFailure;
    if (!done) invalid("provider stream was interrupted");
    if (!text.trim()) invalid("provider returned an empty answer");
    const output = providerOutputSchema.safeParse({
      text, citedChunkIds: [], candidates: [], requestId, ...authoritativeUsage(),
    });
    if (!output.success) invalid("invalid provider stream output");
    return output.data;
  } catch (error) {
    // The provider adapter classifies transport errors after parsing returns.
    // Deliver validated usage separately so the wrapping cannot lose it.
    const { inputTokens, outputTokens, cachedInputTokens } = authoritativeUsage();
    if (hasValidUsage && (answerFailure?.code !== "PROVIDER_REFUSAL" || done)
      && inputTokens !== null && outputTokens !== null) {
      options.onTextDelta?.[onFailedResponseUsage]?.({
        requestId: boundFailedRequestId(requestId),
        inputTokens, outputTokens, cachedInputTokens,
      });
    }
    throw error;
  } finally {
    options.signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
