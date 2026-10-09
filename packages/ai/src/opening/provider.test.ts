import { describe, expect, it, vi } from "vitest";
import { createOpeningProvider } from "./provider";

const input = {
  instruction: "answer",
  text: "hello",
  chunks: [],
  mode: "hint" as const,
  maxOutputTokens: 100,
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
  it("encodes selected chunks as untrusted text context and requests structured JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      id: "req-1",
      choices: [{ message: { content: JSON.stringify({ text: "answer", citedChunkIds: [], candidates: [] }) } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
    const result = await createOpeningProvider({
      baseUrl: "https://model.example",
      apiKey: "key",
      model: "model",
      fetchImpl,
    }).complete({ ...input, chunks: [{
      id: "00000000-0000-4000-8000-000000000001",
      sourceId: "00000000-0000-4000-8000-000000000002",
      sourceVersion: 0, page: 1, slideLabel: null, startMs: null, endMs: null,
      text: "selected chunk text", imageObjectKey: null,
    }] });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.messages[1].content).toContain("selected chunk text");
    expect(body.messages[1].content).toContain("UNTRUSTED DATA");
    expect(body.messages[1].content).toContain("00000000-0000-4000-8000-000000000001");
    expect(body.response_format.type).toBe("json_object");
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

  it("preserves structured citations and pending candidates", async () => {
    const citedChunkIds = ["00000000-0000-4000-8000-000000000001"];
    const candidates = [{ kind: "task", title: "Review Newton", minutes: 10, dueText: null }];
    const provider = createOpeningProvider({
      baseUrl: "https://model.example", apiKey: "key", model: "model",
      fetchImpl: vi.fn().mockResolvedValue(response({
        choices: [{ message: { content: JSON.stringify({ text: "F = ma", citedChunkIds, candidates }) } }],
      })),
    });
    expect(await provider.complete(input)).toMatchObject({ text: "F = ma", citedChunkIds, candidates });
  });

  it.each([
    JSON.stringify({ text: "answer", citedChunkIds: ["invented"], candidates: [] }),
    JSON.stringify({ text: "answer", citedChunkIds: [], candidates: [{ kind: "execute", command: "bad" }] }),
    JSON.stringify({ text: "answer", citedChunkIds: [], candidates: [], injected: true }),
  ])("rejects malformed structured content without fabricating provenance: %s", async (content) => {
    const provider = createOpeningProvider({
      baseUrl: "https://model.example", apiKey: "key", model: "model",
      fetchImpl: vi.fn().mockResolvedValue(response({ choices: [{ message: { content } }] })),
    });
    await expect(provider.complete(input)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE" });
  });

  const strictAnswer = { text: "GLM answer", citedChunkIds: [], candidates: [] as unknown[] };

  it("parses strict JSON content unchanged", async () => {
    const provider = createOpeningProvider({
      baseUrl: "https://model.example", apiKey: "key", model: "model",
      fetchImpl: vi.fn().mockResolvedValue(response({
        id: "req-strict",
        choices: [{ message: { content: JSON.stringify(strictAnswer) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })),
    });
    await expect(provider.complete(input)).resolves.toMatchObject({
      text: "GLM answer", citedChunkIds: [], candidates: [], requestId: "req-strict",
    });
  });

  it("strips markdown json fences around a valid answer object", async () => {
    const fenced = "```json\n" + JSON.stringify(strictAnswer) + "\n```";
    const provider = createOpeningProvider({
      baseUrl: "https://model.example", apiKey: "key", model: "model",
      fetchImpl: vi.fn().mockResolvedValue(response({
        choices: [{ message: { content: fenced } }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      })),
    });
    await expect(provider.complete(input)).resolves.toMatchObject({ text: "GLM answer", citedChunkIds: [], candidates: [] });
  });

  it("extracts JSON object from glm-5.3 style prose prefix/suffix wrappers", async () => {
    // Fixture mimicking Lant/glm-5.3 non-strict output seen in Hermes.
    const wrapped = "好的，这是结构化回答：\n" + JSON.stringify(strictAnswer) + "\n希望对你有帮助。";
    const provider = createOpeningProvider({
      baseUrl: "https://model.example", apiKey: "key", model: "model",
      fetchImpl: vi.fn().mockResolvedValue(response({
        choices: [{ message: { content: wrapped } }],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      })),
    });
    await expect(provider.complete(input)).resolves.toMatchObject({ text: "GLM answer", citedChunkIds: [], candidates: [] });
  });

  it("degrades non-empty plain text to a structured answer so the turn still replies", async () => {
    const provider = createOpeningProvider({
      baseUrl: "https://model.example", apiKey: "key", model: "model",
      fetchImpl: vi.fn().mockResolvedValue(response({
        choices: [{ message: { content: "这是一段没有 JSON 的说明文字。" } }],
        usage: { prompt_tokens: 5, completion_tokens: 8 },
      })),
    });
    await expect(provider.complete(input)).resolves.toMatchObject({
      text: "这是一段没有 JSON 的说明文字。",
      citedChunkIds: [],
      candidates: [],
    });
  });

  it("still rejects empty content as malformed answer JSON", async () => {
    const provider = createOpeningProvider({
      baseUrl: "https://model.example", apiKey: "key", model: "model",
      fetchImpl: vi.fn().mockResolvedValue(response({ choices: [{ message: { content: "   " } }] })),
    });
    await expect(provider.complete(input)).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE",
      message: "provider returned malformed answer JSON",
    });
  });

  it("sends actual page images with source/page labels only when vision is explicitly enabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ choices: [{ message: { content: JSON.stringify({ text: "analysis", citedChunkIds: [], candidates: [] }) } }] }));
    const image = { mediaType: "image/png" as const, data: "data:image/png;base64,aGVsbG8=", sourceId: "00000000-0000-4000-8000-000000000002", physicalPage: 2 };
    const request = { ...input, mediaCapability: "text_plus_page_images" as const, imageParts: [image] };
    await expect(createOpeningProvider({ baseUrl: "https://model.example", apiKey: "key", model: "model", fetchImpl }).complete(request)).rejects.toMatchObject({ code: "PROVIDER_MEDIA_UNSUPPORTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await createOpeningProvider({ baseUrl: "https://model.example", apiKey: "key", model: "model", fetchImpl, supportsVision: true }).complete(request);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[1].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("physical page 2") }),
      { type: "image_url", image_url: { url: image.data, detail: "high" } },
    ]));
    await expect(createOpeningProvider({ baseUrl: "https://model.example", apiKey: "key", model: "model", supportsVision: true, fetchImpl }).complete({ ...request, imageParts: [{ ...image, data: "https://untrusted/page.png" }] })).rejects.toMatchObject({ code: "PROVIDER_MEDIA_UNSUPPORTED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported media without silently dropping the image", async () => {
    const fetchImpl = vi.fn();
    const provider = createOpeningProvider({ baseUrl: "https://model.example", apiKey: "key", model: "model", fetchImpl });
    await expect(provider.complete({ ...input, mediaCapability: "refused" })).rejects.toMatchObject({ code: "PROVIDER_MEDIA_UNSUPPORTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends prior roles before the current question", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ choices: [{ message: { content: JSON.stringify({ text: "next", citedChunkIds: [], candidates: [] }) } }] }));
    await createOpeningProvider({ baseUrl: "https://model.example", apiKey: "key", model: "model", fetchImpl }).complete({ ...input, history: [{ role: "user", text: "yesterday" }, { role: "assistant", text: "step two" }] });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.messages.slice(1, 3)).toEqual([{ role: "user", content: "yesterday" }, { role: "assistant", content: "step two" }]);
    expect(body.messages[3].content).toContain("hello");
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

  it("forwards a caller abort without classifying it as a timeout", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
    );
    const controller = new AbortController();
    const pending = createOpeningProvider({
      baseUrl: "https://model.example",
      apiKey: "key",
      model: "model",
      fetchImpl,
      timeoutMs: 30_000,
    }).complete(input, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "PROVIDER_ABORTED",
      retryable: false,
    });
  });
});
