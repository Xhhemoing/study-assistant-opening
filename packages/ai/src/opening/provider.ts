import {
  providerOutputSchema,
  providerToolCallSchema,
  providerInputSchema,
  type ProviderInput,
  type ProviderOutput,
} from "@aistudy/contracts";
import { hasMediaInput, mediaInputCostBound, mediaInputBytes, type MediaInputCostBound } from "./parent-interaction-budget";
import { classifyProviderFailure } from "./errors";
import { openingProviderRequestBody } from "@aistudy/domain/opening/ai-policy";
import { assertOpeningProviderEndpoint, fetchOpeningProvider, OpeningProviderEndpointError } from "./provider-network";
import { onFailedResponseUsage, OpeningProviderStreamError, readOpeningProviderStream, type ProviderTextDelta } from "./provider-stream";
import { parseModelJson } from "./latex-json";
import { parseProviderUsage } from "./usage";
export type { ProviderTextDelta } from "./provider-stream";

const answerSchema = providerOutputSchema.pick({ text: true, citedChunkIds: true, candidates: true });
export { answerStyleInstruction, openingProviderRequestBody } from "@aistudy/domain/opening/ai-policy";

export type OpeningFetch = typeof fetch;

export type OpeningProviderOptions = Partial<MediaInputCostBound> & {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Trusted test injection only; production callers use the guarded transport. */
  fetchImpl?: OpeningFetch;
  timeoutMs?: number;
  /** Streaming calls reset this idle deadline whenever response bytes arrive. */
  idleTimeoutMs?: number;
  supportsVision?: boolean;
  /** Append the S2 writing rules to the system prompt (OPENING_ANSWER_STYLE). */
  answerStyle?: boolean;
  /** Model accepts `input_audio` content parts (chat completions). */
  supportsAudio?: boolean;
};

export class OpeningProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  /** Attempted fetch only; this does not establish upstream receipt or execution. */
  readonly requestSent: boolean;
  readonly httpStatus?: number;

  constructor(code: string, message: string, retryable = false, requestSent = false, httpStatus?: number) {
    super(message);
    this.name = "OpeningProviderError";
    this.code = code;
    this.retryable = retryable;
    this.requestSent = requestSent;
    if (Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599) this.httpStatus = httpStatus;
  }
}

