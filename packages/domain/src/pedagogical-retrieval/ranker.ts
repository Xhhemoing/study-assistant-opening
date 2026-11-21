import { normalizeSparseAdjacency, sparsePpr } from "./sparse-ppr";
import type {
  CitationAnchor,
  DualCitationBundle,
  PedagogicalBlockKind,
  PedagogicalChunk,
  PedagogicalConceptNode,
  PedagogicalEdgeKind,
  PedagogicalGraphEdge,
  PedagogicalRetrievalAuthorization,
  RankPedagogicalEvidenceInput,
  RankPedagogicalEvidenceResult,
  RankedPedagogicalChunk,
  ScoredCandidate,
  SparseWeightedEdge,
} from "./types";

const DEFAULT_RRF_K = 60;
const DEFAULT_SEED_WEIGHT = 0.55;
const DEFAULT_PPR_WEIGHT = 0.45;
const DEFAULT_PREREQUISITE_WEIGHT = 0.15;
const DEFAULT_MAX_RESULTS = 24;

/**
 * Per-relation mass budget so high-degree example/illustration hubs cannot
 * drown out prerequisite or definition links during graph propagation.
 */
const EDGE_FAMILY_BUDGET: Readonly<Record<string, number>> = {
  prerequisite_walk: 0.45,
  definition_link: 0.30,
  concept_evidence: 0.15,
  support_walk: 0.10,
};

const PEDAGOGICAL_FOUNDATION_TIER: Readonly<Record<PedagogicalBlockKind, number>> = {
  definition: 0,
  lemma: 1,
  theorem: 2,
  proof: 3,
  display_math: 4,
  example: 5,
  prose: 6,
  heading: 6,
  table: 6,
  code: 6,
  transcript_cue: 6,
  exercise: 7,
  hint: 8,
  solution: 9,
};

function toSet(input?: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (!input) return new Set();
  return input instanceof Set ? input : new Set(input);
}

function isSourceAdmissible(
  sourceId: string,
  sourceVersion: number | undefined,
  admissibleSources: ReadonlySet<string>,
  admissibleVersions?: Readonly<Record<string, number>>,
): boolean {
  if (!admissibleSources.has(sourceId)) return false;
  if (admissibleVersions && Object.hasOwn(admissibleVersions, sourceId)) {
    if (sourceVersion === undefined || admissibleVersions[sourceId] !== sourceVersion) return false;
  }
  return true;
}

function matchesPrivacyEpoch(
  itemEpoch: number | undefined,
  expectedEpoch: number | undefined,
): boolean {
  if (expectedEpoch === undefined) return true;
  if (itemEpoch === undefined) return false;
  return itemEpoch === expectedEpoch;
}

function buildCitationAnchor(chunk: PedagogicalChunk): CitationAnchor {
  if (chunk.startMs !== null && chunk.endMs !== null) {
    return {
      kind: "media",
      sourceId: chunk.sourceId,
      sourceVersion: chunk.sourceVersion,
      chunkId: chunk.id,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      keyframeChunkId: chunk.keyframeChunkId,
    };
  }
  return {
    kind: "document",
    sourceId: chunk.sourceId,
    sourceVersion: chunk.sourceVersion,
    chunkId: chunk.id,
    physicalPage: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
  };
}

/**
 * Group ranked pedagogical evidence into dual independent verifiable anchors:
 * document `physicalPage` citations and media `[startMs, endMs, keyframeChunkId]` citations.
 */
export function buildDualCitationBundle(
  ranked: readonly RankedPedagogicalChunk[],
): DualCitationBundle {
  const documentAnchors: Extract<CitationAnchor, { kind: "document" }>[] = [];
  const mediaAnchors: Extract<CitationAnchor, { kind: "media" }>[] = [];
  const seen = new Set<string>();
  for (const item of ranked) {
    if (seen.has(item.citationAnchor.chunkId)) continue;
    seen.add(item.citationAnchor.chunkId);
    if (item.citationAnchor.kind === "media") mediaAnchors.push(item.citationAnchor);
    else documentAnchors.push(item.citationAnchor);
  }
  return { documentAnchors, mediaAnchors };
}

interface TypedGraphEdge {
  readonly from: number;
  readonly to: number;
  readonly family: keyof typeof EDGE_FAMILY_BUDGET;
  readonly weight: number;
}

