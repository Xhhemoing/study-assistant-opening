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
  type StepLocalVerdict,
} from "./types";

export const DEFAULT_SYMBOL_CONFIDENCE_THRESHOLD = 0.85;

const CRITICAL_KIND_SET: ReadonlySet<string> = new Set(CRITICAL_HANDWRITING_TOKEN_KINDS);
const NON_SEMANTIC_KIND_SET: ReadonlySet<string> = new Set(NON_SEMANTIC_HANDWRITING_TOKEN_KINDS);

const NON_SEMANTIC_TEXT_RE = /^(?:[.,;:，。；：、…·•\-–—"'“”‘’()[\]{}]|\.{2,})$/u;
const CRITICAL_AUTO_TEXT_RE =
  /(?:[0-9]|!=|==|<=|>=|->|=>|<-|←|→|[+\-*/=<>^_∑∫∂×÷≤≥≠∈∉⊂⊆∪∩∀∃]|[A-Za-zα-ωΑ-Ω])/u;

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

/**
 * Pure helper applying learner confirmation/corrections onto step AST tokens
 * before re-running Stage 1 / Stage 2.
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

  return Object.freeze(
    steps.map((step) => ({
      ...step,
      ast: {
        ...step.ast,
        tokens: Object.freeze(
          step.ast.tokens.map((token) => {
            const confirmedText = confirmationMap.get(`${step.stepId}\u0000${token.tokenId}`);
            if (confirmedText === undefined) return token;
            return {
              ...token,
              confirmedByLearner: true,
              confirmedText,
            };
          }),
        ),
      },
    })),
  );
}

/**
 * Stage 1: Validates normalized step crops, AST tokens, and critical-symbol
 * confidences against threshold `tau` (default 0.85).
 *
 * Whenever ANY critical symbol has `confidence < tau` and `confirmedByLearner !== true`,
 * emits zero-hint crop confirmation prompts (with ZERO correctness hints, expected
 * values, or answer-key leakage) and sets a hard epistemic block (`canUpdateSkillBelief: false`).
 */
export function evaluateHandwritingStage1(
  steps: readonly HandwritingStepInput[],
  options: HandwritingStage1Options = {},
): HandwritingStage1Result {
  const confidenceThreshold = validateThreshold(options.confidenceThreshold);
  const seenStepIds = new Set<string>();
  const prompts: CropConfirmationPrompt[] = [];
  const blockedStepIndices: number[] = [];
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

      let effectiveText = token.rawText;
      if (token.confirmedText !== undefined) {
        const trimmedConfirmed = token.confirmedText.trim();
        if (trimmedConfirmed.length === 0) {
          throw new RangeError(
            `confirmedText for token "${token.tokenId}" in step "${step.stepId}" must be non-empty.`,
          );
        }
        effectiveText = trimmedConfirmed;
      }

      const confirmedByLearner = token.confirmedByLearner === true;
      const isCritical = isCriticalMathOr408Token({
        kind: token.kind,
        rawText: effectiveText,
      });
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

    if (stepHasUnconfirmedCritical) {
      blockedStepIndices.push(stepIndex);
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
        hasUnconfirmedCriticalSymbol: stepHasUnconfirmedCritical,
      }),
    );
  }

  const awaitingConfirmation = prompts.length > 0;
  return Object.freeze({
    schemaVersion: 1,
    status: awaitingConfirmation ? "awaiting_symbol_confirmation" : "ready_for_verification",
    confidenceThreshold,
    readyForStage2: !awaitingConfirmation && stepSummaries.length > 0,
    canUpdateSkillBelief: false,
    epistemicBlockReason: awaitingConfirmation ? "unconfirmed_critical_ocr_symbol" : null,
    blockedStepIndices: Object.freeze(blockedStepIndices),
    cropConfirmationPrompts: Object.freeze(prompts),
    steps: Object.freeze(stepSummaries),
  });
}

// ---------------------------------------------------------------------------
// Deterministic Numeric Arithmetic / Comparison Evaluator (Pure Fallback)
// ---------------------------------------------------------------------------

