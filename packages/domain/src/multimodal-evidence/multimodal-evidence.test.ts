import { describe, expect, it } from "vitest";
import { createSkillBelief, type SkillBeliefV1 } from "../epistemic/belief";
import type { SkillItemModel } from "../epistemic/gauss-hermite";
import {
  applyHandwritingStage2ToSkillBelief,
  applyLearnerSymbolConfirmations,
  DEFAULT_SYMBOL_CONFIDENCE_THRESHOLD,
  evaluateHandwritingStage1,
  evaluateHandwritingStage2,
  evaluateRawAudioRetentionPolicy,
  isCriticalMathOr408Token,
  issueSpeechTimingReceipt,
  mapStrippedClockToOriginalPcmMs,
  RAW_AUDIO_HARD_RETENTION_CEILING_MS,
  sha256HexUtf8,
  validateNormalizedBoundingBox,
  type HandwritingStepInput,
} from "./index";

const makeBelief = (overrides: Partial<SkillBeliefV1> = {}): SkillBeliefV1 =>
  createSkillBelief({
    workspaceId: "ws-1",
    learnerId: "learner-1",
    courseId: "math-408",
    confirmedSkillVersion: 1,
    lastDirectRecallAtMs: 0,
    misconceptionMass: [
      ["sign_flip", 0.15],
      ["wrong_final_answer", 0.15],
    ],
    otherMass: 0.7,
    ...overrides,
  });

const skillItem: SkillItemModel = {
  itemId: "item-algebra-1",
  a: 1.2,
  b: 0.0,
  g: 0.1,
  l: 0.05,
  misconceptions: [
    { id: "sign_flip", delta: 1.2 },
    { id: "wrong_final_answer", delta: 1.2 },
  ],
};

