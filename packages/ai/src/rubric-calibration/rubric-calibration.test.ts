import { describe, expect, it } from "vitest";
import {
  ANTI_PADDING_COUNTERFACTUAL_TRIPLETS,
  DEFAULT_CALIBRATION_THRESHOLDS,
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
  it("projects consistent monotone pairwise verdicts onto fixed Bradley-Terry anchors and requires independent corroboration for mastery", () => {
    const cleanText = SENTINEL_ANCHOR_ESSAYS[2]!.text;
    for (const targetBand of [4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5]) {
      // Standalone single formal_assessment draft calibrates band but MUST NOT count toward mastery.
      const singleDraft = evaluateAnchorCalibratedRubric({
        submissionId: `sub-${targetBand}`,
        dimension: "task_response",
        text: cleanText,
        mode: "formal_assessment",
        assisted: false,
        comparisons: consistentComparisonsForTarget("task_response", targetBand),
      });

      expect(singleDraft.status).toBe("calibrated");
      expect(singleDraft.band).toBe(targetBand);
      expect(singleDraft.rawBand).not.toBeNull();
      expect(singleDraft.theta).not.toBeNull();
      expect(singleDraft.rawBand!).toBeGreaterThanOrEqual(singleDraft.bandRange[0]);
      expect(singleDraft.rawBand!).toBeLessThanOrEqual(singleDraft.bandRange[1]);
      expect(singleDraft.countsTowardMastery).toBe(false);
      expect(singleDraft.masteryExclusionReasons).toEqual(["single_draft_uncorroborated"]);
      expect(singleDraft.inconsistencyReasons).toEqual([]);

      // Corroborated formal_assessment (>= 2 distinct independent submission IDs) counts toward mastery.
      const corroborated = evaluateAnchorCalibratedRubric({
        submissionId: `sub-${targetBand}`,
        dimension: "task_response",
        text: cleanText,
        mode: "formal_assessment",
        assisted: false,
        comparisons: consistentComparisonsForTarget("task_response", targetBand),
        corroboratingIndependentSubmissionIds: ["sub-independent-2"],
      });

      expect(corroborated.status).toBe("calibrated");
      expect(corroborated.band).toBe(targetBand);
      expect(corroborated.countsTowardMastery).toBe(true);
      expect(corroborated.masteryExclusionReasons).toEqual([]);
      expect(corroborated.inconsistencyReasons).toEqual([]);
    }

    // Empty, self-only, or whitespace plain corroboration lists calibrate normally but MUST NOT unlock mastery.
    for (const invalidCorrob of [[], ["sub-self"], ["   "], ["sub-independent-2", ""]]) {
      const res = evaluateAnchorCalibratedRubric({
        submissionId: "sub-self",
        dimension: "task_response",
        text: cleanText,
        mode: "formal_assessment",
        assisted: false,
        comparisons: consistentComparisonsForTarget("task_response", 6.5),
        corroboratingIndependentSubmissionIds: invalidCorrob,
      });
      expect(res.status).toBe("calibrated");
      expect(res.countsTowardMastery).toBe(false);
      expect(res.masteryExclusionReasons).toEqual(["single_draft_uncorroborated"]);
    }

    // Round-13 [P1-1]: Getter or Proxy on corroboratingIndependentSubmissionIds or outer input/submissionId
    // MUST fail closed with ZERO getter executions and zero second-read TOCTOU.
    let corrobGetterRuns = 0;
    const getterCorrobIds = Object.defineProperty([] as string[], "0", {
      enumerable: true,
      get() {
        corrobGetterRuns += 1;
        return "sub-independent-2";
      },
    });
    const getterCorrobRes = evaluateAnchorCalibratedRubric({
      submissionId: "sub-self",
      dimension: "task_response",
      text: cleanText,
      mode: "formal_assessment",
      assisted: false,
      comparisons: consistentComparisonsForTarget("task_response", 6.5),
      corroboratingIndependentSubmissionIds: getterCorrobIds,
    });
    expect(corrobGetterRuns).toBe(0);
    expect(getterCorrobRes.status).toBe("interval_only");
    expect(getterCorrobRes.countsTowardMastery).toBe(false);
    expect(getterCorrobRes.inconsistencyReasons).toEqual(["invalid_submission_input"]);

    const proxyCorrobRes = evaluateAnchorCalibratedRubric({
      submissionId: "sub-self",
      dimension: "task_response",
      text: cleanText,
      mode: "formal_assessment",
      assisted: false,
      comparisons: consistentComparisonsForTarget("task_response", 6.5),
      corroboratingIndependentSubmissionIds: new Proxy(["sub-independent-2"], {}),
    });
    expect(proxyCorrobRes.status).toBe("interval_only");
    expect(proxyCorrobRes.countsTowardMastery).toBe(false);
    expect(proxyCorrobRes.inconsistencyReasons).toEqual(["invalid_submission_input"]);

    // Outer getter on corroboratingIndependentSubmissionIds or stateful Proxy flipping submissionId across reads.
    let outerCorrobGetterRuns = 0;
    const outerGetterInput = {
      submissionId: "sub-A",
      dimension: "task_response" as const,
      text: cleanText,
      mode: "formal_assessment" as const,
      assisted: false,
      comparisons: consistentComparisonsForTarget("task_response", 6.5),
    };
    Object.defineProperty(outerGetterInput, "corroboratingIndependentSubmissionIds", {
      enumerable: true,
      get() {
        outerCorrobGetterRuns += 1;
        return ["sub-B"];
      },
    });
    const outerGetterRes = evaluateAnchorCalibratedRubric(outerGetterInput);
    expect(outerCorrobGetterRuns).toBe(0);
    expect(outerGetterRes.status).toBe("interval_only");
    expect(outerGetterRes.countsTowardMastery).toBe(false);
    expect(outerGetterRes.inconsistencyReasons).toEqual(["invalid_submission_input"]);

    let submissionIdReads = 0;
    const toctouSubmissionProxy = new Proxy(
      {
        submissionId: "sub-A",
        dimension: "task_response" as const,
        text: cleanText,
        mode: "formal_assessment" as const,
        assisted: false,
        comparisons: consistentComparisonsForTarget("task_response", 6.5),
        corroboratingIndependentSubmissionIds: ["sub-B"],
      },
      {
        getOwnPropertyDescriptor(target, prop) {
          if (prop === "submissionId") {
            submissionIdReads += 1;
            return {
              value: submissionIdReads === 1 ? "sub-A" : "sub-B",
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      },
    );
    const toctouRes = evaluateAnchorCalibratedRubric(toctouSubmissionProxy);
    expect(submissionIdReads).toBe(1);
    expect(toctouRes.status).toBe("interval_only");
    expect(toctouRes.countsTowardMastery).toBe(false);
    expect(toctouRes.inconsistencyReasons).toEqual(["invalid_submission_input"]);

    // Round-14 [P1-1]: Self-detaching nested Proxy on corroboratingIndependentSubmissionIds that
    // mutates its parent to detach itself AND installs an ancestor getter MUST still fail closed
    // via reverse-pre-order structuredClone with ZERO ancestor getter executions.
    let ancestorGetterRuns = 0;
    const detachParent: {
      submissionId: string;
      dimension: "task_response";
      text: string;
      mode: "formal_assessment";
      assisted: boolean;
      comparisons: ReturnType<typeof consistentComparisonsForTarget>;
      corroboratingIndependentSubmissionIds: string[];
    } = {
      submissionId: "sub-self",
      dimension: "task_response",
      text: cleanText,
      mode: "formal_assessment",
      assisted: false,
      comparisons: consistentComparisonsForTarget("task_response", 6.5),
      corroboratingIndependentSubmissionIds: [],
    };
    let detachedOnce = false;
    detachParent.corroboratingIndependentSubmissionIds = new Proxy(["sub-fake-independent"], {
      getOwnPropertyDescriptor(target, prop) {
        if (!detachedOnce && prop === "0") {
          detachedOnce = true;
          detachParent.corroboratingIndependentSubmissionIds = [];
          Object.defineProperty(detachParent, "injectedTrap", {
            enumerable: true,
            configurable: true,
            get() {
              ancestorGetterRuns += 1;
              return "should-never-run";
            },
          });
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    const detachRes = evaluateAnchorCalibratedRubric(detachParent);
    expect(ancestorGetterRuns).toBe(0);
    expect(detachRes.status).toBe("interval_only");
    expect(detachRes.countsTowardMastery).toBe(false);
    expect(detachRes.inconsistencyReasons).toEqual(["invalid_submission_input"]);
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

    // Word-boundary matching: "undeniable factual" and NFKC ligature "Ofﬁce" must NOT false-positive.
    const cleanFactual = detectTemplatePadding(
      "The report identifies undeniable factual errors and undeniable factual discrepancies in municipal budget projections.",
    );
    expect(cleanFactual.clicheHits).toEqual([]);
    expect(cleanFactual.totalClicheOccurrences).toBe(0);
    expect(cleanFactual.isTemplatePadded).toBe(false);

    const ligatureText = detectTemplatePadding(
      "Since the Dawn Of\uFB01ce opened downtown, commuters reported shorter bus delays.",
    );
    expect(ligatureText.clicheHits).toEqual([]);
    expect(ligatureText.totalClicheOccurrences).toBe(0);
    expect(ligatureText.isTemplatePadded).toBe(false);

    // Astral Unicode letter surrogate pairs (Deseret U+10400) must not create false word boundaries.
    const astralLetterText = detectTemplatePadding(
      "\uD801\uDC00needless to say\uD801\uDC00 appears inside an astral word token.",
    );
    expect(astralLetterText.clicheHits).toEqual([]);
    expect(astralLetterText.totalClicheOccurrences).toBe(0);
    expect(astralLetterText.isTemplatePadded).toBe(false);

    // Sub-0.5-band spacing ([4.10, 4.20]) is rejected up front as invalid_anchor_definitions.
    const subHalfBandAnchors = [
      { ...baseAnchors[0]!, anchorId: "nar-410", band: 4.1 as unknown as (typeof baseAnchors)[0]["band"], thetaAnchor: -1 },
      { ...baseAnchors[1]!, anchorId: "nar-420", band: 4.2 as unknown as (typeof baseAnchors)[1]["band"], thetaAnchor: 1 },
    ];
    const subHalfBandRes = evaluateAnchorCalibratedRubric({
      submissionId: "sub-half-band-anchors",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      anchors: subHalfBandAnchors,
      comparisons: [
        { anchorId: "nar-410", forwardChoice: "A", reverseChoice: "B" },
        { anchorId: "nar-420", forwardChoice: "B", reverseChoice: "A" },
      ],
    });
    expect(subHalfBandRes.status).toBe("interval_only");
    expect(subHalfBandRes.band).toBeNull();
    expect(subHalfBandRes.countsTowardMastery).toBe(false);
    expect(subHalfBandRes.inconsistencyReasons).toEqual(["invalid_anchor_definitions"]);

    // Well-conditioned anchors ([4.10@-2, 4.60@0, 5.10@0.25, 5.60@0.5]) whose snapped band (4.0) escapes [4.10, 4.60]
    // still fail closed to interval_only with projection_outside_evidence_bracket.
    const narrowEscapeAnchors = [
      { ...baseAnchors[0]!, anchorId: "esc-410", band: 4.1 as unknown as (typeof baseAnchors)[0]["band"], thetaAnchor: -2 },
      { ...baseAnchors[1]!, anchorId: "esc-460", band: 4.6 as unknown as (typeof baseAnchors)[1]["band"], thetaAnchor: 0 },
      { ...baseAnchors[2]!, anchorId: "esc-510", band: 5.1 as unknown as (typeof baseAnchors)[2]["band"], thetaAnchor: 0.25 },
      { ...baseAnchors[3]!, anchorId: "esc-560", band: 5.6 as unknown as (typeof baseAnchors)[3]["band"], thetaAnchor: 0.5 },
    ];
    const narrowEscapeRes = evaluateAnchorCalibratedRubric({
      submissionId: "narrow-bracket-escape",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      anchors: narrowEscapeAnchors,
      comparisons: [
        { anchorId: "esc-410", forwardChoice: "A", reverseChoice: "B" },
        { anchorId: "esc-460", forwardChoice: "B", reverseChoice: "A" },
        { anchorId: "esc-510", forwardChoice: "B", reverseChoice: "A" },
        { anchorId: "esc-560", forwardChoice: "B", reverseChoice: "A" },
      ],
    });
    expect(narrowEscapeRes.status).toBe("interval_only");
    expect(narrowEscapeRes.band).toBeNull();
    expect(narrowEscapeRes.bandRange).toEqual([4.1, 4.6]);
    expect(narrowEscapeRes.countsTowardMastery).toBe(false);
    expect(narrowEscapeRes.inconsistencyReasons).toEqual(["projection_outside_evidence_bracket"]);

    // Round-9 [P1-3 Bug A]: Cross-dimension custom anchors (lexical_resource on task_response) fail closed.
    const lexicalAnchors = getSentinelAnchorsForDimension("lexical_resource");
    const crossDimRes = evaluateAnchorCalibratedRubric({
      submissionId: "cross-dim-anchors",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      anchors: lexicalAnchors,
      comparisons: consistentComparisonsForTarget("lexical_resource", 6.0),
    });
    expect(crossDimRes.status).toBe("interval_only");
    expect(crossDimRes.band).toBeNull();
    expect(crossDimRes.countsTowardMastery).toBe(false);
    expect(crossDimRes.inconsistencyReasons).toEqual(["invalid_anchor_definitions"]);

    // Round-9 [P1-3 Bug B]: Ill-conditioned theta gap [4.5@0, 5.0@1e-10] fails closed with invalid_anchor_definitions.
    const illConditionedAnchors = [
      { ...baseAnchors[0]!, anchorId: "ic-45", band: 4.5 as const, thetaAnchor: 0 },
      { ...baseAnchors[1]!, anchorId: "ic-50", band: 5.0 as const, thetaAnchor: 1e-10 },
    ];
    const illCondRes = evaluateAnchorCalibratedRubric({
      submissionId: "ill-conditioned-anchors",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
      mode: "formal_assessment",
      assisted: false,
      anchors: illConditionedAnchors,
      comparisons: [
        { anchorId: "ic-45", forwardChoice: "A", reverseChoice: "B" },
        { anchorId: "ic-50", forwardChoice: "A", reverseChoice: "B" },
      ],
    });
    expect(illCondRes.status).toBe("interval_only");
    expect(illCondRes.band).toBeNull();
    expect(illCondRes.countsTowardMastery).toBe(false);
    expect(illCondRes.inconsistencyReasons).toEqual(["invalid_anchor_definitions"]);

    // Round-9 [P1-3 Bug B]: Unanchored tail extrapolation (all wins above max anchor 5.0 -> open [5.0, 9.0] tail,
    // or all losses below min anchor 7.5 -> open [0, 7.5] tail) must NOT certify mastery.
    const lowOnlyAnchors = [
      { ...baseAnchors[0]!, anchorId: "lo-45", band: 4.5 as const, thetaAnchor: 0 },
      { ...baseAnchors[1]!, anchorId: "lo-50", band: 5.0 as const, thetaAnchor: 1 },
    ];
    const unanchoredHighTailRes = evaluateAnchorCalibratedRubric({
      submissionId: "unanchored-high-tail",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[5]!.text,
      mode: "formal_assessment",
      assisted: false,
      anchors: lowOnlyAnchors,
      comparisons: [
        { anchorId: "lo-45", forwardChoice: "A", reverseChoice: "B" },
        { anchorId: "lo-50", forwardChoice: "A", reverseChoice: "B" },
      ],
    });
    expect(unanchoredHighTailRes.status).toBe("interval_only");
    expect(unanchoredHighTailRes.band).toBeNull();
    expect(unanchoredHighTailRes.bandRange).toEqual([5.0, 9.0]);
    expect(unanchoredHighTailRes.countsTowardMastery).toBe(false);
    expect(unanchoredHighTailRes.inconsistencyReasons).toEqual(["unanchored_tail_extrapolation"]);
    expect(unanchoredHighTailRes.masteryExclusionReasons).toContain("unanchored_tail_extrapolation");

    const highOnlyAnchors = [
      { ...baseAnchors[4]!, anchorId: "hi-75", band: 7.5 as const, thetaAnchor: 5 },
      { ...baseAnchors[5]!, anchorId: "hi-80", band: 8.0 as const, thetaAnchor: 7 },
    ];
    const unanchoredLowTailRes = evaluateAnchorCalibratedRubric({
      submissionId: "unanchored-low-tail",
      dimension: "task_response",
      text: SENTINEL_ANCHOR_ESSAYS[0]!.text,
      mode: "formal_assessment",
      assisted: false,
      anchors: highOnlyAnchors,
      comparisons: [
        { anchorId: "hi-75", forwardChoice: "B", reverseChoice: "A" },
        { anchorId: "hi-80", forwardChoice: "B", reverseChoice: "A" },
      ],
    });
    expect(unanchoredLowTailRes.status).toBe("interval_only");
    expect(unanchoredLowTailRes.band).toBeNull();
    expect(unanchoredLowTailRes.bandRange).toEqual([0, 7.5]);
    expect(unanchoredLowTailRes.countsTowardMastery).toBe(false);
    expect(unanchoredLowTailRes.inconsistencyReasons).toEqual(["unanchored_tail_extrapolation"]);

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
      corroboratingIndependentSubmissionIds: ["corrob-independent-1"],
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
      corroboratingIndependentSubmissionIds: ["corrob-independent-1"],
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
      corroboratingIndependentSubmissionIds: ["corrob-independent-1"],
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

  it("enforces unique benchmark/triplet IDs and exact cohort membership when expected IDs are supplied (Round-9 P1-2)", () => {
    // Duplicate itemId "b1" at 4.5 and 8.0 must NEVER pass even when every point matches trueBand.
    const dupBenchmark = evaluateRubricCalibrationGate({
      benchmarkItems: [
        { itemId: "b1", trueBand: 4.5, evaluation: calibratedPoint(4.5) },
        { itemId: "b1", trueBand: 8.0, evaluation: calibratedPoint(8.0) },
      ],
      counterfactualTriplets: passingCounterfactuals,
    });
    expect(dupBenchmark.passed).toBe(false);
    expect(dupBenchmark.failures).toContain("duplicate_or_invalid_benchmark_item_id");
    expect(dupBenchmark.metrics.admissibleCount).toBe(0);

    // Duplicate tripletId fails closed.
    const validBenchmark = [
      { itemId: "g1", trueBand: 4.5, evaluation: { ...calibratedPoint(4.5), submissionId: "g1" } },
      { itemId: "g2", trueBand: 5.0, evaluation: { ...calibratedPoint(5.0), submissionId: "g2" } },
      { itemId: "g3", trueBand: 6.0, evaluation: { ...calibratedPoint(6.0), submissionId: "g3" } },
      { itemId: "g4", trueBand: 6.5, evaluation: { ...calibratedPoint(6.5), submissionId: "g4" } },
      { itemId: "g5", trueBand: 7.5, evaluation: { ...calibratedPoint(7.5), submissionId: "g5" } },
      { itemId: "g6", trueBand: 8.0, evaluation: { ...calibratedPoint(8.0), submissionId: "g6" } },
    ];
    const dupTriplet = evaluateRubricCalibrationGate({
      benchmarkItems: validBenchmark,
      counterfactualTriplets: [passingCounterfactuals[0]!, passingCounterfactuals[0]!],
    });
    expect(dupTriplet.passed).toBe(false);
    expect(dupTriplet.failures).toContain("duplicate_or_invalid_triplet_id");

    // Exact expectedBenchmarkItemIds + expectedTripletIds match passes.
    const exactCohort = evaluateRubricCalibrationGate({
      benchmarkItems: validBenchmark,
      counterfactualTriplets: passingCounterfactuals,
      expectedBenchmarkItemIds: ["g1", "g2", "g3", "g4", "g5", "g6"],
      expectedTripletIds: [passingCounterfactuals[0]!.tripletId],
    });
    expect(exactCohort.passed).toBe(true);
    expect(exactCohort.failures).toEqual([]);

    // Missing or extra benchmark item fails with benchmark_cohort_mismatch.
    const missingCohortItem = evaluateRubricCalibrationGate({
      benchmarkItems: validBenchmark,
      counterfactualTriplets: passingCounterfactuals,
      expectedBenchmarkItemIds: ["g1", "g2", "g3", "g4", "g5", "g6", "g7"],
      expectedTripletIds: ["other-triplet-id"],
    });
    expect(missingCohortItem.passed).toBe(false);
    expect(missingCohortItem.failures).toContain("benchmark_cohort_mismatch");
    expect(missingCohortItem.failures).toContain("triplet_cohort_mismatch");

    // Mismatched evaluation.submissionId against itemId fails with benchmark_cohort_mismatch.
    const mismatchedSubId = evaluateRubricCalibrationGate({
      benchmarkItems: validBenchmark.map((item, idx) =>
        idx === 0 ? { ...item, evaluation: { ...item.evaluation, submissionId: "wrong-sub" } } : item,
      ),
      counterfactualTriplets: passingCounterfactuals,
      expectedBenchmarkItemIds: ["g1", "g2", "g3", "g4", "g5", "g6"],
    });
    expect(mismatchedSubId.passed).toBe(false);
    expect(mismatchedSubId.failures).toContain("benchmark_cohort_mismatch");

    // Round-10 [P2-B]: Single-pass read & Proxy/exotic rejection on evaluateRubricCalibrationGate input/thresholds.
    let expectedIdReads = 0;
    const statefulProxyInput = new Proxy(
      {
        benchmarkItems: validBenchmark,
        counterfactualTriplets: passingCounterfactuals,
        thresholds: { lowTailMaxBand: 5.0 },
      },
      {
        ownKeys(target) {
          return [...Reflect.ownKeys(target), "expectedBenchmarkItemIds"];
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === "expectedBenchmarkItemIds") {
            expectedIdReads += 1;
            return {
              value: expectedIdReads === 1 ? ["g1", "g2", "g3", "g4", "g5", "g6", "missing"] : undefined,
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      },
    );
    const proxyGateRes = evaluateRubricCalibrationGate(statefulProxyInput);
    expect(expectedIdReads).toBe(1);
    expect(proxyGateRes.passed).toBe(false);

    const exoticThresholds = Object.setPrototypeOf(
      Object.assign(new Map(), { minQwk: 0.7 }),
      Object.prototype,
    ) as unknown as { minQwk: number };
    const exoticThresholdsRes = evaluateRubricCalibrationGate({
      benchmarkItems: validBenchmark,
      counterfactualTriplets: passingCounterfactuals,
      thresholds: exoticThresholds,
    });
    expect(exoticThresholdsRes.passed).toBe(false);
    expect(exoticThresholdsRes.failures).toContain("invalid_threshold_configuration");

    // Round-12 [P1-2]: DEFAULT_CALIBRATION_THRESHOLDS is runtime-frozen and cannot be weakened.
    expect(Object.isFrozen(DEFAULT_CALIBRATION_THRESHOLDS)).toBe(true);
    expect(() => {
      Object.assign(DEFAULT_CALIBRATION_THRESHOLDS as Record<string, number>, {
        minSdRatio: 0,
        maxAbsBiasLow: 5,
        maxAbsBiasHigh: 5,
      });
    }).toThrow(TypeError);

    // Round-14 [P1-1]: Self-detaching nested Proxy inside evaluateRubricCalibrationGate input
    // cannot hide itself from reverse-pre-order structuredClone or trigger an injected ancestor getter.
    let gateAncestorGetterRuns = 0;
    const gateDetachParent: {
      benchmarkItems: typeof validBenchmark;
      counterfactualTriplets: typeof passingCounterfactuals;
      expectedBenchmarkItemIds: string[];
    } = {
      benchmarkItems: validBenchmark,
      counterfactualTriplets: passingCounterfactuals,
      expectedBenchmarkItemIds: [],
    };
    let gateDetached = false;
    gateDetachParent.expectedBenchmarkItemIds = new Proxy(["g1", "g2", "g3", "g4", "g5", "g6"], {
      getOwnPropertyDescriptor(target, prop) {
        if (!gateDetached && prop === "0") {
          gateDetached = true;
          gateDetachParent.expectedBenchmarkItemIds = ["g1", "g2", "g3", "g4", "g5", "g6"];
          Object.defineProperty(gateDetachParent, "injectedTrap", {
            enumerable: true,
            configurable: true,
            get() {
              gateAncestorGetterRuns += 1;
              return "boom";
            },
          });
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    const gateDetachRes = evaluateRubricCalibrationGate(gateDetachParent);
    expect(gateAncestorGetterRuns).toBe(0);
    expect(gateDetachRes.passed).toBe(false);
  });
});
