import { COMPARISON_BARS_ID } from "../../capabilities/comparison-bars";
import { FLOW_DIAGRAM_ID } from "../../capabilities/flow-diagram";
import { defineRenderer, type RendererMap } from "../artifact-view";
import { ComparisonBarsView } from "./comparison-bars-view";
import { FlowDiagramView } from "./flow-diagram-view";

export * from "./comparison-bars-view";
export * from "./flow-diagram-view";

/** Renderers for STANDARD_CAPABILITIES; hosts spread their own on top. */
export const STANDARD_RENDERERS: RendererMap = {
  [FLOW_DIAGRAM_ID]: defineRenderer(FlowDiagramView),
  [COMPARISON_BARS_ID]: defineRenderer(ComparisonBarsView),
};
