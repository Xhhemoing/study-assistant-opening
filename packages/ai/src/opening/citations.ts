import type { Citation, SourceChunk } from "@aistudy/contracts";

export type ResolveCitationsOptions = {
  /**
   * When true (default), unknown cited ids are filtered out instead of throwing.
   * Pass soft:false for strict resolve (tests / callers that need hard failure).
   */
  soft?: boolean;
  /** Optional sourceId → display name map to humanize citation labels. */
  sourceNames?: Record<string, string>;
};

function formatTimestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function label(chunk: SourceChunk, sourceNames?: Record<string, string>): string {
  const sourceTitle = sourceNames?.[chunk.sourceId]?.trim();
  const sourcePart = sourceTitle
    ? `${sourceTitle} v${chunk.sourceVersion}`
    : `source ${chunk.sourceId} v${chunk.sourceVersion}`;
  const location = chunk.slideLabel
    ? `slide ${chunk.slideLabel}`
    : `page ${chunk.page ?? "-"}`;
  const timestamp = chunk.startMs === null ? "" : ` at ${formatTimestamp(chunk.startMs)}`;
  return `${sourcePart} ${location}${timestamp}`;
}

function citationFromChunk(
  chunk: SourceChunk,
  sourceNames?: Record<string, string>,
): Citation {
  const result: Citation = {
    chunkId: chunk.id,
    sourceId: chunk.sourceId,
    sourceVersion: chunk.sourceVersion,
    label: label(chunk, sourceNames),
  };
  if (chunk.page != null) result.page = chunk.page;
  if (chunk.startMs != null) result.startMs = chunk.startMs;
  if (chunk.slideLabel != null && chunk.slideLabel.length > 0) {
    result.slideLabel = chunk.slideLabel;
  }
  return result;
}

/**
 * Resolve model-proposed chunk ids against authorized context chunks.
 * Soft mode (default) drops unknown ids; never fabricates citation rows.
 */
export function resolveCitations(
  ids: string[],
  chunks: SourceChunk[],
  options?: ResolveCitationsOptions,
): Citation[] {
  const soft = options?.soft !== false;
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const out: Citation[] = [];
  for (const id of ids) {
    const chunk = byId.get(id);
    if (!chunk) {
      if (soft) continue;
      throw new RangeError(`unknown citation: ${id}`);
    }
    out.push(citationFromChunk(chunk, options?.sourceNames));
  }
  return out;
}

/**
 * Group 1: code fences, inline code and math, passed through untouched.
 * Group 2: a single-number `[n]` marker that is not part of an identifier
 * (`a[1]`), an inline link `[1](url)` or a reference definition `[1]: url`.
 */
const INLINE_MARKER = /(```[\s\S]*?(?:```|$)|`[^`\n]*`|\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]+\$)|(?<!\w)\[(\d{1,2})\](?![(:])/g;

/**
 * S4: the model writes `[n]` with n indexing its own citedChunkIds (1-based).
 * Citations are filtered and reordered after that, so rewrite each marker to
 * index the final citations and drop markers whose chunk did not survive:
 * a remaining `[k]` always points at citations[k-1]. Without cited ids the
 * text is left alone; there is nothing to link and `[n]` may mean something else.
 */
export function renumberInlineCitations(text: string, citedChunkIds: readonly string[], citations: readonly Citation[]): string {
  if (citedChunkIds.length === 0) return text;
  const position = new Map(citations.map((citation, index) => [citation.chunkId, index + 1]));
  return text.replace(INLINE_MARKER, (match, verbatim: string | undefined, number: string | undefined) => {
    if (verbatim !== undefined || number === undefined) return match;
    const id = citedChunkIds[Number(number) - 1];
    const target = id === undefined ? undefined : position.get(id);
    return target === undefined ? "" : `[${target}]`;
  });
}
