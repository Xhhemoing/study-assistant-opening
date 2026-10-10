import type { SourceChunk } from "@aistudy/contracts";
import { keywordOverlapScore } from "./context";

/** Default top-K sources after keyword ranking (Package C). */
export const DEFAULT_PICK_SOURCES_K = 6;
/** Inclusive clamp floor for pick K. */
export const MIN_PICK_SOURCES_K = 3;
/** Inclusive clamp ceiling for pick K. */
export const MAX_PICK_SOURCES_K = 8;

export function clampPickSourcesK(k?: number): number {
  const raw = k === undefined || Number.isNaN(k) ? DEFAULT_PICK_SOURCES_K : Math.floor(k);
  return Math.min(MAX_PICK_SOURCES_K, Math.max(MIN_PICK_SOURCES_K, raw));
}

export type PickSourceIdsOptions = {
  chunks: SourceChunk[];
  query: string;
  /** Restrict ranking to these ids (order preserved as tie-stable input set). */
  sourceIds?: readonly string[];
  /** Top-K after clamp to [MIN_PICK_SOURCES_K, MAX_PICK_SOURCES_K]; default 6. */
  k?: number;
};

/**
 * Rank sources by best chunk keyword/CJK score; return top K (deterministic).
 * Zero-score sources still participate — ordered by sourceId — so a vague query
 * against a large course pool still yields a stable non-empty shortlist.
 */
export function pickSourceIds(options: PickSourceIdsOptions): string[] {
  const k = clampPickSourcesK(options.k);
  const allowed = options.sourceIds?.length
    ? [...new Set(options.sourceIds)]
    : [...new Set(options.chunks.map((chunk) => chunk.sourceId))];
  if (allowed.length === 0) return [];
  if (allowed.length <= k) {
    return [...allowed].sort((a, b) => a.localeCompare(b));
  }
  const bySource = new Map<string, number>();
  for (const id of allowed) bySource.set(id, 0);
  for (const chunk of options.chunks) {
    if (!bySource.has(chunk.sourceId)) continue;
    const score = keywordOverlapScore(options.query, chunk.text);
    const prev = bySource.get(chunk.sourceId) ?? 0;
    if (score > prev) bySource.set(chunk.sourceId, score);
  }
  return [...bySource.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map(([id]) => id);
}

/**
 * True when the client left sourceIds empty and the server filled/narrowed from a pool.
 * Explicit non-empty client selections are never auto-narrowed by pick-sources.
 */
export function shouldAutoPickSources(
  clientSourceIds: readonly string[],
  effectiveSourceIds: readonly string[],
  k: number = DEFAULT_PICK_SOURCES_K,
): boolean {
  return clientSourceIds.length === 0 && effectiveSourceIds.length > clampPickSourcesK(k);
}
