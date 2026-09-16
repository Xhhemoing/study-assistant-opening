import {
  providerOutputSchema,
  type ProviderInput,
  type ProviderOutput,
} from "@aistudy/contracts";
import { classifyProviderFailure } from "./errors";

export type OpeningFetch = typeof fetch;

export type OpeningProviderOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: OpeningFetch;
  timeoutMs?: number;
};

export class OpeningProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "OpeningProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

function endpointAllowed(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
}

function parseOutput(body: unknown): ProviderOutput {
  const value = body as Record<string, unknown>;
  const choices = value?.choices;
  const message = Array.isArray(choices) && choices[0] && typeof choices[0] === "object"
    ? (choices[0] as Record<string, unknown>).message
    : undefined;
  if (!message || typeof message !== "object") {
    throw new OpeningProviderError("PROVIDER_RESPONSE", "invalid provider response");
  }
  const messageValue = message as Record<string, unknown>;
  if (typeof messageValue.refusal === "string") {
    throw new OpeningProviderError("PROVIDER_REFUSAL", "provider refused the request");
  }
  const usage = value.usage as Record<string, unknown> | undefined;
  const output = providerOutputSchema.safeParse({
    text: messageValue.content,
    citedChunkIds: [],
    requestId: typeof value.id === "string" ? value.id : null,
    candidates: [],
    inputTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
    outputTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null,
  });
  if (!output.success) {
    throw new OpeningProviderError("PROVIDER_RESPONSE", "invalid provider response");
  }
  return output.data;
}

export function createOpeningProvider(options: OpeningProviderOptions): { complete(input: ProviderInput): Promise<ProviderOutput> } {
  if (!endpointAllowed(options.baseUrl)) {
    throw new Error("provider baseUrl must use HTTPS");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async complete(input) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      const signal = timeout.signal;
      try {
        const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ model: options.model, messages: [{ role: "system", content: input.instruction }, { role: "user", content: input.text }], max_tokens: input.maxOutputTokens }),
          signal,
        });
        if (!response.ok) {
          const failure = classifyProviderFailure(response.status);
          throw new OpeningProviderError(failure.code, "provider request failed", failure.retryable);
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new OpeningProviderError("PROVIDER_RESPONSE", "provider returned malformed JSON");
        }
        return parseOutput(body);
      } catch (error) {
        if (error instanceof OpeningProviderError) throw error;
        if (signal.aborted) throw new OpeningProviderError("PROVIDER_TIMEOUT", "provider request aborted", true);
        throw new OpeningProviderError("PROVIDER_NETWORK", "provider request failed", true);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
