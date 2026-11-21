import type { SkillBeliefV1 } from "../epistemic/belief";
import { updateBeliefWithEvidence, type BeliefEvidenceUpdate, type SkillItemModel } from "../epistemic/gauss-hermite";
import {
  CRITICAL_HANDWRITING_TOKEN_KINDS,
  NON_SEMANTIC_HANDWRITING_TOKEN_KINDS,
  type CropConfirmationPrompt,
  type HandwritingEpistemicSignal,
  type HandwritingNormalizedToken,
  type HandwritingPropagatedStepState,
  type HandwritingRootCauseError,
  type HandwritingStage1Options,
  type HandwritingStage1Result,
  type HandwritingStage1StepSummary,
  type HandwritingStage2Options,
  type HandwritingStage2Result,
  type HandwritingStepEvaluation,
  type HandwritingStepInput,
  type HandwrittenAstTokenInput,
  type HandwrittenTokenKind,
  type LearnerSymbolConfirmation,
  type NormalizedBoundingBox,
  type PostConfirmationVerdict,
  type StepLocalVerdict,
} from "./types";

export const DEFAULT_SYMBOL_CONFIDENCE_THRESHOLD = 0.85;

const CRITICAL_KIND_SET: ReadonlySet<string> = new Set(CRITICAL_HANDWRITING_TOKEN_KINDS);
const NON_SEMANTIC_KIND_SET: ReadonlySet<string> = new Set(NON_SEMANTIC_HANDWRITING_TOKEN_KINDS);

const NON_SEMANTIC_TEXT_RE = /^(?:[.,;:，。；：、…·•\-–—"'“”‘’]|\.{2,})$/u;
const CRITICAL_AUTO_TEXT_RE =
  /(?:[0-9()[\]{}]|!=|==|<=|>=|->|=>|<-|←|→|[+\-*/=<>^_∑∫∂×÷≤≥≠∈∉⊂⊆∪∩∀∃]|[A-Za-zα-ωΑ-Ω])/u;

export function validateNormalizedBoundingBox(
  bbox: NormalizedBoundingBox,
  contextLabel = "boundingBox",
): NormalizedBoundingBox {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new RangeError(`${contextLabel} must be a 4-tuple [x0, y0, x1, y1].`);
  }
  const [x0, y0, x1, y1] = bbox;
  if (
    !Number.isFinite(x0) ||
    !Number.isFinite(y0) ||
    !Number.isFinite(x1) ||
    !Number.isFinite(y1)
  ) {
    throw new RangeError(`${contextLabel} coordinates must all be finite numbers.`);
  }
  if (x0 < 0 || x1 > 1 || !(x0 < x1)) {
    throw new RangeError(
      `${contextLabel} x-range must satisfy 0 <= x0 < x1 <= 1, got [${x0}, ${x1}].`,
    );
  }
  if (y0 < 0 || y1 > 1 || !(y0 < y1)) {
    throw new RangeError(
      `${contextLabel} y-range must satisfy 0 <= y0 < y1 <= 1, got [${y0}, ${y1}].`,
    );
  }
  return Object.freeze([x0, y0, x1, y1] as const);
}

function validateConfidence(confidence: number, contextLabel: string): number {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError(
      `${contextLabel} confidence must be a finite number in [0, 1], got ${String(confidence)}.`,
    );
  }
  return confidence;
}

function validateThreshold(threshold: number | undefined): number {
  const value = threshold ?? DEFAULT_SYMBOL_CONFIDENCE_THRESHOLD;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(
      `confidenceThreshold must be a finite number in [0, 1], got ${String(value)}.`,
    );
  }
  return value;
}

/**
 * Classifies whether an AST token is mathematically/408-semantically critical
 * versus non-semantic punctuation/formatting.
 */
export function isCriticalMathOr408Token(token: {
  kind: HandwrittenTokenKind;
  rawText: string;
}): boolean {
  if (CRITICAL_KIND_SET.has(token.kind)) {
    return true;
  }
  if (NON_SEMANTIC_KIND_SET.has(token.kind)) {
    return false;
  }
  const trimmed = token.rawText.trim();
  if (trimmed.length === 0) return false;
  if (CRITICAL_AUTO_TEXT_RE.test(trimmed)) return true;
  if (NON_SEMANTIC_TEXT_RE.test(trimmed)) return false;
  return true;
}

function normalizeVisualCandidates(
  rawText: string,
  candidates: readonly string[] | undefined,
): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  const pushCandidate = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    normalized.push(trimmed);
  };
  pushCandidate(rawText);
  if (candidates) {
    for (const candidate of candidates) {
      if (typeof candidate === "string") pushCandidate(candidate);
    }
  }
  return Object.freeze(normalized);
}

function resolveSpan(
  token: HandwrittenAstTokenInput,
  fallbackStart: number,
  effectiveText: string,
): Readonly<{ startOffset: number; endOffset: number }> {
  if (token.span) {
    const { startOffset, endOffset } = token.span;
    if (
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      startOffset < 0 ||
      endOffset < startOffset
    ) {
      throw new RangeError(
        `Invalid token span [${String(startOffset)}, ${String(endOffset)}] for token ${token.tokenId}.`,
      );
    }
    return Object.freeze({ startOffset, endOffset });
  }
  return Object.freeze({
    startOffset: fallbackStart,
    endOffset: fallbackStart + effectiveText.length,
  });
}

function normalizeExpressionKey(expr: string): string {
  return expr.replace(/\s+/g, " ").trim();
}

type StepExpressionKeys = Readonly<{
  effectiveKey: string;
  semanticKey: string;
  hasConfirmedTextMutation: boolean;
}>;

function computeStepExpressionKeys(
  tokens: readonly HandwrittenAstTokenInput[],
  rawExpression?: string,
): StepExpressionKeys {
  const effectiveTexts: string[] = [];
  const semanticTexts: string[] = [];
  let hasConfirmedTextMutation = false;

  for (const token of tokens) {
    const confirmedByLearner = token.confirmedByLearner === true;
    const effectiveText =
      confirmedByLearner && token.confirmedText !== undefined
        ? token.confirmedText.trim()
        : token.rawText;
    if (confirmedByLearner && effectiveText.trim() !== token.rawText.trim()) {
      hasConfirmedTextMutation = true;
    }
    effectiveTexts.push(effectiveText);
    if (isCriticalMathOr408Token({ kind: token.kind, rawText: effectiveText })) {
      semanticTexts.push(effectiveText);
    }
  }

  const joinedEffective = effectiveTexts.join(" ").trim();
  const effectiveExpression =
    joinedEffective.length > 0 ? joinedEffective : (rawExpression ?? "").trim();

  return {
    effectiveKey: normalizeExpressionKey(effectiveExpression),
    semanticKey: normalizeExpressionKey(semanticTexts.join(" ")),
    hasConfirmedTextMutation,
  };
}

