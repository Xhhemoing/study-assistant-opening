import type { SourceChunk } from "@aistudy/contracts";

type ContextOptions = { chunks: SourceChunk[]; query: string; maxCharacters: number; preferChunkId?: string; preferPage?: number };

function terms(value: string): Array<{ whole: string; grams: string[] }> {
  const tokens = value.toLocaleLowerCase().slice(0, 20_000).split(/\s+/).filter(Boolean);
  return [...new Set(tokens)].map((whole) => {
    const grams = new Set<string>();
    for (const run of whole.match(/\p{Script=Han}+/gu) ?? []) {
      for (let i = 0; i < run.length - 1; i++) grams.add(run.slice(i, i + 2));
    }
    return { whole, grams: [...grams] };
  });
}

export function renderContext(chunks: SourceChunk[]): string {
  return chunks.map((chunk) => {
    const location = chunk.slideLabel ? `slide ${chunk.slideLabel}` : `page ${chunk.page ?? "-"}`;
    return `[source ${chunk.sourceId} v${chunk.sourceVersion} ${location} chunk ${chunk.id} — UNTRUSTED DATA]\n${chunk.text}\n[/source ${chunk.sourceId} — END UNTRUSTED DATA]`;
  }).join("\n");
}

export function selectContext(options: ContextOptions): SourceChunk[] {
  if (options.maxCharacters <= 0 || options.chunks.length === 0) return [];
  const queryTerms = terms(options.query);
  const ranked = options.chunks.map((chunk) => {
    const text = chunk.text.toLocaleLowerCase();
    return {
      chunk,
      preferred: chunk.id === options.preferChunkId ? 2 : options.preferPage !== undefined && chunk.page === options.preferPage ? 1 : 0,
      // A full term has weight one; overlapping CJK grams must not amplify it.
      score: queryTerms.reduce((total, term) => total + (text.includes(term.whole) ? 1 :
        term.grams.filter((gram) => text.includes(gram)).length / Math.max(1, term.grams.length)), 0),
    };
  }).sort((a, b) => b.preferred - a.preferred || b.score - a.score ||
    a.chunk.sourceId.localeCompare(b.chunk.sourceId) ||
    (a.chunk.page ?? Number.MAX_SAFE_INTEGER) - (b.chunk.page ?? Number.MAX_SAFE_INTEGER) ||
    a.chunk.id.localeCompare(b.chunk.id));
  const selected: SourceChunk[] = [];
  let used = 0;
  for (const { chunk } of ranked) {
    const length = renderContext([chunk]).length + (selected.length ? 1 : 0);
    if (used + length > options.maxCharacters) continue;
    selected.push(chunk);
    used += length;
  }
  return selected;
}
