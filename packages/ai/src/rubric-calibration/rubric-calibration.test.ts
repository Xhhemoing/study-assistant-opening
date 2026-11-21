import { describe, expect, it } from "vitest";
import {
  ANTI_PADDING_COUNTERFACTUAL_TRIPLETS,
  RUBRIC_DIMENSIONS,
  SENTINEL_ANCHOR_ESSAYS,
  SENTINEL_BANDS,
  computeQuadraticWeightedKappa,
  detectTemplatePadding,
  evaluateAnchorCalibratedRubric,
  evaluateRubricCalibrationGate,
  getSentinelAnchorsForDimension,
  type PairwiseSwapComparison,
  type RubricCalibrationPoint,
  type RubricDimension,
} from "./index";

function consistentComparisonsForTarget(
  dimension: RubricDimension,
  targetBand: number,
): PairwiseSwapComparison[] {
  return getSentinelAnchorsForDimension(dimension).map((anchor) => {
    if (targetBand > anchor.band) {
      return { anchorId: anchor.anchorId, forwardChoice: "A", reverseChoice: "B" };
    }
    if (targetBand < anchor.band) {
      return { anchorId: anchor.anchorId, forwardChoice: "B", reverseChoice: "A" };
    }
    return { anchorId: anchor.anchorId, forwardChoice: "tie", reverseChoice: "tie" };
  });
}

function calibratedPoint(band: number, rawBand = band, countsTowardMastery = true): RubricCalibrationPoint {
  return { status: "calibrated", band, rawBand, countsTowardMastery };
}

describe("AnchorCalibratedRubricV1 sentinel anchors & anti-padding detector", () => {
  it("provides ordered low/mid/high sentinel anchors for every rubric dimension", () => {
    expect(SENTINEL_ANCHOR_ESSAYS.map((essay) => essay.band)).toEqual([...SENTINEL_BANDS]);
    for (const dimension of RUBRIC_DIMENSIONS) {
      const anchors = getSentinelAnchorsForDimension(dimension);
      expect(anchors.map((anchor) => anchor.band)).toEqual([4.5, 5.0, 6.0, 6.5, 7.5, 8.0]);
      expect(anchors.map((anchor) => anchor.tier)).toEqual(["low", "low", "mid", "mid", "high", "high"]);
      for (let i = 1; i < anchors.length; i++) {
        expect(anchors[i]!.thetaAnchor).toBeGreaterThan(anchors[i - 1]!.thetaAnchor);
      }
    }
    for (const essay of SENTINEL_ANCHOR_ESSAYS) {
      expect(detectTemplatePadding(essay.text).isTemplatePadded).toBe(false);
    }
  });

  it("flags template-padded expansions while keeping concise and equal-length substantive essays clean", () => {
    expect(ANTI_PADDING_COUNTERFACTUAL_TRIPLETS.length).toBeGreaterThanOrEqual(2);
    for (const triplet of ANTI_PADDING_COUNTERFACTUAL_TRIPLETS) {
      const concise = detectTemplatePadding(triplet.substantiveConcise);
      const padded = detectTemplatePadding(triplet.templatePaddedExpansion);
      const substantive = detectTemplatePadding(triplet.equalLengthSubstantive);

      expect(concise.isTemplatePadded).toBe(false);
      expect(substantive.isTemplatePadded).toBe(false);
      expect(padded.isTemplatePadded).toBe(true);
      expect(padded.clicheHits.length).toBeGreaterThanOrEqual(4);
      expect(padded.wordCount).toBeGreaterThan(concise.wordCount * 1.5);
      expect(Math.abs(padded.wordCount - substantive.wordCount)).toBeLessThanOrEqual(40);
    }
  });
});

