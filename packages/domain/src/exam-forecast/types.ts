import type { SkillBeliefV1 } from "../epistemic/belief";

export type ExamClockMode = "section_independent" | "shared_full_paper";
export type ExamAggregationMode = "ielts_overall_half_up" | "weighted_sum";
export type ForecastTargetKind = "same_blueprint_mock" | "official_exam";
export type PolicyMode = "cycle_90d" | "sprint_72h";

export type RawToScoreBand = {
  readonly rawMin: number;
  readonly rawMax: number;
  readonly score: number;
};

export type ExamTimeModel = {
  readonly mu: number;
  readonly speedLoading: number;
  readonly skillLoading: Readonly<Record<string, number>>;
  readonly sigma: number;
};

export type ExamItemSpec = {
  readonly itemId: string;
  readonly sectionId: string;
  readonly partId: string;
  readonly skillIds: readonly string[];
  readonly guess: number;
  readonly lapse: number;
  readonly points?: number;
  readonly timeModel: ExamTimeModel;
};

export type ExamPartBlueprint = {
  readonly partId: string;
  readonly label: string;
  readonly weight: number;
  readonly targetItemCount?: number;
  readonly skillIds: readonly string[];
  readonly timeModel?: ExamTimeModel;
};

export type ExamSectionBlueprint = {
  readonly sectionId: string;
  readonly label: string;
  readonly scoringKind: "item_raw_table" | "rubric_band";
  readonly timeLimitMinutes: number | null;
  readonly timeWindowMinutes?: readonly [minMinutes: number, maxMinutes: number];
  readonly weight: number;
  readonly scoreRange: readonly [min: number, max: number];
  readonly scoreStep: number;
  readonly parts: readonly ExamPartBlueprint[];
  readonly items?: readonly ExamItemSpec[];
  readonly rawToBandTable?: readonly RawToScoreBand[];
};

export type ExamBlueprintV1 = {
  readonly schemaVersion: 1;
  readonly blueprintId: string;
  readonly title: string;
  readonly clockMode: ExamClockMode;
  readonly totalTimeLimitMinutes: number | null;
  readonly aggregationMode: ExamAggregationMode;
  readonly scoreRange: readonly [min: number, max: number];
  readonly scoreStep: number;
  readonly skillIds: readonly string[];
  readonly thetaCovariance: readonly (readonly number[])[];
  readonly sections: readonly ExamSectionBlueprint[];
};

export type DiagnosticOption = {
  readonly optionId: string;
  readonly text: string;
  readonly misconceptionTag?: string;
};

export type IeltsDiagnosticSeedItem = {
  readonly seedId: string;
  readonly sectionId: "listening" | "reading" | "writing" | "speaking";
  readonly partId: string;
  readonly targetSeconds: 30;
  readonly skillIds: readonly string[];
  readonly guess: number;
  readonly lapse: number;
  readonly timeModel: ExamTimeModel;
  readonly prompt: string;
  readonly stimulus: string;
  readonly options: readonly DiagnosticOption[];
  readonly correctOptionId: string;
};

export type ScoreObservationValue =
  | { readonly kind: "exact"; readonly score: number }
  | { readonly kind: "interval_only"; readonly low: number; readonly high: number };

export type SpeechTimingReceiptV1 = {
  readonly receiptId: string;
  readonly partId?: string;
  readonly durationSeconds: number;
  readonly speechRateWpm?: number;
  readonly pauseRatio?: number;
  readonly fluencyScore?: number;
  readonly calibrated: boolean;
};

export type EvidenceKind =
  | "diagnostic_item"
  | "independent_mock"
  | "rubric_assessment"
  | "speech_timing"
  | "official_exam"
  | "practice_feedback"
  | "self_report";

export type ExamEvidenceRecord = {
  readonly evidenceId: string;
  readonly learnerId?: string;
  readonly paperFamilyId?: string;
  readonly sectionId: string;
  readonly partId?: string;
  readonly itemId?: string;
  readonly skillId?: string;
  readonly countsTowardMastery: boolean;
  readonly assisted: boolean;
  readonly exposed?: boolean;
  readonly evidenceKind: EvidenceKind;
  readonly observedAtMs: number;
  readonly correct?: boolean;
  readonly elapsedSeconds?: number | null;
  readonly rightCensored?: boolean;
  readonly rubricScore?: ScoreObservationValue;
  readonly speechTimingReceipt?: SpeechTimingReceiptV1;
};

export type JointPassTarget = {
  readonly targetOverall: number;
  readonly targetMinSection: number;
};

export type WholePaperCalibrationRecord = {
  readonly recordId: string;
  readonly learnerId: string;
  readonly paperFamilyId: string;
  readonly blueprintId: string;
  readonly targetKind: ForecastTargetKind;
  readonly evidenceKind: EvidenceKind;
  readonly assisted: boolean;
  readonly countsTowardMastery: boolean;
  readonly exposed?: boolean;
  readonly predictedQuantiles: {
    readonly q10: number;
    readonly q50: number;
    readonly q90: number;
  };
  readonly predictedJointPassProb?: number;
  readonly predictedJointPassByTarget?: Readonly<Record<string, number>>;
  readonly predictedTargetPassProbs?: readonly {
    readonly targetOverall: number;
    readonly targetMinSection: number;
    readonly rawProbability: number;
  }[];
  readonly observedScore: ScoreObservationValue;
  readonly observedSectionScores?: Readonly<
    Record<string, number | { readonly low: number; readonly high: number }>
  >;
  readonly recordedAtMs: number;
};

