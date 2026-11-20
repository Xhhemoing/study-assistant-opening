import { classifyProbeResponse, verifyProbeDistinguishability, type DistinguishableProbeSpec } from "./probe-protocol";
import type {
  CartridgeActiveRetestWindow,
  CartridgeCitation,
  CartridgeExerciseSeed,
  CartridgeMaterialChunk,
  CartridgeProbeEvaluation,
  CartridgeTaskCandidate,
} from "./types";

/* ------------------------------------------------------------ L2 helpers -- */

function windowContains(window: CartridgeActiveRetestWindow, at: number): boolean {
  const opens = Date.parse(window.opensAt);
  const closes = window.closesAt === null ? Infinity : Date.parse(window.closesAt);
  return Number.isFinite(opens) && at >= opens && at < closes;
}

/**
 * Keep cartridge practice from contaminating host retests: candidates for a requirement
 * whose retest window is active are suppressed; candidates that would start inside a
 * future window are deferred to its close (or suppressed when it has no close).
 */
export function respectActiveRetestWindows(
  candidates: readonly CartridgeTaskCandidate[],
  windows: readonly CartridgeActiveRetestWindow[],
  now: string,
): CartridgeTaskCandidate[] {
  const nowMs = Date.parse(now);
  const result: CartridgeTaskCandidate[] = [];
  for (const candidate of candidates) {
    const relevant = windows.filter(window => window.requirementKey === candidate.requirementKey);
    if (relevant.some(window => windowContains(window, nowMs))) continue;
    let earliest = Date.parse(candidate.earliestAt);
    let suppressed = false;
    // Windows may chain; defer repeatedly in opening order until no window contains the start.
    const ordered = [...relevant].sort((a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt));
    for (const window of ordered) {
      if (!windowContains(window, earliest)) continue;
      if (window.closesAt === null) { suppressed = true; break; }
      earliest = Date.parse(window.closesAt);
    }
    if (suppressed) continue;
    result.push({ ...candidate, earliestAt: new Date(earliest).toISOString() });
  }
  return result;
}

/** Stable order: priority desc, earliest asc, id asc. */
export function sortTaskCandidates(candidates: readonly CartridgeTaskCandidate[]): CartridgeTaskCandidate[] {
  return [...candidates].sort((a, b) => b.priority - a.priority
    || Date.parse(a.earliestAt) - Date.parse(b.earliestAt)
    || a.candidateId.localeCompare(b.candidateId));
}

/* ------------------------------------------------------------ L3 helpers -- */

/** A citation is grounded only when its quote is an exact substring of the cited chunk version. */
export function isCitationGrounded(citation: CartridgeCitation, chunks: readonly CartridgeMaterialChunk[]): boolean {
  if (!citation.quote.trim()) return false;
  return chunks.some(chunk => chunk.sourceId === citation.sourceId && chunk.sourceVersion === citation.sourceVersion
    && chunk.chunkId === citation.chunkId && chunk.page === citation.page && chunk.text.includes(citation.quote));
}

export function keepGroundedSeeds(
  seeds: readonly CartridgeExerciseSeed[],
  chunks: readonly CartridgeMaterialChunk[],
): CartridgeExerciseSeed[] {
  return seeds.filter(seed => isCitationGrounded(seed.citation, chunks));
}

/* ------------------------------------------------------------ L4 helpers -- */

/**
 * Deterministic response evaluation for a probe spec. Correctness is decided against the
 * correct model alone; misconception attribution requires a unique matching hypothesis.
 */
export function evaluateProbeWithSpec<TInput, TObservable>(
  spec: DistinguishableProbeSpec<TInput, TObservable>,
  response: unknown,
): CartridgeProbeEvaluation {
  const base = { probeId: spec.probeId, requirementKey: spec.requirementKey };
  const classification = classifyProbeResponse(spec, response);
  if (!classification.wellFormed) {
    return { ...base, outcome: "unverified", diagnosis: "invalid_response", matchedHypothesisId: null, observableKey: null };
  }
  const report = verifyProbeDistinguishability(spec);
  const correctKey = report.predictions[0]?.observableKey ?? null;
  if (correctKey === null) {
    return { ...base, outcome: "unverified", diagnosis: "unclassified", matchedHypothesisId: null,
      observableKey: classification.observableKey };
  }
  if (classification.observableKey === correctKey) {
    return { ...base, outcome: "correct", diagnosis: "correct_model", matchedHypothesisId: null, observableKey: correctKey };
  }
  const misconception = classification.match?.role === "misconception" ? classification.match.modelId : null;
  return { ...base, outcome: "incorrect", diagnosis: misconception ? "misconception" : "unclassified",
    matchedHypothesisId: misconception, observableKey: classification.observableKey };
}
