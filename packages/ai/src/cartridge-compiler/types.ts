/**
 * @aistudy/ai/cartridge-compiler — Gradescope Dynamic Error Clustering &
 * DSPy GEPA (C, -L, T7) Pareto Cartridge Compiler.
 * Pure deterministic self-contained TypeScript (zero node:* or server-only imports).
 */

export const FORBIDDEN_PII_FIELDS = [
  "email",
  "useremail",
  "studentemail",
  "phone",
  "phonenumber",
  "mobile",
  "fullname",
  "studentname",
  "realname",
  "rawname",
  "rawuserid",
  "userid",
  "ssn",
  "ipaddress",
  "address",
] as const;

export const ALLOWED_GEPA_MUTATION_SURFACES = [
  "moveRules",
  "hintLadder",
  "rubricAnchors",
  "approvedTemplateSlots",
] as const;

export type GepaAllowedSurface = (typeof ALLOWED_GEPA_MUTATION_SURFACES)[number];

export const FORBIDDEN_GEPA_MUTATION_SURFACES = [
  "permissions",
  "answerVisibility",
  "gradingWriteAuthority",
  "leakageDetectors",
] as const;

export type GepaForbiddenSurface = (typeof FORBIDDEN_GEPA_MUTATION_SURFACES)[number];

export class CartridgePiiViolationError extends Error {
  constructor(
    message: string,
    readonly offendingFields: readonly string[],
    readonly trajectoryId?: string,
  ) {
    super(message);
    this.name = "CartridgePiiViolationError";
  }
}

export class HoldoutFirewallError extends Error {
  constructor(
    message: string,
    readonly leakedTrajectoryIds: readonly string[],
    readonly leakedLearnerPseudoIds: readonly string[],
    readonly leakedItemFamilyIds: readonly string[],
  ) {
    super(message);
    this.name = "HoldoutFirewallError";
  }
}

export class GepaForbiddenSurfaceError extends Error {
  constructor(
    message: string,
    readonly attemptedSurface: string,
  ) {
    super(message);
    this.name = "GepaForbiddenSurfaceError";
  }
}

export class GepaInvalidPatchPayloadError extends Error {
  constructor(
    message: string,
    readonly surface: string,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = "GepaInvalidPatchPayloadError";
  }
}

export class InvalidRubricAnchorPairError extends Error {
  constructor(
    message: string,
    readonly ruleId: string,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = "InvalidRubricAnchorPairError";
  }
}

export type Day7FollowupStatus = "mature" | "pending" | "ineligible";

export interface ErrorTrajectoryRecord {
  readonly trajectoryId: string;
  readonly learnerPseudoId: string;
  readonly conceptId: string;
  readonly firstErrorRuleId: string;
  readonly normalizedAstEdit: string;
  readonly missingPremise: string;
  readonly hintStage: number;
  readonly itemFamilyId: string;
  readonly verifiableFirstError: boolean;
  readonly selfRepairedInSession: boolean;
  readonly abandoned: boolean;
  readonly totalReleasedTurns: number;
  readonly leakedReleasedTurns: number;
  readonly severeLeakCount: number;
  readonly guardBlockedCount: number;
  readonly day7FollowupStatus: Day7FollowupStatus;
  readonly passedFreshFamilyTransfer?: boolean;
  readonly snippet?: string;
}

export interface ExtractedTrajectoryFeatures {
  readonly trajectoryId: string;
  readonly learnerPseudoId: string;
  readonly conceptId: string;
  readonly firstErrorRuleId: string;
  readonly normalizedAstEdit: string;
  readonly missingPremise: string;
  readonly hintStage: number;
  readonly itemFamilyId: string;
}

export interface RubricAnchorExample {
  readonly anchorId: string;
  readonly label: "positive" | "negative";
  readonly conceptId: string;
  readonly firstErrorRuleId: string;
  readonly normalizedAstEdit: string;
  readonly establishedPremises: readonly string[];
  readonly expression: string;
  readonly rationale: string;
}