function collectTransitiveAncestors(
  stepId: string,
  stepsById: ReadonlyMap<string, HandwritingStepInput>,
): Set<string> {
  const ancestors = new Set<string>();
  const startStep = stepsById.get(stepId);
  if (!startStep?.dependsOnStepIds) return ancestors;

  const queue = [...startStep.dependsOnStepIds];
  while (queue.length > 0) {
    const depId = queue.shift()!;
    if (depId === stepId || ancestors.has(depId)) continue;
    ancestors.add(depId);
    const depStep = stepsById.get(depId);
    if (depStep?.dependsOnStepIds) {
      for (const parentDepId of depStep.dependsOnStepIds) {
        if (!ancestors.has(parentDepId) && parentDepId !== stepId) {
          queue.push(parentDepId);
        }
      }
    }
  }
  return ancestors;
}

function doesPostConfirmationVerdictMatch(
  verdict: PostConfirmationVerdict | undefined,
  stepKeys: StepExpressionKeys,
  ancestorIds: ReadonlySet<string>,
  stepKeysById: ReadonlyMap<string, StepExpressionKeys>,
  mutatedUpstreamIds: ReadonlySet<string>,
): verdict is PostConfirmationVerdict {
  if (verdict === undefined) return false;

  const targetExpr = normalizeExpressionKey(verdict.confirmedExpression);
  if (targetExpr !== stepKeys.effectiveKey && targetExpr !== stepKeys.semanticKey) {
    return false;
  }

  const boundByDepId = new Map<string, string>();
  if (verdict.upstreamConfirmedExpressions !== undefined) {
    for (const [depId, depExpr] of Object.entries(verdict.upstreamConfirmedExpressions)) {
      if (!ancestorIds.has(depId)) return false;
      const depKeys = stepKeysById.get(depId);
      if (!depKeys) return false;
      const normalizedDepExpr = normalizeExpressionKey(depExpr);
      if (normalizedDepExpr !== depKeys.effectiveKey && normalizedDepExpr !== depKeys.semanticKey) {
        return false;
      }
      boundByDepId.set(depId, normalizedDepExpr);
    }
  }

  if (mutatedUpstreamIds.size > 0) {
    if (verdict.upstreamConfirmedExpressions === undefined) return false;
    for (const mutatedDepId of mutatedUpstreamIds) {
      if (!boundByDepId.has(mutatedDepId)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Pure helper applying learner confirmation/corrections onto step AST tokens
 * before re-running Stage 1 / Stage 2.
 *
 * Whenever any confirmed token text differs from its OCR `rawText` (or changes
 * an already-confirmed token), propagates invalidation transitively along
 * `dependsOnStepIds` so affected steps and all downstream steps clear stale
 * pre-confirmation `localVerdict`, `misconceptionId`, `errorCode`,
 * `errorSummary`, and unmatched `postConfirmationVerdict`.
 */
export function applyLearnerSymbolConfirmations(
  steps: readonly HandwritingStepInput[],
  confirmations: readonly LearnerSymbolConfirmation[],
): readonly HandwritingStepInput[] {
  const confirmationMap = new Map<string, string>();
  for (const confirmation of confirmations) {
    const trimmed = confirmation.confirmedText.trim();
    if (trimmed.length === 0) {
      throw new RangeError(
        `Confirmed symbol text for (${confirmation.stepId}, ${confirmation.tokenId}) must be non-empty.`,
      );
    }
    confirmationMap.set(`${confirmation.stepId}\u0000${confirmation.tokenId}`, trimmed);
  }

  const directlyMutatedIds = new Set<string>();
  const stepKeysById = new Map<string, StepExpressionKeys>();
  const updatedById = new Map<string, HandwritingStepInput>();
  const dependentsById = new Map<string, string[]>();

  const preliminarySteps = steps.map((step) => {
    let stepTextMutated = false;
    const updatedTokens = Object.freeze(
      step.ast.tokens.map((token) => {
        const confirmedText = confirmationMap.get(`${step.stepId}\u0000${token.tokenId}`);
        if (confirmedText === undefined) return token;
        const prevEffectiveText =
          token.confirmedByLearner === true && token.confirmedText !== undefined
            ? token.confirmedText.trim()
            : token.rawText.trim();
        if (confirmedText !== token.rawText.trim() || confirmedText !== prevEffectiveText) {
          stepTextMutated = true;
        }
        return {
          ...token,
          confirmedByLearner: true,
          confirmedText,
        };
      }),
    );

    const updatedStep: HandwritingStepInput = {
      ...step,
      ast: {
        ...step.ast,
        tokens: updatedTokens,
      },
    };
    const keys = computeStepExpressionKeys(updatedTokens, step.ast.rawExpression);
    if (stepTextMutated || keys.hasConfirmedTextMutation) {
      directlyMutatedIds.add(step.stepId);
    }
    stepKeysById.set(step.stepId, keys);
    updatedById.set(step.stepId, updatedStep);
    dependentsById.set(step.stepId, []);
    return updatedStep;
  });

  for (const step of preliminarySteps) {
    for (const depId of step.dependsOnStepIds ?? []) {
      dependentsById.get(depId)?.push(step.stepId);
    }
  }

  const affectedStepIds = new Set<string>(directlyMutatedIds);
  const queue = [...directlyMutatedIds];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const childId of dependentsById.get(currentId) ?? []) {
      if (!affectedStepIds.has(childId)) {
        affectedStepIds.add(childId);
        queue.push(childId);
      }
    }
  }

  return Object.freeze(
    preliminarySteps.map((step) => {
      if (!affectedStepIds.has(step.stepId)) {
        return step;
      }

      const {
        localVerdict: _staleVerdict,
        misconceptionId: _staleMisconception,
        errorCode: _staleErrorCode,
        errorSummary: _staleErrorSummary,
        postConfirmationVerdict: stalePostVerdict,
        ...restStep
      } = step;

      const ancestorIds = collectTransitiveAncestors(step.stepId, updatedById);
      const mutatedUpstreamIds = new Set<string>();
      for (const ancestorId of ancestorIds) {
        if (
          directlyMutatedIds.has(ancestorId) ||
          stepKeysById.get(ancestorId)?.hasConfirmedTextMutation === true
        ) {
          mutatedUpstreamIds.add(ancestorId);
        }
      }

      const keepPostVerdict = doesPostConfirmationVerdictMatch(
        stalePostVerdict,
        stepKeysById.get(step.stepId)!,
        ancestorIds,
        stepKeysById,
        mutatedUpstreamIds,
      );

      return {
        ...restStep,
        ...(keepPostVerdict ? { postConfirmationVerdict: stalePostVerdict } : {}),
      };
    }),
  );
}

/**
 * Stage 1: Validates normalized step crops, AST tokens, and critical-symbol
 * confidences against threshold `tau` (default 0.85).
 *
 * Whenever ANY critical symbol has `confidence < tau` and `confirmedByLearner !== true`,
 * emits zero-hint crop confirmation prompts (with ZERO correctness hints, expected
 * values, or answer-key leakage) and sets a hard epistemic block (`canUpdateSkillBelief: false`).
 * Steps lacking any tokenized critical symbols (`tokens: []` or 0 critical tokens)
 * also fail closed (`readyForStage2: false`, `canUpdateSkillBelief: false`).
 */
export function evaluateHandwritingStage1(
  steps: readonly HandwritingStepInput[],
  options: HandwritingStage1Options = {},
): HandwritingStage1Result {
  const confidenceThreshold = validateThreshold(options.confidenceThreshold);
  const seenStepIds = new Set<string>();
  const prompts: CropConfirmationPrompt[] = [];
  const blockedStepIndices: number[] = [];
  const untokenizedStepIndices: number[] = [];
  const stepSummaries: HandwritingStage1StepSummary[] = [];

  for (const [stepIndex, step] of steps.entries()) {
    if (typeof step.stepId !== "string" || step.stepId.trim().length === 0) {
      throw new RangeError(`Step at index ${stepIndex} must have a non-empty stepId.`);
    }
    if (seenStepIds.has(step.stepId)) {
      throw new RangeError(`Duplicate stepId "${step.stepId}" at index ${stepIndex}.`);
    }
    seenStepIds.add(step.stepId);

    const stepBbox = validateNormalizedBoundingBox(step.bbox, `step[${stepIndex}].bbox`);
    const seenTokenIds = new Set<string>();
    const normalizedTokens: HandwritingNormalizedToken[] = [];
    let stepHasUnconfirmedCritical = false;
    let stepHasConfirmedTextMutation = false;
    let criticalTokenCount = 0;
    let cursor = 0;

    for (const [tokenIndex, token] of step.ast.tokens.entries()) {
      if (typeof token.tokenId !== "string" || token.tokenId.trim().length === 0) {
        throw new RangeError(
          `Token at step[${stepIndex}].ast.tokens[${tokenIndex}] must have a non-empty tokenId.`,
        );
      }
      if (seenTokenIds.has(token.tokenId)) {
        throw new RangeError(
          `Duplicate tokenId "${token.tokenId}" in step "${step.stepId}".`,
        );
      }
      seenTokenIds.add(token.tokenId);

      if (typeof token.rawText !== "string" || token.rawText.length === 0) {
        throw new RangeError(
          `Token "${token.tokenId}" in step "${step.stepId}" must have non-empty rawText.`,
        );
      }
      const confidence = validateConfidence(
        token.confidence,
        `step[${stepIndex}].tokens[${tokenIndex}]`,
      );
      const tokenBbox = token.bbox
        ? validateNormalizedBoundingBox(token.bbox, `step[${stepIndex}].tokens[${tokenIndex}].bbox`)
        : stepBbox;

      const confirmedByLearner = token.confirmedByLearner === true;
      let effectiveText = token.rawText;
      if (confirmedByLearner && token.confirmedText !== undefined) {
        const trimmedConfirmed = token.confirmedText.trim();
        if (trimmedConfirmed.length === 0) {
          throw new RangeError(
            `confirmedText for token "${token.tokenId}" in step "${step.stepId}" must be non-empty.`,
          );
        }
        effectiveText = trimmedConfirmed;
      }

      if (confirmedByLearner && effectiveText.trim() !== token.rawText.trim()) {
        stepHasConfirmedTextMutation = true;
      }

      const isCritical = isCriticalMathOr408Token({
        kind: token.kind,
        rawText: effectiveText,
      });
      if (isCritical) {
        criticalTokenCount += 1;
      }
      const span = resolveSpan(token, cursor, token.rawText);
      cursor = Math.max(cursor + token.rawText.length + 1, span.endOffset + 1);

      if (isCritical && confidence < confidenceThreshold && !confirmedByLearner) {
        stepHasUnconfirmedCritical = true;
        prompts.push(
          Object.freeze({
            stepIndex,
            stepId: step.stepId,
            tokenId: token.tokenId,
            cropBoundingBox: tokenBbox,
            rawAmbiguousTokenSpan: Object.freeze({
              text: token.rawText,
              startOffset: span.startOffset,
              endOffset: span.endOffset,
            }),
            transcriptionOptions: normalizeVisualCandidates(
              token.rawText,
              token.visualCandidates,
            ),
            allowsFreeformInput: true as const,
          }),
        );
      }

      normalizedTokens.push(
        Object.freeze({
          tokenId: token.tokenId,
          rawText: token.rawText,
          effectiveText,
          kind: token.kind,
          isCritical,
          confidence,
          bbox: tokenBbox,
          span,
          confirmedByLearner,
        }),
      );
    }

    const hasCriticalToken = normalizedTokens.length > 0 && criticalTokenCount > 0;
    if (stepHasUnconfirmedCritical) {
      blockedStepIndices.push(stepIndex);
    }
    if (!hasCriticalToken) {
      untokenizedStepIndices.push(stepIndex);
    }

    const tokenJoinedExpression = normalizedTokens.map((t) => t.effectiveText).join(" ").trim();
    const effectiveExpression =
      tokenJoinedExpression.length > 0
        ? tokenJoinedExpression
        : (step.ast.rawExpression ?? "").trim();

    stepSummaries.push(
      Object.freeze({
        stepId: step.stepId,
        stepIndex,
        bbox: stepBbox,
        astKind: step.ast.kind,
        effectiveExpression,
        tokens: Object.freeze(normalizedTokens),
        hasCriticalToken,
        hasUnconfirmedCriticalSymbol: stepHasUnconfirmedCritical,
        hasConfirmedTextMutation: stepHasConfirmedTextMutation,
      }),
    );
  }

  const awaitingConfirmation = prompts.length > 0;
  const hasUntokenizedSteps = untokenizedStepIndices.length > 0;
  return Object.freeze({
    schemaVersion: 1,
    status:
      awaitingConfirmation || hasUntokenizedSteps
        ? "awaiting_symbol_confirmation"
        : "ready_for_verification",
    confidenceThreshold,
    readyForStage2: !awaitingConfirmation && !hasUntokenizedSteps && stepSummaries.length > 0,
    canUpdateSkillBelief: false,
    epistemicBlockReason: awaitingConfirmation
      ? "unconfirmed_critical_ocr_symbol"
      : hasUntokenizedSteps
        ? "untokenized_ocr_step"
        : null,
    blockedStepIndices: Object.freeze(blockedStepIndices),
    untokenizedStepIndices: Object.freeze(untokenizedStepIndices),
    cropConfirmationPrompts: Object.freeze(prompts),
    steps: Object.freeze(stepSummaries),
  });
}

// ---------------------------------------------------------------------------
// Deterministic Exact Rational & Certified Interval Numeric Evaluator
// ---------------------------------------------------------------------------

const MAX_RATIONAL_BIT_LENGTH = 512;

type Rational = Readonly<{ num: bigint; den: bigint }>;
type RealInterval = Readonly<{ lower: number; upper: number }>;

type NumericEvalResult =
  | { kind: "rational"; value: Rational }
  | { kind: "real_interval"; interval: RealInterval }
  | { kind: "div_by_zero" }
  | { kind: "unknown" };

const absBigInt = (value: bigint): bigint => (value < 0n ? -value : value);
const bitLengthBigInt = (value: bigint): number =>
  value === 0n ? 0 : absBigInt(value).toString(2).length;

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = absBigInt(a);
  let y = absBigInt(b);
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

function makeRational(num: bigint, den: bigint): NumericEvalResult {
  if (den === 0n) return { kind: "div_by_zero" };
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n === 0n) {
    return { kind: "rational", value: { num: 0n, den: 1n } };
  }
  const g = gcdBigInt(n, d);
  const rn = n / g;
  const rd = d / g;
  if (
    bitLengthBigInt(rn) > MAX_RATIONAL_BIT_LENGTH ||
    bitLengthBigInt(rd) > MAX_RATIONAL_BIT_LENGTH
  ) {
    return { kind: "unknown" };
  }
  return { kind: "rational", value: { num: rn, den: rd } };
}

function parseDecimalRational(literal: string): NumericEvalResult {
  const dotIndex = literal.indexOf(".");
  if (dotIndex < 0) {
    return makeRational(BigInt(literal), 1n);
  }
  const intPart = literal.slice(0, dotIndex);
  const fracPart = literal.slice(dotIndex + 1);
  if (fracPart.length > 150) {
    return { kind: "unknown" };
  }
  const digits = `${intPart}${fracPart}`;
  const num = digits.length > 0 ? BigInt(digits) : 0n;
  const den = 10n ** BigInt(fracPart.length);
  return makeRational(num, den);
}

function powBigIntBounded(base: bigint, exp: bigint): bigint | null {
  let result = 1n;
  let cur = base;
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result *= cur;
      if (bitLengthBigInt(result) > MAX_RATIONAL_BIT_LENGTH) return null;
    }
    e >>= 1n;
    if (e > 0n) {
      cur *= cur;
      if (bitLengthBigInt(cur) > MAX_RATIONAL_BIT_LENGTH) return null;
    }
  }
  return result;
}

