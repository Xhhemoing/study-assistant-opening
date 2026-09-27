import { mediaSegmentSchema, type MediaSegment } from "@aistudy/contracts";

/** Validate server-owned media timing before persisting derived segments. */
export function validateMediaSegments(
  segments: MediaSegment[],
  durationMs: number,
): MediaSegment[] {
  if (!Number.isInteger(durationMs) || durationMs < 0) {
    throw new Error("source duration must be a non-negative integer");
  }

  return segments.map((segment) => {
    const validated = mediaSegmentSchema.parse(segment);
    if (validated.endMs <= validated.startMs) {
      throw new Error("endMs must be greater than startMs");
    }
    if (validated.endMs > durationMs) {
      throw new Error("segment is outside source duration");
    }
    return {
      ...validated,
      frameChunkIds: [...validated.frameChunkIds],
    };
  });
}
