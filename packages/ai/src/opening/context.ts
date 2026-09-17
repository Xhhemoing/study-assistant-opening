import type { SourceChunk } from "@aistudy/contracts";

type ContextOptions = { chunks: SourceChunk[]; query: string; maxCharacters: number; preferChunkId?: string; preferPage?: number };
function terms(value: string): string[] {
  return value.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}
function score(chunk: SourceChunk, queryTerms: string[]): number { const text = chunk.text.toLocaleLowerCase(); return queryTerms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0); }
function compare(a: SourceChunk, b: SourceChunk, queryTerms: string[], options: ContextOptions): number {
  const preferred = (chunk: SourceChunk): number => chunk.id === options.preferChunkId ? 2 : options.preferPage !== undefined && chunk.page === options.preferPage ? 1 : 0;
  return preferred(b) - preferred(a) || score(b, queryTerms) - score(a, queryTerms) || a.sourceId.localeCompare(b.sourceId) || (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id);
}
export function renderContext(chunks: SourceChunk[]): string { return chunks.map((chunk) => { const location = chunk.slideLabel ? `slide ${chunk.slideLabel}` : `page ${chunk.page ?? "-"}`; return `[source ${chunk.sourceId} v${chunk.sourceVersion} ${location} — UNTRUSTED DATA]\n${chunk.text}\n[/source ${chunk.sourceId} — END UNTRUSTED DATA]`; }).join("\n"); }
export function selectContext(options: ContextOptions): SourceChunk[] {
  if (options.maxCharacters <= 0 || options.chunks.length === 0) return [];
  const ranked = [...options.chunks].sort((a, b) => compare(a, b, terms(options.query), options)); const selected: SourceChunk[] = [];
  for (const chunk of ranked) if (renderContext([...selected, chunk]).length <= options.maxCharacters) selected.push(chunk);
  return selected;
}
