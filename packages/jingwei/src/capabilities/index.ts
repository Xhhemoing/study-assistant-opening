import type { Capability } from "../capability";
import { comparisonBarsCapability } from "./comparison-bars";
import { flowDiagramCapability } from "./flow-diagram";

export * from "./comparison-bars";
export * from "./flow-diagram";

/** Domain-neutral capabilities every host can register alongside its own. */
export const STANDARD_CAPABILITIES: readonly Capability[] = [flowDiagramCapability, comparisonBarsCapability];