export interface MisconceptionRubricRule {
  readonly ruleId: string;
  readonly conceptId: string;
  readonly firstErrorRuleId: string;
  readonly requiredAstTokens: readonly string[];
  readonly requiredMissingPremise: string;
  readonly positiveAnchors: readonly RubricAnchorExample[];
  readonly negativeAnchors: readonly RubricAnchorExample[];
}

export interface AnchorPairValidationResult {
  readonly valid: boolean;
  readonly ruleId: string;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly positiveFiredCount: number;
  readonly negativeFalsePositiveCount: number;
  readonly missedPositiveAnchorIds: readonly string[];
  readonly falsePositiveNegativeAnchorIds: readonly string[];
  readonly issues: readonly string[];
}

export type ErrorClusterStatus = "actionable_candidate" | "observation_only";

export interface ErrorTrajectoryCluster {
  readonly clusterId: string;
  readonly bucketKey: string;
  readonly conceptId: string;
  readonly firstErrorRuleId: string;
  readonly centroidAstEdit: string;
  readonly missingPremise: string;
  readonly hintStageDistribution: Readonly<Record<string, number>>;
  readonly supportCount: number;
  readonly uniqueLearnerCount: number;
  readonly itemFamilyIds: readonly string[];
  readonly trajectoryIds: readonly string[];
  readonly status: ErrorClusterStatus;
  readonly cohesionScore: number;
}

export interface ClusteringOptions {
  /** Minimum trajectory count for a cluster to become actionable (default 5). */
  readonly minSupport?: number;
  /** Structural AST + premise similarity threshold in [0, 1] (default 0.72). */
  readonly similarityThreshold?: number;
}

export interface ClusteringSummary {
  readonly totalTrajectories: number;
  readonly minSupport: number;
  readonly similarityThreshold: number;
  readonly clusters: readonly ErrorTrajectoryCluster[];
  readonly actionableClusters: readonly ErrorTrajectoryCluster[];
  readonly observationOnlyClusters: readonly ErrorTrajectoryCluster[];
}

export interface CMetric {
  readonly rate: number;
  readonly repairedCount: number;
  readonly verifiableFirstErrorCount: number;
  readonly abandonedCount: number;
  readonly abandonmentRate: number;
}

export interface LMetric {
  readonly rate: number;
  readonly leakedReleasedTurns: number;
  readonly totalReleasedTurns: number;
  readonly severeLeakCount: number;
  readonly guardBlockedCount: number;
  readonly telemetryIssues?: readonly string[];
}

export type T7Metric =
  | {
      readonly status: "mature";
      readonly rate: number;
      readonly passedFreshTransferCount: number;
      readonly eligibleFollowupCohortCount: number;
      readonly learnerClusterCount: number;
      readonly effectiveClusterSampleSize: number;
      readonly learnerClusterMean: number;
      readonly standardError: number;
      readonly clopperPearsonLowerBound: number;
      readonly learnerClusterLowerBound: number;
    }
  | {
      readonly status: "pending";
      readonly passedFreshTransferCount: number;
      readonly eligibleFollowupCohortCount: number;
      readonly pendingCohortCount: number;
      readonly reason: string;
    };

export interface CartridgeCandidateMetrics {
  readonly candidateId: string;
  readonly c: CMetric;
  readonly l: LMetric;
  readonly t7: T7Metric;
}

export type ParetoCandidateStatus =
  | "vetoed_leakage"
  | "dominated"
  | "shadow_candidate"
  | "promoted";

export interface ParetoCandidateEvaluation {
  readonly candidateId: string;
  readonly metrics: CartridgeCandidateMetrics;
  readonly status: ParetoCandidateStatus;
  readonly onParetoFrontier: boolean;
  readonly dominatedBy: readonly string[];
  readonly vetoReasons: readonly string[];
  readonly promotionBlockers: readonly string[];
}