describe("AnchorCalibratedRubricV1 pairwise swap, monotonicity & mastery gates", () => {
  it("projects consistent monotone pairwise verdicts onto fixed Bradley-Terry anchors including boundary cases", () => {
    const cleanText = SENTINEL_ANCHOR_ESSAYS[2]!.text;
    for (const targetBand of [4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5]) {
      const result = evaluateAnchorCalibratedRubric({
        submissionId: `sub-${targetBand}`,
        dimension: "task_response",
        text: cleanText,
        mode: "formal_assessment",
        assisted: false,
        comparisons: consistentComparisonsForTarget("task_response", targetBand),
      });

      expect(result.status).toBe("calibrated");
      expect(result.band).toBe(targetBand);
      expect(result.rawBand).not.toBeNull();
      expect(result.theta).not.toBeNull();
      expect(result.rawBand!).toBeGreaterThanOrEqual(result.bandRange[0]);
      expect(result.rawBand!).toBeLessThanOrEqual(result.bandRange[1]);
      expect(result.countsTowardMastery).toBe(true);
      expect(result.inconsistencyReasons).toEqual([]);
    }
  });

  it("fails closed to interval_only without fabricating a band on forward/reverse swap contradiction", () => {
    const anchors = getSentinelAnchorsForDimension("coherence_cohesion");
    const comparisons: PairwiseSwapComparison[] = anchors.map((anchor) => {
      if (anchor.band === 6.0) {
        // Position bias: both forward and reverse pick option A.
        return { anchorId: anchor.anchorId, forwardChoice: "A", reverseChoice: "A" };
      }
      return anchor.band < 6.0
        ? { anchorId: anchor.anchorId, forwardChoice: "A", reverseChoice: "B" }
        : { anchorId: anchor.anchorId, forwardChoice: "B", reverseChoice: "A" };
    });

    const result = evaluateAnchorCalibratedRubric({
      submissionId: "swap-contradiction",
      dimension: "coherence_cohesion",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      comparisons,
    });

    expect(result.status).toBe("interval_only");
    expect(result.band).toBeNull();
    expect(result.rawBand).toBeNull();
    expect(result.theta).toBeNull();
    expect(result.bandRange).toEqual([5.0, 6.5]);
    expect(result.countsTowardMastery).toBe(false);
    expect(result.inconsistencyReasons).toContain("swap_position_bias_first");
    expect(result.masteryExclusionReasons).toContain("interval_only_inconsistent");
  });

  it("fails closed to interval_only on non-adjacent monotonicity inversion or missing reverse judgment", () => {
    const anchors = getSentinelAnchorsForDimension("lexical_resource");
    // Beats 4.5, loses to 5.0/6.0/6.5, yet beats 7.5 and loses to 8.0.
    const nonMonotone: PairwiseSwapComparison[] = [
      { anchorId: anchors[0]!.anchorId, forwardChoice: "A", reverseChoice: "B" },
      { anchorId: anchors[1]!.anchorId, forwardChoice: "B", reverseChoice: "A" },
      { anchorId: anchors[2]!.anchorId, forwardChoice: "B", reverseChoice: "A" },
      { anchorId: anchors[3]!.anchorId, forwardChoice: "B", reverseChoice: "A" },
      { anchorId: anchors[4]!.anchorId, forwardChoice: "A", reverseChoice: "B" },
      { anchorId: anchors[5]!.anchorId, forwardChoice: "B", reverseChoice: "A" },
    ];

    const monoResult = evaluateAnchorCalibratedRubric({
      submissionId: "non-monotone",
      dimension: "lexical_resource",
      text: SENTINEL_ANCHOR_ESSAYS[3]!.text,
      mode: "formal_assessment",
      assisted: false,
      comparisons: nonMonotone,
    });

    expect(monoResult.status).toBe("interval_only");
    expect(monoResult.band).toBeNull();
    expect(monoResult.bandRange).toEqual([4.5, 8.0]);
    expect(monoResult.countsTowardMastery).toBe(false);
    expect(monoResult.inconsistencyReasons).toContain("non_adjacent_monotonicity_violation");

    const missingReverse = evaluateAnchorCalibratedRubric({
      submissionId: "missing-reverse",
      dimension: "lexical_resource",
      text: SENTINEL_ANCHOR_ESSAYS[3]!.text,
      mode: "formal_assessment",
      assisted: false,
      comparisons: consistentComparisonsForTarget("lexical_resource", 6.5).map((item, index) =>
        index === 2 ? { anchorId: item.anchorId, forwardChoice: item.forwardChoice } : item,
      ),
    });

    expect(missingReverse.status).toBe("interval_only");
    expect(missingReverse.band).toBeNull();
    expect(missingReverse.countsTowardMastery).toBe(false);
    expect(missingReverse.inconsistencyReasons).toContain("missing_reverse_comparison");
  });

  it("excludes duplicate anchor comparisons from narrowing bandRange and rejects invalid runtime choices", () => {
    const anchors = getSentinelAnchorsForDimension("task_response");
    const duplicateBase = consistentComparisonsForTarget("task_response", 6.25);
    // Anchor 6.0 appears twice with conflicting verdicts (win then loss); bracket must stay [5.0, 6.5], not [6.0, 6.5].
    const duplicated = [
      ...duplicateBase,
      { anchorId: anchors[2]!.anchorId, forwardChoice: "B" as const, reverseChoice: "A" as const },
    ];

    const dupResult = evaluateAnchorCalibratedRubric({
      submissionId: "dup-anchor",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      comparisons: duplicated,
    });
    expect(dupResult.status).toBe("interval_only");
    expect(dupResult.band).toBeNull();
    expect(dupResult.countsTowardMastery).toBe(false);
    expect(dupResult.bandRange).toEqual([5.0, 6.5]);
    expect(dupResult.inconsistencyReasons).toContain("duplicate_anchor_comparison");

    const invalidChoiceValue = "unexpected" as unknown as PairwiseSwapComparison["forwardChoice"];
    const invalidChoiceResult = evaluateAnchorCalibratedRubric({
      submissionId: "invalid-choice",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      comparisons: duplicateBase.map((item, idx) =>
        idx === 2 ? { anchorId: item.anchorId, forwardChoice: invalidChoiceValue, reverseChoice: "tie" } : item,
      ),
    });
    expect(invalidChoiceResult.status).toBe("interval_only");
    expect(invalidChoiceResult.band).toBeNull();
    expect(invalidChoiceResult.countsTowardMastery).toBe(false);
    expect(invalidChoiceResult.inconsistencyReasons).toContain("invalid_comparison_choice");
  });

  it("fails closed on invalid custom anchors (duplicate IDs, NaN theta, non-monotone order) and repeated single-phrase boilerplate", () => {
    const baseAnchors = getSentinelAnchorsForDimension("task_response");
    const duplicateAnchors = [
      baseAnchors[0]!,
      { ...baseAnchors[1]!, anchorId: baseAnchors[0]!.anchorId },
      ...baseAnchors.slice(2),
    ];
    const dupAnchorResult = evaluateAnchorCalibratedRubric({
      submissionId: "bad-anchors-dup",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      anchors: duplicateAnchors,
      comparisons: consistentComparisonsForTarget("task_response", 6.0),
    });
    expect(dupAnchorResult.status).toBe("interval_only");
    expect(dupAnchorResult.band).toBeNull();
    expect(dupAnchorResult.rawBand).toBeNull();
    expect(dupAnchorResult.theta).toBeNull();
    expect(dupAnchorResult.bandRange).toEqual([0, 9]);
    expect(dupAnchorResult.countsTowardMastery).toBe(false);
    expect(dupAnchorResult.inconsistencyReasons).toEqual(["invalid_anchor_definitions"]);

    const nanThetaAnchors = baseAnchors.map((a, idx) =>
      idx === 1 ? { ...a, thetaAnchor: Number.NaN } : a,
    );
    const nanAnchorResult = evaluateAnchorCalibratedRubric({
      submissionId: "bad-anchors-nan",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      anchors: nanThetaAnchors,
      comparisons: consistentComparisonsForTarget("task_response", 6.0),
    });
    expect(nanAnchorResult.status).toBe("interval_only");
    expect(nanAnchorResult.band).toBeNull();
    expect(nanAnchorResult.countsTowardMastery).toBe(false);
    expect(nanAnchorResult.inconsistencyReasons).toEqual(["invalid_anchor_definitions"]);

    const reversedAnchors = baseAnchors.map((a, idx) =>
      idx === 2 ? { ...a, thetaAnchor: baseAnchors[1]!.thetaAnchor - 1 } : a,
    );
    const reversedResult = evaluateAnchorCalibratedRubric({
      submissionId: "bad-anchors-order",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      anchors: reversedAnchors,
      comparisons: consistentComparisonsForTarget("task_response", 6.0),
    });
    expect(reversedResult.status).toBe("interval_only");
    expect(reversedResult.countsTowardMastery).toBe(false);
    expect(reversedResult.inconsistencyReasons).toEqual(["invalid_anchor_definitions"]);

    // Equal (band, thetaAnchor) anchors must fail closed in either input order.
    const anchorA = { ...baseAnchors[2]!, anchorId: "tied-anchor-a", band: 6.0 as const, thetaAnchor: -1.0 };
    const anchorB = { ...baseAnchors[2]!, anchorId: "tied-anchor-b", band: 6.0 as const, thetaAnchor: -1.0 };
    for (const tiedPair of [
      [baseAnchors[0]!, anchorA, anchorB, baseAnchors[5]!],
      [baseAnchors[0]!, anchorB, anchorA, baseAnchors[5]!],
    ]) {
      const tiedResult = evaluateAnchorCalibratedRubric({
        submissionId: "bad-anchors-tied-band",
        dimension: "task_response",
        text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
        mode: "formal_assessment",
        assisted: false,
        anchors: tiedPair,
        comparisons: [
          { anchorId: baseAnchors[0]!.anchorId, forwardChoice: "A", reverseChoice: "B" },
          { anchorId: anchorA.anchorId, forwardChoice: "A", reverseChoice: "B" },
          { anchorId: anchorB.anchorId, forwardChoice: "B", reverseChoice: "A" },
          { anchorId: baseAnchors[5]!.anchorId, forwardChoice: "B", reverseChoice: "A" },
        ],
      });
      expect(tiedResult.status).toBe("interval_only");
      expect(tiedResult.band).toBeNull();
      expect(tiedResult.bandRange).toEqual([0, 9]);
      expect(tiedResult.countsTowardMastery).toBe(false);
      expect(tiedResult.inconsistencyReasons).toEqual(["invalid_anchor_definitions"]);
    }

    // Repeated single cliche phrase across essay must trigger template padding.
    const repeatedSingleCliche =
      "Every coin has two sides when cities evaluate transit subsidies. " +
      "Outer commuters need reliable feeder buses and affordable fares. " +
      "Every coin has two sides in municipal transport planning.";
    const repeatedEval = evaluateAnchorCalibratedRubric({
      submissionId: "repeated-cliche",
      dimension: "task_response",
      text: repeatedSingleCliche,
      mode: "formal_assessment",
      assisted: false,
      comparisons: consistentComparisonsForTarget("task_response", 6.0),
    });
    expect(repeatedEval.paddingReport.clicheHits).toEqual(["every coin has two sides"]);
    expect(repeatedEval.paddingReport.totalClicheOccurrences).toBe(2);
    expect(repeatedEval.paddingReport.isTemplatePadded).toBe(true);
    expect(repeatedEval.countsTowardMastery).toBe(false);
    expect(repeatedEval.masteryExclusionReasons).toContain("template_padding_detected");

    // High boilerplate word coverage (>= 0.20) from even a single phrase occurrence.
    const shortBoilerplate = detectTemplatePadding("In light of the aforementioned considerations, policy choices matter.");
    expect(shortBoilerplate.clicheWordRatio).toBeGreaterThanOrEqual(0.20);
    expect(shortBoilerplate.isTemplatePadded).toBe(true);

    // Word-boundary matching: "undeniable factual" must NOT falsely match "undeniable fact".
    const cleanFactual = detectTemplatePadding(
      "The report identifies undeniable factual errors and undeniable factual discrepancies in municipal budget projections.",
    );
    expect(cleanFactual.clicheHits).toEqual([]);
    expect(cleanFactual.totalClicheOccurrences).toBe(0);
    expect(cleanFactual.isTemplatePadded).toBe(false);

    // Out-of-range custom thetaAnchor (e.g. 100 / 101) fails closed and never projects outside evidence bracket.
    const extremeThetaAnchors = [
      { ...baseAnchors[0]!, anchorId: "ext-45", band: 4.5 as const, thetaAnchor: 100 },
      { ...baseAnchors[1]!, anchorId: "ext-50", band: 5.0 as const, thetaAnchor: 101 },
    ];
    const extremeThetaRes = evaluateAnchorCalibratedRubric({
      submissionId: "extreme-theta",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      anchors: extremeThetaAnchors,
      comparisons: [
        { anchorId: "ext-45", forwardChoice: "A", reverseChoice: "B" },
        { anchorId: "ext-50", forwardChoice: "B", reverseChoice: "A" },
      ],
    });
    expect(extremeThetaRes.status).toBe("interval_only");
    expect(extremeThetaRes.band).toBeNull();
    expect(extremeThetaRes.countsTowardMastery).toBe(false);
    expect(extremeThetaRes.inconsistencyReasons).toEqual(["invalid_anchor_definitions"]);

    // Valid custom scale anchors project strictly within the [4.5, 5.0] evidence bracket.
    const customScaleAnchors = [
      { ...baseAnchors[0]!, anchorId: "cs-45", band: 4.5 as const, thetaAnchor: 0 },
      { ...baseAnchors[1]!, anchorId: "cs-50", band: 5.0 as const, thetaAnchor: 1 },
    ];
    const customScaleRes = evaluateAnchorCalibratedRubric({
      submissionId: "custom-scale-ok",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      anchors: customScaleAnchors,
      comparisons: [
        { anchorId: "cs-45", forwardChoice: "A", reverseChoice: "B" },
        { anchorId: "cs-50", forwardChoice: "B", reverseChoice: "A" },
      ],
    });
    expect(customScaleRes.status).toBe("calibrated");
    expect(customScaleRes.rawBand!).toBeGreaterThanOrEqual(4.5);
    expect(customScaleRes.rawBand!).toBeLessThanOrEqual(5.0);
    expect(customScaleRes.band!).toBeGreaterThanOrEqual(4.5);
    expect(customScaleRes.band!).toBeLessThanOrEqual(5.0);
  });

  it("blocks mastery updates for practice_feedback, assisted submissions, and template-padded essays", () => {
    const comparisons = consistentComparisonsForTarget("grammatical_range_accuracy", 6.5);
    const cleanText = SENTINEL_ANCHOR_ESSAYS[3]!.text;
    const paddedText = ANTI_PADDING_COUNTERFACTUAL_TRIPLETS[0]!.templatePaddedExpansion;

    const practiceResult = evaluateAnchorCalibratedRubric({
      submissionId: "practice-1",
      dimension: "grammatical_range_accuracy",
      text: cleanText,
      mode: "practice_feedback",
      assisted: false,
      comparisons,
    });
    expect(practiceResult.status).toBe("calibrated");
    expect(practiceResult.countsTowardMastery).toBe(false);
    expect(practiceResult.masteryExclusionReasons).toEqual(["practice_feedback_only"]);

    const assistedResult = evaluateAnchorCalibratedRubric({
      submissionId: "assisted-1",
      dimension: "grammatical_range_accuracy",
      text: cleanText,
      mode: "formal_assessment",
      assisted: true,
      comparisons,
    });
    expect(assistedResult.status).toBe("calibrated");
    expect(assistedResult.countsTowardMastery).toBe(false);
    expect(assistedResult.masteryExclusionReasons).toEqual(["assisted_submission"]);

    const paddedResult = evaluateAnchorCalibratedRubric({
      submissionId: "padded-1",
      dimension: "grammatical_range_accuracy",
      text: paddedText,
      mode: "formal_assessment",
      assisted: false,
      comparisons,
    });
    expect(paddedResult.status).toBe("calibrated");
    expect(paddedResult.paddingReport.isTemplatePadded).toBe(true);
    expect(paddedResult.countsTowardMastery).toBe(false);
    expect(paddedResult.masteryExclusionReasons).toEqual(["template_padding_detected"]);
  });
});

