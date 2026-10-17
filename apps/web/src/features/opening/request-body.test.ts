import { describe, expect, it } from "vitest";
import { ApiError } from "../auth/service";
import {
  OPENING_JSON_BODY_MAX_BYTES,
  readOpeningJsonBody,
  readOpeningRawBody,
} from "./request-body";

function jsonRequest(body: string, contentLength?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request("http://localhost/opening-body", {
    method: "POST",
    headers,
    body,
  });
}

function streamRequest(
  chunks: Uint8Array[],
  headers: HeadersInit = {},
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("http://localhost/opening-body", {
    method: "POST",
    headers,
    body,
    // Node fetch requires duplex when the body is a stream.
    duplex: "half",
  } as RequestInit);
}

describe("readOpeningJsonBody", () => {
  it("counts UTF-8 bytes and cancels a sender that exceeds the cap", async () => {
    let cancelled = false;
    const request = new Request("http://localhost/opening-body", {
      method: "POST",
      body: new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"x":"中"}')); },
        cancel() { cancelled = true; },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(readOpeningJsonBody(request, 9)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
    expect(request.body?.locked).toBe(false);
  });

  it("rejects a declared Content-Length above the limit with 413", async () => {
    const request = jsonRequest("{}", String(OPENING_JSON_BODY_MAX_BYTES + 1));

    await expect(readOpeningJsonBody(request)).rejects.toMatchObject({
      name: "ApiError",
      code: "VALIDATION",
      status: 413,
      message: "请求体过大",
    } satisfies Partial<ApiError>);
  });

  it("rejects streamed bytes above the limit when Content-Length is absent", async () => {
    const over = new Uint8Array(OPENING_JSON_BODY_MAX_BYTES + 1);
    const request = streamRequest([over], { "content-type": "application/json" });

    expect(request.headers.get("content-length")).toBeNull();
    await expect(readOpeningJsonBody(request)).rejects.toMatchObject({
      name: "ApiError",
      code: "VALIDATION",
      status: 413,
      message: "请求体过大",
    } satisfies Partial<ApiError>);
  });

  it("throws SyntaxError for invalid JSON so mapDomainError can map it", async () => {
    await expect(readOpeningJsonBody(jsonRequest("{"))).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
});

describe("readOpeningRawBody", () => {
  it("rejects a declared Content-Length above the limit with 413", async () => {
    const maxBytes = 16;
    const request = new Request("http://localhost/opening-body", {
      method: "POST",
      headers: { "content-length": String(maxBytes + 1) },
      body: new Uint8Array([1, 2, 3, 4]),
    });

    await expect(readOpeningRawBody(request, maxBytes)).rejects.toMatchObject({
      name: "ApiError",
      code: "VALIDATION",
      status: 413,
      message: "请求体过大",
    } satisfies Partial<ApiError>);
  });

  it("rejects streamed bytes above the limit when Content-Length is absent", async () => {
    const maxBytes = 8;
    const request = streamRequest([new Uint8Array(maxBytes + 1)]);

    expect(request.headers.get("content-length")).toBeNull();
    await expect(readOpeningRawBody(request, maxBytes)).rejects.toMatchObject({
      name: "ApiError",
      code: "VALIDATION",
      status: 413,
      message: "请求体过大",
    } satisfies Partial<ApiError>);
  });

  it("accepts a body whose size is exactly the limit", async () => {
    const maxBytes = 32;
    const bytes = Uint8Array.from({ length: maxBytes }, (_, i) => i);

    await expect(readOpeningRawBody(
      new Request("http://localhost/opening-body", {
        method: "POST",
        headers: { "content-length": String(maxBytes) },
        body: bytes,
      }),
      maxBytes,
    )).resolves.toEqual(bytes);
  });
});