function comparePowAgainstTarget(base: bigint, exp: bigint, target: bigint): "lt" | "eq" | "gt" {
  let result = 1n;
  let cur = base;
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result *= cur;
      if (result > target) return "gt";
    }
    e >>= 1n;
    if (e > 0n) {
      cur *= cur;
      if (cur > target) {
        // Because e > 0 still has at least one set bit, result * cur > target.
        return "gt";
      }
    }
  }
  if (result < target) return "lt";
  if (result > target) return "gt";
  return "eq";
}

function integerNthRoot(n: bigint, d: bigint): bigint | null {
  if (n < 0n || d < 2n) return null;
  if (n === 0n) return 0n;
  if (n === 1n) return 1n;
  const bits = bitLengthBigInt(n);
  if (d > BigInt(bits)) return null;
  const dNum = Number(d);
  let lo = 1n;
  let hi = (1n << BigInt(Math.ceil(bits / dNum))) + 1n;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1n;
    const cmp = comparePowAgainstTarget(mid, d, n);
    if (cmp === "eq") return mid;
    if (cmp === "lt") {
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }
  return null;
}

function rationalToFloat(r: Rational): number | null {
  const value = Number(r.num) / Number(r.den);
  return Number.isFinite(value) ? value : null;
}

function toRealInterval(res: NumericEvalResult): RealInterval | null {
  if (res.kind === "real_interval") return res.interval;
  if (res.kind !== "rational") return null;
  const f = rationalToFloat(res.value);
  if (f === null) return null;
  if (res.value.den === 1n && bitLengthBigInt(res.value.num) <= 53) {
    return { lower: f, upper: f };
  }
  const tol = Math.max(Number.MIN_VALUE, Math.abs(f) * 4 * Number.EPSILON);
  return { lower: f - tol, upper: f + tol };
}

