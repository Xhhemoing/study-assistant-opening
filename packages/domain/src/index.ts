/**
 * Pure domain package — no UI/DB/Redis imports.
 * Workspace smoke symbol used by monorepo quality gates.
 */
export const PLATFORM_NAME = "AIstudy" as const;

export type SummaryBand = "stable" | "usable" | "weak" | "untested";

export function isSummaryBand(value: string): value is SummaryBand {
  return (
    value === "stable" ||
    value === "usable" ||
    value === "weak" ||
    value === "untested"
  );
}

export { SRS_VERSION, createInitialState, scheduleReview } from "./srs/scheduler";
export { ASSESSMENT_VERSION, deriveStatus, type EvidenceEvent } from "./assessment/status";
export {
  PLANNER_VERSION,
  buildTodayPlan,
  type PlannerInput,
  type PlannerPointInput,
} from "./planning/planner";
export { rankResults, type SearchDoc, type SearchHit } from "./search/query";
export {
  assertNonEmptyRevisionBlocks,
  diffRevisionBlocks,
  selectProposalBlocks,
  preserveBothBlocks,
} from "./revisions/proposals";
export {
  REQUIREMENT_PROFILE_VERSION,
  REQUIREMENT_PROFILES,
  REQUIREMENT_PROFILES_BY_KIND,
  getRequirementProfile,
  resolveRequirementProfile,
  listRequirementProfileKinds,
  isAssessmentEnabled,
  validateAbilityWeights,
  normalizeAbilityWeights,
  type RequirementPreset,
} from "./courses/requirements";