function normalizeTypedAdjacency(nodeCount: number, edges: readonly TypedGraphEdge[]) {
  // Allocate per-family budgets per source node, then normalize across present families.
  const perNode = Array.from(
    { length: nodeCount },
    () => new Map<string, Map<number, number>>(),
  );
  for (const edge of edges) {
    if (edge.weight <= 0 || !Number.isFinite(edge.weight)) continue;
    const families = perNode[edge.from]!;
    let targets = families.get(edge.family);
    if (!targets) {
      targets = new Map();
      families.set(edge.family, targets);
    }
    targets.set(edge.to, (targets.get(edge.to) ?? 0) + edge.weight);
  }

  const flattened: SparseWeightedEdge[] = [];
  for (let u = 0; u < nodeCount; u++) {
    const families = perNode[u]!;
    if (families.size === 0) continue;
    let activeBudgetSum = 0;
    for (const family of families.keys()) {
      activeBudgetSum += EDGE_FAMILY_BUDGET[family] ?? 0.1;
    }
    for (const [family, targets] of families.entries()) {
      const familyMass = (EDGE_FAMILY_BUDGET[family] ?? 0.1) / activeBudgetSum;
      let targetSum = 0;
      for (const w of targets.values()) targetSum += w;
      if (targetSum <= 0) continue;
      for (const [v, w] of targets.entries()) {
        flattened.push({ from: u, to: v, weight: familyMass * (w / targetSum) });
      }
    }
  }
  return normalizeSparseAdjacency(nodeCount, flattened);
}

function compareChunksDeterministically(a: PedagogicalChunk, b: PedagogicalChunk): number {
  return (
    a.sourceId.localeCompare(b.sourceId) ||
    a.sourceVersion - b.sourceVersion ||
    (a.pageStart ?? Number.MAX_SAFE_INTEGER) - (b.pageStart ?? Number.MAX_SAFE_INTEGER) ||
    (a.startMs ?? Number.MAX_SAFE_INTEGER) - (b.startMs ?? Number.MAX_SAFE_INTEGER) ||
    a.startOffset - b.startOffset ||
    a.id.localeCompare(b.id)
  );
}

function filterEdgeAuthorized(
  edge: PedagogicalGraphEdge,
  auth: PedagogicalRetrievalAuthorization,
  admissibleSources: ReadonlySet<string>,
  survivingNodeIds: ReadonlySet<string>,
  survivingChunkIds: ReadonlySet<string>,
): boolean {
  // Answer-solving edges and sealed edges NEVER enter the retrieval graph.
  if (edge.kind === "solves") return false;
  if (edge.visibility === "sealed") return false;
  if (edge.visibility === "hint_gated" && !auth.allowHintGated) return false;
  if (!matchesPrivacyEpoch(edge.privacyEpoch, auth.expectedPrivacyEpoch)) return false;
  if (!survivingNodeIds.has(edge.from) || !survivingNodeIds.has(edge.to)) return false;
  if (edge.sourceId !== undefined && !admissibleSources.has(edge.sourceId)) return false;
  if (edge.supportingSourceIds && edge.supportingSourceIds.length > 0) {
    if (!edge.supportingSourceIds.some(sourceId => admissibleSources.has(sourceId))) return false;
  }
  if (edge.supportingChunkIds && edge.supportingChunkIds.length > 0) {
    if (!edge.supportingChunkIds.some(chunkId => survivingChunkIds.has(chunkId))) return false;
  }
  return true;
}

function edgeDirectionPlan(
  kind: PedagogicalEdgeKind,
  fromIdx: number,
  toIdx: number,
  weight: number,
): TypedGraphEdge[] {
  switch (kind) {
    case "prerequisite":
      // `from` is a prerequisite of `to` (matches opening_course_knowledge).
      // Walk backward (`to -> from`) with high weight to retrieve foundations!
      return [
        { from: toIdx, to: fromIdx, family: "prerequisite_walk", weight },
        { from: fromIdx, to: toIdx, family: "support_walk", weight: weight * 0.25 },
      ];
    case "requires":
    case "uses_formula":
      // `from` directly requires `to`.
      return [
        { from: fromIdx, to: toIdx, family: "prerequisite_walk", weight },
        { from: toIdx, to: fromIdx, family: "support_walk", weight: weight * 0.25 },
      ];
    case "defines":
    case "states":
      return [
        { from: fromIdx, to: toIdx, family: "definition_link", weight },
        { from: toIdx, to: fromIdx, family: "definition_link", weight },
      ];
    case "proves":
    case "illustrates":
    case "applies_to":
    case "contains":
    case "next_step":
      return [
        { from: fromIdx, to: toIdx, family: "support_walk", weight },
        { from: toIdx, to: fromIdx, family: "support_walk", weight: weight * 0.5 },
      ];
    case "solves":
      return [];
  }
}