function widenInterval(lower: number, upper: number, relErr = 1e-12): NumericEvalResult {
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    return { kind: "unknown" };
  }
  const lo = Math.min(lower, upper);
  const hi = Math.max(lower, upper);
  const pad = Math.max(1e-15, Math.max(Math.abs(lo), Math.abs(hi)) * relErr);
  const finalLo = lo - pad;
  const finalHi = hi + pad;
  if (!Number.isFinite(finalLo) || !Number.isFinite(finalHi)) {
    return { kind: "unknown" };
  }
  return { kind: "real_interval", interval: { lower: finalLo, upper: finalHi } };
}

function addNumeric(left: NumericEvalResult, right: NumericEvalResult): NumericEvalResult {
  if (left.kind === "div_by_zero" || left.kind === "unknown") return left;
  if (right.kind === "div_by_zero" || right.kind === "unknown") return right;
  if (left.kind === "rational" && right.kind === "rational") {
    return makeRational(
      left.value.num * right.value.den + right.value.num * left.value.den,
      left.value.den * right.value.den,
    );
  }
  const l = toRealInterval(left);
  const r = toRealInterval(right);
  if (!l || !r) return { kind: "unknown" };
  return widenInterval(l.lower + r.lower, l.upper + r.upper);
}

function subNumeric(left: NumericEvalResult, right: NumericEvalResult): NumericEvalResult {
  if (left.kind === "div_by_zero" || left.kind === "unknown") return left;
  if (right.kind === "div_by_zero" || right.kind === "unknown") return right;
  if (left.kind === "rational" && right.kind === "rational") {
    return makeRational(
      left.value.num * right.value.den - right.value.num * left.value.den,
      left.value.den * right.value.den,
    );
  }
  const l = toRealInterval(left);
  const r = toRealInterval(right);
  if (!l || !r) return { kind: "unknown" };
  return widenInterval(l.lower - r.upper, l.upper - r.lower);
}

function mulNumeric(left: NumericEvalResult, right: NumericEvalResult): NumericEvalResult {
  if (left.kind === "div_by_zero" || left.kind === "unknown") return left;
  if (right.kind === "div_by_zero" || right.kind === "unknown") return right;
  if (left.kind === "rational" && right.kind === "rational") {
    return makeRational(left.value.num * right.value.num, left.value.den * right.value.den);
  }
  const l = toRealInterval(left);
  const r = toRealInterval(right);
  if (!l || !r) return { kind: "unknown" };
  const corners = [l.lower * r.lower, l.lower * r.upper, l.upper * r.lower, l.upper * r.upper];
  return widenInterval(Math.min(...corners), Math.max(...corners));
}

