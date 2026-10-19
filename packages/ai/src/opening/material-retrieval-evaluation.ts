import type { MaterialRetrievalEvaluation, SystemQueryRequest, SystemQueryResult } from "@aistudy/contracts";

type Reader = (request: SystemQueryRequest, signal: AbortSignal) => Promise<SystemQueryResult>;
type Chunk = { id: string; sourceId: string; sourceVersion: number; physicalPage: number | null };
type Hits = { chunks: Chunk[]; complete: boolean; reason: string | null };
type Score = { recallAtK: number; reciprocalRank: number };
type EvaluationCase = { id: string; group: MaterialRetrievalEvaluation["cases"][number]["group"]; query: string; relevantChunkIds: string[] | null;
  expansionQueries: string[]; status: "scored" | "unable_to_judge" | "judged_no_relevant_chunks"; reason: string | null;
  baseline: { retrievedChunkIds: string[]; metrics: Score | null }; contextAlias: { retrievedChunkIds: string[]; metrics: Score | null } };
const compare = (a: Chunk, b: Chunk): number => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : (a.physicalPage ?? Infinity) - (b.physicalPage ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sameChunks = (a: Chunk[], b: Chunk[]) => JSON.stringify(a) === JSON.stringify(b);
const score = (ids: string[], relevant: string[]): Score => ({ recallAtK: ids.filter(id => relevant.includes(id)).length / relevant.length,
  reciprocalRank: ids.findIndex(id => relevant.includes(id)) < 0 ? 0 : 1 / (ids.findIndex(id => relevant.includes(id)) + 1) });

/** Only this evaluation runner uses augmentation; it never changes production ranking. */
export function materialEvaluationQueries(test: MaterialRetrievalEvaluation["cases"][number], aliases: MaterialRetrievalEvaluation["aliases"]): string[] {
  const queries = [test.query, ...(test.context?.terms ?? [])];
  for (const alias of aliases) if (test.query.toLowerCase().includes(alias.phrase.toLowerCase())) queries.push(...alias.alternatives);
  return [...new Set(queries)].slice(0, 8);
}
export async function runMaterialRetrievalEvaluation(dataset: MaterialRetrievalEvaluation, reader: Reader,
  options: { mode: "scoped_postgres_reader" | "fixture_replay"; now?: () => Date } = { mode: "scoped_postgres_reader" }) {
  const startedAt = (options.now?.() ?? new Date()).toISOString(), receipts: Array<{ asOf: string; version: string }> = [];
  let permissionRevision: string | null = null, authorizationChanged = false;
  async function read(source: MaterialRetrievalEvaluation["sources"][number], query: string | undefined, offset: number, page?: number, limit = 10): Promise<Hits & { nextOffset: number | null }> {
    try {
      const result = await reader({ name: "materials", arguments: { sourceId: source.sourceId, sourceVersion: source.sourceVersion,
        ...(query ? { query } : {}), ...(page ? { physicalPage: page } : {}), limit, offset } }, new AbortController().signal);
      if (result.name !== "materials" || result.authorization.workspaceId !== dataset.scope.workspaceId
        || result.authorization.principalId !== dataset.scope.ownerUserId || result.authorization.purpose !== "system_record_lookup") {
        authorizationChanged = true; return { chunks: [], complete: false, reason: "authorization_mismatch", nextOffset: null };
      }
      if (permissionRevision !== null && permissionRevision !== result.authorization.permissionRevision) authorizationChanged = true;
      permissionRevision ??= result.authorization.permissionRevision;
      receipts.push({ asOf: result.asOf, version: result.version });
      if (result.status === "unknown" || result.status === "partial" && (result.reason !== "truncated" || result.nextOffset === null)) return { chunks: [], complete: false, reason: result.reason, nextOffset: null };
      const chunks = result.data.map(row => ({ id: row.id, sourceId: row.sourceId, sourceVersion: row.sourceVersion, physicalPage: row.physicalPage }));
      if (chunks.some(chunk => chunk.sourceId !== source.sourceId || chunk.sourceVersion !== source.sourceVersion)) return { chunks: [], complete: false, reason: "source_version_mismatch", nextOffset: null };
      return { chunks, complete: true, reason: null, nextOffset: result.nextOffset };
    } catch { return { chunks: [], complete: false, reason: "reader_error", nextOffset: null }; }
  }
  async function inventory(source: MaterialRetrievalEvaluation["sources"][number]): Promise<Hits> {
    const chunks: Chunk[] = [];
    let offset = 0;
    while (offset <= 1000) {
      const response = await read(source, undefined, offset);
      if (!response.complete) return { chunks, complete: false, reason: response.reason };
      chunks.push(...response.chunks);
      if (response.nextOffset === null) return { chunks, complete: true, reason: null };
      if (response.nextOffset <= offset) return { chunks, complete: false, reason: "pagination_not_advancing" };
      offset = response.nextOffset;
    }
    return { chunks, complete: false, reason: "corpus_inventory_truncated" };
  }
  const before = new Map<string, Hits>();
  for (const source of dataset.sources) before.set(source.sourceId, await inventory(source));
  const accessible = new Set([...before.values()].flatMap(value => value.chunks.map(chunk => chunk.id)));
  async function retrieve(test: MaterialRetrievalEvaluation["cases"][number], augmented: boolean): Promise<Hits> {
    const context = augmented ? test.context : undefined;
    const sources = context?.sourceId ? dataset.sources.filter(source => source.sourceId === context.sourceId) : dataset.sources;
    if (!sources.length || context?.sourceVersion !== undefined && sources.some(source => source.sourceVersion !== context.sourceVersion)) return { chunks: [], complete: false, reason: "context_outside_frozen_corpus" };
    const ranked: Chunk[][] = [];
    for (const query of augmented ? materialEvaluationQueries(test, dataset.aliases) : [test.query]) {
      const chunks: Chunk[] = [];
      for (const source of sources) {
        const result = await read(source, query, 0, context?.physicalPage, dataset.k);
        if (!result.complete) return result;
        chunks.push(...result.chunks);
      }
      ranked.push(chunks.sort(compare).slice(0, dataset.k));
    }
    if (!augmented) return { chunks: ranked[0]!, complete: true, reason: null };
    const fused = new Map<string, { chunk: Chunk; score: number }>();
    for (const ranking of ranked) ranking.forEach((chunk, index) => {
      const prior = fused.get(chunk.id);
      fused.set(chunk.id, { chunk, score: (prior?.score ?? 0) + 1 / (60 + index + 1) });
    });
    return { chunks: [...fused.values()].sort((a, b) => b.score - a.score || compare(a.chunk, b.chunk)).slice(0, dataset.k).map(value => value.chunk), complete: true, reason: null };
  }
  const cases: EvaluationCase[] = [];
  for (const test of dataset.cases) {
    const baseline = await retrieve(test, false), augmented = await retrieve(test, true);
    const targets = test.relevantChunkIds;
    const reason = targets === null ? "relevance_not_annotated" : [...before.values()].some(value => !value.complete) ? "corpus_unavailable_or_truncated"
      : targets.some(id => !accessible.has(id)) ? "relevant_chunk_not_in_accessible_corpus" : !baseline.complete ? baseline.reason : !augmented.complete ? augmented.reason : null;
    cases.push({ id: test.id, group: test.group, query: test.query, relevantChunkIds: targets, expansionQueries: materialEvaluationQueries(test, dataset.aliases),
      status: reason ? "unable_to_judge" : targets?.length ? "scored" : "judged_no_relevant_chunks", reason,
      baseline: { retrievedChunkIds: baseline.chunks.map(chunk => chunk.id), metrics: !reason && targets?.length ? score(baseline.chunks.map(chunk => chunk.id), targets) : null },
      contextAlias: { retrievedChunkIds: augmented.chunks.map(chunk => chunk.id), metrics: !reason && targets?.length ? score(augmented.chunks.map(chunk => chunk.id), targets) : null } });
  }
  let corpusChanged = false;
  for (const source of dataset.sources) {
    const after = await inventory(source), initial = before.get(source.sourceId)!;
    if (!after.complete || !initial.complete || !sameChunks(initial.chunks, after.chunks)) corpusChanged = true;
  }
  if (authorizationChanged || corpusChanged) for (const row of cases) {
    row.status = "unable_to_judge"; row.reason = authorizationChanged ? "authorization_changed" : "corpus_changed_or_unavailable";
    row.baseline.metrics = null; row.contextAlias.metrics = null;
  }
  const scored = cases.filter(test => test.status === "scored");
  const aggregate = (rows: typeof cases, method: "baseline" | "contextAlias") => ({ count: rows.length,
    recallAtK: rows.length ? rows.reduce((sum, row) => sum + row[method].metrics!.recallAtK, 0) / rows.length : null,
    mrrAtK: rows.length ? rows.reduce((sum, row) => sum + row[method].metrics!.reciprocalRank, 0) / rows.length : null });
  return { protocolVersion: dataset.protocolVersion, datasetId: dataset.datasetId, corpusVersion: dataset.corpusVersion,
    annotationProvenance: dataset.annotationProvenance, mode: options.mode, k: dataset.k, startedAt, completedAt: (options.now?.() ?? new Date()).toISOString(),
    scope: dataset.scope, corpus: dataset.sources.map(source => ({ ...source, complete: before.get(source.sourceId)!.complete,
      chunkIds: before.get(source.sourceId)!.chunks.map(chunk => chunk.id) })), readReceipts: receipts,
    coverage: { total: cases.length, pairedScored: scored.length, noRelevantTargets: cases.filter(row => row.status === "judged_no_relevant_chunks").length,
      unableToJudge: cases.filter(row => row.status === "unable_to_judge").length },
    aggregate: { baseline: aggregate(scored, "baseline"), contextAlias: aggregate(scored, "contextAlias") },
    groups: [...new Set(cases.map(test => test.group))].map(group => ({ group, baseline: aggregate(scored.filter(test => test.group === group), "baseline"), contextAlias: aggregate(scored.filter(test => test.group === group), "contextAlias") })),
    cases, limitations: ["No production ranking changes or paid embedding/model calls.", "Paired metrics exclude unavailable, stale, drifting or unannotated cases rather than treating them as misses.", "Separate reader transactions are version-pinned and inventoried before/after; this is not one database snapshot.", options.mode === "fixture_replay" ? "Repository teaching-fixture replay only; PostgreSQL and production relevance were not measured." : "Relevance labels were supplied by the operator and are not automatically certified."] };
}