export type SimulatedItemOutcome = {
  readonly itemId: string;
  readonly sectionId: string;
  readonly partId: string;
  readonly attempted: boolean;
  readonly correct: boolean;
  readonly rightCensored: boolean;
  readonly observedTimeSeconds: number | null;
  readonly successProbability: number;
};

export type SectionSimulationSummary = {
  readonly sectionId: string;
  readonly timedMeanScore: number;
  readonly untimedMeanScore: number;
  readonly rightCensoringRate: number;
  readonly censoredItemFraction: number;
  readonly partCensoringRates: Readonly<Record<string, number>>;
};

export type ScoreBucketProbability = {
  readonly score: number;
  readonly probability: number;
};

export type PaperSimulationSummary = {
  readonly blueprintId: string;
  readonly examAtMs: number;
  readonly numDraws: number;
  readonly timedScores: readonly number[];
  readonly untimedExpectedScore: number;
  readonly timedExpectedScore: number;
  readonly timeSqueezeDelta: number;
  readonly q10: number;
  readonly q50: number;
  readonly q90: number;
  readonly sectionSummaries: Readonly<Record<string, SectionSimulationSummary>>;
  readonly rightCensoringRateBySection: Readonly<Record<string, number>>;
  readonly sampleRightCensoredItems: readonly SimulatedItemOutcome[];
  readonly untimedScoreDistribution: readonly ScoreBucketProbability[];
  readonly drawSectionScores: readonly Readonly<Record<string, number>>[];
};

export type NextDiagnosticAction = {
  readonly kind:
    | "run_diagnostic_items"
    | "submit_independent_mock"
    | "collect_section_evidence"
    | "insufficient_official_exam_calibration";
  readonly sectionIds: readonly string[];
  readonly recommendedItemIds: readonly string[];
  readonly message: string;
};

export type JointPassProbabilityEstimate = {
  readonly targetOverall: number;
  readonly targetMinSection: number;
  readonly rawProbability: number;
  readonly calibratedProbability: number;
  readonly calibrationSampleCount: number;
};

export type ExamScoreForecastV1 =
  | {
      readonly schemaVersion: 1;
      readonly blueprintId: string;
      readonly status: "insufficient_blueprint";
      readonly missingFields: readonly string[];
      readonly officialExamCalibrated: false;
    }
  | {
      readonly schemaVersion: 1;
      readonly blueprintId: string;
      readonly status: "insufficient_independent_evidence";
      readonly missingSections: readonly string[];
      readonly rejectedEvidenceCount: number;
      readonly calibrationCount: number;
      readonly requiredCalibrationCount: number;
      readonly widthGateExceeded?: boolean;
      readonly observedIntervalWidth?: number;
      readonly maxInformativeWidth?: number;
      readonly nextDiagnosticAction: NextDiagnosticAction;
      readonly officialExamCalibrated: false;
    }
  | {
      readonly schemaVersion: 1;
      readonly blueprintId: string;
      readonly status: "calibrated_forecast_ready";
      readonly forecastTargetKind: ForecastTargetKind;
      readonly labelScope: string;
      readonly officialExamCalibrated: boolean;
      readonly confidenceLevel: 0.8;
      readonly examAtMs: number;
      readonly pointEstimate: number;
      readonly rawPointEstimate: number;
      readonly interval80: {
        readonly low: number;
        readonly high: number;
        readonly width: number;
        readonly conformalMargin: number;
      };
      readonly untimedBaseline: {
        readonly expectedScore: number;
        readonly timeSqueezeDelta: number;
        readonly scoreDistribution: readonly ScoreBucketProbability[];
      };
      readonly timedSimulation: {
        readonly expectedScore: number;
        readonly q10: number;
        readonly q50: number;
        readonly q90: number;
        readonly rightCensoringRateBySection: Readonly<Record<string, number>>;
        readonly sectionSummaries: Readonly<Record<string, SectionSimulationSummary>>;
      };
      readonly jointPassTarget?: JointPassProbabilityEstimate;
      readonly jointPassLadder?: readonly JointPassProbabilityEstimate[];
      readonly calibrationReceipt: {
        readonly n: number;
        readonly k: number;
        readonly nonconformityRadius: number;
        readonly maxInformativeWidth: number;
      };
    };

export type CandidateStudyAction = {
  readonly actionId: string;
  readonly title: string;
  readonly durationHours: number;
  readonly kind: "skill_repair" | "timed_mock" | "speed_drill" | "recovery";
  readonly skillEffects?: Readonly<Record<string, { readonly abilityDelta?: number; readonly logStabilityDelta?: number }>>;
  readonly expectedSpeedShift?: number;
  readonly recoveryMinutes?: number;
};

export type CrnActionEvaluation = {
  readonly actionId: string;
  readonly durationHours: number;
  readonly baselineMeanScore: number;
  readonly withActionMeanScore: number;
  readonly pairedMeanGain: number;
  readonly monteCarloSe: number;
  readonly roiBandPerHour: number;
  readonly timeSqueezeReduction: number;
  readonly superlinearSynergy: number;
};

export type UnifiedDecisionSnapshotV1 = {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly blueprintId: string;
  readonly crnSeed: number;
  readonly horizonHours: number;
  readonly policyMode: PolicyMode;
  readonly executableMinutes: number;
  readonly allocatedRecoveryMinutes: number;
  readonly maxRecoveryMinutes: number;
  readonly forecast: ExamScoreForecastV1;
  readonly baselineActionIds: readonly string[];
  readonly rankedActions: readonly CrnActionEvaluation[];
  readonly selectedActionIds: readonly string[];
};

export type SkillBeliefMap = Readonly<Record<string, SkillBeliefV1>>;
