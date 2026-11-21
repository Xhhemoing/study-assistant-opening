import type { Capability } from "../capability";
import { comparisonBarsCapability } from "./comparison-bars";
import { flowDiagramCapability } from "./flow-diagram";
import { EXTENDED_CAPABILITIES, RULE_WITNESS_CAPABILITIES, proposalDiffCapability, functionDiffPlotCapability, subspaceRowTraceCapability, dsPointerStepCapability } from "./rule-witness";

export * from "./comparison-bars";
export * from "./flow-diagram";
export * from "./rule-witness";

/** Domain-neutral capabilities every host can register alongside its own. */
export const STANDARD_CAPABILITIES: readonly Capability[] = [flowDiagramCapability, comparisonBarsCapability, ...EXTENDED_CAPABILITIES];
export { EXTENDED_CAPABILITIES, RULE_WITNESS_CAPABILITIES, proposalDiffCapability, functionDiffPlotCapability, subspaceRowTraceCapability, dsPointerStepCapability };