describe("multimodal-evidence: Two-Stage Handwritten Math & 408 Diagram Verifier", () => {
  it("validates normalized [x0, y0, x1, y1] bounding boxes and symbol confidences", () => {
    expect(validateNormalizedBoundingBox([0, 0.1, 0.8, 0.9])).toEqual([0, 0.1, 0.8, 0.9]);
    expect(() => validateNormalizedBoundingBox([-0.01, 0, 0.5, 0.5])).toThrow(RangeError);
    expect(() => validateNormalizedBoundingBox([0, 0, 1.01, 0.5])).toThrow(RangeError);
    expect(() => validateNormalizedBoundingBox([0.5, 0, 0.5, 0.5])).toThrow(RangeError);
    expect(() => validateNormalizedBoundingBox([0, 0.7, 0.5, 0.6])).toThrow(RangeError);
    expect(() => validateNormalizedBoundingBox([0, NaN, 0.5, 0.5])).toThrow(RangeError);

    expect(() =>
      evaluateHandwritingStage1([
        {
          stepId: "s1",
          bbox: [0.1, 0.1, 0.9, 0.3],
          ast: {
            kind: "expression",
            tokens: [{ tokenId: "t1", rawText: "x", kind: "variable", confidence: 1.05 }],
          },
        },
      ]),
    ).toThrow(RangeError);
  });

  it("distinguishes critical mathematical/408 tokens from non-semantic punctuation", () => {
    expect(isCriticalMathOr408Token({ kind: "operator", rawText: "!=" })).toBe(true);
    expect(isCriticalMathOr408Token({ kind: "exponent", rawText: "^2" })).toBe(true);
    expect(isCriticalMathOr408Token({ kind: "subscript", rawText: "_i" })).toBe(true);
    expect(isCriticalMathOr408Token({ kind: "matrix_entry", rawText: "A[i][j]" })).toBe(true);
    expect(isCriticalMathOr408Token({ kind: "pointer_arrow", rawText: "->" })).toBe(true);
    expect(isCriticalMathOr408Token({ kind: "pointer_index", rawText: "top-1" })).toBe(true);
    expect(isCriticalMathOr408Token({ kind: "punctuation", rawText: "," })).toBe(false);
    expect(isCriticalMathOr408Token({ kind: "whitespace", rawText: " " })).toBe(false);
    expect(isCriticalMathOr408Token({ kind: "auto", rawText: ";" })).toBe(false);
    expect(isCriticalMathOr408Token({ kind: "auto", rawText: "->" })).toBe(true);
    // [P1-4] Grouping delimiters ()[]{} are critical under kind: "auto".
    expect(isCriticalMathOr408Token({ kind: "auto", rawText: "(" })).toBe(true);
    expect(isCriticalMathOr408Token({ kind: "auto", rawText: ")" })).toBe(true);
    expect(isCriticalMathOr408Token({ kind: "auto", rawText: "[" })).toBe(true);
    expect(isCriticalMathOr408Token({ kind: "auto", rawText: "]" })).toBe(true);
    expect(isCriticalMathOr408Token({ kind: "auto", rawText: "{" })).toBe(true);
    expect(isCriticalMathOr408Token({ kind: "auto", rawText: "}" })).toBe(true);

    // Low-confidence grouping parentheses under kind: "auto" must block Stage 1.
    const lowConfParen = evaluateHandwritingStage1([
      {
        stepId: "s-paren",
        bbox: [0.05, 0.05, 0.9, 0.25],
        ast: {
          kind: "equation",
          tokens: [
            { tokenId: "p1", rawText: "(", kind: "auto", confidence: 0.61 },
            { tokenId: "p2", rawText: "2", kind: "auto", confidence: 0.98 },
            { tokenId: "p3", rawText: "+", kind: "auto", confidence: 0.96 },
            { tokenId: "p4", rawText: "3", kind: "auto", confidence: 0.98 },
            { tokenId: "p5", rawText: ")", kind: "auto", confidence: 0.95 },
            { tokenId: "p6", rawText: "=", kind: "auto", confidence: 0.97 },
            { tokenId: "p7", rawText: "5", kind: "auto", confidence: 0.99 },
          ],
        },
      },
    ]);
    expect(lowConfParen.status).toBe("awaiting_symbol_confirmation");
    expect(lowConfParen.canUpdateSkillBelief).toBe(false);
    expect(lowConfParen.cropConfirmationPrompts.map((p) => p.rawAmbiguousTokenSpan.text)).toEqual([
      "(",
    ]);

    // Low-confidence non-semantic punctuation does NOT block Stage 1.
    const stage1 = evaluateHandwritingStage1([
      {
        stepId: "s1",
        bbox: [0.05, 0.05, 0.9, 0.25],
        ast: {
          kind: "equation",
          tokens: [
            { tokenId: "t1", rawText: "2", kind: "digit", confidence: 0.98 },
            { tokenId: "t2", rawText: "+", kind: "operator", confidence: 0.95 },
            { tokenId: "t3", rawText: "3", kind: "digit", confidence: 0.99 },
            { tokenId: "t4", rawText: "=", kind: "operator", confidence: 0.96 },
            { tokenId: "t5", rawText: "5", kind: "digit", confidence: 0.97 },
            { tokenId: "t6", rawText: ".", kind: "punctuation", confidence: 0.22 },
          ],
        },
      },
    ]);
    expect(stage1.status).toBe("ready_for_verification");
    expect(stage1.readyForStage2).toBe(true);
    expect(stage1.cropConfirmationPrompts).toEqual([]);
  });

  it("blocks < tau critical symbols with zero-hint crop prompts and hard SkillBeliefV1 lock until confirmed", () => {
    const initialBelief = makeBelief();
    const ambiguousSteps: readonly HandwritingStepInput[] = [
      {
        stepId: "step-1",
        bbox: [0.1, 0.1, 0.9, 0.3],
        ast: {
          kind: "equation",
          tokens: [
            { tokenId: "t1", rawText: "2", kind: "digit", confidence: 0.97 },
            {
              tokenId: "t2",
              rawText: "*",
              kind: "operator",
              confidence: 0.62,
              bbox: [0.28, 0.12, 0.34, 0.24],
              span: { startOffset: 2, endOffset: 3 },
              visualCandidates: ["*", "+", "×"],
            },
            { tokenId: "t3", rawText: "3", kind: "digit", confidence: 0.95 },
            { tokenId: "t4", rawText: "=", kind: "operator", confidence: 0.96 },
            { tokenId: "t5", rawText: "5", kind: "digit", confidence: 0.94 },
          ],
        },
        misconceptionId: "sign_flip",
      },
    ];

    const stage1Blocked = evaluateHandwritingStage1(ambiguousSteps);
    expect(stage1Blocked.confidenceThreshold).toBe(DEFAULT_SYMBOL_CONFIDENCE_THRESHOLD);
    expect(stage1Blocked.status).toBe("awaiting_symbol_confirmation");
    expect(stage1Blocked.readyForStage2).toBe(false);
    expect(stage1Blocked.canUpdateSkillBelief).toBe(false);
    expect(stage1Blocked.epistemicBlockReason).toBe("unconfirmed_critical_ocr_symbol");
    expect(stage1Blocked.blockedStepIndices).toEqual([0]);
    expect(stage1Blocked.cropConfirmationPrompts).toHaveLength(1);

    const prompt = stage1Blocked.cropConfirmationPrompts[0]!;
    expect(prompt).toEqual({
      stepIndex: 0,
      stepId: "step-1",
      tokenId: "t2",
      cropBoundingBox: [0.28, 0.12, 0.34, 0.24],
      rawAmbiguousTokenSpan: { text: "*", startOffset: 2, endOffset: 3 },
      transcriptionOptions: ["*", "+", "×"],
      allowsFreeformInput: true,
    });
    // Zero hints / expected values / correctness flags anywhere in cropConfirmationPrompts.
    const serialized = JSON.stringify(prompt);
    expect(serialized).not.toMatch(/expected|correct|hint|answer|score|misconception|valid|invalid/i);

    // Stage 2 refuses belief-updating grading while OCR symbol remains unconfirmed.
    const stage2Blocked = evaluateHandwritingStage2(ambiguousSteps);
    expect(stage2Blocked.status).toBe("blocked_unconfirmed_ocr");
    expect(stage2Blocked.overallVerdict).toBe("blocked");
    expect(stage2Blocked.canUpdateSkillBelief).toBe(false);
    expect(stage2Blocked.firstRootCauseError).toBeNull();
    expect(stage2Blocked.unconfirmedPrompts).toHaveLength(1);

    const blockedBeliefAttempt = applyHandwritingStage2ToSkillBelief({
      stage2: stage2Blocked,
      belief: initialBelief,
      item: skillItem,
      atMs: 86_400_000,
      isFreshFamily: true,
    });
    expect(blockedBeliefAttempt.applied).toBe(false);
    expect(blockedBeliefAttempt.belief).toBe(initialBelief);
    expect(blockedBeliefAttempt.evidenceUpdate).toBeNull();

    // Learner confirms the ambiguous symbol was "+", unlocking Stage 2 and proving 2 + 3 = 5 valid.
    const confirmedSteps = applyLearnerSymbolConfirmations(ambiguousSteps, [
      { stepId: "step-1", tokenId: "t2", confirmedText: "+" },
    ]);
    const stage1Ready = evaluateHandwritingStage1(confirmedSteps);
    expect(stage1Ready.status).toBe("ready_for_verification");
    expect(stage1Ready.readyForStage2).toBe(true);
    expect(stage1Ready.cropConfirmationPrompts).toEqual([]);

    const stage2Evaluated = evaluateHandwritingStage2(confirmedSteps, { assisted: false });
    expect(stage2Evaluated.status).toBe("evaluated");
    expect(stage2Evaluated.overallVerdict).toBe("valid");
    expect(stage2Evaluated.canUpdateSkillBelief).toBe(true);
    expect(stage2Evaluated.firstRootCauseError).toBeNull();

    const updatedBelief = applyHandwritingStage2ToSkillBelief({
      stage2: stage2Evaluated,
      belief: initialBelief,
      item: skillItem,
      atMs: 86_400_000,
      isFreshFamily: true,
    });
    expect(updatedBelief.applied).toBe(true);
    expect(updatedBelief.belief.abilityMean).toBeGreaterThan(initialBelief.abilityMean);

    // If learner confirms OCR really WAS "*", deterministic evaluator flags 2 * 3 = 5 as invalid.
    const confirmedWrongOp = applyLearnerSymbolConfirmations(ambiguousSteps, [
      { stepId: "step-1", tokenId: "t2", confirmedText: "*" },
    ]);
    const wrongOpStage2 = evaluateHandwritingStage2(confirmedWrongOp, { assisted: false });
    expect(wrongOpStage2.status).toBe("evaluated");
    expect(wrongOpStage2.overallVerdict).toBe("invalid");
    expect(wrongOpStage2.firstRootCauseError?.stepId).toBe("step-1");
    expect(wrongOpStage2.firstRootCauseError?.misconceptionId).toBe("sign_flip");
  });

  it("blocks Stage 2 when an unconfirmed < tau symbol sits upstream of a later invalid step", () => {
    const chainWithUpstreamUncertain: readonly HandwritingStepInput[] = [
      {
        stepId: "s1",
        bbox: [0.1, 0.1, 0.9, 0.25],
        ast: {
          kind: "equation",
          tokens: [{ tokenId: "t1", rawText: "x", kind: "variable", confidence: 0.95 }],
        },
        localVerdict: "valid",
      },
      {
        stepId: "s2",
        dependsOnStepIds: ["s1"],
        bbox: [0.1, 0.3, 0.9, 0.45],
        ast: {
          kind: "equation",
          tokens: [{ tokenId: "t2", rawText: "-", kind: "operator", confidence: 0.55 }],
        },
        localVerdict: "valid",
      },
      {
        stepId: "s3",
        dependsOnStepIds: ["s2"],
        bbox: [0.1, 0.5, 0.9, 0.65],
        ast: {
          kind: "equation",
          tokens: [{ tokenId: "t3", rawText: "9", kind: "digit", confidence: 0.96 }],
        },
        localVerdict: "invalid",
        misconceptionId: "wrong_final_answer",
      },
    ];

    const blocked = evaluateHandwritingStage2(chainWithUpstreamUncertain);
    expect(blocked.status).toBe("blocked_unconfirmed_ocr");
    expect(blocked.canUpdateSkillBelief).toBe(false);
    expect(blocked.firstRootCauseError).toBeNull();
    expect(blocked.unconfirmedPrompts.map((p) => p.stepId)).toEqual(["s2"]);
  });

  it("respects custom tau threshold for borderline symbol confidence", () => {
    const steps: readonly HandwritingStepInput[] = [
      {
        stepId: "s1",
        bbox: [0.1, 0.1, 0.8, 0.3],
        ast: {
          kind: "diagram_408",
          diagramType: "linked_list_pointer_reversal",
          tokens: [
            { tokenId: "p1", rawText: "->", kind: "pointer_arrow", confidence: 0.88 },
          ],
        },
        localVerdict: "valid",
      },
    ];
    expect(evaluateHandwritingStage1(steps, { confidenceThreshold: 0.85 }).readyForStage2).toBe(true);
    const strict = evaluateHandwritingStage1(steps, { confidenceThreshold: 0.92 });
    expect(strict.status).toBe("awaiting_symbol_confirmation");
    expect(strict.blockedStepIndices).toEqual([0]);
  });

  it("propagates 4-state DAG verdicts and shields follow-through dependent steps from double-penalization", () => {
    const beliefBefore = makeBelief();
    const derivation: readonly HandwritingStepInput[] = [
      {
        stepId: "s1",
        bbox: [0.1, 0.05, 0.85, 0.2],
        ast: {
          kind: "equation",
          tokens: [{ tokenId: "a1", rawText: "x", kind: "variable", confidence: 0.96 }],
        },
        localVerdict: "valid",
      },
      {
        stepId: "s2",
        dependsOnStepIds: ["s1"],
        bbox: [0.1, 0.25, 0.85, 0.4],
        ast: {
          kind: "equation",
          tokens: [{ tokenId: "a2", rawText: "-", kind: "operator", confidence: 0.93 }],
        },
        localVerdict: "invalid",
        misconceptionId: "sign_flip",
        errorCode: "SIGN_DISTRIBUTION_ERROR",
        errorSummary: "Distributed negative sign incorrectly on step 2.",
      },
      {
        stepId: "s3",
        dependsOnStepIds: ["s2"],
        bbox: [0.1, 0.45, 0.85, 0.6],
        ast: {
          kind: "equation",
          tokens: [{ tokenId: "a3", rawText: "x", kind: "variable", confidence: 0.95 }],
        },
        // Follow-through ECF step consistent with s2's corrupted value.
        localVerdict: "valid",
        misconceptionId: "wrong_final_answer",
      },
      {
        stepId: "s4",
        dependsOnStepIds: ["s3"],
        bbox: [0.1, 0.65, 0.85, 0.8],
        ast: {
          kind: "equation",
          tokens: [{ tokenId: "a4", rawText: "7", kind: "digit", confidence: 0.94 }],
        },
        // Naive final-value comparator flagged s4 invalid due to upstream s2 error.
        localVerdict: "invalid",
        misconceptionId: "wrong_final_answer",
      },
    ];

    const stage2 = evaluateHandwritingStage2(derivation, { assisted: false });
    expect(stage2.status).toBe("evaluated");
    expect(stage2.overallVerdict).toBe("invalid");
    expect(stage2.canUpdateSkillBelief).toBe(true);
    expect(stage2.steps.map((s) => s.propagatedState)).toEqual([
      "valid",
      "invalid",
      "dependent",
      "dependent",
    ]);
    expect(stage2.firstRootCauseError).toEqual({
      stepId: "s2",
      stepIndex: 1,
      misconceptionId: "sign_flip",
      errorCode: "SIGN_DISTRIBUTION_ERROR",
      errorSummary: "Distributed negative sign incorrectly on step 2.",
      cropBoundingBox: [0.1, 0.25, 0.85, 0.4],
    });
    expect(stage2.suppressedDependentStepIndices).toEqual([2, 3]);
    expect(stage2.steps[2]!.attributedMisconceptionId).toBeNull();
    expect(stage2.steps[3]!.attributedMisconceptionId).toBeNull();

    // Update SkillBeliefV1: ONLY sign_flip (root cause) gains posterior diagnostic mass;
    // wrong_final_answer (suppressed on dependent steps) is NOT penalized.
    const applied = applyHandwritingStage2ToSkillBelief({
      stage2,
      belief: beliefBefore,
      item: skillItem,
      atMs: 86_400_000,
    });
    expect(applied.applied).toBe(true);
    const massAfter = new Map(applied.belief.misconceptionMass);
    const massBefore = new Map(beliefBefore.misconceptionMass);
    expect(massAfter.get("sign_flip")!).toBeGreaterThan(massBefore.get("sign_flip")!);
    expect(massAfter.get("wrong_final_answer")!).toBeLessThan(massBefore.get("wrong_final_answer")!);

    // Assisted attempts are blocked from updating SkillBeliefV1.
    const assistedStage2 = evaluateHandwritingStage2(derivation, { assisted: true });
    expect(assistedStage2.canUpdateSkillBelief).toBe(false);
    expect(
      applyHandwritingStage2ToSkillBelief({
        stage2: assistedStage2,
        belief: beliefBefore,
        item: skillItem,
        atMs: 86_400_000,
      }).applied,
    ).toBe(false);
  });

  it("handles DAG branches, out-of-order steps, unknown leaps, and rejects cycles", () => {
    // Branch B (index 2) and Branch A (index 3) both introduce independent invalid steps;
    // diamond merge (index 4) depends on both; out-of-order input order is respected.
    const dagSteps: readonly HandwritingStepInput[] = [
      {
        stepId: "merge",
        dependsOnStepIds: ["b1", "a2"],
        bbox: [0.1, 0.7, 0.9, 0.85],
        ast: {
          kind: "diagram_408",
          diagramType: "dijkstra_relaxation_matrix",
          tokens: [{ tokenId: "m1", rawText: "dp[3]", kind: "matrix_entry", confidence: 0.94 }],
        },
        localVerdict: "valid",
      },
      {
        stepId: "root",
        bbox: [0.1, 0.05, 0.9, 0.2],
        ast: {
          kind: "diagram_408",
          tokens: [{ tokenId: "r1", rawText: "0", kind: "digit", confidence: 0.99 }],
        },
        localVerdict: "valid",
      },
      {
        stepId: "a1",
        dependsOnStepIds: ["root"],
        bbox: [0.1, 0.25, 0.45, 0.4],
        ast: {
          kind: "diagram_408",
          tokens: [{ tokenId: "a1t", rawText: "->", kind: "pointer_arrow", confidence: 0.92 }],
        },
        localVerdict: "valid",
      },
      {
        stepId: "b1",
        dependsOnStepIds: ["root"],
        bbox: [0.55, 0.25, 0.9, 0.4],
        ast: {
          kind: "diagram_408",
          tokens: [{ tokenId: "b1t", rawText: "dist[2]", kind: "pointer_index", confidence: 0.91 }],
        },
        localVerdict: "invalid",
        misconceptionId: "earliest_branch_error",
      },
      {
        stepId: "a2",
        dependsOnStepIds: ["a1"],
        bbox: [0.1, 0.45, 0.45, 0.6],
        ast: {
          kind: "diagram_408",
          tokens: [{ tokenId: "a2t", rawText: "5", kind: "matrix_entry", confidence: 0.93 }],
        },
        localVerdict: "invalid",
        misconceptionId: "later_branch_error",
      },
    ];

    const result = evaluateHandwritingStage2(dagSteps);
    expect(result.topologicalOrderStepIds).toEqual(["root", "a1", "b1", "a2", "merge"]);
    expect(result.firstRootCauseError?.stepId).toBe("b1");
    expect(result.firstRootCauseError?.misconceptionId).toBe("earliest_branch_error");
    expect(result.steps[0]!.propagatedState).toBe("dependent"); // merge
    expect(result.steps[4]!.attributedMisconceptionId).toBeNull(); // a2 not double-attributed

    // Unsupported leap ("unknown") propagates to downstream steps and blocks belief update.
    const unknownChain = evaluateHandwritingStage2([
      {
        stepId: "u1",
        bbox: [0.1, 0.1, 0.8, 0.2],
        ast: {
          kind: "expression",
          tokens: [{ tokenId: "ut1", rawText: "x", kind: "variable", confidence: 0.95 }],
        },
        localVerdict: "unknown",
      },
      {
        stepId: "u2",
        dependsOnStepIds: ["u1"],
        bbox: [0.1, 0.3, 0.8, 0.4],
        ast: {
          kind: "expression",
          tokens: [{ tokenId: "ut2", rawText: "y", kind: "variable", confidence: 0.95 }],
        },
        localVerdict: "valid",
      },
    ]);
    expect(unknownChain.overallVerdict).toBe("unknown");
    expect(unknownChain.steps.map((s) => s.propagatedState)).toEqual(["unknown", "unknown"]);
    expect(unknownChain.canUpdateSkillBelief).toBe(false);

    // Cycle detection.
    expect(() =>
      evaluateHandwritingStage2([
        {
          stepId: "c1",
          dependsOnStepIds: ["c2"],
          bbox: [0.1, 0.1, 0.4, 0.3],
          ast: { kind: "expression", tokens: [] },
        },
        {
          stepId: "c2",
          dependsOnStepIds: ["c1"],
          bbox: [0.5, 0.1, 0.9, 0.3],
          ast: { kind: "expression", tokens: [] },
        },
      ]),
    ).toThrow(/cycle/i);
  });

  it("[P1-2][P1-3][P2-2] enforces exponent/unary precedence, fails closed on overflow/unsupported syntax, strips punctuation, and gates confirmedText", () => {
    const makeEqStep = (stepId: string, tokens: string[]): HandwritingStepInput => ({
      stepId,
      bbox: [0.1, 0.1, 0.9, 0.3],
      ast: {
        kind: "equation",
        tokens: tokens.map((rawText, idx) => ({
          tokenId: `${stepId}-t${idx}`,
          rawText,
          kind: "auto",
          confidence: 0.99,
        })),
      },
    });

    // [P1-2] Unary negation vs exponentiation precedence & right-associative powers.
    expect(evaluateHandwritingStage2([makeEqStep("p1", ["-2", "^", "2", "=", "-4"])]).overallVerdict).toBe("valid");
    expect(evaluateHandwritingStage2([makeEqStep("p2", ["-2", "^", "2", "=", "4"])]).overallVerdict).toBe("invalid");
    expect(evaluateHandwritingStage2([makeEqStep("p3", ["(", "-2", ")", "^", "2", "=", "4"])]).overallVerdict).toBe("valid");
    expect(evaluateHandwritingStage2([makeEqStep("p4", ["-4", "^", "0.5", "=", "-2"])]).overallVerdict).toBe("valid");
    expect(evaluateHandwritingStage2([makeEqStep("p5", ["2", "^", "-3", "=", "0.125"])]).overallVerdict).toBe("valid");
    expect(evaluateHandwritingStage2([makeEqStep("p6", ["2", "^", "3", "^", "2", "=", "512"])]).overallVerdict).toBe("valid");

    // [P1-3] Trailing non-semantic punctuation / decoration excluded before numeric check.
    const punctuated = evaluateHandwritingStage2([
      {
        stepId: "punct",
        bbox: [0.1, 0.1, 0.9, 0.3],
        ast: {
          kind: "equation",
          tokens: [
            { tokenId: "t1", rawText: "2.5", kind: "number", confidence: 0.99 },
            { tokenId: "t2", rawText: "+", kind: "operator", confidence: 0.99 },
            { tokenId: "t3", rawText: "2.5", kind: "number", confidence: 0.99 },
            { tokenId: "t4", rawText: "=", kind: "operator", confidence: 0.99 },
            { tokenId: "t5", rawText: "5.0", kind: "number", confidence: 0.99 },
            { tokenId: "t6", rawText: ".", kind: "punctuation", confidence: 0.3 },
            { tokenId: "t7", rawText: "__", kind: "decoration", confidence: 0.2 },
          ],
        },
      },
    ]);
    expect(punctuated.overallVerdict).toBe("valid");

    // [P1-3] Unsupported implicit multiplication & float64 overflow fail closed as "unknown", while div-by-zero is "invalid".
    const implicitMul = evaluateHandwritingStage2([makeEqStep("impl", ["2", "(", "3", ")", "=", "6"])]);
    expect(implicitMul.overallVerdict).toBe("unknown");
    expect(implicitMul.canUpdateSkillBelief).toBe(false);

    const overflow = evaluateHandwritingStage2([makeEqStep("ovf", ["10", "^", "400", "=", "10", "^", "400"])]);
    expect(overflow.overallVerdict).toBe("unknown");
    expect(overflow.canUpdateSkillBelief).toBe(false);

    const divZero = evaluateHandwritingStage2([makeEqStep("dz", ["1", "/", "0", "=", "0"])]);
    expect(divZero.overallVerdict).toBe("invalid");

    // [P2-2] Unconfirmed confirmedText must be ignored when confirmedByLearner !== true.
    const unconfirmedDraft: readonly HandwritingStepInput[] = [
      {
        stepId: "draft-only",
        bbox: [0.1, 0.1, 0.9, 0.3],
        ast: {
          kind: "equation",
          tokens: [
            { tokenId: "d1", rawText: "2", kind: "digit", confidence: 0.99 },
            {
              tokenId: "d2",
              rawText: "*",
              kind: "operator",
              confidence: 0.92,
              confirmedByLearner: false,
              confirmedText: "+",
            },
            { tokenId: "d3", rawText: "3", kind: "digit", confidence: 0.99 },
            { tokenId: "d4", rawText: "=", kind: "operator", confidence: 0.99 },
            { tokenId: "d5", rawText: "5", kind: "digit", confidence: 0.99 },
          ],
        },
      },
    ];
    const stage1Draft = evaluateHandwritingStage1(unconfirmedDraft);
    expect(stage1Draft.steps[0]!.tokens[1]!.effectiveText).toBe("*");
    expect(evaluateHandwritingStage2(unconfirmedDraft).overallVerdict).toBe("invalid");
  });

  it("Round-3 [P1-1]: invalidates stale pre-confirmation localVerdict & misconception when confirmed text changes", () => {
    // 1. Numeric equation "1 = 2" had stale localVerdict: "invalid" before learner corrected "2" -> "1".
    const staleNumericSteps: readonly HandwritingStepInput[] = [
      {
        stepId: "s-num",
        bbox: [0.1, 0.1, 0.9, 0.3],
        ast: {
          kind: "equation",
          tokens: [
            { tokenId: "n1", rawText: "1", kind: "digit", confidence: 0.98 },
            { tokenId: "n2", rawText: "=", kind: "operator", confidence: 0.99 },
            { tokenId: "n3", rawText: "2", kind: "digit", confidence: 0.54 },
          ],
        },
        localVerdict: "invalid",
        misconceptionId: "ocr_stale_misconception",
        errorCode: "STALE_RHS",
        errorSummary: "1 != 2",
      },
    ];

    const viaHelper = applyLearnerSymbolConfirmations(staleNumericSteps, [
      { stepId: "s-num", tokenId: "n3", confirmedText: "1" },
    ]);
    expect(viaHelper[0]!.localVerdict).toBeUndefined();
    expect(viaHelper[0]!.misconceptionId).toBeUndefined();

    const helperStage2 = evaluateHandwritingStage2(viaHelper, { assisted: false });
    expect(helperStage2.overallVerdict).toBe("valid");
    expect(helperStage2.firstRootCauseError).toBeNull();
    expect(helperStage2.canUpdateSkillBelief).toBe(true);

    // Even when caller sets confirmedByLearner: true directly without applyLearnerSymbolConfirmations,
    // Stage 2 still ignores the stale pre-confirmation localVerdict/misconception!
    const directMutatedStep: readonly HandwritingStepInput[] = [
      {
        ...staleNumericSteps[0]!,
        ast: {
          ...staleNumericSteps[0]!.ast,
          tokens: [
            staleNumericSteps[0]!.ast.tokens[0]!,
            staleNumericSteps[0]!.ast.tokens[1]!,
            {
              ...staleNumericSteps[0]!.ast.tokens[2]!,
              confirmedByLearner: true,
              confirmedText: "1",
            },
          ],
        },
      },
    ];
    const directStage2 = evaluateHandwritingStage2(directMutatedStep, { assisted: false });
    expect(directStage2.overallVerdict).toBe("valid");
    expect(directStage2.firstRootCauseError).toBeNull();

    // 2. Non-numeric step changed by confirmation fails closed as "unknown" unless a matching postConfirmationVerdict is supplied.
    const symbolicStale: readonly HandwritingStepInput[] = [
      {
        stepId: "s-sym",
        bbox: [0.1, 0.1, 0.9, 0.3],
        ast: {
          kind: "equation",
          tokens: [
            { tokenId: "x1", rawText: "x", kind: "variable", confidence: 0.97 },
            { tokenId: "x2", rawText: "+", kind: "operator", confidence: 0.98 },
            { tokenId: "x3", rawText: "2", kind: "digit", confidence: 0.51 },
            { tokenId: "x4", rawText: "=", kind: "operator", confidence: 0.99 },
            { tokenId: "x5", rawText: "3", kind: "digit", confidence: 0.96 },
          ],
        },
        localVerdict: "invalid",
        misconceptionId: "stale_symbolic_err",
      },
    ];
    const symConfirmedNoFresh = applyLearnerSymbolConfirmations(symbolicStale, [
      { stepId: "s-sym", tokenId: "x3", confirmedText: "1" },
    ]);
    const symUnknown = evaluateHandwritingStage2(symConfirmedNoFresh, { assisted: false });
    expect(symUnknown.overallVerdict).toBe("unknown");
    expect(symUnknown.canUpdateSkillBelief).toBe(false);
    expect(symUnknown.firstRootCauseError).toBeNull();

    // Mismatched postConfirmationVerdict (keyed to old "x + 2 = 3") is ignored.
    const mismatchedPostVerdict = evaluateHandwritingStage2([
      {
        ...symConfirmedNoFresh[0]!,
        postConfirmationVerdict: {
          confirmedExpression: "x + 2 = 3",
          localVerdict: "invalid",
          misconceptionId: "stale_symbolic_err",
        },
      },
    ]);
    expect(mismatchedPostVerdict.overallVerdict).toBe("unknown");
    expect(mismatchedPostVerdict.canUpdateSkillBelief).toBe(false);

    // Exact matching postConfirmationVerdict IS honored.
    const matchedPostVerdict = evaluateHandwritingStage2([
      {
        ...symConfirmedNoFresh[0]!,
        postConfirmationVerdict: {
          confirmedExpression: "x + 1 = 3",
          localVerdict: "invalid",
          misconceptionId: "fresh_constant_err",
        },
      },
    ]);
    expect(matchedPostVerdict.overallVerdict).toBe("invalid");
    expect(matchedPostVerdict.firstRootCauseError?.misconceptionId).toBe("fresh_constant_err");
    expect(matchedPostVerdict.canUpdateSkillBelief).toBe(true);
  });

  it("Round-3 [P1-2]: blocks untokenized OCR steps (tokens: [] or 0 critical tokens) from updating SkillBeliefV1", () => {
    const initialBelief = makeBelief();
    const untokenizedSteps: readonly HandwritingStepInput[] = [
      {
        stepId: "raw-only",
        bbox: [0.1, 0.1, 0.9, 0.3],
        ast: {
          kind: "equation",
          rawExpression: "2 = 2",
          tokens: [],
        },
      },
    ];

    const stage1 = evaluateHandwritingStage1(untokenizedSteps);
    expect(stage1.status).toBe("awaiting_symbol_confirmation");
    expect(stage1.readyForStage2).toBe(false);
    expect(stage1.canUpdateSkillBelief).toBe(false);
    expect(stage1.epistemicBlockReason).toBe("untokenized_ocr_step");
    expect(stage1.untokenizedStepIndices).toEqual([0]);

    const stage2 = evaluateHandwritingStage2(untokenizedSteps, { assisted: false });
    expect(stage2.overallVerdict).toBe("unknown");
    expect(stage2.steps[0]!.propagatedState).toBe("unknown");
    expect(stage2.canUpdateSkillBelief).toBe(false);
    expect(stage2.epistemicSignal.reasonCode).toBe("blocked_untokenized_ocr_step");

    const beliefGuard = applyHandwritingStage2ToSkillBelief({
      stage2,
      belief: initialBelief,
      item: skillItem,
      atMs: 86_400_000,
    });
    expect(beliefGuard.applied).toBe(false);
    expect(beliefGuard.belief).toBe(initialBelief);

    // Step with only non-semantic punctuation tokens (0 critical tokens) + pre-supplied localVerdict also fails closed.
    const punctOnlySteps: readonly HandwritingStepInput[] = [
      {
        stepId: "punct-only",
        bbox: [0.1, 0.1, 0.9, 0.3],
        ast: {
          kind: "equation",
          rawExpression: "2 = 2",
          tokens: [{ tokenId: "p1", rawText: ".", kind: "punctuation", confidence: 0.99 }],
        },
        localVerdict: "valid",
      },
    ];
    const punctStage2 = evaluateHandwritingStage2(punctOnlySteps, { assisted: false });
    expect(punctStage2.overallVerdict).toBe("unknown");
    expect(punctStage2.canUpdateSkillBelief).toBe(false);
  });

  it("Round-3 [P1-3]: evaluates decimal/integer expressions with exact BigInt rationals and abstains on ambiguous irrational float comparisons", () => {
    const makeEq = (id: string, tokens: string[]): HandwritingStepInput => ({
      stepId: id,
      bbox: [0.1, 0.1, 0.9, 0.3],
      ast: {
        kind: "equation",
        tokens: tokens.map((rawText, idx) => ({
          tokenId: `${id}-${idx}`,
          rawText,
          kind: "auto",
          confidence: 0.99,
        })),
      },
    });
    const makeIneq = (id: string, tokens: string[]): HandwritingStepInput => ({
      stepId: id,
      bbox: [0.1, 0.1, 0.9, 0.3],
      ast: {
        kind: "inequality",
        tokens: tokens.map((rawText, idx) => ({
          tokenId: `${id}-${idx}`,
          rawText,
          kind: "auto",
          confidence: 0.99,
        })),
      },
    });

    // Sub-1e-9 difference MUST NOT pass as equal!
    const tinyDiff = evaluateHandwritingStage2([makeEq("tiny", ["0", "=", "0.0000000005"])]);
    expect(tinyDiff.overallVerdict).toBe("invalid");

    // Classic IEEE-754 0.1 + 0.2 == 0.3 and 0.30000000000000004 are exact.
    expect(evaluateHandwritingStage2([makeEq("dec-ok", ["0.1", "+", "0.2", "=", "0.3"])]).overallVerdict).toBe("valid");
    expect(
      evaluateHandwritingStage2([makeEq("dec-bad", ["0.1", "+", "0.2", "=", "0.30000000000000004"])]).overallVerdict,
    ).toBe("invalid");

    // Exact fractional roots like 4^0.5 = 2 and (9/16)^-0.5 = 4/3 are exact rationals.
    expect(evaluateHandwritingStage2([makeEq("sqrt4", ["4", "^", "0.5", "=", "2"])]).overallVerdict).toBe("valid");
    expect(evaluateHandwritingStage2([makeEq("sqrt4-bad", ["4", "^", "0.5", "=", "2.000000000001"])]).overallVerdict).toBe("invalid");

    // Irrational power certified outside IEEE-754 interval uncertainty: 2^0.5 = 2 is invalid; 2^0.5 < 1.5 is valid.
    expect(evaluateHandwritingStage2([makeEq("irr-false", ["2", "^", "0.5", "=", "2"])]).overallVerdict).toBe("invalid");
    expect(evaluateHandwritingStage2([makeIneq("irr-lt", ["2", "^", "0.5", "<", "1.5"])]).overallVerdict).toBe("valid");

    // Ambiguous IEEE-754 decimal match for irrational root abstains as "unknown" with canUpdateSkillBelief: false.
    const ambiguousFloat = evaluateHandwritingStage2([
      makeEq("irr-ambig", ["2", "^", "0.5", "=", "1.4142135623730951"]),
    ]);
    expect(ambiguousFloat.overallVerdict).toBe("unknown");
    expect(ambiguousFloat.canUpdateSkillBelief).toBe(false);
  });
});

