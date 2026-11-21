/**
 * Closed-Core Domain Types for Multimodal Evidence Verification:
 * 1. Two-Stage Handwritten Math & 408 Diagram Symbol-Confidence Verifier
 * 2. Pre-VAD Original PCM Clock Speech Timing Receipt & Ephemeral Raw Audio Policy
 *
 * Pure browser-safe TypeScript — zero Node/DB/AI imports.
 */

// ---------------------------------------------------------------------------
// 1. Two-Stage Handwritten Math & 408 Diagram Verification Types
// ---------------------------------------------------------------------------

/** Normalized `[x0, y0, x1, y1]` step or symbol bounding box in `[0, 1]^4`. */
export type NormalizedBoundingBox = readonly [
  x0: number,
  y0: number,
  x1: number,
  y1: number,
];

export const CRITICAL_HANDWRITING_TOKEN_KINDS = [
  "operator",
  "comparator",
  "exponent",
  "subscript",
  "digit",
  "number",
  "variable",
  "matrix_entry",
  "pointer_arrow",
  "pointer_index",
] as const;

export const NON_SEMANTIC_HANDWRITING_TOKEN_KINDS = [
  "punctuation",
  "whitespace",
  "decoration",
] as const;

export type CriticalHandwritingTokenKind =
  (typeof CRITICAL_HANDWRITING_TOKEN_KINDS)[number];

export type NonSemanticHandwritingTokenKind =
  (typeof NON_SEMANTIC_HANDWRITING_TOKEN_KINDS)[number];

export type HandwrittenTokenKind =
  | CriticalHandwritingTokenKind
  | NonSemanticHandwritingTokenKind
  | "auto";

export type HandwrittenAstKind =
  | "expression"
  | "equation"
  | "inequality"
  | "matrix"
  | "diagram_408"
  | "text_step";

export type HandwrittenAstTokenInput = Readonly<{
  tokenId: string;
  rawText: string;
  kind: HandwrittenTokenKind;
  /** Symbol recognition confidence in `[0, 1]`. */
  confidence: number;
  /** Optional character span inside step raw transcription. */
  span?: Readonly<{ startOffset: number; endOffset: number }>;
  /** Optional sub-crop bounding box in `[0, 1]^4`. */
  bbox?: NormalizedBoundingBox;
  /** Neutral visual N-best OCR alternatives (never correctness hints). */
  visualCandidates?: readonly string[];
  /** Explicit learner confirmation/correction state. */
  confirmedByLearner?: boolean;
  confirmedText?: string;
}>;

export type HandwrittenStepAstInput = Readonly<{
  kind: HandwrittenAstKind;
  rawExpression?: string;
  diagramType?: string;
  tokens: readonly HandwrittenAstTokenInput[];
}>;

export type StepLocalVerdict = "valid" | "invalid" | "unknown";

export type PostConfirmationVerdict = Readonly<{
  /**
   * Normalized confirmed expression (matching `stage1Step.effectiveExpression`
   * or critical-token expression) this verdict was produced against.
   */
  confirmedExpression: string;
  localVerdict: StepLocalVerdict;
  misconceptionId?: string;
  errorCode?: string;
  errorSummary?: string;
}>;

export type HandwritingStepInput = Readonly<{
  stepId: string;
  bbox: NormalizedBoundingBox;
  ast: HandwrittenStepAstInput;
  dependsOnStepIds?: readonly string[];
  /**
   * Local transition verdict given this step's stated premises.
   * Ignored if learner OCR confirmation changed any token's text from `rawText`
   * unless a matching `postConfirmationVerdict` is provided.
   */
  localVerdict?: StepLocalVerdict;
  postConfirmationVerdict?: PostConfirmationVerdict;
  misconceptionId?: string;
  errorCode?: string;
  errorSummary?: string;
}>;

export type LearnerSymbolConfirmation = Readonly<{
  stepId: string;
  tokenId: string;
  confirmedText: string;
}>;

export type HandwritingStage1Options = Readonly<{
  /** Critical symbol confidence threshold `tau` in `[0, 1]`. Default `0.85`. */
  confidenceThreshold?: number;
}>;

export type CropConfirmationPrompt = Readonly<{
  stepIndex: number;
  stepId: string;
  tokenId: string;
  cropBoundingBox: NormalizedBoundingBox;
  rawAmbiguousTokenSpan: Readonly<{
    text: string;
    startOffset: number;
    endOffset: number;
  }>;
  transcriptionOptions: readonly string[];
  allowsFreeformInput: true;
}>;

