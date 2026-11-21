type ByteRange = { start: number; end: number };

/** null means serve the full representation. An unsatisfiable range gets 416. */
export function parseByteRange(header: string | null, length: number): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/i.exec(header ?? "");
  if (!match) return null;

  // HTTP offsets can exceed Number.MAX_SAFE_INTEGER. Clamp before converting.
  const total = BigInt(length);
  if (match[3] !== undefined) {
    const suffix = BigInt(match[3]);
    if (suffix === 0n || total === 0n) return "unsatisfiable";
    return { start: suffix >= total ? 0 : Number(total - suffix), end: length - 1 };
  }
  const start = BigInt(match[1]!);
  const end = match[2] ? BigInt(match[2]) : null;
  if (end !== null && end < start) return null;
  if (start >= total) return "unsatisfiable";
  return { start: Number(start), end: end === null || end >= total ? length - 1 : Number(end) };
}

// Phase 1 slices the storage stream here. S3 GetObject Range pass-through is a separate follow-up.
export function streamByteRange(body: ReadableStream<Uint8Array>, { start, end }: ByteRange): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const endExclusive = end + 1;
  let offset = 0;
  let finished = false;

  async function cancel(reason?: unknown) {
    if (finished) return;
    finished = true;
    try {
      await reader.cancel(reason);
    } finally {
      reader.releaseLock();
    }
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        while (!finished) {
          const chunk = await reader.read();
          if (finished) return;
          if (chunk.done) throw new Error("Source stream ended before the requested byte range");
          const chunkStart = offset;
          offset += chunk.value.byteLength;
          if (offset <= start) continue;

          controller.enqueue(chunk.value.subarray(Math.max(0, start - chunkStart), endExclusive - chunkStart));
          if (offset >= endExclusive) {
            controller.close();
            // The requested bytes are complete even if storage rejects cancellation.
            await cancel().catch(() => undefined);
          }
          return;
        }
      } catch (error) {
        if (finished) return;
        controller.error(error);
        await cancel(error).catch(() => undefined);
      }
    },
    cancel,
  });
}
