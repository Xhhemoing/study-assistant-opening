import { createCapabilityRegistry, type Capability, type CapabilityRegistry } from "../capability";
import { comparisonBarsCapability } from "./comparison-bars";
import { flowDiagramCapability } from "./flow-diagram";
import {
  EXTENDED_CAPABILITIES,
  RULE_WITNESS_CAPABILITIES,
  dsPointerStepCapability,
  functionDiffPlotCapability,
  proposalDiffCapability,
  subspaceRowTraceCapability,
} from "./rule-witness";

export * from "./comparison-bars";
export * from "./flow-diagram";
export * from "./rule-witness";

/** Domain-neutral capabilities every host can register alongside its own. */
export const STANDARD_CAPABILITIES: readonly Capability[] = [flowDiagramCapability, comparisonBarsCapability];

/** Extended v3 capabilities (rule-witness cards + host-only proposal diffs). */
export const V3_CAPABILITIES: readonly Capability[] = [...STANDARD_CAPABILITIES, ...EXTENDED_CAPABILITIES] as const;

/** Builds a v3 capability registry including standard, rule-witness, and host-only proposal capabilities. */
export function createV3CapabilityRegistry(extra: readonly Capability[] = []): CapabilityRegistry {
  return createCapabilityRegistry([...V3_CAPABILITIES, ...extra]);
}

export {
  EXTENDED_CAPABILITIES,
  RULE_WITNESS_CAPABILITIES,
  proposalDiffCapability,
  functionDiffPlotCapability,
  subspaceRowTraceCapability,
  dsPointerStepCapability,
};
