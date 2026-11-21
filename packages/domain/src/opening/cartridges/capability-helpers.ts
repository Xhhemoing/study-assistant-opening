import { cloneCartridgeData } from "./clone-cartridge-data";
import {
  classifyProbeResponseWithSnapshot,
  isVerifiedProbeSnapshot,
  snapshotAndVerifyProbe,
  type DistinguishableProbeSpec,
  type VerifiedProbeSnapshot,
} from "./probe-protocol";
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
  rawCandidates: readonly CartridgeTaskCandidate[],
  rawWindows: readonly CartridgeActiveRetestWindow[],
  now: string,
): CartridgeTaskCandidate[] {
  const candidates = cloneCartridgeData(rawCandidates);
  const windows = cloneCartridgeData(rawWindows);
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
  return [...cloneCartridgeData(candidates)].sort((a, b) => b.priority - a.priority
    || Date.parse(a.earliestAt) - Date.parse(b.earliestAt)
    || a.candidateId.localeCompare(b.candidateId));
}

/* ------------------------------------------------------------ L3 helpers -- */

/** A citation is grounded only when its quote is an exact substring of the cited chunk version. */
function citationMatchesChunk(citation: CartridgeCitation, chunks: readonly CartridgeMaterialChunk[]): boolean {
  if (!citation.quote.trim()) return false;
  return chunks.some(chunk => chunk.sourceId === citation.sourceId && chunk.sourceVersion === citation.sourceVersion
    && chunk.chunkId === citation.chunkId && chunk.page === citation.page && chunk.text.includes(citation.quote));
}

export function isCitationGrounded(citation: CartridgeCitation, chunks: readonly CartridgeMaterialChunk[]): boolean {
  try {
    return citationMatchesChunk(cloneCartridgeData(citation), cloneCartridgeData(chunks));
  } catch {
    return false;
  }
}

export function keepGroundedSeeds(
  seeds: readonly CartridgeExerciseSeed[],
  chunks: readonly CartridgeMaterialChunk[],
): CartridgeExerciseSeed[] {
  const capturedChunks = cloneCartridgeData(chunks);
  return cloneCartridgeData(seeds).filter(seed => citationMatchesChunk(seed.citation, capturedChunks));
}

/* ------------------------------------------------------------ L4 helpers -- */

export interface SnapshotProbeEvaluationResult {
  evaluation: CartridgeProbeEvaluation;
  /** True when a parsed observable cannot be isolated or encoded to a stable, valid key. */
  encodingFailed: boolean;
}

/**
 * Deterministic response evaluation strictly against a single immutable verified probe
 * snapshot. Withholds graded outcomes (`outcome: "unverified"`) whenever probe
 * verification failed or response encoding failed.
 */
export function evaluateProbeWithSnapshot<TObservable>(
  snapshot: VerifiedProbeSnapshot<TObservable>,
  response: unknown,
): SnapshotProbeEvaluationResult {
  if (!isVerifiedProbeSnapshot(snapshot)) {
    return {
      evaluation: { probeId: "", requirementKey: "", outcome: "unverified", diagnosis: "unclassified", matchedHypothesisId: null, observableKey: null },
      encodingFailed: true,
    };
  }
  const base = { probeId: snapshot.probeId, requirementKey: snapshot.requirementKey };
  if (!snapshot.report.distinguishable || snapshot.correctObservableKey === null) {
    return {
      evaluation: { ...base, outcome: "unverified", diagnosis: "unclassified", matchedHypothesisId: null, observableKey: null },
      encodingFailed: false,
    };
  }
  const { classification, encodingFailed } = classifyProbeResponseWithSnapshot(snapshot, response);
  if (encodingFailed) {
    return {
      evaluation: { ...base, outcome: "unverified", diagnosis: "unclassified", matchedHypothesisId: null, observableKey: null },
      encodingFailed: true,
    };
  }
  if (!classification.wellFormed || classification.observableKey === null) {
    return {
      evaluation: { ...base, outcome: "unverified", diagnosis: "invalid_response", matchedHypothesisId: null, observableKey: null },
      encodingFailed: false,
    };
  }
  if (classification.observableKey === snapshot.correctObservableKey) {
    return {
      evaluation: { ...base, outcome: "correct", diagnosis: "correct_model", matchedHypothesisId: null, observableKey: classification.observableKey },
      encodingFailed: false,
    };
  }
  const misconception = classification.match?.role === "misconception" ? classification.match.modelId : null;
  return {
    evaluation: {
      ...base,
      outcome: "incorrect",
      diagnosis: misconception ? "misconception" : "unclassified",
      matchedHypothesisId: misconception,
      observableKey: classification.observableKey,
    },
    encodingFailed: false,
  };
}

/**
 * Deterministic response evaluation for a probe spec. Captures a single immutable
 * prediction snapshot and runs both distinguishability verification and response
 * scoring against that exact snapshot.
 */
export function evaluateProbeWithSpec<TInput, TObservable>(
  spec: DistinguishableProbeSpec<TInput, TObservable>,
  response: unknown,
): CartridgeProbeEvaluation {
  return evaluateProbeWithSnapshot(snapshotAndVerifyProbe(spec), response).evaluation;
}
