import { evaluateProbeWithSnapshot } from "./capability-helpers";
import {
  callCartridgeDataMethod, cloneCartridgeData, isInspectableCartridgeObject, readCartridgeDataProperty,
  isPlainCartridgeRecord,
} from "./clone-cartridge-data";
import type { ProbeDistinguishabilityReport, VerifiedProbeSnapshot } from "./probe-protocol";
import { readProbeRejection, readProbeSnapshot } from "./published-probe";
import { getCartridge, type CartridgeRegistry } from "./registry";
import { hasEvidenceCapability, type CartridgeCapabilityLevel, type CartridgeProbeEvaluation } from "./types";

/**
 * Server-side record of what a cartridge observed. It carries the raw response, never a
 * client-supplied verdict: the gate re-derives outcome and distinguishability itself.
 */
export interface CartridgeObservationEmission {
  cartridgeId: string;
  cartridgeVersion: string;
  probeId: string;
  response: unknown;
}

export type CartridgeEvidenceGateReasonCode =
  | "cartridge_unregistered"
  | "cartridge_version_mismatch"
  | "cartridge_level_below_evidence"
  | "cartridge_probe_unknown"
  | "cartridge_probe_lookup_failed"
  | "cartridge_probe_identity_mismatch"
  | "cartridge_probe_not_distinguishable"
  | "cartridge_probe_requirement_mismatch"
  | "cartridge_response_invalid"
  | "cartridge_outcome_unverified"
  | "cartridge_outcome_conflict"
  | "cartridge_evaluation_failed"
  | "cartridge_evaluation_mismatch"
  | "cartridge_evidence_qualified";

export interface CartridgeEvidenceQualification {
  /** True only for an L4 cartridge whose probe passed the distinguishability pre-check. */
  qualified: boolean;
  cartridgeId: string;
  probeId: string;
  level: CartridgeCapabilityLevel | null;
  evaluation: CartridgeProbeEvaluation | null;
  distinguishability: ProbeDistinguishabilityReport | null;
  reasonCodes: CartridgeEvidenceGateReasonCode[];
}

export interface CartridgeEvidenceObservationFacts {
  outcome?: string | null;
  requirementKey?: string | null;
}

export function malformedCartridgeEmission(): CartridgeEvidenceQualification {
  return {
    qualified: false, cartridgeId: "", probeId: "", level: null,
    evaluation: null, distinguishability: null, reasonCodes: ["cartridge_evaluation_failed"],
  };
}

function evaluationsMatch(
  expected: CartridgeProbeEvaluation,
  actual: unknown,
): boolean {
  if (!isInspectableCartridgeObject(actual)) return false;
  try {
    const candidate = cloneCartridgeData(actual) as Partial<CartridgeProbeEvaluation>;
    return candidate.probeId === expected.probeId
      && candidate.requirementKey === expected.requirementKey
      && candidate.outcome === expected.outcome
      && candidate.diagnosis === expected.diagnosis
      && candidate.matchedHypothesisId === expected.matchedHypothesisId
      && candidate.observableKey === expected.observableKey;
  } catch {
    return false;
  }
}

function snapshotResponse(value: unknown) {
  try {
    const verifiedResponseCopy = cloneCartridgeData(value);
    // Both scorers start from independently held copies of the same capture.
    const cartridgeResponseCopy = structuredClone(verifiedResponseCopy);
    return { verifiedResponseCopy, cartridgeResponseCopy };
  } catch {
    return null;
  }
}

/**
 * Decide whether a cartridge emission may contribute to formal mastery/learner-state
 * progression. L1–L3 cartridges, unregistered cartridges and unverified probes stay
 * practice/continuity feedback.
 */