function orderFoundationsBeforeDependents(
  selected: readonly RankedPedagogicalChunk[],
  prereqBeforePairs: ReadonlySet<string>,
  conceptsByChunkId: ReadonlyMap<string, ReadonlySet<string>>,
): RankedPedagogicalChunk[] {
  if (selected.length <= 1) return [...selected];
  const n = selected.length;
  const outgoing: number[][] = Array.from({ length: n }, () => []);
  const inDegree = new Int32Array(n);

  const addOrderConstraint = (beforeIdx: number, afterIdx: number) => {
    if (beforeIdx === afterIdx) return;
    if (outgoing[beforeIdx]!.includes(afterIdx)) return;
    outgoing[beforeIdx]!.push(afterIdx);
    inDegree[afterIdx]!++;
  };

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const chunkA = selected[i]!.chunk;
      const chunkB = selected[j]!.chunk;

      // 1. Explicit filtered prerequisite / requires / defines dependency: A precedes B.
      if (prereqBeforePairs.has(`${chunkA.id}\0${chunkB.id}`)) {
        addOrderConstraint(i, j);
        continue;
      }

      // Guard reverse direction: never add a shared-concept tier edge A -> B when an
      // explicit prerequisite already requires B -> A (prevents spurious 2-cycles).
      if (prereqBeforePairs.has(`${chunkB.id}\0${chunkA.id}`)) {
        continue;
      }

      // 2. Shared concept foundational tier: e.g. Definition precedes Theorem/Proof/Example
      //    for the same concept, without letting unrelated low-scoring definitions hijack rank 1.
      const conceptsA = conceptsByChunkId.get(chunkA.id);
      const conceptsB = conceptsByChunkId.get(chunkB.id);
      let sharedConcept = false;
      if (conceptsA && conceptsB) {
        for (const c of conceptsA) {
          if (conceptsB.has(c)) {
            sharedConcept = true;
            break;
          }
        }
      }
      if (sharedConcept) {
        const tierA = PEDAGOGICAL_FOUNDATION_TIER[chunkA.kind];
        const tierB = PEDAGOGICAL_FOUNDATION_TIER[chunkB.kind];
        if (tierA < tierB) {
          addOrderConstraint(i, j);
        }
      }
    }
  }

  // Compute each node's effective priority = highest relevance rank (lowest index)
  // among itself and all descendants it unlocks, so prerequisites of rank-0 hits
  // are emitted ahead of lower-ranked unrelated components.
  const effectivePriority = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let best = i;
    const seen = new Uint8Array(n);
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur < best) best = cur;
      for (const next of outgoing[cur]!) {
        if (!seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    effectivePriority[i] = best;
  }

  // Kahn's topological sort breaking ties by (effectivePriority asc, foundationTier asc, originalRank asc),
  // falling back cleanly if a cyclic dependency exists.
  const emitted = new Uint8Array(n);
  const ordered: RankedPedagogicalChunk[] = [];
  const isBetter = (a: number, b: number): boolean => {
    const prioDiff = effectivePriority[a]! - effectivePriority[b]!;
    if (prioDiff !== 0) return prioDiff < 0;
    const tierDiff =
      PEDAGOGICAL_FOUNDATION_TIER[selected[a]!.chunk.kind] -
      PEDAGOGICAL_FOUNDATION_TIER[selected[b]!.chunk.kind];
    if (tierDiff !== 0) return tierDiff < 0;
    return a < b;
  };
  for (let step = 0; step < n; step++) {
    let pick = -1;
    for (let idx = 0; idx < n; idx++) {
      if (!emitted[idx] && inDegree[idx] === 0 && (pick === -1 || isBetter(idx, pick))) {
        pick = idx;
      }
    }
    if (pick === -1) {
      // Break any cycle deterministically by highest effective priority remaining.
      for (let idx = 0; idx < n; idx++) {
        if (!emitted[idx] && (pick === -1 || isBetter(idx, pick))) {
          pick = idx;
        }
      }
    }
    emitted[pick] = 1;
    ordered.push(selected[pick]!);
    for (const next of outgoing[pick]!) {
      inDegree[next]!--;
    }
  }

  return ordered;
}