export type HandwritingNormalizedToken = Readonly<{
  tokenId: string;
  rawText: string;
  effectiveText: string;
  kind: HandwrittenTokenKind;
  isCritical: boolean;
  confidence: number;
  bbox: NormalizedBoundingBox;
  span: Readonly<{ startOffset: number; endOffset: number }>;
  confirmedByLearner: boolean;
}>;

export type HandwritingStage1StepSummary = Readonly<{
  stepId: string;
  stepIndex: number;
  bbox: NormalizedBoundingBox;
  astKind: HandwrittenAstKind;
  effectiveExpression: string;
  tokens: readonly HandwritingNormalizedToken[];
  hasCriticalToken: boolean;
  hasUnconfirmedCriticalSymbol: boolean;
  hasConfirmedTextMutation: boolean;
}>;

export type HandwritingStage1Result = Readonly<{
  schemaVersion: 1;
  status: "awaiting_symbol_confirmation" | "ready_for_verification";
  confidenceThreshold: number;
  readyForStage2: boolean;
  /** Stage 1 itself never updates belief; always `false` when blocked, and requires Stage 2 completion. */
  canUpdateSkillBelief: false;
  epistemicBlockReason:
    | "unconfirmed_critical_ocr_symbol"
    | "untokenized_ocr_step"
    | null;
  blockedStepIndices: readonly number[];
  untokenizedStepIndices: readonly number[];
  cropConfirmationPrompts: readonly CropConfirmationPrompt[];
  steps: readonly HandwritingStage1StepSummary[];
}>;

export type HandwritingPropagatedStepState =
  | "valid"
  | "invalid"
  | "dependent"
  | "unknown";

export type HandwritingStage2Options = Readonly<{
  confidenceThreshold?: number;
  /** Unassisted independent attempt flag (`false` -> belief updates permitted; `true` -> blocked). */
  assisted?: boolean;
}>;

export type HandwritingStepEvaluation = Readonly<{
  stepId: string;
  stepIndex: number;
  dependsOnStepIds: readonly string[];
  localVerdict: StepLocalVerdict;
  propagatedState: HandwritingPropagatedStepState;
  upstreamErrorStepIds: readonly string[];
  isRootCauseError: boolean;
  /** Only populated on the earliest `"invalid"` root-cause step; strictly `null` for `"dependent"` steps. */
  attributedMisconceptionId: string | null;
  errorCode: string | null;
  errorSummary: string | null;
  cropBoundingBox: NormalizedBoundingBox;
}>;

export type HandwritingRootCauseError = Readonly<{
  stepId: string;
  stepIndex: number;
  misconceptionId: string | null;
  errorCode: string | null;
  errorSummary: string | null;
  cropBoundingBox: NormalizedBoundingBox;
}>;

export type HandwritingEpistemicSignal = Readonly<{
  shouldUpdateBelief: boolean;
  channel: "unassisted" | "step-failure" | null;
  outcome: boolean | null;
  misconceptionId: string | null;
  reasonCode: string;
}>;

export type HandwritingStage2Result = Readonly<{
  schemaVersion: 1;
  status: "evaluated" | "blocked_unconfirmed_ocr";
  overallVerdict: "valid" | "invalid" | "unknown" | "blocked";
  assisted: boolean;
  canUpdateSkillBelief: boolean;
  topologicalOrderStepIds: readonly string[];
  steps: readonly HandwritingStepEvaluation[];
  firstRootCauseError: HandwritingRootCauseError | null;
  additionalInvalidStepIndices: readonly number[];
  suppressedDependentStepIndices: readonly number[];
  unconfirmedPrompts: readonly CropConfirmationPrompt[];
  epistemicSignal: HandwritingEpistemicSignal;
}>;

// ---------------------------------------------------------------------------
// 2. Pre-VAD Original PCM Clock Speech Timing Receipt & Audio Retention Types
// ---------------------------------------------------------------------------

export type VadVoicedSegment = Readonly<{
  originalStartMs: number;
  originalEndMs: number;
  strippedStartMs: number;
  strippedEndMs: number;
}>;

export type SpeechWordClock = "original_pcm" | "vad_stripped";

export type SpeechDisfluencyKind =
  | "none"
  | "repetition"
  | "self_repair"
  | "filler";

