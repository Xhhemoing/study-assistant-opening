import { describe, expect, it, vi } from "vitest";
import { createOpeningProvider } from "./provider";

const input = {
  instruction: "answer",
  text: "hello",
  chunks: [],
  mode: "hint" as const,
  maxOutputTokens: 100,
  signal: new AbortController().signal,
  mediaCapability: "text_only" as const,
  imageParts: [],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("opening provider", () => {
  it("maps a valid completion", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      id: "req-1",
      choices: [{ message: { content: "answer" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
    const result = await createOpeningProvider({
      baseUrl: "https://model.example",
      apiKey: "key",
      model: "model",
      fetchImpl,
    }).complete(input);
    expect(result.text).toBe("answer");
    expect(result.requestId).toBe("req-1");
    expect(result.inputTokens).toBe(3);
  });

  it("rejects malformed and refused responses", async () => {
    const malformed = vi.fn().mockResolvedValue(response({ nope: true }));
    await expect(createOpeningProvider({
      baseUrl: "https://model.example",
      apiKey: "key",
      model: "model",
      fetchImpl: malformed,
    }).complete(input)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE" });

    const refused = vi.fn().mockResolvedValue(response({
      id: "req-1",
      choices: [{ message: { refusal: "no" } }],
    }));
    await expect(createOpeningProvider({
      baseUrl: "https://model.example",
      apiKey: "key",
      model: "model",
      fetchImpl: refused,
    }).complete(input)).rejects.toMatchObject({ code: "PROVIDER_REFUSAL" });
  });

  it("rejects insecure non-loopback endpoints", () => {
    expect(() => createOpeningProvider({
      baseUrl: "http://model.example",
      apiKey: "key",
      model: "model",
    })).toThrow();
  });

  it("classifies provider HTTP failures without blind retries", async () => {
    for (const [status, code, retryable] of [
      [401, "PROVIDER_AUTH", false],
      [429, "PROVIDER_RATE_LIMIT", true],
      [500, "PROVIDER_UNAVAILABLE", true],
    ] as const) {
      const fetchImpl = vi.fn().mockResolvedValue(response({}, status));
      await expect(createOpeningProvider({
        baseUrl: "https://model.example",
        apiKey: "key",
        model: "model",
        fetchImpl,
      }).complete(input)).rejects.toMatchObject({ code, retryable });
    }
  });

  it("marks timeouts as retryable unknown-outcome failures", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
    );
    await expect(createOpeningProvider({
      baseUrl: "https://model.example",
      apiKey: "key",
      model: "model",
      fetchImpl,
      timeoutMs: 10,
    }).complete(input)).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      retryable: true,
    });
  });
});