function divNumeric(left: NumericEvalResult, right: NumericEvalResult): NumericEvalResult {
  if (left.kind === "div_by_zero" || left.kind === "unknown") return left;
  if (right.kind === "div_by_zero" || right.kind === "unknown") return right;
  if (left.kind === "rational" && right.kind === "rational") {
    if (right.value.num === 0n) return { kind: "div_by_zero" };
    return makeRational(left.value.num * right.value.den, left.value.den * right.value.num);
  }
  const l = toRealInterval(left);
  const r = toRealInterval(right);
  if (!l || !r) return { kind: "unknown" };
  if (r.lower <= 0 && r.upper >= 0) {
    return r.lower === 0 && r.upper === 0 ? { kind: "div_by_zero" } : { kind: "unknown" };
  }
  const corners = [l.lower / r.lower, l.lower / r.upper, l.upper / r.lower, l.upper / r.upper];
  return widenInterval(Math.min(...corners), Math.max(...corners));
}

function negNumeric(inner: NumericEvalResult): NumericEvalResult {
  if (inner.kind === "div_by_zero" || inner.kind === "unknown") return inner;
  if (inner.kind === "rational") {
    return { kind: "rational", value: { num: -inner.value.num, den: inner.value.den } };
  }
  return {
    kind: "real_interval",
    interval: { lower: -inner.interval.upper, upper: -inner.interval.lower },
  };
}

function powRational(base: Rational, exp: Rational): NumericEvalResult {
  if (exp.den === 1n) {
    if (exp.num === 0n) {
      return base.num === 0n
        ? { kind: "unknown" }
        : { kind: "rational", value: { num: 1n, den: 1n } };
    }
    let b = base;
    let e = exp.num;
    if (e < 0n) {
      if (b.num === 0n) return { kind: "div_by_zero" };
      b = b.num < 0n ? { num: -b.den, den: -b.num } : { num: b.den, den: b.num };
      e = -e;
    }
    if (b.num === 0n) return { kind: "rational", value: { num: 0n, den: 1n } };
    if (b.den === 1n && b.num === 1n) return { kind: "rational", value: { num: 1n, den: 1n } };
    if (b.den === 1n && b.num === -1n) {
      return {
        kind: "rational",
        value: { num: e % 2n === 0n ? 1n : -1n, den: 1n },
      };
    }
    if (e > BigInt(MAX_RATIONAL_BIT_LENGTH)) return { kind: "unknown" };
    const rn = powBigIntBounded(b.num, e);
    const rd = powBigIntBounded(b.den, e);
    if (rn === null || rd === null) return { kind: "unknown" };
    return makeRational(rn, rd);
  }

  // Non-integer rational exponent: attempt exact rational root first.
  if (base.num < 0n && exp.den % 2n === 0n) {
    return { kind: "unknown" };
  }
  if (base.num === 0n) {
    return exp.num < 0n
      ? { kind: "div_by_zero" }
      : { kind: "rational", value: { num: 0n, den: 1n } };
  }
  const absNum = absBigInt(base.num);
  const rootNum = integerNthRoot(absNum, exp.den);
  const rootDen = integerNthRoot(base.den, exp.den);
  if (rootNum !== null && rootDen !== null) {
    const signedRootNum = base.num < 0n ? -rootNum : rootNum;
    return powRational({ num: signedRootNum, den: rootDen }, { num: exp.num, den: 1n });
  }

  // Irrational power: compute magnitude via interval power on |base| and exp
  // so float64 rounding errors cannot produce false precision or wrong signs.
  const absBaseInterval = toRealInterval({
    kind: "rational",
    value: { num: absNum, den: base.den },
  });
  const expInterval = toRealInterval({ kind: "rational", value: exp });
  if (!absBaseInterval || !expInterval) return { kind: "unknown" };
  const magnitude = powPositiveRealIntervals(absBaseInterval, expInterval);
  if (base.num < 0n && exp.num % 2n !== 0n) {
    return negNumeric(magnitude);
  }
  return magnitude;
}

function powPositiveRealIntervals(b: RealInterval, e: RealInterval): NumericEvalResult {
  if (b.lower <= 0) return { kind: "unknown" };
  const corners = [
    Math.pow(b.lower, e.lower),
    Math.pow(b.lower, e.upper),
    Math.pow(b.upper, e.lower),
    Math.pow(b.upper, e.upper),
  ];
  if (corners.some((value) => !Number.isFinite(value))) {
    return { kind: "unknown" };
  }
  const lower = Math.min(...corners);
  const upper = Math.max(...corners);
  const relErr = 1e-11;
  const upperPad = Math.max(Number.MIN_VALUE, Math.abs(upper) * relErr);
  const finalUpper = upper + upperPad;
  if (!Number.isFinite(finalUpper)) {
    return { kind: "unknown" };
  }
  // Strictly positive base interval raised to finite exponent remains > 0
  // unless IEEE-754 underflowed a corner to subnormal / 0.
  const finalLower =
    lower >= 1e-300
      ? Math.max(Number.MIN_VALUE, lower * (1 - relErr) - Number.MIN_VALUE)
      : 0;
  return {
    kind: "real_interval",
    interval: { lower: finalLower, upper: finalUpper },
  };
}

function powNumeric(base: NumericEvalResult, exp: NumericEvalResult): NumericEvalResult {
  if (base.kind === "div_by_zero" || base.kind === "unknown") return base;
  if (exp.kind === "div_by_zero" || exp.kind === "unknown") return exp;
  if (base.kind === "rational" && exp.kind === "rational") {
    return powRational(base.value, exp.value);
  }
  const b = toRealInterval(base);
  const e = toRealInterval(exp);
  if (!b || !e) return { kind: "unknown" };
  return powPositiveRealIntervals(b, e);
}

