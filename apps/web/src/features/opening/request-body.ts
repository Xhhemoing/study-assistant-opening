import { ApiError } from "../auth/service";

export const OPENING_JSON_BODY_MAX_BYTES = 128 * 1024;

export async function readOpeningJsonBody(
  request: Request,
  maxBytes = OPENING_JSON_BODY_MAX_BYTES,
): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isInteger(declaredBytes) && declaredBytes > maxBytes) {
      throw new ApiError("VALIDATION", "请求体过大", 413);
    }
  }

  if (!request.body) return request.json();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new ApiError("VALIDATION", "请求体过大", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
