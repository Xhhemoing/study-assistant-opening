export const IELTS_CARTRIDGE_ID = "ielts-writing-speaking-v1" as const;
export const IELTS_CARTRIDGE_VERSION = "1.0.0" as const;

export const IELTS_CRITERIA = ["TR", "CC", "LR", "GRA"] as const;
export type IeltsCriterion = (typeof IELTS_CRITERIA)[number];

export type IeltsCriterionMeta = {
  readonly code: IeltsCriterion;
  readonly officialName: string;
  readonly zhLabel: string;
  readonly focusSummary: string;
};

export const IELTS_CRITERION_META: Readonly<Record<IeltsCriterion, IeltsCriterionMeta>> = {
  TR: {
    code: "TR",
    officialName: "Task Response",
    zhLabel: "任务回应",
    focusSummary: "立场清晰度、论点展开深度与反方视角回应",
  },
  CC: {
    code: "CC",
    officialName: "Coherence & Cohesion",
    zhLabel: "连贯与衔接",
    focusSummary: "段落推进逻辑、指代清晰度与自然衔接手段",
  },
  LR: {
    code: "LR",
    officialName: "Lexical Resource",
    zhLabel: "词汇资源",
    focusSummary: "学术搭配准确度、语域得体性与避免空泛重复",
  },
  GRA: {
    code: "GRA",
    officialName: "Grammatical Range & Accuracy",
    zhLabel: "语法广度与准确度",
    focusSummary: "复合句与让步结构多样性、句法控制与标点准确度",
  },
};

export type IeltsTaskMode = "writing_task2" | "speaking_part3";

export type IeltsBandScore = 4 | 4.5 | 5 | 5.5 | 6 | 6.5 | 7 | 7.5 | 8 | 8.5 | 9;

export type IeltsEpistemicStatus = "practice_feedback" | "rubric_verified_evidence";

export type IeltsEvidenceSourceKind =
  | "single_draft_diagnostic"
  | "assisted_revision"
  | "unassisted_cross_draft_transfer"
  | "unassisted_fresh_prompt_transfer";

export type IeltsSpanEvidence = {
  readonly id: string;
  readonly paragraphIndex: number;
  readonly excerpt: string;
  readonly criterion: IeltsCriterion;
  readonly diagnosis: string;
  readonly upgradeRewrite: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
};

export type IeltsCriterionAssessment = {
  readonly criterion: IeltsCriterion;
  readonly band: IeltsBandScore;
  readonly summary: string;
  readonly evidenceSpans: readonly IeltsSpanEvidence[];
};

export type IeltsEssayDraft = {
  readonly draftId: string;
  readonly version: number;
  readonly label: string;
  readonly promptId: string;
  readonly paragraphs: readonly string[];
  readonly assisted: boolean;
  readonly timeSpentSeconds: number;
  readonly timeBoxSeconds: number;
  readonly createdAt: string;
};

export type IeltsMemorizedTemplateHit = {
  readonly phrase: string;
  readonly paragraphIndex: number;
  readonly severity: "warning" | "blocking";
  readonly advice: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
};

export type IeltsRubricReceipt = {
  readonly receiptId: string;
  readonly cartridgeId: typeof IELTS_CARTRIDGE_ID;
  readonly taskMode: IeltsTaskMode;
  readonly promptId: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly overallBand: IeltsBandScore;
  readonly criteria: Readonly<Record<IeltsCriterion, IeltsCriterionAssessment>>;
  readonly epistemicStatus: IeltsEpistemicStatus;
  readonly countsTowardMastery: boolean;
  readonly masteryQualified: boolean;
  readonly epistemicReason: string;
  readonly evidenceSource: IeltsEvidenceSourceKind;
  readonly memorizedTemplateFlags: readonly IeltsMemorizedTemplateHit[];
  readonly wordCount: number;
  readonly createdAt: string;
};

export type IeltsRubricValidationError = {
  readonly code:
    | "INVALID_BAND"
    | "MISSING_CRITERION"
    | "MISSING_EVIDENCE_SPANS"
    | "EMPTY_SPAN_FIELD"
    | "PARAGRAPH_OUT_OF_RANGE"
    | "EXCERPT_NOT_GROUNDED"
    | "CRITERION_MISMATCH"
    | "EMPTY_DRAFT";
  readonly criterion?: IeltsCriterion;
  readonly spanId?: string;
  readonly message: string;
};

export type IeltsRubricValidationResult =
  | { readonly ok: true; readonly receipt: IeltsRubricReceipt }
  | { readonly ok: false; readonly errors: readonly IeltsRubricValidationError[] };

export type IeltsUpgradeCategory =
  | "targetCollocations"
  | "syntacticStructures"
  | "cohesiveDevices"
  | "counterargumentDepth";

export type IeltsTransferStatus =
  | "transferred"
  | "regressed"
  | "memorized_cliche"
  | "pending";

export type IeltsUpgradeTarget = {
  readonly id: string;
  readonly category: IeltsUpgradeCategory;
  readonly criterion: IeltsCriterion;
  readonly label: string;
  readonly targetPatterns: readonly string[];
  readonly weakBaselinePatterns?: readonly string[];
  readonly clichePatterns?: readonly string[];
  readonly guidance: string;
};

