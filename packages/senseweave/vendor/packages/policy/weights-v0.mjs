/** Internal audit identity only; not a public policy version or learned parameters.
 * Frozen design heuristics. Explicit feedback is an input, never weight training.
 */
export const WEIGHTS_VERSION = 'weights-v0';
export const WEIGHTS_V0 = Object.freeze({
  base: 0.74, markdownTable: 0.54, planning: 0.88, json: 0.64,
  math: 0.78, diff: 0.8, diagram: 0.8, variant: 0.92, explored: 0.6,
  large: 0.16, inspectCompare: 0.16, compactWide: -0.16, small: -0.08,
  jsonLong: 0.12, jsonInspect: 0.12, visual: 0.1, reader: -0.2,
  constant: -0.24, missing: -0.14, compactMany: -0.12, feedback: 1
});
export const VISUAL_COST_V0 = Object.freeze({table:1,plot:3,chart:2,diagram:2,json:1,diff:1,math:1,details:1});
