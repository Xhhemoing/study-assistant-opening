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
  });
});