export function qualifyCartridgeEmission(
  registry: CartridgeRegistry,
  emission: unknown,
  observation: CartridgeEvidenceObservationFacts = {},
): CartridgeEvidenceQualification {
  let capturedEmission: Readonly<{
    cartridgeId: string;
    cartridgeVersion: string;
    probeId: string;
    response: ReturnType<typeof snapshotResponse>;
  }>;
  let capturedObservation: Readonly<{
    outcome: string | null;
    requirementKey: string | null;
  }>;
  try {
    if (!isInspectableCartridgeObject(emission)) return malformedCartridgeEmission();
    const { cartridgeId, cartridgeVersion, probeId, response } = emission as Partial<CartridgeObservationEmission>;
    const cloned = snapshotResponse(response);
    if (typeof cartridgeId !== "string" || typeof cartridgeVersion !== "string" || typeof probeId !== "string") {
      return {
        qualified: false,
        cartridgeId: typeof cartridgeId === "string" ? cartridgeId : "",
        probeId: typeof probeId === "string" ? probeId : "",
        level: null,
        evaluation: null,
        distinguishability: null,
        reasonCodes: ["cartridge_evaluation_failed"],
      };
    }
    capturedEmission = Object.freeze({
      cartridgeId,
      cartridgeVersion,
      probeId,
      response: cloned,
    });
    const rawOutcome = observation && typeof observation === "object" ? observation.outcome : null;
    const rawRequirementKey = observation && typeof observation === "object" ? observation.requirementKey : null;
    capturedObservation = Object.freeze({
      outcome: rawOutcome ?? null,
      requirementKey: rawRequirementKey ?? null,
    });
  } catch {
    return malformedCartridgeEmission();
  }

  const result: CartridgeEvidenceQualification = {
    qualified: false, cartridgeId: capturedEmission.cartridgeId, probeId: capturedEmission.probeId,
    level: null, evaluation: null, distinguishability: null, reasonCodes: [],
  };
  const reject = (code: CartridgeEvidenceGateReasonCode) => ({ ...result, reasonCodes: [code] });
  if (!capturedEmission.response) return reject("cartridge_response_invalid");

  let cartridge: ReturnType<CartridgeRegistry["getCartridge"]>;
  try {
    cartridge = getCartridge(registry, capturedEmission.cartridgeId);
  } catch {
    return reject("cartridge_evaluation_failed");
  }
  if (!cartridge) return reject("cartridge_unregistered");
  let manifestVersion: string;
  try {
    const rawManifest = readCartridgeDataProperty(cartridge, "manifest");
    if (!isPlainCartridgeRecord(rawManifest)) return reject("cartridge_evaluation_failed");
    const manifest = cloneCartridgeData(rawManifest);
    if (!Object.hasOwn(manifest, "id") || typeof manifest.id !== "string" || manifest.id !== capturedEmission.cartridgeId) {
      return reject("cartridge_unregistered");
    }
    result.level = manifest.level;
    manifestVersion = manifest.version;
  } catch {
    return reject("cartridge_evaluation_failed");
  }
  if (manifestVersion !== capturedEmission.cartridgeVersion) return reject("cartridge_version_mismatch");
  if (!hasEvidenceCapability(cartridge)) return reject("cartridge_level_below_evidence");

  let snapshot: VerifiedProbeSnapshot;
  try {
    const probe = callCartridgeDataMethod(cartridge, "getProbe", [capturedEmission.probeId]);
    if (probe === null) return reject("cartridge_probe_unknown");
    snapshot = readProbeSnapshot(probe);
  } catch (error) {
    const report = readProbeRejection(error);
    if (report) {
      result.distinguishability = report;
      return reject(report.probeId === capturedEmission.probeId
        ? "cartridge_probe_not_distinguishable"
        : "cartridge_probe_identity_mismatch");
    }
    return reject("cartridge_probe_lookup_failed");
  }
  result.distinguishability = snapshot.report;
  if (snapshot.probeId !== capturedEmission.probeId) return reject("cartridge_probe_identity_mismatch");
  if (!snapshot.report.distinguishable) return reject("cartridge_probe_not_distinguishable");
  if (capturedObservation.requirementKey && capturedObservation.requirementKey !== snapshot.requirementKey) {
    return reject("cartridge_probe_requirement_mismatch");
  }

  const verified = evaluateProbeWithSnapshot(snapshot, capturedEmission.response.verifiedResponseCopy);
  if (verified.encodingFailed) return reject("cartridge_evaluation_failed");

  let cartridgeEvaluation: unknown;
  try {
    cartridgeEvaluation = callCartridgeDataMethod(cartridge, "evaluateProbeResponse", [
      capturedEmission.probeId,
      capturedEmission.response.cartridgeResponseCopy,
    ]);
  } catch {
    return reject("cartridge_evaluation_failed");
  }
  if (!evaluationsMatch(verified.evaluation, cartridgeEvaluation)) {
    return reject("cartridge_evaluation_mismatch");
  }

  result.evaluation = verified.evaluation;
  if (result.evaluation.diagnosis === "invalid_response") return reject("cartridge_response_invalid");
  if (result.evaluation.outcome === "unverified") return reject("cartridge_outcome_unverified");
  if (capturedObservation.outcome != null && capturedObservation.outcome !== result.evaluation.outcome) {
    return reject("cartridge_outcome_conflict");
  }
  return { ...result, qualified: true, reasonCodes: ["cartridge_evidence_qualified"] };
}