export type SpeechWordTokenInput = Readonly<{
  word: string;
  startMs: number;
  endMs: number;
  clock?: SpeechWordClock;
  /** Explicit clause/sentence boundary following this word. */
  isSentenceBoundaryAfter?: boolean;
  /** Optional explicit syllable count for syllable-rate computation. */
  syllableCount?: number;
  /** Explicit self-repair/repetition marker from transcript aligner. */
  isRepairOrRepetition?: boolean;
  disfluencyKind?: SpeechDisfluencyKind;
}>;

export type SpeechTimingReceiptInput = Readonly<{
  receiptId: string;
  totalOriginalDurationMs: number;
  voicedSegments: readonly VadVoicedSegment[];
  words: readonly SpeechWordTokenInput[];
  /** Default clock for word tokens that omit per-token `clock`. Default `"vad_stripped"`. */
  defaultTokenClock?: SpeechWordClock;
  /** Minor mid-clause hesitation threshold in ms. Default `800`. */
  minorHesitationThresholdMs?: number;
  /** Major breakdown / lexical retrieval stall threshold in ms. Default `1500`. */
  breakdownHesitationThresholdMs?: number;
  /** Prefer syllables/min or words/min for `speechRateSylOrWordsPerMin`. Default `"words_per_min"`. */
  speechRateMetric?: "words_per_min" | "syllables_per_min";
  issuedAtMs?: number;
}>;

export type MappedSpeechWordToken = Readonly<{
  index: number;
  word: string;
  originalStartMs: number;
  originalEndMs: number;
  durationMs: number;
  mappedFromClock: SpeechWordClock;
  isSentenceBoundaryAfter: boolean;
  syllableCount: number;
  isRepairOrRepetition: boolean;
  disfluencyKind: SpeechDisfluencyKind;
}>;

export type SpeechPauseKind =
  | "mid_clause_minor"
  | "mid_clause_breakdown"
  | "sentence_boundary";

export type SpeechPauseEvent = Readonly<{
  afterWordIndex: number;
  beforeWordIndex: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  kind: SpeechPauseKind;
}>;

export type SpeechTimingReceipt = Readonly<{
  schemaVersion: 1;
  receiptId: string;
  issuedAtMs: number;
  totalDurationMs: number;
  voicedDurationMs: number;
  silenceDurationMs: number;
  initialLatencyMs: number;
  trailingSilenceMs: number;
  wordCount: number;
  syllableCount: number;
  speechRateMetric: "words_per_min" | "syllables_per_min";
  speechRateSylOrWordsPerMin: number;
  speechRateWordsPerMin: number;
  speechRateSyllablesPerMin: number;
  articulationRateWordsPerMin: number;
  minorHesitationCount: number;
  breakdownPauseCount: number;
  midClauseHesitationCount: number;
  sentenceBoundaryPauseCount: number;
  midClauseHesitationPauses: readonly SpeechPauseEvent[];
  sentenceBoundaryPauses: readonly SpeechPauseEvent[];
  meanLengthOfRunWords: number;
  runWordCounts: readonly number[];
  repairRepetitionCount: number;
  filledPauseCount: number;
  repairRepetitionRatio: number;
  words: readonly MappedSpeechWordToken[];
  integrityDigest: string;
}>;

export type MediaBudgetRejectionReason =
  | "media_quota_exceeded"
  | "provider_media_max_bytes_exceeded"
  | "recording_duration_exceeded";

export type RawAudioRetentionPolicyInput = Readonly<{
  mediaBytesUsed: number;
  recordingBytes: number;
  mediaQuotaBytes: number;
  durationMs: number;
  maxRecordingDurationMs: number;
  /** Optional `0080` provider `media_max_input_bytes` cap. */
  providerMediaMaxInputBytes?: number | null;
  issuedAtMs: number;
  nowMs?: number;
  /** Default `false` -> immediate purge upon receipt issuance. */
  learnerOptInReplay?: boolean;
  /** Optional requested expiry when `learnerOptInReplay === true`; clamped to `<= issuedAtMs + 24h`. */
  requestedRetentionUntilMs?: number;
}>;

export type RawAudioDisposition =
  | "immediate_delete"
  | "temporary_replay_retained"
  | "sweep_expired"
  | "rejected_over_budget";

export type RawAudioRetentionPolicyDecision = Readonly<{
  schemaVersion: 1;
  accepted: boolean;
  disposition: RawAudioDisposition;
  retainRawAudio: boolean;
  deleteDeadlineMs: number;
  sweep_due_immediately: boolean;
  hardCeilingMs: number;
  hardCeilingApplied: boolean;
  remainingMediaBytesAfterUpload: number;
  rejectionReasons: readonly MediaBudgetRejectionReason[];
}>;