describe("multimodal-evidence: Pre-VAD Original PCM Clock & 0080 Raw Audio Retention", () => {
  it("matches NIST SHA-256 test vector in pure browser-safe TypeScript", () => {
    expect(sha256HexUtf8("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("reconstructs a 2,200 ms VAD-stripped silence back onto the exact original PCM clock", () => {
    // Original 5,000 ms recording:
    // - Segment 0: [200, 1200] (1,000 ms) -> stripped [0, 1000]
    // - Silence gap: [1200, 3400] (2,200 ms mid-clause stall!)
    // - Segment 1: [3400, 4400] (1,000 ms) -> stripped [1000, 2000]
    const voicedSegments = [
      { originalStartMs: 200, originalEndMs: 1200, strippedStartMs: 0, strippedEndMs: 1000 },
      { originalStartMs: 3400, originalEndMs: 4400, strippedStartMs: 1000, strippedEndMs: 2000 },
    ] as const;

    const strippedWords = [
      { word: "I", startMs: 0, endMs: 250 },
      { word: "usually", startMs: 300, endMs: 650 },
      { word: "prefer", startMs: 700, endMs: 1000 }, // ends right at VAD boundary 1000
      { word: "reading", startMs: 1000, endMs: 1450 }, // starts right at VAD boundary 1000
      { word: "novels", startMs: 1500, endMs: 1950 },
    ] as const;

    // Naive calculation treating stripped timestamps as original PCM misses the 2,200 ms stall.
    const naiveStrippedReceipt = issueSpeechTimingReceipt({
      receiptId: "naive-stripped",
      totalOriginalDurationMs: 2000,
      voicedSegments: [
        { originalStartMs: 0, originalEndMs: 2000, strippedStartMs: 0, strippedEndMs: 2000 },
      ],
      words: strippedWords,
      defaultTokenClock: "original_pcm",
    });
    expect(naiveStrippedReceipt.breakdownPauseCount).toBe(0);
    expect(naiveStrippedReceipt.midClauseHesitationCount).toBe(0);
    expect(naiveStrippedReceipt.meanLengthOfRunWords).toBe(5);

    // Exact pre-VAD reconstruction recovers the 2,200 ms breakdown pause and accurate MLR.
    const preVadReceipt = issueSpeechTimingReceipt({
      receiptId: "rcpt-pre-vad-1",
      issuedAtMs: 1_700_000_000_000,
      totalOriginalDurationMs: 5000,
      voicedSegments,
      words: strippedWords,
      defaultTokenClock: "vad_stripped",
    });

    expect(preVadReceipt.totalDurationMs).toBe(5000);
    expect(preVadReceipt.voicedDurationMs).toBe(2000);
    expect(preVadReceipt.silenceDurationMs).toBe(3000);
    expect(preVadReceipt.words[2]!.originalEndMs).toBe(1200);
    expect(preVadReceipt.words[3]!.originalStartMs).toBe(3400);
    expect(preVadReceipt.breakdownPauseCount).toBe(1);
    expect(preVadReceipt.minorHesitationCount).toBe(0);
    expect(preVadReceipt.midClauseHesitationCount).toBe(1);
    expect(preVadReceipt.sentenceBoundaryPauseCount).toBe(0);
    expect(preVadReceipt.midClauseHesitationPauses[0]).toEqual({
      afterWordIndex: 2,
      beforeWordIndex: 3,
      startMs: 1200,
      endMs: 3400,
      durationMs: 2200,
      kind: "mid_clause_breakdown",
    });
    expect(preVadReceipt.runWordCounts).toEqual([3, 2]);
    expect(preVadReceipt.meanLengthOfRunWords).toBe(2.5);
    expect(preVadReceipt.speechRateSylOrWordsPerMin).toBe(60); // 5 words / (5000 / 60000) min
    expect(preVadReceipt.articulationRateWordsPerMin).toBe(150); // 5 words / (2000 / 60000) min
    expect(preVadReceipt.integrityDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect("rawAudioBytes" in preVadReceipt).toBe(false);
  });

  it("[P1-1][P2-1] snaps cross-segment vad_stripped jitter tokens to majority segment without swallowing excised silences", () => {
    const voicedSegments = [
      { originalStartMs: 200, originalEndMs: 1200, strippedStartMs: 0, strippedEndMs: 1000 },
      { originalStartMs: 3400, originalEndMs: 4400, strippedStartMs: 1000, strippedEndMs: 2000 },
    ] as const;

    // 1. Majority in seg[0] ([700, 1010] -> 300ms in seg0, 10ms in seg1) snaps to seg[0] [900, 1200].
    const forwardJitter = issueSpeechTimingReceipt({
      receiptId: "rcpt-seam-forward",
      totalOriginalDurationMs: 5000,
      voicedSegments,
      words: [
        { word: "I", startMs: 0, endMs: 300 },
        { word: "prefer", startMs: 700, endMs: 1010 },
        { word: "reading", startMs: 1010, endMs: 1450 },
      ],
      defaultTokenClock: "vad_stripped",
    });
    expect(forwardJitter.voicedDurationMs).toBe(2000);
    expect(forwardJitter.words[1]!.originalStartMs).toBe(900);
    expect(forwardJitter.words[1]!.originalEndMs).toBe(1200);
    expect(forwardJitter.words[2]!.originalStartMs).toBe(3410);
    expect(forwardJitter.breakdownPauseCount).toBe(1);
    expect(forwardJitter.midClauseHesitationPauses[0]!.durationMs).toBe(2210);
    expect(forwardJitter.meanLengthOfRunWords).toBe(1.5);

    // 2. Majority in seg[1] ([990, 1450] -> 10ms in seg0, 450ms in seg1) snaps to seg[1] [3400, 3850].
    const backwardJitter = issueSpeechTimingReceipt({
      receiptId: "rcpt-seam-backward",
      totalOriginalDurationMs: 5000,
      voicedSegments,
      words: [
        { word: "prefer", startMs: 700, endMs: 990 },
        { word: "reading", startMs: 990, endMs: 1450 },
      ],
      defaultTokenClock: "vad_stripped",
    });
    expect(backwardJitter.words[0]!.originalEndMs).toBe(1190);
    expect(backwardJitter.words[1]!.originalStartMs).toBe(3400);
    expect(backwardJitter.breakdownPauseCount).toBe(1);
    expect(backwardJitter.midClauseHesitationPauses[0]!.durationMs).toBe(2210);

    // 3. Token spanning > 1 excised silence gap snaps to majority island without swallowing silences.
    const multiIslandSegments = [
      { originalStartMs: 0, originalEndMs: 500, strippedStartMs: 0, strippedEndMs: 500 },
      { originalStartMs: 2500, originalEndMs: 3500, strippedStartMs: 500, strippedEndMs: 1500 },
      { originalStartMs: 5500, originalEndMs: 6500, strippedStartMs: 1500, strippedEndMs: 2500 },
    ] as const;
    const multiSpan = issueSpeechTimingReceipt({
      receiptId: "rcpt-multi-island",
      totalOriginalDurationMs: 7000,
      voicedSegments: multiIslandSegments,
      words: [
        { word: "well", startMs: 0, endMs: 400 },
        { word: "um", startMs: 450, endMs: 1550 }, // 50ms in seg0, 1000ms in seg1, 50ms in seg2
        { word: "yes", startMs: 1600, endMs: 2200 },
      ],
      defaultTokenClock: "vad_stripped",
    });
    expect(multiSpan.voicedDurationMs).toBe(2500);
    expect(multiSpan.words[1]!.originalStartMs).toBe(2500);
    expect(multiSpan.words[1]!.originalEndMs).toBe(3500);
    expect(multiSpan.breakdownPauseCount).toBe(2);

    // 4. [P2-1] Non-touching padded stripped segments honor exact segment endpoints.
    const paddedSegments = [
      { originalStartMs: 0, originalEndMs: 1000, strippedStartMs: 0, strippedEndMs: 1000 },
      { originalStartMs: 3000, originalEndMs: 4000, strippedStartMs: 1050, strippedEndMs: 2050 },
    ] as const;
    expect(mapStrippedClockToOriginalPcmMs(1000, paddedSegments, "start")).toEqual({
      originalMs: 1000,
      segmentIndex: 0,
    });
    expect(mapStrippedClockToOriginalPcmMs(1050, paddedSegments, "end")).toEqual({
      originalMs: 3000,
      segmentIndex: 1,
    });
  });

  it("distinguishes sentence-boundary pauses, minor hesitations, and repair/repetition ratio", () => {
    const receipt = issueSpeechTimingReceipt({
      receiptId: "rcpt-fc-2",
      totalOriginalDurationMs: 10_000,
      voicedSegments: [
        { originalStartMs: 0, originalEndMs: 1500, strippedStartMs: 0, strippedEndMs: 1500 },
        { originalStartMs: 2500, originalEndMs: 4000, strippedStartMs: 1500, strippedEndMs: 3000 },
        { originalStartMs: 6000, originalEndMs: 8000, strippedStartMs: 3000, strippedEndMs: 5000 },
      ],
      words: [
        { word: "The", startMs: 0, endMs: 300 },
        { word: "the", startMs: 350, endMs: 700 }, // repetition
        { word: "library", startMs: 750, endMs: 1500 },
        // 1,000 ms minor mid-clause hesitation [1500 -> 2500]
        { word: "opens", startMs: 2500, endMs: 3100 },
        { word: "early.", startMs: 3200, endMs: 4000, isSentenceBoundaryAfter: true },
        // 2,000 ms natural sentence-boundary pause [4000 -> 6000]
        { word: "However", startMs: 6000, endMs: 6900 },
        { word: "stud-", startMs: 6950, endMs: 7300 }, // self-repair false start
        { word: "students", startMs: 7350, endMs: 8000 },
      ],
      defaultTokenClock: "original_pcm",
    });

    expect(receipt.minorHesitationCount).toBe(1);
    expect(receipt.breakdownPauseCount).toBe(0);
    expect(receipt.midClauseHesitationCount).toBe(1);
    expect(receipt.sentenceBoundaryPauseCount).toBe(1);
    expect(receipt.runWordCounts).toEqual([3, 2, 3]);
    expect(receipt.meanLengthOfRunWords).toBeCloseTo(8 / 3, 10);
    expect(receipt.repairRepetitionCount).toBe(2);
    expect(receipt.repairRepetitionRatio).toBeCloseTo(2 / 8, 10);
  });

  it("Round-3 [P2]: includes filledPauseCount and per-word disfluency fields in integrityDigest", () => {
    const baseInput = {
      receiptId: "rcpt-digest-disfluency",
      issuedAtMs: 1_700_000_000_000,
      totalOriginalDurationMs: 4000,
      voicedSegments: [
        { originalStartMs: 0, originalEndMs: 2000, strippedStartMs: 0, strippedEndMs: 2000 },
      ],
      defaultTokenClock: "original_pcm" as const,
    };
    const noneReceipt = issueSpeechTimingReceipt({
      ...baseInput,
      words: [
        { word: "um", startMs: 0, endMs: 300, disfluencyKind: "none" },
        { word: "yes", startMs: 400, endMs: 800, disfluencyKind: "none" },
      ],
    });
    const fillerReceipt = issueSpeechTimingReceipt({
      ...baseInput,
      words: [
        { word: "um", startMs: 0, endMs: 300, disfluencyKind: "filler" },
        { word: "yes", startMs: 400, endMs: 800, disfluencyKind: "none" },
      ],
    });

    expect(noneReceipt.filledPauseCount).toBe(0);
    expect(fillerReceipt.filledPauseCount).toBe(1);
    expect(fillerReceipt.integrityDigest).not.toBe(noneReceipt.integrityDigest);
  });

  it("rejects mismatched VAD segment durations, overlaps, and out-of-range timestamps", () => {
    expect(() =>
      issueSpeechTimingReceipt({
        receiptId: "bad-dur",
        totalOriginalDurationMs: 5000,
        voicedSegments: [
          { originalStartMs: 0, originalEndMs: 1000, strippedStartMs: 0, strippedEndMs: 900 },
        ],
        words: [],
      }),
    ).toThrow(RangeError);

    expect(() =>
      issueSpeechTimingReceipt({
        receiptId: "overlap",
        totalOriginalDurationMs: 5000,
        voicedSegments: [
          { originalStartMs: 0, originalEndMs: 1200, strippedStartMs: 0, strippedEndMs: 1200 },
          { originalStartMs: 1100, originalEndMs: 2100, strippedStartMs: 1200, strippedEndMs: 2200 },
        ],
        words: [],
      }),
    ).toThrow(RangeError);

    expect(() =>
      mapStrippedClockToOriginalPcmMs(
        2500,
        [{ originalStartMs: 0, originalEndMs: 1000, strippedStartMs: 0, strippedEndMs: 1000 }],
        "start",
      ),
    ).toThrow(RangeError);
  });

  it("enforces 0080 media quota ceiling, immediate-delete default, and <= 24h hard sweep ceiling", () => {
    const issuedAtMs = 1_700_000_000_000;

    // 1. Quota & duration rejection before upload acceptance.
    const overQuota = evaluateRawAudioRetentionPolicy({
      mediaBytesUsed: 9_500_000,
      recordingBytes: 600_000,
      mediaQuotaBytes: 10_000_000,
      durationMs: 45_000,
      maxRecordingDurationMs: 60_000,
      providerMediaMaxInputBytes: 500_000,
      issuedAtMs,
    });
    expect(overQuota.accepted).toBe(false);
    expect(overQuota.disposition).toBe("rejected_over_budget");
    expect(overQuota.retainRawAudio).toBe(false);
    expect(overQuota.sweep_due_immediately).toBe(true);
    expect(overQuota.rejectionReasons).toEqual([
      "media_quota_exceeded",
      "provider_media_max_bytes_exceeded",
    ]);

    const overDuration = evaluateRawAudioRetentionPolicy({
      mediaBytesUsed: 0,
      recordingBytes: 100_000,
      mediaQuotaBytes: 10_000_000,
      durationMs: 185_000,
      maxRecordingDurationMs: 180_000,
      issuedAtMs,
    });
    expect(overDuration.accepted).toBe(false);
    expect(overDuration.rejectionReasons).toEqual(["recording_duration_exceeded"]);

    // 2. Default immediate purge after speechTimingReceipt issuance.
    const defaultPurge = evaluateRawAudioRetentionPolicy({
      mediaBytesUsed: 1_000_000,
      recordingBytes: 250_000,
      mediaQuotaBytes: 10_000_000,
      durationMs: 15_000,
      maxRecordingDurationMs: 180_000,
      issuedAtMs,
    });
    expect(defaultPurge.accepted).toBe(true);
    expect(defaultPurge.disposition).toBe("immediate_delete");
    expect(defaultPurge.retainRawAudio).toBe(false);
    expect(defaultPurge.deleteDeadlineMs).toBe(issuedAtMs);
    expect(defaultPurge.sweep_due_immediately).toBe(true);
    expect(defaultPurge.remainingMediaBytesAfterUpload).toBe(8_750_000);

    // 3. Learner replay opt-in clamped strictly to <= 24h ceiling, flipping sweep_due_immediately at deadline.
    const seventyTwoHoursLater = issuedAtMs + 72 * 3_600_000;
    const retainedWithinWindow = evaluateRawAudioRetentionPolicy({
      mediaBytesUsed: 1_000_000,
      recordingBytes: 250_000,
      mediaQuotaBytes: 10_000_000,
      durationMs: 15_000,
      maxRecordingDurationMs: 180_000,
      issuedAtMs,
      nowMs: issuedAtMs + 2 * 3_600_000,
      learnerOptInReplay: true,
      requestedRetentionUntilMs: seventyTwoHoursLater,
    });
    expect(retainedWithinWindow.accepted).toBe(true);
    expect(retainedWithinWindow.disposition).toBe("temporary_replay_retained");
    expect(retainedWithinWindow.retainRawAudio).toBe(true);
    expect(retainedWithinWindow.hardCeilingApplied).toBe(true);
    expect(retainedWithinWindow.deleteDeadlineMs).toBe(
      issuedAtMs + RAW_AUDIO_HARD_RETENTION_CEILING_MS,
    );
    expect(retainedWithinWindow.sweep_due_immediately).toBe(false);

    const expiredAtCeiling = evaluateRawAudioRetentionPolicy({
      mediaBytesUsed: 1_000_000,
      recordingBytes: 250_000,
      mediaQuotaBytes: 10_000_000,
      durationMs: 15_000,
      maxRecordingDurationMs: 180_000,
      issuedAtMs,
      nowMs: issuedAtMs + RAW_AUDIO_HARD_RETENTION_CEILING_MS,
      learnerOptInReplay: true,
      requestedRetentionUntilMs: seventyTwoHoursLater,
    });
    expect(expiredAtCeiling.disposition).toBe("sweep_expired");
    expect(expiredAtCeiling.retainRawAudio).toBe(false);
    expect(expiredAtCeiling.sweep_due_immediately).toBe(true);

    // [P2-3] immediate_delete sets sweep_due_immediately: true unconditionally even if nowMs < issuedAtMs.
    const earlyClockImmediate = evaluateRawAudioRetentionPolicy({
      mediaBytesUsed: 0,
      recordingBytes: 10_000,
      mediaQuotaBytes: 10_000_000,
      durationMs: 5_000,
      maxRecordingDurationMs: 180_000,
      issuedAtMs,
      nowMs: issuedAtMs - 1_000,
      learnerOptInReplay: false,
    });
    expect(earlyClockImmediate.disposition).toBe("immediate_delete");
    expect(earlyClockImmediate.sweep_due_immediately).toBe(true);

    const earlyClockOptInExpired = evaluateRawAudioRetentionPolicy({
      mediaBytesUsed: 0,
      recordingBytes: 10_000,
      mediaQuotaBytes: 10_000_000,
      durationMs: 5_000,
      maxRecordingDurationMs: 180_000,
      issuedAtMs,
      nowMs: issuedAtMs - 1_000,
      learnerOptInReplay: true,
      requestedRetentionUntilMs: issuedAtMs,
    });
    expect(earlyClockOptInExpired.disposition).toBe("immediate_delete");
    expect(earlyClockOptInExpired.sweep_due_immediately).toBe(true);
  });
});