function evaluateNumericExpression(expr: string): NumericEvalResult {
  const cleaned = expr.replace(/\s+/g, "");
  if (cleaned.length === 0 || !/^[0-9+\-*/^().]+$/u.test(cleaned)) {
    return { kind: "unknown" };
  }

  let pos = 0;

  const parseExpr = (): NumericEvalResult => {
    let left: NumericEvalResult = parseTerm();
    if (left.kind === "div_by_zero" || left.kind === "unknown") return left;
    while (pos < cleaned.length && (cleaned[pos] === "+" || cleaned[pos] === "-")) {
      const op = cleaned[pos]!;
      pos += 1;
      const right = parseTerm();
      left = op === "+" ? addNumeric(left, right) : subNumeric(left, right);
      if (left.kind === "div_by_zero" || left.kind === "unknown") return left;
    }
    return left;
  };

  const parseTerm = (): NumericEvalResult => {
    let left: NumericEvalResult = parseUnary();
    if (left.kind === "div_by_zero" || left.kind === "unknown") return left;
    while (pos < cleaned.length && (cleaned[pos] === "*" || cleaned[pos] === "/")) {
      const op = cleaned[pos]!;
      pos += 1;
      const right = parseUnary();
      left = op === "*" ? mulNumeric(left, right) : divNumeric(left, right);
      if (left.kind === "div_by_zero" || left.kind === "unknown") return left;
    }
    return left;
  };

  const parseUnary = (): NumericEvalResult => {
    if (pos < cleaned.length && cleaned[pos] === "-") {
      pos += 1;
      return negNumeric(parseUnary());
    }
    if (pos < cleaned.length && cleaned[pos] === "+") {
      pos += 1;
      return parseUnary();
    }
    return parsePower();
  };

  const parsePower = (): NumericEvalResult => {
    const base = parsePrimary();
    if (base.kind === "div_by_zero" || base.kind === "unknown") return base;
    if (pos < cleaned.length && cleaned[pos] === "^") {
      pos += 1;
      const exp = parseUnary();
      return powNumeric(base, exp);
    }
    return base;
  };

  const parsePrimary = (): NumericEvalResult => {
    if (pos >= cleaned.length) return { kind: "unknown" };
    if (cleaned[pos] === "(") {
      pos += 1;
      const inner = parseExpr();
      if (inner.kind === "div_by_zero" || inner.kind === "unknown") return inner;
      if (cleaned[pos] !== ")") return { kind: "unknown" };
      pos += 1;
      return inner;
    }
    const start = pos;
    let sawDigit = false;
    let sawDot = false;
    while (pos < cleaned.length) {
      const ch = cleaned[pos]!;
      if (ch >= "0" && ch <= "9") {
        sawDigit = true;
        pos += 1;
      } else if (ch === "." && !sawDot) {
        sawDot = true;
        pos += 1;
      } else {
        break;
      }
    }
    if (!sawDigit) return { kind: "unknown" };
    return parseDecimalRational(cleaned.slice(start, pos));
  };

  const result = parseExpr();
  if (result.kind === "div_by_zero" || result.kind === "unknown") return result;
  if (pos !== cleaned.length) return { kind: "unknown" };
  return result;
}

function tryVerifyPureNumericRelation(expression: string): StepLocalVerdict | null {
  const normalized = expression
    .replaceAll("×", "*")
    .replaceAll("÷", "/")
    .replaceAll("−", "-")
    .replaceAll("≠", "!=")
    .replaceAll("≤", "<=")
    .replaceAll("≥", ">=")
    .trim();
  const relationMatch = /^(.+?)(!=|<=|>=|=|<|>)(.+)$/u.exec(normalized);
  if (!relationMatch) return null;
  const lhsRaw = relationMatch[1];
  const operator = relationMatch[2];
  const rhsRaw = relationMatch[3];
  if (!lhsRaw || !operator || !rhsRaw) return null;

  // Reject chained operators on RHS/LHS so only single binary relations evaluate here.
  if (/[=<>]/u.test(lhsRaw) || /[=<>]/u.test(rhsRaw)) return null;

  const lhs = evaluateNumericExpression(lhsRaw);
  const rhs = evaluateNumericExpression(rhsRaw);
  if (lhs.kind === "div_by_zero" || rhs.kind === "div_by_zero") {
    return "invalid";
  }
  if (lhs.kind === "unknown" || rhs.kind === "unknown") {
    return null;
  }

  if (lhs.kind === "rational" && rhs.kind === "rational") {
    const leftCross = lhs.value.num * rhs.value.den;
    const rightCross = rhs.value.num * lhs.value.den;
    switch (operator) {
      case "=":
        return leftCross === rightCross ? "valid" : "invalid";
      case "!=":
        return leftCross !== rightCross ? "valid" : "invalid";
      case "<":
        return leftCross < rightCross ? "valid" : "invalid";
      case "<=":
        return leftCross <= rightCross ? "valid" : "invalid";
      case ">":
        return leftCross > rightCross ? "valid" : "invalid";
      case ">=":
        return leftCross >= rightCross ? "valid" : "invalid";
      default:
        return null;
    }
  }

  const l = toRealInterval(lhs);
  const r = toRealInterval(rhs);
  if (!l || !r) return null;

  if (l.upper < r.lower) {
    switch (operator) {
      case "=":
      case ">":
      case ">=":
        return "invalid";
      case "!=":
      case "<":
      case "<=":
        return "valid";
      default:
        return null;
    }
  }
  if (l.lower > r.upper) {
    switch (operator) {
      case "=":
      case "<":
      case "<=":
        return "invalid";
      case "!=":
      case ">":
      case ">=":
        return "valid";
      default:
        return null;
    }
  }
  // Overlapping real intervals (e.g. 2^0.5 vs 1.4142135623730951): abstain safely.
  return null;
}

// ---------------------------------------------------------------------------
// Topological Sort & 4-State Dependency Propagation (Stage 2)
// ---------------------------------------------------------------------------

function computeTopologicalOrder(
  steps: readonly HandwritingStepInput[],
): readonly { step: HandwritingStepInput; stepIndex: number; deps: readonly string[] }[] {
  const indexById = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    indexById.set(step.stepId, index);
  }

  const dependents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const normalizedDeps = new Map<string, readonly string[]>();

  for (const step of steps) {
    dependents.set(step.stepId, []);
    inDegree.set(step.stepId, 0);
  }

  for (const step of steps) {
    const rawDeps = step.dependsOnStepIds ?? [];
    const uniqueDeps: string[] = [];
    const seenDep = new Set<string>();
    for (const depId of rawDeps) {
      if (!indexById.has(depId)) {
        throw new RangeError(
          `Step "${step.stepId}" depends on unknown stepId "${depId}".`,
        );
      }
      if (depId === step.stepId) {
        throw new RangeError(`Step "${step.stepId}" cannot depend on itself.`);
      }
      if (!seenDep.has(depId)) {
        seenDep.add(depId);
        uniqueDeps.push(depId);
        dependents.get(depId)!.push(step.stepId);
      }
    }
    normalizedDeps.set(step.stepId, Object.freeze(uniqueDeps));
    inDegree.set(step.stepId, uniqueDeps.length);
  }

  // Kahn's algorithm picking earliest original stepIndex among available zero-in-degree nodes.
  const available: number[] = [];
  for (const [index, step] of steps.entries()) {
    if ((inDegree.get(step.stepId) ?? 0) === 0) {
      available.push(index);
    }
  }
  available.sort((a, b) => a - b);

  const ordered: { step: HandwritingStepInput; stepIndex: number; deps: readonly string[] }[] = [];
  while (available.length > 0) {
    const nextIndex = available.shift()!;
    const step = steps[nextIndex]!;
    ordered.push({
      step,
      stepIndex: nextIndex,
      deps: normalizedDeps.get(step.stepId)!,
    });
    for (const childId of dependents.get(step.stepId) ?? []) {
      const remaining = (inDegree.get(childId) ?? 0) - 1;
      inDegree.set(childId, remaining);
      if (remaining === 0) {
        available.push(indexById.get(childId)!);
        available.sort((a, b) => a - b);
      }
    }
  }

  if (ordered.length !== steps.length) {
    throw new RangeError("Handwriting step dependency graph contains a cycle.");
  }

  return ordered;
}

