export {
  IELTS_CARTRIDGE_ID,
  IELTS_CARTRIDGE_VERSION,
  IELTS_CRITERIA,
  IELTS_CRITERION_META,
} from "./types";

export type {
  IeltsBandScore,
  IeltsCriterion,
  IeltsCriterionAssessment,
  IeltsCriterionMeta,
  IeltsCrossDraftTransferReport,
  IeltsCrossDraftTransferSummary,
  IeltsEpistemicStatus,
  IeltsEssayDraft,
  IeltsEvidenceSourceKind,
  IeltsMemorizedTemplateHit,
  IeltsParagraphDiff,
  IeltsRubricReceipt,
  IeltsRubricValidationError,
  IeltsRubricValidationResult,
  IeltsSpanEvidence,
  IeltsSpeakingEvidenceQuote,
  IeltsSpeakingFeedbackReceipt,
  IeltsSpeakingPaceStatus,
  IeltsSpeakingPart3Seed,
  IeltsSpeakingRetellingInput,
  IeltsSpeakingSignalKey,
  IeltsSpeakingSignalRating,
  IeltsSpeakingTranscriptSignal,
  IeltsTaskMode,
  IeltsTransferStatus,
  IeltsUpgradeCategory,
  IeltsUpgradeTarget,
  IeltsUpgradeTransferItem,
  IeltsWritingCoreArgument,
  IeltsWritingDraftSource,
  IeltsWritingTransferSource,
} from "./types";

export {
  IELTS_MEMORIZED_TEMPLATE_CATALOG,
  clampToIeltsBand,
  computeOverallIeltsBand,
  countDraftWords,
  countEnglishWords,
  createValidatedRubricReceipt,
  detectMemorizedTemplates,
  hasMemorizedTemplateStuffing,
  isValidIeltsBand,
  locateGroundedExcerpt,
  resolveIeltsEpistemicStatus,
} from "./rubric";

export type {
  CreateRubricReceiptInput,
  EpistemicResolution,
  EpistemicResolutionInput,
} from "./rubric";

export {
  analyzeCrossDraftTransfer,
  detectLowEntropyStuffing,
  diffEssayParagraphs,
  evaluateRevisedDraftDeterministically,
} from "./transfer";

export type {
  AnalyzeCrossDraftTransferInput,
  EvaluateRevisedDraftInput,
  EvaluateRevisedDraftResult,
} from "./transfer";

export {
  buildSpeakingPart3Seed,
  evaluateSpeakingRetelling,
  getSpeakingEvaluationContext,
  getSpeakingTargets,
  hasRequiredWritingReceipt,
} from "./speaking";

export { getWritingDraftSource, getWritingTransferSource } from "./writing-source";
export { graphemeBoundaries } from "./graphemes";
export { maskIeltsMarkup } from "./prose";
