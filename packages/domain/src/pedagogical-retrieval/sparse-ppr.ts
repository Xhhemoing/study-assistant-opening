import type {
  ScoredCandidate,
  SparseAdjacencyEntry,
  SparsePprOptions,
  SparseTransitionGraph,
  SparseWeightedEdge,
} from "./types";

const DEFAULT_ALPHA = 0.15;
const DEFAULT_TOLERANCE = 1e-7;
const DEFAULT_MAX_ITERATIONS = 32;
const DEFAULT_RRF_K = 60;

/**
 * Build a row-stochastic sparse transition graph from raw directed edges.
 * Outgoing weights per node sum to 1.0 (up to rounding); nodes with no positive
 * outgoing edges remain dangling (`[]`) so `sparsePpr` redistributes their
 * probability mass back to the personalization seed vector.
 */
export function normalizeSparseAdjacency(
  nodeCount: number,
  edges: readonly SparseWeightedEdge[],
): SparseTransitionGraph {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 0) {
    throw new RangeError("nodeCount must be a non-negative safe integer");
  }
  const maxWeights = new Float64Array(nodeCount);
  for (const edge of edges) {
    if (
      !Number.isSafeInteger(edge.from) ||
      !Number.isSafeInteger(edge.to) ||
      edge.from < 0 ||
      edge.from >= nodeCount ||
      edge.to < 0 ||
      edge.to >= nodeCount
    ) {
      throw new RangeError(`Edge (${edge.from} -> ${edge.to}) out of range [0, ${nodeCount})`);
    }
    if (!Number.isFinite(edge.weight) || edge.weight < 0) {
      throw new RangeError(`Edge weight must be finite and non-negative, got ${edge.weight}`);
    }
    maxWeights[edge.from] = Math.max(maxWeights[edge.from]!, edge.weight);
  }

  // Keep parallel weights unscaled while their sum fits, so tiny edges combine before rounding.
  const sumsByNode = Array.from({ length: nodeCount }, () => new Map<number, { weight: number; scaled: boolean }>());
  for (const { from, to, weight } of edges) {
    if (weight === 0) continue;
    const row = sumsByNode[from]!;
    const target = row.get(to);
    if (!target) {
      row.set(to, { weight, scaled: false });
    } else if (target.scaled) {
      target.weight += weight / maxWeights[from]!;
    } else {
      const combined = target.weight + weight;
      if (Number.isFinite(combined)) target.weight = combined;
      else {
        target.weight = target.weight / maxWeights[from]! + weight / maxWeights[from]!;
        target.scaled = true;
      }
    }
  }

  return sumsByNode.map((row, from) => {
    let total = 0;
    for (const target of row.values()) {
      if (!target.scaled) target.weight /= maxWeights[from]!;
      total += target.weight;
    }
    if (total <= 0) return [];
    const entries: SparseAdjacencyEntry[] = [];
    const targets = [...row.keys()].sort((a, b) => a - b);
    for (const target of targets) {
      entries.push([target, row.get(target)!.weight / total]);
    }
    return entries;
  });
}

function normalizeSeedVector(seed: Float64Array): Float64Array | null {
  let maxWeight = 0;
  for (let i = 0; i < seed.length; i++) {
    const value = seed[i]!;
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Seed weight at index ${i} must be finite and non-negative`);
    }
    maxWeight = Math.max(maxWeight, value);
  }
  if (maxWeight === 0) return null;
  const normalized = new Float64Array(seed.length);
  let sum = 0;
  for (let i = 0; i < seed.length; i++) {
    const weight = seed[i]! / maxWeight;
    normalized[i] = weight;
    sum += weight;
  }
  for (let i = 0; i < seed.length; i++) normalized[i] = normalized[i]! / sum;
  return normalized;
}

function validateSparsePprInputs(
  adjacency: SparseTransitionGraph,
  seed: Float64Array,
  alpha: number,
  tolerance: number,
  maxIterations: number,
): void {
  if (adjacency.length !== seed.length) {
    throw new RangeError(`Adjacency length (${adjacency.length}) must equal seed length (${seed.length})`);
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new RangeError(`alpha must lie strictly in (0, 1), got ${alpha}`);
  }
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new RangeError(`tolerance must be finite and > 0, got ${tolerance}`);
  }
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new RangeError(`maxIterations must be a positive safe integer, got ${maxIterations}`);
  }
  for (let u = 0; u < adjacency.length; u++) {
    for (const [v, w] of adjacency[u]!) {
      if (!Number.isSafeInteger(v) || v < 0 || v >= adjacency.length) {
        throw new RangeError(`Target index ${v} at node ${u} out of bounds`);
      }
      if (!Number.isFinite(w) || w < 0) {
        throw new RangeError(`Transition weight (${u} -> ${v}) must be finite and non-negative`);
      }
    }
  }
}

/**
 * Pure ~15-line Sparse Personalized PageRank via power iteration:
 *   p^(k+1) = alpha * s + (1 - alpha) * (W^T p^(k) + d^(k) * s)
 * where `adjacency[u]` is row-stochastic (or empty for dangling nodes).
 * Total probability mass is conserved at 1.0 whenever `seed` has positive mass.
 */
export function sparsePpr(
  adjacency: SparseTransitionGraph,
  seed: Float64Array,
  options: SparsePprOptions = {},
): Float64Array {
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  validateSparsePprInputs(adjacency, seed, alpha, tolerance, maxIterations);
  const s = normalizeSeedVector(seed);
  if (!s) return new Float64Array(adjacency.length);

  let rank = s.slice();
  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Float64Array(s.length);
    let dangling = 0;
    for (let u = 0; u < adjacency.length; u++) {
      const edges = adjacency[u]!;
      if (edges.length === 0) dangling += rank[u]!;
      else for (const [v, w] of edges) next[v]! += (1 - alpha) * rank[u]! * w;
    }
    const teleport = alpha + (1 - alpha) * dangling;
    let delta = 0;
    for (let v = 0; v < next.length; v++) {
      next[v]! += teleport * s[v]!;
      delta += Math.abs(next[v]! - rank[v]!);
    }
    rank = next;
    if (delta < tolerance) break;
  }
  return rank;
}

/**
 * Reciprocal Rank Fusion over one or more scored candidate lists with
 * deterministic tie-breaking (`score desc`, then `id asc`).
 */
export function computeRrfScores(
  rankings: readonly (readonly ScoredCandidate[])[],
  admissibleIds: ReadonlySet<string>,
  k = DEFAULT_RRF_K,
): Map<string, number> {
  if (!Number.isFinite(k) || k <= 0) {
    throw new RangeError(`RRF constant k must be finite and > 0, got ${k}`);
  }
  const scores = new Map<string, number>();
  for (const list of rankings) {
    const deduped = new Map<string, number>();
    for (const candidate of list) {
      if (!admissibleIds.has(candidate.id)) continue;
      if (!Number.isFinite(candidate.score) || candidate.score <= 0) continue;
      const existing = deduped.get(candidate.id);
      if (existing === undefined || candidate.score > existing) {
        deduped.set(candidate.id, candidate.score);
      }
    }
    const ordered = [...deduped.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    for (let rank = 0; rank < ordered.length; rank++) {
      const id = ordered[rank]![0];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return scores;
}
