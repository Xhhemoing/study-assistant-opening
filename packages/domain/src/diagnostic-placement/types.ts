import type { SkillBeliefV1 } from "../epistemic/belief";

export const MAX_EXACT_KST_STATES = 20_000;
export const DEFAULT_MIN_PLACEMENT_ITEMS = 8;
export const DEFAULT_MAX_PLACEMENT_ITEMS = 12;
export const MAX_PLACEMENT_ITEMS_CEILING = 12;
export const DEFAULT_PLACEMENT_BUDGET_SECONDS = 900;
export const MAX_PLACEMENT_BUDGET_SECONDS = 900;
export const DEFAULT_SKIP_THRESHOLD = 0.85;
export const DEFAULT_READY_THRESHOLD = 0.7;
export const DEFAULT_HIGH_VALUE_WEIGHT_THRESHOLD = 0.2;
export const DELAYED_CHECK_AFTER_HOURS = 72;
export const MAX_TOTAL_DRILLDOWN_PROBES = 2;
export const INTEGRATION_STEP_COORDINATION = "integration_step_coordination" as const;

export const SKIP_CANDIDATE_UI_LABEL = "暂跳讲解，随时补看";
export const READY_UI_LABEL = "可进入当前学习";
export const BLOCKED_UI_LABEL = "先补前置基础";

export type DiagnosticPlacementErrorCode = "VALIDATION" | "STATE" | "INVALID_STATE" | "INFEASIBLE";

export class DiagnosticPlacementError extends Error {
  readonly code: DiagnosticPlacementErrorCode;
  constructor(code: DiagnosticPlacementErrorCode, message: string) {
    super(message);
    this.name = "DiagnosticPlacementError";
    this.code = code;
  }
}

export type DiagnosticSkillNode = {
  skillId: string;
  chapterId: string;
  title?: string;
  prerequisiteIds?: readonly string[];
  syllabusWeight?: number;
  priorMastery?: number;
};

export type DiagnosticProbeItem = {
  itemId: string;
  familyId: string;
  chapterId: string;
  requiredSkillIds: readonly string[];
  slip: number;
  guess: number;
  estimatedSeconds: number;
};

export type DiagnosticProbeChannel =
  | "unassisted"
  | "hinted"
  | "assisted"
  | "multi-draft"
  | "abandoned"
  | "invalid";

export type DiagnosticProbeObservation = {
  observationId: string;
  itemId: string;
  correct: boolean;
  channel?: DiagnosticProbeChannel;
  unassisted?: boolean;
  assisted?: boolean;
  hinted?: boolean;
  valid?: boolean;
  elapsedSeconds?: number;
  answeredAtMs?: number;
};

export type KstApproximationMode = "exact" | "component_decomposed" | "bounded_component_envelope";
export type KstComponentMode = "exact" | "bounded_component_envelope";

export type KstComponentJointWeights = {
  componentId: string;
  skillIds: readonly string[];
  approximationMode: KstComponentMode;
  exactStateCountEstimate: number | null;
  stateCount: number;
  wByState: Readonly<Record<string, number>>;
};

export type KstSnapshotV1 = {
  schemaVersion: 1;
  snapshotId: string;
  courseId?: string;
  learnerId?: string;
  createdAtMs: number;
  approximationMode: KstApproximationMode;
  totalFeasibleStateCount: number | null;
  totalFeasibleStateCountExact: string | null;
  wByState: Readonly<Record<string, number>> | null;
  componentJointWeights: readonly KstComponentJointWeights[];
  piBySkill: Readonly<Record<string, number>>;
  outerFringeBySkill: Readonly<Record<string, number>>;
  parentsSatisfiedBySkill: Readonly<Record<string, number>>;
  skillCovariance: Readonly<Record<string, Readonly<Record<string, number>>>>;
  prerequisitesBySkill?: Readonly<Record<string, readonly string[]>>;
  consumedProbeObservationIds: readonly string[];
};