/**
 * Scale-invariant score-weighted RRF over admissible candidates.
 * Reduces identically to standard RRF `1 / (k + rank)` when scores are uniform,
 * while preventing low-relevance tail hits from stealing PPR restart mass.
 */
function computeWeightedRrfSeeds(
  rankings: readonly (readonly ScoredCandidate[])[],
  admissibleIds: ReadonlySet<string>,
  k: number,
): Map<string, number> {
  if (!Number.isFinite(k) || k <= 0) {
    throw new RangeError(`RRF constant k must be finite and > 0, got ${k}`);
  }
  const scores = new Map<string, number>();
  for (const list of rankings) {
    const deduped = new Map<string, number>();
    let maxScore = 0;
    for (const candidate of list) {
      if (!admissibleIds.has(candidate.id)) continue;
      if (!Number.isFinite(candidate.score) || candidate.score <= 0) continue;
      const existing = deduped.get(candidate.id);
      if (existing === undefined || candidate.score > existing) {
        deduped.set(candidate.id, candidate.score);
      }
      if (candidate.score > maxScore) maxScore = candidate.score;
    }
    if (maxScore <= 0) continue;
    const ordered = [...deduped.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    for (let rank = 0; rank < ordered.length; rank++) {
      const [id, rawScore] = ordered[rank]!;
      const relWeight = rawScore / maxScore;
      scores.set(id, (scores.get(id) ?? 0) + relWeight / (k + rank + 1));
    }
  }
  return scores;
}

/**
 * Filter chunks, concepts, and edges strictly BEFORE graph construction and
 * traversal, fuse lexical/dense RRF seeds with ~15-line sparse PPR over the
 * authorized pedagogical graph, boost prerequisite neighborhoods, and order
 * foundational definitions before dependent theorems.
 */
export function rankPedagogicalEvidence(
  input: RankPedagogicalEvidenceInput,
): RankPedagogicalEvidenceResult {
  const { authorization, options = {} } = input;
  const admissibleSources = toSet(authorization.admissibleSourceIds);
  const excludedFamilies = toSet(authorization.excludedItemFamilyIds);
  const allowHintGated = authorization.allowHintGated ?? false;

  const rrfK = options.rrfK ?? DEFAULT_RRF_K;
  const seedWeight = options.seedWeight ?? DEFAULT_SEED_WEIGHT;
  const pprWeight = options.pprWeight ?? DEFAULT_PPR_WEIGHT;
  const prerequisiteWeight = options.prerequisiteWeight ?? DEFAULT_PREREQUISITE_WEIGHT;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const orderFoundationsFirst = options.orderFoundationsFirst ?? true;

  // 1. Pre-graph strict chunk filtering (ZERO sealed / unauthorized / wrong-epoch mass).
  let filteredSealedChunks = 0;
  let filteredHintGatedChunks = 0;
  let filteredUnauthorizedChunks = 0;
  let filteredExcludedFamilyChunks = 0;

  const survivingChunks: PedagogicalChunk[] = [];
  const survivingChunkIds = new Set<string>();
  for (const chunk of input.chunks) {
    if (chunk.visibility === "sealed") {
      filteredSealedChunks++;
      continue;
    }
    if (chunk.visibility === "hint_gated" && !allowHintGated) {
      filteredHintGatedChunks++;
      continue;
    }
    if (
      !isSourceAdmissible(
        chunk.sourceId,
        chunk.sourceVersion,
        admissibleSources,
        authorization.admissibleSourceVersions,
      ) ||
      !matchesPrivacyEpoch(chunk.privacyEpoch, authorization.expectedPrivacyEpoch)
    ) {
      filteredUnauthorizedChunks++;
      continue;
    }
    if (chunk.itemFamilyId && excludedFamilies.has(chunk.itemFamilyId)) {
      filteredExcludedFamilyChunks++;
      continue;
    }
    if (!survivingChunkIds.has(chunk.id)) {
      survivingChunkIds.add(chunk.id);
      survivingChunks.push(chunk);
    }
  }

  // Deterministic canonical node order ensures bit-for-bit stable graph indices.
  survivingChunks.sort(compareChunksDeterministically);

  // 2. Pre-graph strict concept filtering.
  const survivingConcepts: PedagogicalConceptNode[] = [];
  const survivingConceptIds = new Set<string>();
  for (const concept of input.concepts ?? []) {
    if (!matchesPrivacyEpoch(concept.privacyEpoch, authorization.expectedPrivacyEpoch)) continue;
    if (concept.supportingSourceIds && concept.supportingSourceIds.length > 0) {
      if (!concept.supportingSourceIds.some(sourceId => admissibleSources.has(sourceId))) continue;
    }
    if (concept.evidenceChunkIds && concept.evidenceChunkIds.length > 0) {
      if (!concept.evidenceChunkIds.some(chunkId => survivingChunkIds.has(chunkId))) continue;
    }
    if (!survivingConceptIds.has(concept.id) && !survivingChunkIds.has(concept.id)) {
      survivingConceptIds.add(concept.id);
      survivingConcepts.push(concept);
    }
  }
  survivingConcepts.sort((a, b) => a.id.localeCompare(b.id));

  // Build unified index space: [chunks..., concepts...]
  const nodeIds: string[] = [
    ...survivingChunks.map(c => c.id),
    ...survivingConcepts.map(c => c.id),
  ];
  const nodeIndexById = new Map<string, number>(nodeIds.map((id, idx) => [id, idx]));
  const survivingNodeIds = new Set(nodeIds);

  // Track concept memberships per surviving chunk for foundational ordering & bipartite edges.
  const conceptsByChunkId = new Map<string, Set<string>>();
  const chunksByConceptId = new Map<string, Set<string>>();
  const linkChunkConcept = (chunkId: string, conceptId: string) => {
    if (!survivingChunkIds.has(chunkId) || !survivingConceptIds.has(conceptId)) return;
    let cSet = conceptsByChunkId.get(chunkId);
    if (!cSet) {
      cSet = new Set();
      conceptsByChunkId.set(chunkId, cSet);
    }
    cSet.add(conceptId);
    let kSet = chunksByConceptId.get(conceptId);
    if (!kSet) {
      kSet = new Set();
      chunksByConceptId.set(conceptId, kSet);
    }
    kSet.add(chunkId);
  };

  for (const chunk of survivingChunks) {
    for (const conceptId of chunk.conceptIds ?? []) {
      linkChunkConcept(chunk.id, conceptId);
    }
  }
  for (const concept of survivingConcepts) {
    for (const chunkId of concept.evidenceChunkIds ?? []) {
      linkChunkConcept(chunkId, concept.id);
    }
  }

  // 3. Filter edges BEFORE building transition matrix.
  const typedEdges: TypedGraphEdge[] = [];
  const prerequisiteTargetsBySource = new Map<string, Set<string>>();
  const addPrereqLink = (dependentId: string, prereqId: string) => {
    let set = prerequisiteTargetsBySource.get(dependentId);
    if (!set) {
      set = new Set();
      prerequisiteTargetsBySource.set(dependentId, set);
    }
    set.add(prereqId);
  };

  let survivingEdges = 0;
  let filteredEdges = 0;
  for (const edge of input.edges ?? []) {
    if (
      !filterEdgeAuthorized(
        edge,
        authorization,
        admissibleSources,
        survivingNodeIds,
        survivingChunkIds,
      )
    ) {
      filteredEdges++;
      continue;
    }
    const weight = edge.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      filteredEdges++;
      continue;
    }
    const fromIdx = nodeIndexById.get(edge.from)!;
    const toIdx = nodeIndexById.get(edge.to)!;
    const expanded = edgeDirectionPlan(edge.kind, fromIdx, toIdx, weight);
    if (expanded.length === 0) {
      filteredEdges++;
      continue;
    }
    survivingEdges++;
    typedEdges.push(...expanded);

    if (edge.kind === "prerequisite") {
      addPrereqLink(edge.to, edge.from);
    } else if (edge.kind === "requires" || edge.kind === "uses_formula") {
      addPrereqLink(edge.from, edge.to);
    } else if (edge.kind === "defines") {
      addPrereqLink(edge.to, edge.from);
    }
  }

  // Add bipartite edges between surviving chunks and their linked surviving concepts.
  for (const [chunkId, conceptSet] of conceptsByChunkId.entries()) {
    const chunkIdx = nodeIndexById.get(chunkId)!;
    for (const conceptId of conceptSet) {
      const conceptIdx = nodeIndexById.get(conceptId)!;
      const chunk = survivingChunks[chunkIdx]!;
      const family = chunk.kind === "definition" ? "definition_link" : "concept_evidence";
      typedEdges.push(
        { from: chunkIdx, to: conceptIdx, family, weight: 1 },
        { from: conceptIdx, to: chunkIdx, family, weight: 1 },
      );
    }
  }

  // 4. Compute score-weighted RRF + explicit seeds strictly over surviving nodes.
  const rankings = [
    ...(input.lexicalRanking ? [input.lexicalRanking] : []),
    ...(input.denseRanking ? [input.denseRanking] : []),
  ];
  const rrfScores = computeWeightedRrfSeeds(rankings, survivingNodeIds, rrfK);

  const seedVector = new Float64Array(nodeIds.length);
  const seededNodeIds = new Set<string>();
  for (let idx = 0; idx < nodeIds.length; idx++) {
    const id = nodeIds[idx]!;
    const rrf = rrfScores.get(id) ?? 0;
    const explicit =
      input.seedScores && Object.hasOwn(input.seedScores, id) ? input.seedScores[id]! : 0;
    const totalSeed = rrf + (Number.isFinite(explicit) && explicit > 0 ? explicit : 0);
    seedVector[idx] = totalSeed;
    if (totalSeed > 0) seededNodeIds.add(id);
  }

  // 5. Run ~15-line sparse Personalized PageRank over the filtered graph.
  const adjacency = normalizeTypedAdjacency(nodeIds.length, typedEdges);
  const ppr = sparsePpr(adjacency, seedVector, {
    alpha: options.alpha,
    tolerance: options.tolerance,
    maxIterations: options.maxIterations,
  });

  let totalPprMass = 0;
  const pprByNodeId: Record<string, number> = {};
  for (let idx = 0; idx < nodeIds.length; idx++) {
    const mass = ppr[idx]!;
    totalPprMass += mass;
    pprByNodeId[nodeIds[idx]!] = mass;
  }

  // 6. Identify prerequisite neighborhood reachable from seeded nodes (1..2 hops).
  const prereqReachableNodes = new Set<string>();
  const frontier = [...seededNodeIds];
  // Also include concepts directly attached to seeded chunks as starting points.
  for (const seededId of seededNodeIds) {
    for (const cId of conceptsByChunkId.get(seededId) ?? []) {
      frontier.push(cId);
    }
  }
  const visitedPrereq = new Set<string>(frontier);
  let currentLevel = frontier;
  for (let hop = 0; hop < 2; hop++) {
    const nextLevel: string[] = [];
    for (const nodeId of currentLevel) {
      for (const prereqId of prerequisiteTargetsBySource.get(nodeId) ?? []) {
        prereqReachableNodes.add(prereqId);
        if (!visitedPrereq.has(prereqId)) {
          visitedPrereq.add(prereqId);
          nextLevel.push(prereqId);
        }
      }
    }
    currentLevel = nextLevel;
    if (currentLevel.length === 0) break;
  }

  // Expand transitive chunk-level `prereqBeforePairs` from direct chunk edges
  // and concept-level prerequisite chains over the filtered subgraph.
  const prereqBeforePairs = new Set<string>();
  const transitivePrereqsOf = (startId: string): Set<string> => {
    const visited = new Set<string>();
    const queue = [startId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const prereqId of prerequisiteTargetsBySource.get(current) ?? []) {
        if (!visited.has(prereqId)) {
          visited.add(prereqId);
          queue.push(prereqId);
        }
      }
    }
    return visited;
  };
  for (const dependentId of prerequisiteTargetsBySource.keys()) {
    const depChunks = survivingChunkIds.has(dependentId)
      ? [dependentId]
      : [...(chunksByConceptId.get(dependentId) ?? [])];
    if (depChunks.length === 0) continue;
    for (const prereqId of transitivePrereqsOf(dependentId)) {
      const preChunks = survivingChunkIds.has(prereqId)
        ? [prereqId]
        : [...(chunksByConceptId.get(prereqId) ?? [])];
      for (const pre of preChunks) {
        for (const dep of depChunks) {
          if (pre !== dep) prereqBeforePairs.add(`${pre}\0${dep}`);
        }
      }
    }
  }

  // 7. Score surviving chunks (normalize seed & PPR scales cleanly).
  let maxSeed = 0;
  let maxPpr = 0;
  const rawChunkPpr = new Float64Array(survivingChunks.length);
  for (let i = 0; i < survivingChunks.length; i++) {
    const chunk = survivingChunks[i]!;
    if (seedVector[i]! > maxSeed) maxSeed = seedVector[i]!;
    let effectivePpr = ppr[i]!;
    for (const conceptId of conceptsByChunkId.get(chunk.id) ?? []) {
      const conceptIdx = nodeIndexById.get(conceptId)!;
      const conceptShare = ppr[conceptIdx]! / Math.max(1, chunksByConceptId.get(conceptId)?.size ?? 1);
      effectivePpr += conceptShare * 0.5;
    }
    rawChunkPpr[i] = effectivePpr;
    if (effectivePpr > maxPpr) maxPpr = effectivePpr;
  }

  const candidates: RankedPedagogicalChunk[] = [];
  for (let i = 0; i < survivingChunks.length; i++) {
    const chunk = survivingChunks[i]!;
    const rawSeed = seedVector[i]!;
    const chunkPpr = rawChunkPpr[i]!;
    const isPrereqChunk =
      prereqReachableNodes.has(chunk.id) ||
      [...(conceptsByChunkId.get(chunk.id) ?? [])].some(cId => prereqReachableNodes.has(cId));

    // Only emit chunks that received positive retrieval signal (seed or PPR propagation).
    if (rawSeed <= 0 && chunkPpr <= 0) continue;

    const normSeed = maxSeed > 0 ? rawSeed / maxSeed : 0;
    const normPpr = maxPpr > 0 ? chunkPpr / maxPpr : 0;
    const foundationBonus =
      isPrereqChunk ? (chunk.kind === "definition" ? 1.0 : chunk.kind === "lemma" ? 0.85 : 0.65) : 0;

    const combinedScore =
      seedWeight * normSeed + pprWeight * normPpr + prerequisiteWeight * foundationBonus;

    candidates.push({
      chunk,
      seedScore: rawSeed,
      pprScore: chunkPpr,
      prerequisiteBoost: foundationBonus,
      combinedScore,
      citationAnchor: buildCitationAnchor(chunk),
    });
  }

  candidates.sort(
    (a, b) =>
      b.combinedScore - a.combinedScore ||
      b.pprScore - a.pprScore ||
      b.seedScore - a.seedScore ||
      compareChunksDeterministically(a.chunk, b.chunk),
  );

  // Enforce per-item-family diversity cap and maxResults ceiling.
  const selected: RankedPedagogicalChunk[] = [];
  const familyCounts = new Map<string, number>();
  for (const item of candidates) {
    if (selected.length >= maxResults) break;
    const family = item.chunk.itemFamilyId;
    if (family && options.maxChunksPerItemFamily !== undefined) {
      const count = familyCounts.get(family) ?? 0;
      if (count >= options.maxChunksPerItemFamily) continue;
      familyCounts.set(family, count + 1);
    }
    selected.push(item);
  }

  const finalRanked = orderFoundationsFirst
    ? orderFoundationsBeforeDependents(selected, prereqBeforePairs, conceptsByChunkId)
    : selected;

  return {
    ranked: finalRanked,
    citations: buildDualCitationBundle(finalRanked),
    pprByNodeId,
    diagnostics: {
      totalInputChunks: input.chunks.length,
      survivingChunks: survivingChunks.length,
      filteredSealedChunks,
      filteredHintGatedChunks,
      filteredUnauthorizedChunks,
      filteredExcludedFamilyChunks,
      survivingEdges,
      filteredEdges,
      totalPprMass,
    },
  };
}
