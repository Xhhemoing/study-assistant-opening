const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Returns a reusable boundary lookup for UTF-16 offsets in the original text. */
export function graphemeBoundaries(text: string) {
  const segments = segmenter.segment(text);
  return {
    floor(offset: number): number {
      return segments.containing(offset)?.index ?? offset;
    },
    ceil(offset: number): number {
      const segment = segments.containing(offset);
      return segment && segment.index < offset
        ? segment.index + segment.segment.length
        : offset;
    },
  };
}

/** Clips a masked prose range inward to visible edges on the original text's boundaries. */
export function trimToProseGraphemes(
  prose: string,
  boundaries: ReturnType<typeof graphemeBoundaries>,
  startOffset: number,
  endOffset: number,
): { startOffset: number; endOffset: number } | null {
  while (startOffset < endOffset) {
    if (/\s/u.test(prose[startOffset]!)) {
      startOffset += 1;
    } else {
      const next = boundaries.ceil(startOffset);
      if (next === startOffset) break;
      startOffset = next;
    }
  }
  while (endOffset > startOffset) {
    if (/\s/u.test(prose[endOffset - 1]!)) {
      endOffset -= 1;
    } else {
      const previous = boundaries.floor(endOffset);
      if (previous === endOffset) break;
      endOffset = previous;
    }
  }
  return startOffset < endOffset ? { startOffset, endOffset } : null;
}