export type GradingDiagnosticPhase = "admission" | "provider" | "parse" | "persist" | "usage" | "settle";
const diagnosticCodes = [
  "PROVIDER_AUTH", "PROVIDER_RATE_LIMIT", "PROVIDER_MEDIA_UNSUPPORTED", "PROVIDER_PAYLOAD_TOO_LARGE",
  "PROVIDER_REQUEST", "PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT", "PROVIDER_NETWORK", "PROVIDER_RESPONSE",
  "PROVIDER_REFUSAL", "PROVIDER_ABORTED", "PROVIDER_ENDPOINT", "PROVIDER_DISABLED",
  "BUDGET_INVALID_ACTUAL", "BUDGET_OUTCOME_UNKNOWN", "BUDGET_EXECUTION_CLAIMED",
  "BUDGET_REPLAY_COMPLETED", "BUDGET_REPLAY_RELEASED", "GRADING_PARSE", "USAGE_MISSING", "CONFLICT",
] as const;
export type SafeGradingDiagnostic = {
  phase: GradingDiagnosticPhase;
  errorClass: "OpeningProviderError" | "TypeError" | "RangeError" | "Error" | "UNKNOWN";
  code: typeof diagnosticCodes[number] | "UNKNOWN";
  /** null means no transport evidence; true means attempted fetch, never upstream receipt. */
  attemptedFetch: boolean | null;
  httpStatus?: number;
};
// Provenance stays process-local. Arbitrary error properties/diagnostic objects are never trusted.
const gradingDiagnostics = new WeakMap<object, SafeGradingDiagnostic>();
export function readGradingDiagnostic(value: unknown): SafeGradingDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const diagnostic = gradingDiagnostics.get(value);
  return diagnostic ? { phase: diagnostic.phase, errorClass: diagnostic.errorClass, code: diagnostic.code,
    attemptedFetch: diagnostic.attemptedFetch, ...(diagnostic.httpStatus === undefined ? {} : { httpStatus: diagnostic.httpStatus }) } : undefined;
}
export function recordGradingDiagnostic(value: unknown, phase: GradingDiagnosticPhase,
  evidence?: { attemptedFetch: boolean; httpStatus?: number }, code?: "GRADING_PARSE" | "USAGE_MISSING"): void {
  if (!value || typeof value !== "object" || gradingDiagnostics.has(value)) return;
  const rawCode = code ?? ("code" in value ? value.code : undefined);
  const status = evidence?.httpStatus;
  gradingDiagnostics.set(value, {
    phase: (["admission", "provider", "parse", "persist", "usage", "settle"] as const).find(candidate => candidate === phase) ?? "admission",
    errorClass: value instanceof OpeningProviderError ? "OpeningProviderError" : value instanceof TypeError ? "TypeError"
      : value instanceof RangeError ? "RangeError" : value instanceof Error ? "Error" : "UNKNOWN",
    code: diagnosticCodes.find(candidate => candidate === rawCode) ?? "UNKNOWN",
    attemptedFetch: typeof evidence?.attemptedFetch === "boolean" ? evidence.attemptedFetch : null,
    ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { httpStatus: status } : {}),
  });
}
export function copyGradingDiagnostic(source: unknown, target: object): void {
  const diagnostic = readGradingDiagnostic(source);
  if (diagnostic) gradingDiagnostics.set(target, diagnostic);
}
/** Internal structured event for failures hidden by a durable successful result. */
export function logGradingDiagnostic(value: unknown, operationId: string): void {
  const diagnostic = readGradingDiagnostic(value);
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const operation = new RegExp(`^ai-grade:${uuid}:${uuid}(?::[1-9][0-9]{0,8})?$`);
  // Absolute end check also rejects a trailing newline (which `$` alone permits).
  const regradeOperation = new RegExp(`^ai-regrade:${uuid}:${uuid}(?![\\s\\S])`);
  if (diagnostic && (operation.test(operationId) || regradeOperation.test(operationId))) console.warn({ event: "grading_diagnostic", operationId, ...diagnostic });
}

/** Strip optional markdown code fences (```json ... ``` / ``` ... ```). */
function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
  const inner = fenced?.[1];
  return inner !== undefined ? inner.trim() : trimmed;
}