function evaluateNumericExpression(expr: string): number | null {
  const cleaned = expr.replace(/\s+/g, "");
  if (cleaned.length === 0 || !/^[0-9+\-*/^().]+$/u.test(cleaned)) {
    return null;
  }

  let pos = 0;

  const parseExpr = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    while (pos < cleaned.length && (cleaned[pos] === "+" || cleaned[pos] === "-")) {
      const op = cleaned[pos]!;
      pos += 1;
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return Number.isFinite(left) ? left : null;
  };

  const parseTerm = (): number | null => {
    let left = parsePower();
    if (left === null) return null;
    while (pos < cleaned.length && (cleaned[pos] === "*" || cleaned[pos] === "/")) {
      const op = cleaned[pos]!;
      pos += 1;
      const right = parsePower();
      if (right === null) return null;
      if (op === "/") {
        if (Math.abs(right) <= 1e-12) return null;
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return Number.isFinite(left) ? left : null;
  };

  const parsePower = (): number | null => {
    const base = parseUnary();
    if (base === null) return null;
    if (pos < cleaned.length && cleaned[pos] === "^") {
      pos += 1;
      const exp = parsePower();
      if (exp === null) return null;
      const result = Math.pow(base, exp);
      return Number.isFinite(result) ? result : null;
    }
    return base;
  };

  const parseUnary = (): number | null => {
    if (pos < cleaned.length && cleaned[pos] === "-") {
      pos += 1;
      const inner = parseUnary();
      return inner === null ? null : -inner;
    }
    if (pos < cleaned.length && cleaned[pos] === "+") {
      pos += 1;
      return parseUnary();
    }
    return parsePrimary();
  };

  const parsePrimary = (): number | null => {
    if (pos >= cleaned.length) return null;
    if (cleaned[pos] === "(") {
      pos += 1;
      const inner = parseExpr();
      if (inner === null || cleaned[pos] !== ")") return null;
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
    if (!sawDigit) return null;
    const value = Number(cleaned.slice(start, pos));
    return Number.isFinite(value) ? value : null;
  };

  const value = parseExpr();
  if (value === null || pos !== cleaned.length) return null;
  return value;
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
  if (lhs === null || rhs === null) {
    // Only fail invalid if both sides are pure numeric syntax with division-by-zero; otherwise unknown.
    const pureSyntax = /^[0-9+\-*/^().\s]+$/u;
    if (pureSyntax.test(lhsRaw) && pureSyntax.test(rhsRaw)) {
      return "invalid";
    }
    return null;
  }

  const eps = 1e-9;
  switch (operator) {
    case "=":
      return Math.abs(lhs - rhs) <= eps ? "valid" : "invalid";
    case "!=":
      return Math.abs(lhs - rhs) > eps ? "valid" : "invalid";
    case "<":
      return lhs < rhs - eps ? "valid" : "invalid";
    case "<=":
      return lhs <= rhs + eps ? "valid" : "invalid";
    case ">":
      return lhs > rhs + eps ? "valid" : "invalid";
    case ">=":
      return lhs >= rhs - eps ? "valid" : "invalid";
    default:
      return null;
  }
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
  if (stage1.status === "awaiting_symbol_confirmation") {
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
  const evalById = new Map<string, HandwritingStepEvaluation>();

  let firstRootCauseError: HandwritingRootCauseError | null = null;
  const additionalInvalidStepIndices: number[] = [];
  const suppressedDependentStepIndices: number[] = [];

  for (const { step, stepIndex, deps } of ordered) {
    const stage1Step = stage1ById.get(step.stepId)!;
    const localVerdict: StepLocalVerdict =
      step.localVerdict ??
      (step.ast.kind === "equation" || step.ast.kind === "inequality"
        ? (tryVerifyPureNumericRelation(stage1Step.effectiveExpression) ?? "unknown")
        : "unknown");

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
          misconceptionId: step.misconceptionId ?? null,
          errorCode: step.errorCode ?? null,
          errorSummary: step.errorSummary ?? null,
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
        attributedMisconceptionId: isEarliestInvalid ? (step.misconceptionId ?? null) : null,
        errorCode: step.errorCode ?? null,
        errorSummary: step.errorSummary ?? null,
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
    !assisted && (overallVerdict === "valid" || overallVerdict === "invalid");

  const epistemicSignal: HandwritingEpistemicSignal = Object.freeze(
    !canUpdateSkillBelief
      ? {
          shouldUpdateBelief: false,
          channel: null,
          outcome: null,
          misconceptionId: null,
          reasonCode: assisted ? "blocked_assisted_attempt" : "blocked_unknown_derivation",
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
