/** RU-03: file selection is not current-page selection. Server membership checks. */

export type PageSelectionCode =
  | "page_not_in_sources"
  | "chunk_not_in_sources"
  | "page_chunk_mismatch";

export type PageSelectionInput = {
  sourceIds: string[];
  currentPage?: number | null;
  chunkId?: string | null;
};

/** Chunks already authorized for the caller's scope; still filtered by sourceIds. */
export type AuthorizedChunk = {
  id: string;
  sourceId: string;
  /** Physical page index; never treat PPTX slideLabel as page. */
  page: number | null;
};

export type PageSelectionOk = {
  ok: true;
  /** Chunk ids that satisfy the selection; empty when no page/chunk was requested. */
  matchedChunkIds: string[];
};

export type PageSelectionErr = {
  ok: false;
  code: PageSelectionCode;
};

export type PageSelectionResult = PageSelectionOk | PageSelectionErr;

function inSources(
  chunk: AuthorizedChunk,
  sourceIds: ReadonlySet<string>,
): boolean {
  return sourceIds.has(chunk.sourceId);
}

/**
 * Validate optional currentPage / chunkId against authorized chunks.
 * When both are absent, does not invent a page (matchedChunkIds stays empty).
 */
export function validatePageSelection(
  input: PageSelectionInput,
  authorizedChunks: readonly AuthorizedChunk[],
): PageSelectionResult {
  const sourceIds = new Set(input.sourceIds);
  const pool = authorizedChunks.filter((c) => inSources(c, sourceIds));
  const hasPage = input.currentPage != null;
  const hasChunk = input.chunkId != null && input.chunkId !== "";

  if (!hasPage && !hasChunk) {
    return { ok: true, matchedChunkIds: [] };
  }

  let chunk: AuthorizedChunk | undefined;
  if (hasChunk) {
    chunk = pool.find((c) => c.id === input.chunkId);
    if (!chunk) {
      return { ok: false, code: "chunk_not_in_sources" };
    }
  }

  if (hasPage) {
    const pageHits = pool.filter((c) => c.page === input.currentPage);
    if (pageHits.length === 0) {
      return { ok: false, code: "page_not_in_sources" };
    }
    if (chunk && chunk.page != null && chunk.page !== input.currentPage) {
      return { ok: false, code: "page_chunk_mismatch" };
    }
    const matched = chunk ? [chunk.id] : pageHits.map((c) => c.id);
    return { ok: true, matchedChunkIds: matched };
  }

  // chunk only
  return { ok: true, matchedChunkIds: chunk ? [chunk.id] : [] };
}