export type KstObservationUpdateResult = {
  applied: boolean;
  reason: "updated" | "duplicate_observation" | "assisted_or_invalid_response" | "zero_likelihood_observation";
  observationId: string;
  consumedProbeObservationIds: readonly string[];
};

export type PartitionedObservation<T extends { observationId: string }> = T & {
  eligibleForDirectUpdate: boolean;
  eligibleForFirePropagation: boolean;
  alreadyConsumedByKst: boolean;
};

export type PartitionedObservationsResult<T extends { observationId: string }> = {
  directObservations: readonly T[];
  unconsumedObservations: readonly T[];
  strippedConsumedObservations: readonly PartitionedObservation<T>[];
  annotatedObservations: readonly PartitionedObservation<T>[];
  consumedObservationIds: readonly string[];
};

export type DownstreamSkillProbeObservation = {
  observationId: string;
  skillId: string;
  correct: boolean;
  slip: number;
  guess: number;
  channel?: DiagnosticProbeChannel;
  unassisted?: boolean;
  assisted?: boolean;
  hinted?: boolean;
  valid?: boolean;
  eligibleForFirePropagation?: boolean;
};

export type DownstreamSkillPosteriorResult = {
  skillId: string;
  priorProbability: number;
  posteriorProbability: number;
  appliedObservationIds: readonly string[];
  partitioned: PartitionedObservationsResult<DownstreamSkillProbeObservation>;
  belief?: SkillBeliefV1;
};

export type PlacementRouteKind = "inferred_skip_candidate" | "inferred_ready" | "prerequisite_gap_blocked";

export type SkillPlacementRoute = {
  skillId: string;
  chapterId: string;
  route: PlacementRouteKind;
  masteryProbability: number;
  outerFringeProbability: number;
  parentsSatisfiedProbability: number;
  syllabusWeight: number;
  countsTowardMastery: false;
  verificationStatus: "unverified_inferred";
  uiLabel: string;
  holdoutVerificationRequired: boolean;
  delayedCheckAfterHours: number | null;
  missingPrerequisiteIds: readonly string[];
};

export type ChapterQuotaInput = number | { minItems?: number; maxItems?: number };

export type PlacementSessionConfig = {
  minItems?: number;
  maxItems?: number;
  totalBudgetSeconds?: number;
  chapterQuotas?: Readonly<Record<string, ChapterQuotaInput>>;
  earlyStopMinMutualInfoBits?: number;
  skipThreshold?: number;
  readyThreshold?: number;
  highValueWeightThreshold?: number;
};

export type PlacementStopReason =
  | "max_items_reached"
  | "uncertainty_converged"
  | "time_budget_exhausted"
  | "candidate_pool_exhausted"
  | "infeasible_constraints";

export type PlacementSelectionResult = {
  status: "selected" | "stopped";
  probe: DiagnosticProbeItem | null;
  mutualInformationBits: number | null;
  stopReason: PlacementStopReason | null;
  administeredCount: number;
  remainingBudgetSeconds: number;
};

export type FrozenOriginalContext = {
  readonly originalAttemptId: string;
  readonly originalItemId: string;
  readonly frozenDraftText: string;
  readonly frozenCursorOffset: number;
  readonly startedAtMs: number;
};

export type DrilldownRootCause =
  | "prerequisite_deficit"
  | typeof INTEGRATION_STEP_COORDINATION
  | "insufficient_diagnostic_evidence";
export type RepairPlanStepKind = "foundational_prerequisite" | "bridging_step" | "restore_original_attempt";
export type RepairPlanStep = { stepIndex: number; kind: RepairPlanStepKind; skillId: string; itemId: string | null; label: string };
export type DrilldownHypothesisPosterior = { hypothesisId: string; kind: DrilldownRootCause; skillId: string | null; probability: number };
export type DrilldownStatus = "probing" | "repair_plan_ready" | "restore_original_attempt";