export interface ParetoEvaluationOptions {
  readonly baseline: {
    readonly cRate: number;
    readonly t7Rate: number;
  };
  /** Maximum permitted leakage rate before Hard Pre-Pareto Veto (default 0). */
  readonly maxAllowedLeakageRate?: number;
  /** Required lift of candidate student-clustered T7 LCB above baseline T7 (default 0.05). */
  readonly minT7Gain?: number;
  /** Maximum permitted drop of candidate C below baseline C (default 0.02). */
  readonly nonInferiorityMargin?: number;
  /** Minimum unique student clusters required in mature T7 cohort for promotion (default 5). */
  readonly minClusterCount?: number;
}

export interface ParetoEvaluationResult {
  readonly results: readonly ParetoCandidateEvaluation[];
  readonly frontierCandidateIds: readonly string[];
  readonly vetoedCandidateIds: readonly string[];
  readonly shadowCandidateIds: readonly string[];
  readonly promotedCandidateIds: readonly string[];
  readonly dominatedCandidateIds: readonly string[];
}

export interface CartridgeMoveRule {
  readonly id: string;
  readonly conceptId: string;
  readonly triggerRuleId: string;
  readonly missingPremise: string;
  readonly move: string;
  readonly priority: number;
}

export interface CartridgeHintStep {
  readonly stage: number;
  readonly conceptId: string;
  readonly cueTemplate: string;
  readonly revealsPremiseCheck: boolean;
}

export interface CartridgeDeclarativePolicy {
  readonly policyId: string;
  readonly version: string;
  readonly moveRules: readonly CartridgeMoveRule[];
  readonly hintLadder: readonly CartridgeHintStep[];
  readonly rubricAnchors: readonly MisconceptionRubricRule[];
  readonly approvedTemplateSlots: Readonly<Record<string, string>>;
}

export type GepaSurfacePatch =
  | {
      readonly surface: "moveRules";
      readonly summary: string;
      readonly payload: readonly CartridgeMoveRule[];
    }
  | {
      readonly surface: "hintLadder";
      readonly summary: string;
      readonly payload: readonly CartridgeHintStep[];
    }
  | {
      readonly surface: "rubricAnchors";
      readonly summary: string;
      readonly payload: readonly MisconceptionRubricRule[];
    }
  | {
      readonly surface: "approvedTemplateSlots";
      readonly summary: string;
      readonly payload: Readonly<Record<string, string>>;
    };

export interface HoldoutFirewall {
  readonly holdoutTrajectoryIds: readonly string[];
  readonly holdoutLearnerPseudoIds: readonly string[];
  readonly holdoutItemFamilyIds: readonly string[];
}

export interface DisjointDatasetSplit {
  readonly train: readonly ErrorTrajectoryRecord[];
  readonly dev: readonly ErrorTrajectoryRecord[];
  readonly holdout: readonly ErrorTrajectoryRecord[];
  readonly quarantinedCrossing: readonly ErrorTrajectoryRecord[];
  readonly holdoutFirewall: HoldoutFirewall;
}

export interface GepaReflectionClusterDigest {
  readonly clusterId: string;
  readonly conceptId: string;
  readonly firstErrorRuleId: string;
  readonly centroidAstEdit: string;
  readonly missingPremise: string;
  readonly supportCount: number;
  readonly uniqueLearnerCount: number;
  readonly itemFamilyIds: readonly string[];
}

export interface GepaReflectionContext {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly trainTrajectoryCount: number;
  readonly devTrajectoryCount: number;
  readonly actionableClusters: readonly GepaReflectionClusterDigest[];
  readonly observationOnlyClusterCount: number;
  readonly allowedSurfaces: readonly GepaAllowedSurface[];
  readonly currentPolicy: CartridgeDeclarativePolicy;
}

export interface GepaProposedCandidate {
  readonly candidateId: string;
  readonly policy: CartridgeDeclarativePolicy;
  readonly appliedPatches: readonly GepaSurfacePatch[];
}

export interface GepaOptimizationRoundResult {
  readonly reflectionContext: GepaReflectionContext;
  readonly candidates: readonly GepaProposedCandidate[];
  readonly pareto: ParetoEvaluationResult;
}