describe("evaluateRubricCalibrationGate four-fold & 3-way anti-padding gate", () => {
  const passingCounterfactuals = [
    {
      tripletId: ANTI_PADDING_COUNTERFACTUAL_TRIPLETS[0]!.tripletId,
      substantiveConcise: calibratedPoint(6.0, 6.0),
      templatePaddedExpansion: calibratedPoint(6.0, 6.1, false),
      equalLengthSubstantive: calibratedPoint(7.5, 7.5),
    },
  ];

  it("rejects mean-compressed predictions with QWK > 0.78 and SMD = 0 via biasLow = +0.75 and biasHigh = -0.75", () => {
    const trueBands = [4.5, 5.0, 6.0, 6.5, 7.5, 8.0];
    const predBands = [5.5, 5.5, 6.0, 6.5, 7.0, 7.0];

    expect(computeQuadraticWeightedKappa(trueBands, predBands)).toBeCloseTo(37 / 47, 6);

    const report = evaluateRubricCalibrationGate({
      benchmarkItems: trueBands.map((trueBand, index) => ({
        itemId: `gold-${index}`,
        trueBand,
        evaluation: calibratedPoint(predBands[index]!),
      })),
      counterfactualTriplets: passingCounterfactuals,
    });

    expect(report.metrics.qwk).toBeGreaterThan(0.78);
    expect(report.metrics.smd).toBeCloseTo(0, 10);
    expect(report.metrics.biasLow).toBeCloseTo(0.75, 10);
    expect(report.metrics.biasHigh).toBeCloseTo(-0.75, 10);
    expect(report.metrics.sdRatio).toBeLessThan(0.75);
    expect(report.passed).toBe(false);
    expect(report.failures).toContain("low_tail_bias_exceeds_threshold");
    expect(report.failures).toContain("high_tail_bias_exceeds_threshold");
    expect(report.failures).toContain("sd_ratio_compression_detected");
  });

  it("passes a well-calibrated benchmark with clean anti-padding counterfactuals", () => {
    const benchmark = [
      { itemId: "g1", trueBand: 4.5, evaluation: calibratedPoint(4.5) },
      { itemId: "g2", trueBand: 5.0, evaluation: calibratedPoint(5.0) },
      { itemId: "g3", trueBand: 6.0, evaluation: calibratedPoint(6.0) },
      { itemId: "g4", trueBand: 6.5, evaluation: calibratedPoint(6.5) },
      { itemId: "g5", trueBand: 7.5, evaluation: calibratedPoint(7.5) },
      { itemId: "g6", trueBand: 8.0, evaluation: calibratedPoint(8.0) },
    ];

    const report = evaluateRubricCalibrationGate({
      benchmarkItems: benchmark,
      counterfactualTriplets: passingCounterfactuals,
    });

    expect(report.passed).toBe(true);
    expect(report.metrics.qwk).toBeCloseTo(1, 10);
    expect(report.metrics.smd).toBeCloseTo(0, 10);
    expect(report.metrics.biasLow).toBeCloseTo(0, 10);
    expect(report.metrics.biasHigh).toBeCloseTo(0, 10);
    expect(report.metrics.sdRatio).toBeCloseTo(1, 10);
    expect(report.metrics.admissibleCoverage).toBe(1);
    expect(report.failures).toEqual([]);
  });

  it("fails closed when tails are empty, admissible coverage is below 0.85, or anti-padding counterfactuals fail", () => {
    const emptyTails = evaluateRubricCalibrationGate({
      benchmarkItems: [
        { itemId: "m1", trueBand: 6.0, evaluation: calibratedPoint(6.0) },
        { itemId: "m2", trueBand: 6.5, evaluation: calibratedPoint(6.5) },
      ],
      counterfactualTriplets: passingCounterfactuals,
    });
    expect(emptyTails.passed).toBe(false);
    expect(emptyTails.failures).toContain("missing_low_tail_samples");
    expect(emptyTails.failures).toContain("missing_high_tail_samples");

    const intervalOnly: RubricCalibrationPoint = {
      status: "interval_only",
      band: null,
      rawBand: null,
      countsTowardMastery: false,
    };
    const lowCoverage = evaluateRubricCalibrationGate({
      benchmarkItems: [
        { itemId: "c1", trueBand: 4.5, evaluation: calibratedPoint(4.5) },
        { itemId: "c2", trueBand: 6.0, evaluation: calibratedPoint(6.0) },
        { itemId: "c3", trueBand: 8.0, evaluation: calibratedPoint(8.0) },
        { itemId: "c4", trueBand: 6.5, evaluation: intervalOnly },
      ],
      counterfactualTriplets: passingCounterfactuals,
    });
    expect(lowCoverage.passed).toBe(false);
    expect(lowCoverage.metrics.admissibleCoverage).toBe(0.75);
    expect(lowCoverage.failures).toContain("admissible_coverage_below_threshold");

    const paddingInflation = evaluateRubricCalibrationGate({
      benchmarkItems: [
        { itemId: "p1", trueBand: 4.5, evaluation: calibratedPoint(4.5) },
        { itemId: "p2", trueBand: 5.0, evaluation: calibratedPoint(5.0) },
        { itemId: "p3", trueBand: 6.0, evaluation: calibratedPoint(6.0) },
        { itemId: "p4", trueBand: 6.5, evaluation: calibratedPoint(6.5) },
        { itemId: "p5", trueBand: 7.5, evaluation: calibratedPoint(7.5) },
        { itemId: "p6", trueBand: 8.0, evaluation: calibratedPoint(8.0) },
      ],
      counterfactualTriplets: [
        {
          tripletId: "inflated-padding",
          substantiveConcise: calibratedPoint(6.0, 6.0),
          templatePaddedExpansion: calibratedPoint(6.5, 6.5, false),
          equalLengthSubstantive: calibratedPoint(6.5, 6.5),
        },
      ],
    });
    expect(paddingInflation.passed).toBe(false);
    expect(paddingInflation.failures).toContain("counterfactual_padding_gain_exceeds_limit");
    expect(paddingInflation.failures).toContain("counterfactual_padded_not_below_equal_length_substantive");

    const paddedCountsForMastery = evaluateRubricCalibrationGate({
      benchmarkItems: [
        { itemId: "m1", trueBand: 4.5, evaluation: calibratedPoint(4.5) },
        { itemId: "m2", trueBand: 5.0, evaluation: calibratedPoint(5.0) },
        { itemId: "m3", trueBand: 6.0, evaluation: calibratedPoint(6.0) },
        { itemId: "m4", trueBand: 6.5, evaluation: calibratedPoint(6.5) },
        { itemId: "m5", trueBand: 7.5, evaluation: calibratedPoint(7.5) },
        { itemId: "m6", trueBand: 8.0, evaluation: calibratedPoint(8.0) },
      ],
      counterfactualTriplets: [
        {
          tripletId: "mastery-leak-padded",
          substantiveConcise: calibratedPoint(6.0, 6.0),
          templatePaddedExpansion: calibratedPoint(6.0, 6.1, true),
          equalLengthSubstantive: calibratedPoint(7.5, 7.5),
        },
      ],
    });
    expect(paddedCountsForMastery.passed).toBe(false);
    expect(paddedCountsForMastery.failures).toContain("counterfactual_padded_counts_toward_mastery");
    expect(paddedCountsForMastery.counterfactualAudits[0]!.passed).toBe(false);

    // Runtime undefined countsTowardMastery must also fail closed (!== false).
    const undefinedMasteryPoint = {
      status: "calibrated",
      band: 6.0,
      rawBand: 6.0,
      countsTowardMastery: undefined,
    } as unknown as RubricCalibrationPoint;
    const missingMasteryFlag = evaluateRubricCalibrationGate({
      benchmarkItems: [
        { itemId: "u1", trueBand: 4.5, evaluation: calibratedPoint(4.5) },
        { itemId: "u2", trueBand: 5.0, evaluation: calibratedPoint(5.0) },
        { itemId: "u3", trueBand: 6.0, evaluation: calibratedPoint(6.0) },
        { itemId: "u4", trueBand: 6.5, evaluation: calibratedPoint(6.5) },
        { itemId: "u5", trueBand: 7.5, evaluation: calibratedPoint(7.5) },
        { itemId: "u6", trueBand: 8.0, evaluation: calibratedPoint(8.0) },
      ],
      counterfactualTriplets: [
        {
          tripletId: "undefined-mastery-flag",
          substantiveConcise: calibratedPoint(6.0, 6.0),
          templatePaddedExpansion: undefinedMasteryPoint,
          equalLengthSubstantive: calibratedPoint(7.5, 7.5),
        },
      ],
    });
    expect(missingMasteryFlag.passed).toBe(false);
    expect(missingMasteryFlag.failures).toContain("counterfactual_padded_counts_toward_mastery");
  });

  it("enforces tightening-only thresholds and rejects non-finite threshold overrides", () => {
    const trueBands = [4.5, 5.0, 6.0, 6.5, 7.5, 8.0];
    const compressedPreds = [5.5, 5.5, 6.0, 6.5, 7.0, 7.0];

    // Attempting to relax thresholds MUST NOT let a mean-compressed scorer pass.
    const relaxedAttempt = evaluateRubricCalibrationGate({
      benchmarkItems: trueBands.map((trueBand, index) => ({
        itemId: `rel-${index}`,
        trueBand,
        evaluation: calibratedPoint(compressedPreds[index]!),
      })),
      counterfactualTriplets: passingCounterfactuals,
      thresholds: {
        minQwk: 0.1,
        maxAbsSmd: 2.0,
        maxAbsBiasLow: 1.0,
        maxAbsBiasHigh: 1.0,
        minSdRatio: 0,
        minAdmissibleCoverage: 0.1,
        maxPaddingGain: 3.0,
      },
    });
    expect(relaxedAttempt.passed).toBe(false);
    expect(relaxedAttempt.failures).toContain("low_tail_bias_exceeds_threshold");
    expect(relaxedAttempt.failures).toContain("high_tail_bias_exceeds_threshold");
    expect(relaxedAttempt.failures).toContain("sd_ratio_compression_detected");

    // Non-finite threshold override fails closed with invalid_threshold_configuration.
    const nanThreshold = evaluateRubricCalibrationGate({
      benchmarkItems: trueBands.map((trueBand, index) => ({
        itemId: `nan-${index}`,
        trueBand,
        evaluation: calibratedPoint(trueBand),
      })),
      counterfactualTriplets: passingCounterfactuals,
      thresholds: { minQwk: Number.NaN },
    });
    expect(nanThreshold.passed).toBe(false);
    expect(nanThreshold.failures).toContain("invalid_threshold_configuration");

    // Narrowing lowTailMaxBand to 4.5 must NOT hide a +0.50 bias in the default <= 5.0 tail.
    const hiddenTailErrorPreds = [4.5, 6.0, 5.0, 6.5, 7.5, 8.0];
    const hiddenTailAttempt = evaluateRubricCalibrationGate({
      benchmarkItems: trueBands.map((trueBand, index) => ({
        itemId: `tail-${index}`,
        trueBand,
        evaluation: calibratedPoint(hiddenTailErrorPreds[index]!),
      })),
      counterfactualTriplets: passingCounterfactuals,
      thresholds: { lowTailMaxBand: 4.5 },
    });
    expect(hiddenTailAttempt.passed).toBe(false);
    expect(hiddenTailAttempt.metrics.biasLow).toBeCloseTo(0.5, 10);
    expect(hiddenTailAttempt.failures).toContain("low_tail_bias_exceeds_threshold");
  });
});
