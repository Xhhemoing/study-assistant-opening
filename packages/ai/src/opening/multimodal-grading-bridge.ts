import {
  applyLearnerSymbolConfirmations, evaluateHandwritingStage1, evaluateHandwritingStage2,
  evaluateRawAudioRetentionPolicy, issueSpeechTimingReceipt, sha256HexUtf8,
  type HandwritingStepInput, type LearnerSymbolConfirmation, type RawAudioRetentionPolicyInput,
  type SpeechTimingReceiptInput,
} from "@aistudy/domain/multimodal-evidence";
import type { OpeningRubricCalibrationHook } from "./rubric-grading-bridge";

type GradingContext = Parameters<OpeningRubricCalibrationHook>[0];

/** OCR and confirmations loaded from the saved, scoped submission by the server. */
export type OpeningHandwritingEvidence = {
  readonly observationId: string;
  readonly answerRevision: number;
  readonly workSource: GradingContext["workSource"];
  readonly photoStorageKey?: string | null;
  readonly steps: readonly HandwritingStepInput[];
  readonly confirmations?: readonly LearnerSymbolConfirmation[];
};

export type OpeningMultimodalEvidenceHook = (
  context: GradingContext,
) => OpeningHandwritingEvidence | null | Promise<OpeningHandwritingEvidence | null>;

export function canGradeOpeningHandwriting(
  { observation, input, answerRevision, workSource }: GradingContext,
  evidence: OpeningHandwritingEvidence | null,
): boolean {
  const photoStorageKey = observation.photoStorageKey ?? null;
  if (!photoStorageKey && !workSource && !input.workSourceId) return true;
  if (!evidence || evidence.observationId !== observation.id || evidence.answerRevision !== answerRevision
    || (evidence.photoStorageKey ?? null) !== photoStorageKey) return false;

  const boundWorkSource = evidence.workSource;
  if (boundWorkSource?.id !== workSource?.id || boundWorkSource?.version !== workSource?.version
    || boundWorkSource?.physicalPage !== workSource?.physicalPage) return false;
  if (input.workSourceId && (input.workSourceId !== workSource?.id || input.workSourceVersion !== workSource.version
    || input.physicalPage !== workSource.physicalPage)) return false;

  const confirmations = evidence.confirmations ?? [];
  const steps = confirmations.length ? applyLearnerSymbolConfirmations(evidence.steps, confirmations) : evidence.steps;
  const stage1 = evaluateHandwritingStage1(steps);
  const stage2 = confirmations.length ? evaluateHandwritingStage2(steps) : null;
  return stage1.readyForStage2 && stage2?.status !== "blocked_unconfirmed_ocr";
}

export type OpeningSpeechTimingInput = {
  readonly timing: SpeechTimingReceiptInput & { readonly issuedAtMs: number };
  readonly audio: Omit<RawAudioRetentionPolicyInput, "durationMs" | "issuedAtMs">;
};

export function buildOpeningSpeechTimingEvidence({ timing, audio }: OpeningSpeechTimingInput) {
  const retention = evaluateRawAudioRetentionPolicy({
    ...audio, durationMs: timing.totalOriginalDurationMs, issuedAtMs: timing.issuedAtMs,
  });
  if (!retention.accepted) return { receipt: null, transcriptDigest: null, retention };

  const receipt = issueSpeechTimingReceipt(timing);
  const transcriptDigest = `sha256:${sha256HexUtf8(receipt.words.map(word => word.word).join(" "))}`;
  return { receipt, transcriptDigest, retention };
}