/**
 * Stage 2: Evaluates confirmed handwritten derivation / 408 diagram steps across
 * their dependency DAG (`dependsOnStepIds`) using 4-state epistemic propagation:
 * `valid | invalid | dependent | unknown`.
 *
 * - Refuses belief-updating grading (`blocked_unconfirmed_ocr`, `canUpdateSkillBelief: false`)
 *   if Stage 1 still has unconfirmed `< tau` critical symbols reachable before/at any error.
 * - Marks any step descending from an upstream `"invalid"` or `"dependent"` step as
 *   `"dependent"`, shielding follow-through steps from double-penalization.
 * - Reports ONLY the earliest topological/sequential `"invalid"` step as
 *   `firstRootCauseError`, enabling belief update ONLY when unassisted (`assisted === false`).
 */
export function evaluateHandwritingStage2(
  steps: readonly HandwritingStepInput[],
  options: HandwritingStage2Options = {},
): HandwritingStage2Result {
  const assisted = options.assisted === true;
  const stage1 = evaluateHandwritingStage1(steps, {
    confidenceThreshold: options.confidenceThreshold,
  });
  const ordered = computeTopologicalOrder(steps);
  const topologicalOrderStepIds = Object.freeze(ordered.map((entry) => entry.step.stepId));

  // If Stage 1 still has unconfirmed critical symbols (< tau), block belief-updating
  // grading and return the zero-hint crop confirmation prompts.
  if (stage1.cropConfirmationPrompts.length > 0) {
    return Object.freeze({
      schemaVersion: 1,
      status: "blocked_unconfirmed_ocr",
      overallVerdict: "blocked",
      assisted,
      canUpdateSkillBelief: false,
      topologicalOrderStepIds,
      steps: Object.freeze([]),
      firstRootCauseError: null,
      additionalInvalidStepIndices: Object.freeze([]),
      suppressedDependentStepIndices: Object.freeze([]),
      unconfirmedPrompts: stage1.cropConfirmationPrompts,
      epistemicSignal: Object.freeze({
        shouldUpdateBelief: false,
        channel: null,
        outcome: null,
        misconceptionId: null,
        reasonCode: "blocked_unconfirmed_ocr",
      }),
    });
  }

  if (steps.length === 0) {
    return Object.freeze({
      schemaVersion: 1,
      status: "evaluated",
      overallVerdict: "unknown",
      assisted,
      canUpdateSkillBelief: false,
      topologicalOrderStepIds,
      steps: Object.freeze([]),
      firstRootCauseError: null,
      additionalInvalidStepIndices: Object.freeze([]),
      suppressedDependentStepIndices: Object.freeze([]),
      unconfirmedPrompts: Object.freeze([]),
      epistemicSignal: Object.freeze({
        shouldUpdateBelief: false,
        channel: null,
        outcome: null,
        misconceptionId: null,
        reasonCode: "no_derivation_steps",
      }),
    });
  }

  const stage1ById = new Map(stage1.steps.map((s) => [s.stepId, s] as const));
  const stepKeysById = new Map<string, StepExpressionKeys>();
  const semanticExprById = new Map<string, string>();
  for (const s1 of stage1.steps) {
    const semanticTokenExpression = s1.tokens
      .filter((t) => t.isCritical)
      .map((t) => t.effectiveText)
      .join(" ")
      .trim();
    semanticExprById.set(s1.stepId, semanticTokenExpression);
    stepKeysById.set(s1.stepId, {
      effectiveKey: normalizeExpressionKey(s1.effectiveExpression),
      semanticKey: normalizeExpressionKey(semanticTokenExpression),
      hasConfirmedTextMutation: s1.hasConfirmedTextMutation,
    });
  }

  const ancestorsById = new Map<string, Set<string>>();
  const mutatedPremiseStepIds = new Set<string>();
  const evalById = new Map<string, HandwritingStepEvaluation>();

  let firstRootCauseError: HandwritingRootCauseError | null = null;
  const additionalInvalidStepIndices: number[] = [];
  const suppressedDependentStepIndices: number[] = [];

  const hasUntokenizedStep = stage1.untokenizedStepIndices.length > 0;

  for (const { step, stepIndex, deps } of ordered) {
    const stage1Step = stage1ById.get(step.stepId)!;
    const semanticTokenExpression = semanticExprById.get(step.stepId)!;
    const ancestors = new Set<string>();
    for (const depId of deps) {
      ancestors.add(depId);
      const depAncestors = ancestorsById.get(depId);
      if (depAncestors) {
        for (const ancId of depAncestors) {
          ancestors.add(ancId);
        }
      }
    }
    ancestorsById.set(step.stepId, ancestors);

    const hasMutatedUpstreamPremise = deps.some((depId) => mutatedPremiseStepIds.has(depId));
    if (stage1Step.hasConfirmedTextMutation || hasMutatedUpstreamPremise) {
      mutatedPremiseStepIds.add(step.stepId);
    }

    const mutatedUpstreamIds = new Set<string>();
    for (const ancId of ancestors) {
      if (stepKeysById.get(ancId)?.hasConfirmedTextMutation === true) {
        mutatedUpstreamIds.add(ancId);
      }
    }

    const matchedPostVerdict = doesPostConfirmationVerdictMatch(
      step.postConfirmationVerdict,
      stepKeysById.get(step.stepId)!,
      ancestors,
      stepKeysById,
      mutatedUpstreamIds,
    )
      ? step.postConfirmationVerdict
      : undefined;

    // [P1-2] Untokenized steps (tokens: [] or 0 critical tokens) must fail closed as "unknown"
    // and never bypass Stage-1 confidence gating via rawExpression or pre-confirmation localVerdict.
    let localVerdict: StepLocalVerdict;
    let stepMisconceptionId: string | null = null;
    let stepErrorCode: string | null = null;
    let stepErrorSummary: string | null = null;

    if (!stage1Step.hasCriticalToken) {
      localVerdict = "unknown";
    } else if (matchedPostVerdict !== undefined) {
      localVerdict = matchedPostVerdict.localVerdict;
      stepMisconceptionId = matchedPostVerdict.misconceptionId ?? null;
      stepErrorCode = matchedPostVerdict.errorCode ?? null;
      stepErrorSummary = matchedPostVerdict.errorSummary ?? null;
    } else if (mutatedPremiseStepIds.has(step.stepId)) {
      // Confirmed symbol mutation on this step or any transitive upstream premise invalidates
      // stale pre-confirmation localVerdict / misconception / error metadata.
      localVerdict =
        step.ast.kind === "equation" || step.ast.kind === "inequality"
          ? (tryVerifyPureNumericRelation(semanticTokenExpression) ?? "unknown")
          : "unknown";
    } else {
      localVerdict =
        step.localVerdict ??
        (step.ast.kind === "equation" || step.ast.kind === "inequality"
          ? (tryVerifyPureNumericRelation(semanticTokenExpression) ?? "unknown")
          : "unknown");
      stepMisconceptionId = step.misconceptionId ?? null;
      stepErrorCode = step.errorCode ?? null;
      stepErrorSummary = step.errorSummary ?? null;
    }

    const upstreamErrorStepIds: string[] = [];
    let hasUpstreamUnknown = false;

    for (const depId of deps) {
      const parentEval = evalById.get(depId)!;
      if (
        parentEval.propagatedState === "invalid" ||
        parentEval.propagatedState === "dependent"
      ) {
        upstreamErrorStepIds.push(depId);
      } else if (parentEval.propagatedState === "unknown") {
        hasUpstreamUnknown = true;
      }
    }

    let propagatedState: HandwritingPropagatedStepState;
    if (upstreamErrorStepIds.length > 0) {
      propagatedState = "dependent";
    } else if (localVerdict === "invalid") {
      propagatedState = "invalid";
    } else if (localVerdict === "unknown" || hasUpstreamUnknown) {
      propagatedState = "unknown";
    } else {
      propagatedState = "valid";
    }

    const isEarliestInvalid =
      propagatedState === "invalid" && firstRootCauseError === null;
    if (propagatedState === "invalid") {
      if (isEarliestInvalid) {
        firstRootCauseError = Object.freeze({
          stepId: step.stepId,
          stepIndex,
          misconceptionId: stepMisconceptionId,
          errorCode: stepErrorCode,
          errorSummary: stepErrorSummary,
          cropBoundingBox: stage1Step.bbox,
        });
      } else {
        additionalInvalidStepIndices.push(stepIndex);
      }
    } else if (propagatedState === "dependent") {
      suppressedDependentStepIndices.push(stepIndex);
    }

    evalById.set(
      step.stepId,
      Object.freeze({
        stepId: step.stepId,
        stepIndex,
        dependsOnStepIds: deps,
        localVerdict,
        propagatedState,
        upstreamErrorStepIds: Object.freeze(upstreamErrorStepIds),
        isRootCauseError: isEarliestInvalid,
        // Shield dependent steps and secondary errors from double-penalization;
        // attribute ONLY the earliest topological/sequential root-cause error.
        attributedMisconceptionId: isEarliestInvalid ? stepMisconceptionId : null,
        errorCode: stepErrorCode,
        errorSummary: stepErrorSummary,
        cropBoundingBox: stage1Step.bbox,
      }),
    );
  }

  // Return step evaluations in original input index order for caller clarity.
  const evaluatedSteps = Object.freeze(
    steps.map((step) => evalById.get(step.stepId)!),
  );

  const hasInvalid = firstRootCauseError !== null;
  const hasUnknown = evaluatedSteps.some((s) => s.propagatedState === "unknown");
  const overallVerdict: HandwritingStage2Result["overallVerdict"] = hasInvalid
    ? "invalid"
    : hasUnknown
      ? "unknown"
      : "valid";

  const canUpdateSkillBelief =
    !assisted &&
    !hasUntokenizedStep &&
    (overallVerdict === "valid" || overallVerdict === "invalid");

  const epistemicSignal: HandwritingEpistemicSignal = Object.freeze(
    !canUpdateSkillBelief
      ? {
          shouldUpdateBelief: false,
          channel: null,
          outcome: null,
          misconceptionId: null,
          reasonCode: assisted
            ? "blocked_assisted_attempt"
            : hasUntokenizedStep
              ? "blocked_untokenized_ocr_step"
              : "blocked_unknown_derivation",
        }
      : overallVerdict === "valid"
        ? {
            shouldUpdateBelief: true,
            channel: "unassisted",
            outcome: true,
            misconceptionId: null,
            reasonCode: "unassisted_verified_derivation",
          }
        : {
            shouldUpdateBelief: true,
            channel: "step-failure",
            outcome: false,
            misconceptionId: firstRootCauseError?.misconceptionId ?? null,
            reasonCode: "unassisted_root_cause_step_failure",
          },
  );

  return Object.freeze({
    schemaVersion: 1,
    status: "evaluated",
    overallVerdict,
    assisted,
    canUpdateSkillBelief,
    topologicalOrderStepIds,
    steps: evaluatedSteps,
    firstRootCauseError,
    additionalInvalidStepIndices: Object.freeze(additionalInvalidStepIndices),
    suppressedDependentStepIndices: Object.freeze(suppressedDependentStepIndices),
    unconfirmedPrompts: Object.freeze([]),
    epistemicSignal,
  });
}

