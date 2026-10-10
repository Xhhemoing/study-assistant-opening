import type { SourceChunk } from "@aistudy/contracts";

type ContextOptions = {
  chunks: SourceChunk[];
  query: string;
  maxCharacters: number;
  preferChunkId?: string;
  preferPage?: number;
};

function terms(value: string): Array<{ whole: string; grams: string[] }> {
  // Strip sentence punctuation, but keep formula operators, parentheses and primes intact.
  const tokens = value.toLocaleLowerCase().slice(0, 20_000).split(/\s+/)
    .map((token) => token.replace(/^[,.;:!?"“”「」『』、，。；：！？…]+|[,.;:!?"“”「」『』、，。；：！？…]+$/gu, ""))
    .filter(Boolean);
  return [...new Set(tokens)].map((whole) => {
    const grams = new Set<string>();
    for (const run of whole.match(/\p{Script=Han}+/gu) ?? []) {
      for (let i = 0; i < run.length - 1; i++) grams.add(run.slice(i, i + 2));
    }
    return { whole, grams: [...grams] };
  });
}

/** Keyword / CJK bigram overlap score (no embeddings). Shared with pick-sources. */
export function keywordOverlapScore(query: string, text: string): number {
  const queryTerms = terms(query);
  const haystack = text.toLocaleLowerCase();
  return queryTerms.reduce(
    (total, term) =>
      total +
      (haystack.includes(term.whole)
        ? 1
        : term.grams.filter((gram) => haystack.includes(gram)).length /
          Math.max(1, term.grams.length)),
    0,
  );
}

function isUsableChunk(chunk: SourceChunk): boolean {
  if (chunk.text.trim().length > 0) return true;
  return chunk.imageObjectKey != null && chunk.imageObjectKey !== "";
}

function preferenceRank(
  chunk: SourceChunk,
  preferChunkId?: string,
  preferPage?: number,
): number {
  if (chunk.id === preferChunkId) return 2;
  if (preferPage !== undefined && chunk.page === preferPage) return 1;
  return 0;
}

function compareRanked(
  a: { chunk: SourceChunk; preferred: number; score: number },
  b: { chunk: SourceChunk; preferred: number; score: number },
): number {
  return (
    b.preferred - a.preferred ||
    b.score - a.score ||
    a.chunk.sourceId.localeCompare(b.chunk.sourceId) ||
    (a.chunk.page ?? Number.MAX_SAFE_INTEGER) -
      (b.chunk.page ?? Number.MAX_SAFE_INTEGER) ||
    a.chunk.id.localeCompare(b.chunk.id)
  );
}

function fillBudget(ranked: SourceChunk[], maxCharacters: number): SourceChunk[] {
  const selected: SourceChunk[] = [];
  let used = 0;
  for (const chunk of ranked) {
    const length = renderContext([chunk]).length + (selected.length ? 1 : 0);
    if (used + length > maxCharacters) continue;
    selected.push(chunk);
    used += length;
  }
  return selected;
}

export function renderContext(chunks: SourceChunk[]): string {
  return chunks.map((chunk) => {
    const location = chunk.slideLabel ? `slide ${chunk.slideLabel}` : `page ${chunk.page ?? "-"}`;
    return `[source ${chunk.sourceId} v${chunk.sourceVersion} ${location} chunk ${chunk.id} — UNTRUSTED DATA]\n${chunk.text}\n[/source ${chunk.sourceId} — END UNTRUSTED DATA]`;
  }).join("\n");
}

/**
 * Rank and budget-fill chunks for the tutor provider.
 * Blank queries keep budget-only selection.
 * Non-blank queries prefer lexical matches / preferChunkId / preferPage.
 * Package C honesty: when selected/pool chunks exist but every query score is 0
 * (and nothing is preferred), fall back to deterministic first-pages / budget-fill
 * so usable material is never silently dropped.
 */
export function selectContext(options: ContextOptions): SourceChunk[] {
  if (options.maxCharacters <= 0 || options.chunks.length === 0) return [];
  const blankQuery = options.query.trim().length === 0;
  const scored = options.chunks.map((chunk) => ({
    chunk,
    preferred: preferenceRank(chunk, options.preferChunkId, options.preferPage),
    score: keywordOverlapScore(options.query, chunk.text),
  }));
  let ranked = scored.filter(
    ({ preferred, score }) => blankQuery || preferred > 0 || score > 0,
  );
  // Query miss with no preferred hits: never silently empty if usable chunks exist.
  if (ranked.length === 0 && !blankQuery) {
    const usable = scored.filter(({ chunk }) => isUsableChunk(chunk));
    ranked = usable;
  }
  ranked.sort(compareRanked);
  return fillBudget(
    ranked.map(({ chunk }) => chunk),
    options.maxCharacters,
  );
}
