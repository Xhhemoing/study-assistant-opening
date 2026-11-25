import {
  applyLearnerSymbolConfirmations, evaluateHandwritingStage1, evaluateHandwritingStage2,
  evaluateRawAudioRetentionPolicy, issueSpeechTimingReceipt, sha256HexUtf8,
  type HandwritingStepInput, type LearnerSymbolConfirmation, type NormalizedBoundingBox, type RawAudioRetentionPolicyInput,
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

type HandwritingGradingEvidence = {
  verified: boolean;
  symbolConfirmations: readonly { step: number; token: number; symbol: string; bbox: NormalizedBoundingBox }[];
};

const unverifiedHandwriting = { verified: false, symbolConfirmations: [] } as const;
const glyphKey = (stepId: string, tokenId: string) => JSON.stringify([stepId, tokenId]);

export function resolveOpeningHandwritingForGrading(
  { observation, input, answerRevision, workSource }: GradingContext,
  evidence: OpeningHandwritingEvidence | null,
): HandwritingGradingEvidence {
  const photoStorageKey = observation.photoStorageKey ?? null;
  if (!photoStorageKey && !workSource && !input.workSourceId) return { verified: true, symbolConfirmations: [] };
  if (!evidence || evidence.observationId !== observation.id || evidence.answerRevision !== answerRevision
    || (evidence.photoStorageKey ?? null) !== photoStorageKey) return unverifiedHandwriting;

  const boundWorkSource = evidence.workSource;
  if (boundWorkSource?.id !== workSource?.id || boundWorkSource?.version !== workSource?.version
    || boundWorkSource?.physicalPage !== workSource?.physicalPage) return unverifiedHandwriting;
  if (input.workSourceId && (input.workSourceId !== workSource?.id || input.workSourceVersion !== workSource.version
    || input.physicalPage !== workSource.physicalPage)) return unverifiedHandwriting;

  const confirmations = evidence.confirmations ?? [];
  const byGlyph = new Map<string, string>();
  for (const { stepId, tokenId, confirmedText } of confirmations) {
    const key = glyphKey(stepId, tokenId);
    const symbol = confirmedText.trim();
    const previous = byGlyph.get(key);
    if (!symbol || (previous !== undefined && previous !== symbol)) return unverifiedHandwriting;
    byGlyph.set(key, symbol);
  }
  for (const { stepId, ast } of evidence.steps) {
    for (const token of ast.tokens) {
      const key = glyphKey(stepId, token.tokenId);
      const symbol = byGlyph.get(key);
      if (symbol === undefined) continue;
      if (token.confirmedByLearner && (token.confirmedText ?? token.rawText).trim() !== symbol) return unverifiedHandwriting;
      byGlyph.delete(key);
    }
  }
  if (byGlyph.size) return unverifiedHandwriting;

  const steps = confirmations.length ? applyLearnerSymbolConfirmations(evidence.steps, confirmations) : evidence.steps;
  const stage1 = evaluateHandwritingStage1(steps);
  if (!stage1.readyForStage2) return unverifiedHandwriting;
  const stage2 = confirmations.length ? evaluateHandwritingStage2(steps) : null;
  if (stage2?.status === "blocked_unconfirmed_ocr") return unverifiedHandwriting;

  const symbolConfirmations = stage1.steps.flatMap(({ stepIndex, tokens }) => tokens.flatMap((token, index) =>
    token.isCritical && token.confirmedByLearner
      ? [{ step: stepIndex + 1, token: index + 1, symbol: token.effectiveText, bbox: token.bbox }]
      : [],
  ));
  if (symbolConfirmations.length && !workSource) return unverifiedHandwriting;
  return { verified: true, symbolConfirmations };
}

export function canGradeOpeningHandwriting(context: GradingContext, evidence: OpeningHandwritingEvidence | null): boolean {
  return resolveOpeningHandwritingForGrading(context, evidence).verified;
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
