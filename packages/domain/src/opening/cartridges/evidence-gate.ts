import { verifyProbeDistinguishability, type ProbeDistinguishabilityReport } from "./probe-protocol";
import type { CartridgeRegistry } from "./registry";
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
  | "cartridge_probe_not_distinguishable"
  | "cartridge_probe_requirement_mismatch"
  | "cartridge_response_invalid"
  | "cartridge_outcome_unverified"
  | "cartridge_outcome_conflict"
  | "cartridge_evaluation_failed"
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

/**
 * Decide whether a cartridge emission may contribute to formal mastery/learner-state
 * progression. L1–L3 cartridges, unregistered cartridges and unverified probes stay
 * practice/continuity feedback.
 */
export function qualifyCartridgeEmission(
  registry: CartridgeRegistry,
  emission: CartridgeObservationEmission,
  observation: CartridgeEvidenceObservationFacts = {},
): CartridgeEvidenceQualification {
  const result: CartridgeEvidenceQualification = {
    qualified: false, cartridgeId: emission.cartridgeId, probeId: emission.probeId,
    level: null, evaluation: null, distinguishability: null, reasonCodes: [],
  };
  const reject = (code: CartridgeEvidenceGateReasonCode) => ({ ...result, reasonCodes: [code] });
  const cartridge = registry.getCartridge(emission.cartridgeId);
  if (!cartridge) return reject("cartridge_unregistered");
  result.level = cartridge.manifest.level;
  if (cartridge.manifest.version !== emission.cartridgeVersion) return reject("cartridge_version_mismatch");
  if (!hasEvidenceCapability(cartridge)) return reject("cartridge_level_below_evidence");
  const probe = cartridge.getProbe(emission.probeId);
  if (!probe) return reject("cartridge_probe_unknown");
  result.distinguishability = verifyProbeDistinguishability(probe);
  if (!result.distinguishability.distinguishable) return reject("cartridge_probe_not_distinguishable");
  if (observation.requirementKey && observation.requirementKey !== probe.requirementKey) {
    return reject("cartridge_probe_requirement_mismatch");
  }
  try {
    result.evaluation = cartridge.evaluateProbeResponse(emission.probeId, emission.response);
  } catch {
    return reject("cartridge_evaluation_failed");
  }
  if (result.evaluation.diagnosis === "invalid_response") return reject("cartridge_response_invalid");
  if (result.evaluation.outcome === "unverified") return reject("cartridge_outcome_unverified");
  if (observation.outcome != null && observation.outcome !== result.evaluation.outcome) {
    return reject("cartridge_outcome_conflict");
  }
  return { ...result, qualified: true, reasonCodes: ["cartridge_evidence_qualified"] };
}
