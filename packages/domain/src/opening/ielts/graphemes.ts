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
