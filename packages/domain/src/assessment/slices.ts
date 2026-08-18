import type { AbilityWeights } from "@aistudy/contracts";
import type { AssessmentSlice } from "./status";

const WEIGHT_TO_SLICE: Array<[keyof AbilityWeights, AssessmentSlice]> = [
  ["recognition", "recognition"],
  ["recall", "recall"],
  ["procedural", "procedure"],
  ["transfer", "transfer"],
  ["expression", "expression"],
  ["timed", "timed"],
];

export function disabledSlicesFromWeights(abilities: AbilityWeights): AssessmentSlice[] {
  return WEIGHT_TO_SLICE.filter(([key]) => abilities[key] === 0).map(([, slice]) => slice);
}