export type IeltsUpgradeTransferItem = {
  readonly targetId: string;
  readonly category: IeltsUpgradeCategory;
  readonly criterion: IeltsCriterion;
  readonly label: string;
  readonly status: IeltsTransferStatus;
  readonly baselineMatched: readonly string[];
  readonly revisedMatched: readonly string[];
  readonly matchedParagraphIndices: readonly number[];
  readonly clicheHits: readonly string[];
  readonly guidance: string;
  readonly explanation: string;
};

export type IeltsParagraphDiff = {
  readonly paragraphIndex: number;
  readonly draft1Text: string;
  readonly draft2Text: string;
  readonly status: "unchanged" | "revised" | "added" | "removed";
  readonly wordDelta: number;
  readonly addedTerms: readonly string[];
  readonly removedTerms: readonly string[];
};

export type IeltsCrossDraftTransferSummary = {
  readonly totalTargets: number;
  readonly transferredCount: number;
  readonly regressedCount: number;
  readonly memorizedClicheCount: number;
  readonly pendingCount: number;
  readonly transferRate: number;
  readonly hasMemorizedStuffing: boolean;
  readonly hasSubstantiveRevision: boolean;
  readonly hasLowEntropyStuffing: boolean;
  readonly hasMechanicalKeywordPaste: boolean;
  readonly meetsCrossDraftVerification: boolean;
  readonly masteryQualified: boolean;
  readonly disqualificationReason?: string;
};

export type IeltsCrossDraftTransferReport = {
  readonly fromDraftId: string;
  readonly toDraftId: string;
  readonly items: readonly IeltsUpgradeTransferItem[];
  readonly paragraphDiffs: readonly IeltsParagraphDiff[];
  readonly memorizedTemplateHits: readonly IeltsMemorizedTemplateHit[];
  readonly summary: IeltsCrossDraftTransferSummary;
};

export type IeltsWritingCoreArgument = {
  readonly promptId: string;
  readonly topic: string;
  readonly coreClaim: string;
  readonly supportingReason: string;
  readonly counterPerspective?: string;
  readonly activeCollocations: readonly string[];
};

export type IeltsSpeakingPart3Seed = {
  readonly seedId: string;
  readonly cartridgeId: typeof IELTS_CARTRIDGE_ID;
  readonly sourcePromptId: string;
  readonly sourceDraftId: string;
  readonly topic: string;
  readonly followUpQuestion: string;
  readonly followUpQuestionZh: string;
  readonly timeWindowSeconds: { readonly min: 60; readonly max: 90 };
  readonly targetSpokenCollocations: readonly string[];
  readonly argumentBridgeCues: readonly string[];
  readonly avoidWrittenClunkyPhrases: readonly string[];
};

export type IeltsSpeakingRetellingInput = {
  readonly seed: IeltsSpeakingPart3Seed;
  readonly transcript: string;
  readonly durationSeconds: number;
  readonly assisted: boolean;
  readonly freshPromptTransfer?: boolean;
  readonly createdAt?: string;
};

export type IeltsSpeakingPaceStatus =
  | "invalid_duration"
  | "too_short"
  | "on_target"
  | "over_time";

export type IeltsSpeakingSignalKey =
  | "fluencyCohesion"
  | "lexicalTransfer"
  | "syntacticVariety"
  | "durationCompliance";

export type IeltsSpeakingSignalRating = "strong" | "developing" | "needs_work";

export type IeltsSpeakingTranscriptSignal = {
  readonly key: IeltsSpeakingSignalKey;
  readonly label: string;
  readonly rating: IeltsSpeakingSignalRating;
  readonly note: string;
};

export type IeltsSpeakingEvidenceQuote = {
  readonly id: string;
  readonly signal: IeltsSpeakingSignalKey;
  readonly quote: string;
  readonly matchedExpression?: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly diagnosis: string;
  readonly upgradeRewrite: string;
};

export type IeltsSpeakingFeedbackReceipt = {
  readonly receiptId: string;
  readonly cartridgeId: typeof IELTS_CARTRIDGE_ID;
  readonly seedId: string;
  readonly sourceTranscript: string;
  readonly taskMode: "speaking_part3";
  readonly feedbackMode: "transcript_practice_feedback";
  readonly pronunciationAssessed: false;
  readonly assessmentScopeNote: string;
  readonly epistemicStatus: IeltsEpistemicStatus;
  readonly countsTowardMastery: boolean;
  readonly masteryQualified: boolean;
  readonly epistemicReason: string;
  readonly wordCount: number;
  readonly durationSeconds: number | null;
  readonly paceStatus: IeltsSpeakingPaceStatus;
  readonly transferredCollocations: readonly string[];
  readonly pendingCollocations: readonly string[];
  readonly evidenceQuotes: readonly IeltsSpeakingEvidenceQuote[];
  readonly memorizedTemplateHits: readonly IeltsMemorizedTemplateHit[];
  readonly transcriptSignals: Readonly<
    Record<IeltsSpeakingSignalKey, IeltsSpeakingTranscriptSignal>
  >;
  readonly createdAt: string;
};