export type GuardedBeliefUpdateResult = Readonly<{
  applied: boolean;
  belief: SkillBeliefV1;
  evidenceUpdate: BeliefEvidenceUpdate | null;
  reasonCode: string;
}>;

/**
 * Epistemic hard-gate bridge onto `SkillBeliefV1`: refuses any belief or
 * misconception mass mutation whenever Stage 1 is blocked, the submission is
 * assisted, or the derivation contains unverified `"unknown"` leaps.
 */
export function applyHandwritingStage2ToSkillBelief(input: {
  stage2: HandwritingStage2Result;
  belief: SkillBeliefV1;
  item: SkillItemModel;
  atMs: number;
  isFreshFamily?: boolean;
}): GuardedBeliefUpdateResult {
  const { stage2, belief, item, atMs, isFreshFamily } = input;
  if (!stage2.canUpdateSkillBelief || !stage2.epistemicSignal.shouldUpdateBelief || stage2.epistemicSignal.outcome === null) {
    return Object.freeze({
      applied: false,
      belief,
      evidenceUpdate: null,
      reasonCode: stage2.epistemicSignal.reasonCode,
    });
  }

  const evidenceUpdate = updateBeliefWithEvidence({
    belief,
    item,
    atMs,
    observation: {
      outcome: stage2.epistemicSignal.outcome,
      channel: stage2.epistemicSignal.channel ?? "unassisted",
      misconceptionId: stage2.epistemicSignal.misconceptionId ?? undefined,
      localizedStepFailure: stage2.epistemicSignal.channel === "step-failure",
      isFreshFamily,
    },
  });

  return Object.freeze({
    applied: true,
    belief: evidenceUpdate.belief,
    evidenceUpdate,
    reasonCode: stage2.epistemicSignal.reasonCode,
  });
}