/** Parse answer JSON; tolerate fences, prose wrappers, or degrade to plain text. */
function parseAnswerContent(raw: string): unknown {
  const stripped = stripMarkdownFences(raw);
  const tryParse = (text: string): unknown | undefined => {
    try {
      return parseModelJson(text);
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(stripped);
  if (direct !== undefined) return direct;
  // Same pattern as build-course-knowledge: first `{` … last `}`.
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const extracted = tryParse(stripped.slice(start, end + 1));
    if (extracted !== undefined) return extracted;
  }
  // GLM / non-strict models sometimes return prose only — still answer the turn.
  if (stripped.length > 0) {
    return { text: stripped, citedChunkIds: [], candidates: [] };
  }
  throw new OpeningProviderError("PROVIDER_RESPONSE", "provider returned malformed answer JSON");
}

function parseJsonObjectContent(raw: string): Record<string, unknown> {
  const stripped = stripMarkdownFences(raw);
  const attempts = [stripped];
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) attempts.push(stripped.slice(start, end + 1));
  for (const candidate of attempts) {
    try {
      const parsed: unknown = parseModelJson(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  throw new OpeningProviderError("PROVIDER_RESPONSE", "provider returned malformed task JSON");
}

function parseOutput(choices: unknown, accounting: Pick<ProviderOutput, "requestId" | "inputTokens" | "outputTokens" | "cachedInputTokens"> | null,
  format: NonNullable<ProviderInput["outputFormat"]>, allowedTools: string[] = []): ProviderOutput {
  const choice = Array.isArray(choices) && choices[0] && typeof choices[0] === "object"
    ? choices[0] as Record<string, unknown> : undefined;
  const message = choice?.message;
  if (!message || typeof message !== "object") {
    throw new OpeningProviderError("PROVIDER_RESPONSE", "invalid provider response");
  }
  const messageValue = message as Record<string, unknown>;
  if (typeof messageValue.refusal === "string") {
    throw new OpeningProviderError("PROVIDER_REFUSAL", "provider refused the request");
  }
  const finishReason = choice?.finish_reason;
  const calls = messageValue.tool_calls;
  if (Array.isArray(calls) && calls.length) {
    if (!allowedTools.length || finishReason !== "tool_calls") throw new OpeningProviderError("PROVIDER_RESPONSE", "unexpected or incomplete tool call");
    const parsed = providerToolCallSchema.array().min(1).max(4).safeParse(calls.map((raw: unknown) => {
      const call = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : {};
      return { id: call.id, name: call.type === "function" ? fn.name : null, arguments: fn.arguments };
    }));
    if (!parsed.success || parsed.data.some(call => !allowedTools.includes(call.name)) || new Set(parsed.data.map(call => call.id)).size !== parsed.data.length) throw new OpeningProviderError("PROVIDER_RESPONSE", "invalid provider tool calls");
    if (!accounting) {
      throw new OpeningProviderError("PROVIDER_RESPONSE", "invalid provider response");
    }
    const output = providerOutputSchema.safeParse({
      text: "",
      citedChunkIds: [],
      candidates: [],
      toolCalls: parsed.data,
      ...accounting,
    });
    if (!output.success) {
      throw new OpeningProviderError("PROVIDER_RESPONSE", "invalid provider response");
    }
    return output.data;
  }
  if (finishReason != null && finishReason !== "stop") {
    throw new OpeningProviderError("PROVIDER_RESPONSE", "provider did not finish the answer");
  }
  if (typeof messageValue.content !== "string") {
    throw new OpeningProviderError("PROVIDER_RESPONSE", "provider returned malformed answer JSON");
  }
  const content = format === "json"
    ? { text: JSON.stringify(parseJsonObjectContent(messageValue.content)), citedChunkIds: [], candidates: [] }
    : format === "markdown" ? { text: messageValue.content, citedChunkIds: [], candidates: [] } : parseAnswerContent(messageValue.content);
  const answer = answerSchema.safeParse(content);
  if (!answer.success) {
    throw new OpeningProviderError("PROVIDER_RESPONSE", "invalid structured answer");
  }
  if (!accounting) {
    throw new OpeningProviderError("PROVIDER_RESPONSE", "invalid provider response");
  }
  const output = providerOutputSchema.safeParse({
    ...answer.data,
    ...accounting,
  });
  if (!output.success) {
    throw new OpeningProviderError("PROVIDER_RESPONSE", "invalid provider response");
  }
  return output.data;
}

export function createOpeningProvider(options: OpeningProviderOptions): { complete(input: ProviderInput, signal?: AbortSignal, onTextDelta?: ProviderTextDelta): Promise<ProviderOutput> } {
  assertOpeningProviderEndpoint(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetchOpeningProvider;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async complete(input, callerSignal, onTextDelta) {
      input = providerInputSchema.parse(input);
      const vision = input.mediaCapability === "text_plus_page_images";
      if (input.mediaCapability === "refused" || (vision && !options.supportsVision) || (!vision && input.imageParts.length > 0)
        || input.imageParts.some(image => !image.data.startsWith(`data:${image.mediaType};base64,`) || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data.split(",")[1] ?? ""))) {
        throw new OpeningProviderError("PROVIDER_MEDIA_UNSUPPORTED", "page image input is not configured or invalid");
      }
      const audioParts = input.audioParts ?? [];
      if (audioParts.length > 0 && !options.supportsAudio) {
        throw new OpeningProviderError("PROVIDER_MEDIA_UNSUPPORTED", "audio input is not configured for this model");
      }
      const bound = mediaInputCostBound(options);
      if (bound && hasMediaInput(input)) {
        let bytes: number;
        try { bytes = mediaInputBytes(input); }
        catch { throw new OpeningProviderError("PROVIDER_MEDIA_UNSUPPORTED", "invalid media encoding"); }
        if (bytes > bound.mediaMaxInputBytes) throw new OpeningProviderError("PROVIDER_MEDIA_UNSUPPORTED", "media exceeds configured billing input bound");
      }
      const format = input.outputFormat ?? "answer";
      const streaming = format === "markdown" && !input.tools?.length;
      const timeout = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resetDeadline = () => { clearTimeout(timer); timer = setTimeout(() => timeout.abort(), streaming ? options.idleTimeoutMs ?? 60_000 : timeoutMs); };
      resetDeadline();
      const onCallerAbort = () => timeout.abort(callerSignal?.reason);
      if (callerSignal?.aborted) timeout.abort(callerSignal.reason);
      else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
      const signal = timeout.signal;
      let requestSent = false;
      let httpStatus: number | undefined;
      let phase: GradingDiagnosticPhase = "provider";
      try {
        signal.throwIfAborted();
        const requestBody = JSON.stringify(openingProviderRequestBody(input, options));
        requestSent = true;
        const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: requestBody,
          signal,
          redirect: "error",
        });
        httpStatus = response.status;
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const failure = classifyProviderFailure(response.status);
          throw new OpeningProviderError(failure.code, "provider request failed", failure.retryable, true, response.status);
        }
        phase = "parse";
        if (streaming) {
          if (!response.body) throw new OpeningProviderError("PROVIDER_RESPONSE", "provider returned no stream", false, true);
          const output = await readOpeningProviderStream(response.body, { signal, onChunk: resetDeadline, onTextDelta });
          recordGradingDiagnostic(output, phase, { attemptedFetch: requestSent, httpStatus });
          return output;
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          if (signal.aborted || error instanceof OpeningProviderEndpointError) throw error;
          throw new OpeningProviderError("PROVIDER_RESPONSE", "provider returned malformed JSON", false, true);
        }
        const envelope = body as Record<string, unknown> | null;
        const requestId = typeof envelope?.id === "string" ? envelope.id : null;
        const usage = parseProviderUsage(envelope?.usage, { clamp: false });
        const accounting = usage && {
          ...usage, requestId,
          cachedInputTokens: usage.cachedInputTokens === null || usage.inputTokens === null
            ? usage.cachedInputTokens : Math.min(usage.cachedInputTokens, usage.inputTokens),
        };
        try {
          const output = parseOutput(envelope?.choices, accounting, format, input.tools?.map(tool => tool.name));
          recordGradingDiagnostic(output, phase, { attemptedFetch: requestSent, httpStatus });
          return output;
        } catch (error) {
          if (accounting && accounting.inputTokens !== null && accounting.outputTokens !== null) {
            onTextDelta?.[onFailedResponseUsage]?.({
              requestId: requestId && requestId.length > 200 ? null : requestId,
              inputTokens: accounting.inputTokens, outputTokens: accounting.outputTokens,
              cachedInputTokens: accounting.cachedInputTokens,
            });
          }
          throw error;
        }
      } catch (error) {
        const failure = error instanceof OpeningProviderError ? error
          : error instanceof OpeningProviderStreamError ? new OpeningProviderError(error.code, error.message, false, true, httpStatus)
          : error instanceof OpeningProviderEndpointError ? new OpeningProviderError("PROVIDER_ENDPOINT", error.message, false, requestSent)
          : callerSignal?.aborted ? new OpeningProviderError("PROVIDER_ABORTED", "provider request aborted", false, requestSent, httpStatus)
          : signal.aborted ? new OpeningProviderError("PROVIDER_TIMEOUT", "provider request aborted", true, requestSent, httpStatus)
          : new OpeningProviderError("PROVIDER_NETWORK", "provider request failed", true, requestSent, httpStatus);
        recordGradingDiagnostic(failure, phase, { attemptedFetch: requestSent, httpStatus });
        throw failure;
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}
