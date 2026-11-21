import { describe, expect, it } from "vitest";
import { createSkillBelief, DAY_MS, type SkillBeliefV1 } from "../epistemic/belief";
import {
  buildUnifiedDecisionSnapshot,
  calibrateJointPassTargets,
  choleskyDecompose,
  computeConformalBandInterval,
  computeIeltsOverallBand,
  computeWritingBand,
  convolveLordWingersky,
  cqrWorstCaseNonconformity,
  createSharedFullPaperBlueprint,
  evaluateCrnActionRoi,
  evaluateExamForecast,
  filterIndependentCalibrationRecords,
  formatJointTargetKey,
  IELTS_ACADEMIC_DIAGNOSTIC_SEEDS,
  IELTS_ACADEMIC_READING_RAW_TO_BAND,
  IELTS_ACADEMIC_SKILL_IDS,
  IELTS_ACADEMIC_V1_BLUEPRINT,
  IELTS_LISTENING_RAW_TO_BAND,
  itemSuccessProbability,
  partitionExamEvidence,
  rawScoreToBand,
  roundHalfUp05,
  simulateExamPaper,
  snapToScoreGrid,
  validateExamBlueprint,
  type CandidateStudyAction,
  type ExamEvidenceRecord,
  type SkillBeliefMap,
  type WholePaperCalibrationRecord,
} from "./index";

function makeIeltsBeliefs(
  overrides: Partial<{ abilityMean: number; logStability: number; implicitLogCredit: number; lastDirectRecallAtMs: number | null }> = {},
): SkillBeliefMap {
  const map: Record<string, SkillBeliefV1> = {};
  for (const skillId of IELTS_ACADEMIC_SKILL_IDS) {
    map[skillId] = createSkillBelief({
      workspaceId: "ws-1",
      learnerId: "learner-target",
      courseId: "ielts-academic",
      confirmedSkillVersion: 1,
      abilityMean: overrides.abilityMean ?? 0.4,
      abilityVariance: 0.4,
      logStability: overrides.logStability ?? Math.log(14),
      implicitLogCredit: overrides.implicitLogCredit ?? 0,
      lastDirectRecallAtMs: overrides.lastDirectRecallAtMs === undefined ? 0 : overrides.lastDirectRecallAtMs,
    });
  }
  return map;
}

function makeIndependentSectionEvidence(observedAtMs = 1_000): ExamEvidenceRecord[] {
  return [
    {
      evidenceId: "ev-l",
      learnerId: "learner-target",
      paperFamilyId: "diag-family-a",
      sectionId: "listening",
      countsTowardMastery: true,
      assisted: false,
      evidenceKind: "diagnostic_item",
      observedAtMs,
      correct: true,
      elapsedSeconds: 24,
    },
    {
      evidenceId: "ev-r",
      learnerId: "learner-target",
      paperFamilyId: "diag-family-a",
      sectionId: "reading",
      countsTowardMastery: true,
      assisted: false,
      evidenceKind: "diagnostic_item",
      observedAtMs,
      correct: true,
      elapsedSeconds: 29,
    },
    {
      evidenceId: "ev-w",
      learnerId: "learner-target",
      paperFamilyId: "diag-family-a",
      sectionId: "writing",
      partId: "writing-task-2",
      countsTowardMastery: true,
      assisted: false,
      evidenceKind: "rubric_assessment",
      observedAtMs,
      rubricScore: { kind: "interval_only", low: 6.0, high: 7.0 },
    },
    {
      evidenceId: "ev-s",
      learnerId: "learner-target",
      paperFamilyId: "diag-family-a",
      sectionId: "speaking",
      countsTowardMastery: true,
      assisted: false,
      evidenceKind: "speech_timing",
      observedAtMs,
      speechTimingReceipt: {
        receiptId: "sr-1",
        durationSeconds: 120,
        speechRateWpm: 132,
        pauseRatio: 0.14,
        fluencyScore: 6.5,
        calibrated: true,
      },
    },
  ];
}

function makeCalibrationRecords(count = 5): WholePaperCalibrationRecord[] {
  return Array.from({ length: count }, (_, idx) => ({
    recordId: `cal-${idx}`,
    learnerId: `other-learner-${idx}`,
    paperFamilyId: `mock-family-${idx}`,
    blueprintId: "ielts-academic-v1",
    targetKind: "same_blueprint_mock",
    evidenceKind: "independent_mock",
    assisted: false,
    countsTowardMastery: true,
    predictedQuantiles: { q10: 5.5, q50: 6.5, q90: 7.0 },
    predictedJointPassProb: 0.25 + idx * 0.15,
    predictedTargetPassProbs: [
      { targetOverall: 7.0, targetMinSection: 6.5, rawProbability: 0.15 + idx * 0.15 },
    ],
    observedScore: { kind: "exact", score: 6.0 + (idx % 3) * 0.5 },
    observedSectionScores: {
      listening: 6.0 + (idx % 3) * 0.5,
      reading: 5.5 + (idx % 3) * 0.5,
      writing: 6.0 + (idx % 2) * 0.5,
      speaking: 6.5,
    },
    recordedAtMs: 5_000 + idx * 1_000,
  }));
}

describe("IELTS Academic blueprint & official rounding", () => {
  it("validates IELTS_ACADEMIC_V1_BLUEPRINT and covers 0..40 conversion tables", () => {
    expect(validateExamBlueprint(IELTS_ACADEMIC_V1_BLUEPRINT)).toEqual([]);
    expect(rawScoreToBand(30, IELTS_LISTENING_RAW_TO_BAND)).toBe(7.0);
    expect(rawScoreToBand(26, IELTS_LISTENING_RAW_TO_BAND)).toBe(6.5);
    expect(rawScoreToBand(26, IELTS_ACADEMIC_READING_RAW_TO_BAND)).toBe(6.0);
    expect(rawScoreToBand(27, IELTS_ACADEMIC_READING_RAW_TO_BAND)).toBe(6.5);
    expect(rawScoreToBand(39, IELTS_ACADEMIC_READING_RAW_TO_BAND)).toBe(9.0);
  });

  it("applies official roundHalfUp05 after continuous mean without double-rounding bias", () => {
    expect(roundHalfUp05(6.25)).toBe(6.5);
    expect(roundHalfUp05(6.75)).toBe(7.0);
    expect(roundHalfUp05(6.125)).toBe(6.0);
    expect(roundHalfUp05(12)).toBe(9.0);
    expect(roundHalfUp05(-1)).toBe(0);

    // Task 1 = 6.5 (1/3), Task 2 = 7.0 (2/3) => unrounded Writing = 6.83333...
    // Mean(6.5, 6.5, 6.83333..., 7.0) = 6.70833... => official overall = 6.5.
    // Pre-rounding Writing to 7.0 would bias the mean to 6.75 => 7.0!
    const unroundedWriting = computeWritingBand(6.5, 7.0);
    const preroundedWriting = computeWritingBand(6.5, 7.0, { roundSection: true });
    expect(preroundedWriting).toBe(7.0);
    expect(
      computeIeltsOverallBand({ listening: 6.5, reading: 6.5, writing: unroundedWriting, speaking: 7.0 }),
    ).toBe(6.5);
    expect(
      computeIeltsOverallBand({ listening: 6.5, reading: 6.5, writing: preroundedWriting, speaking: 7.0 }),
    ).toBe(7.0);
  });

  it("supports shared_full_paper 150-point / 180-min blueprints and cross-section censoring", () => {
    const mathSkills = ["math.calc", "math.linalg"] as const;
    const itemsA = Array.from({ length: 10 }, (_, idx) => ({
      itemId: `mcq-${idx}`,
      sectionId: "sec-a",
      partId: "part-a",
      skillIds: ["math.calc"],
      guess: 0.25,
      lapse: 0.02,
      points: 5,
      timeModel: { mu: Math.log(540), speedLoading: 0.2, skillLoading: { "math.calc": 0.1 }, sigma: 0.1 },
    }));
    const itemsB = Array.from({ length: 10 }, (_, idx) => ({
      itemId: `frq-${idx}`,
      sectionId: "sec-b",
      partId: "part-b",
      skillIds: ["math.linalg"],
      guess: 0,
      lapse: 0.03,
      points: 10,
      timeModel: { mu: Math.log(800), speedLoading: 0.2, skillLoading: { "math.linalg": 0.1 }, sigma: 0.1 },
    }));
    const mathBlueprint = createSharedFullPaperBlueprint({
      blueprintId: "math-150-v1",
      title: "150pt Shared 180m Exam",
      totalTimeLimitMinutes: 180,
      totalPoints: 150,
      skillIds: mathSkills,
      sections: [
        {
          sectionId: "sec-a",
          label: "Section A",
          scoringKind: "item_raw_table",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 50],
          scoreStep: 1,
          parts: [{ partId: "part-a", label: "MCQ", weight: 1, skillIds: ["math.calc"] }],
          items: itemsA,
          rawToBandTable: Array.from({ length: 51 }, (_, raw) => ({ rawMin: raw, rawMax: raw, score: raw })),
        },
        {
          sectionId: "sec-b",
          label: "Section B",
          scoringKind: "item_raw_table",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 100],
          scoreStep: 1,
          parts: [{ partId: "part-b", label: "FRQ", weight: 1, skillIds: ["math.linalg"] }],
          items: itemsB,
          rawToBandTable: Array.from({ length: 101 }, (_, raw) => ({ rawMin: raw, rawMax: raw, score: raw })),
        },
      ],
    });
    expect(validateExamBlueprint(mathBlueprint)).toEqual([]);
    const beliefs: SkillBeliefMap = {
      "math.calc": createSkillBelief({ workspaceId: "w", learnerId: "l", courseId: "c", confirmedSkillVersion: 1, abilityMean: 1.5, lastDirectRecallAtMs: 0 }),
      "math.linalg": createSkillBelief({ workspaceId: "w", learnerId: "l", courseId: "c", confirmedSkillVersion: 1, abilityMean: 1.5, lastDirectRecallAtMs: 0 }),
    };
    const sim = simulateExamPaper({ blueprint: mathBlueprint, learnerId: "l", beliefs, evidence: [], examAtMs: DAY_MS, numDraws: 120, seed: 7 });
    expect(sim.rightCensoringRateBySection["sec-b"]).toBeGreaterThan(0.5);
    expect(sim.timeSqueezeDelta).toBeGreaterThan(5);
  });

  it("provides 100% original 30s diagnostic seeds across all 4 IELTS sections", () => {
    const sections = new Set(IELTS_ACADEMIC_DIAGNOSTIC_SEEDS.map((s) => s.sectionId));
    expect(sections).toEqual(new Set(["listening", "reading", "writing", "speaking"]));
    const validSkills = new Set(IELTS_ACADEMIC_SKILL_IDS);
    for (const seed of IELTS_ACADEMIC_DIAGNOSTIC_SEEDS) {
      expect(seed.targetSeconds).toBe(30);
      expect(seed.skillIds.length).toBeGreaterThan(0);
      expect(seed.skillIds.every((id) => validSkills.has(id as (typeof IELTS_ACADEMIC_SKILL_IDS)[number]))).toBe(true);
      expect(seed.options.some((o) => o.optionId === seed.correctOptionId)).toBe(true);
      expect(seed.timeModel.sigma).toBeGreaterThan(0);
    }
  });
});

describe("Correlated simulator, purity gate & Lord-Wingersky untimed baseline", () => {
  it("enforces Evidence Purity Gate and ignores implicitLogCredit during decay", () => {
    const clean = makeIndependentSectionEvidence();
    const contaminated: ExamEvidenceRecord[] = [
      ...clean,
      { evidenceId: "bad-pf", learnerId: "learner-target", sectionId: "reading", countsTowardMastery: true, assisted: false, evidenceKind: "practice_feedback", observedAtMs: 100, correct: true },
      { evidenceId: "bad-sr", learnerId: "learner-target", sectionId: "reading", countsTowardMastery: true, assisted: false, evidenceKind: "self_report", observedAtMs: 100, correct: true },
      { evidenceId: "bad-ast", learnerId: "learner-target", sectionId: "reading", countsTowardMastery: true, assisted: true, evidenceKind: "diagnostic_item", observedAtMs: 100, correct: true },
      { evidenceId: "bad-exp", learnerId: "learner-target", sectionId: "reading", countsTowardMastery: true, assisted: false, exposed: true, evidenceKind: "diagnostic_item", observedAtMs: 100, correct: true },
    ];
    expect(partitionExamEvidence(contaminated).rejectedCount).toBe(4);

    const noCredit = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: makeIeltsBeliefs({ implicitLogCredit: 0 }),
      evidence: clean,
      examAtMs: 10 * DAY_MS,
      numDraws: 120,
      seed: 42,
    });
    const withImplicitCredit = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: makeIeltsBeliefs({ implicitLogCredit: Math.log(1.2) }),
      evidence: clean,
      examAtMs: 10 * DAY_MS,
      numDraws: 120,
      seed: 42,
    });
    expect(withImplicitCredit.timedScores).toEqual(noCredit.timedScores);
    expect(withImplicitCredit.untimedExpectedScore).toBe(noCredit.untimedExpectedScore);
  });

  it("validates Cholesky PSD covariance and applies guess/lapse once", () => {
    const chol = choleskyDecompose(IELTS_ACADEMIC_V1_BLUEPRINT.thetaCovariance);
    expect(chol.length).toBe(IELTS_ACADEMIC_SKILL_IDS.length);
    expect(() => choleskyDecompose([[1, 2], [2, 1]])).toThrow(/positive semidefinite/);

    const item = IELTS_ACADEMIC_V1_BLUEPRINT.sections[0]!.items![0]!;
    expect(itemSuccessProbability({ ...item, guess: 0.2, lapse: 0.05 }, { "ielts.listening.detail": 1, "ielts.listening.distractor": 1 })).toBeCloseTo(0.95, 12);
    expect(itemSuccessProbability({ ...item, guess: 0.2, lapse: 0.05 }, { "ielts.listening.detail": 0, "ielts.listening.distractor": 1 })).toBeCloseTo(0.2, 12);

    const dist = convolveLordWingersky([0.8, 0.5]);
    expect(dist[0]).toBeCloseTo(0.1, 12);
    expect(dist[1]).toBeCloseTo(0.5, 12);
    expect(dist[2]).toBeCloseTo(0.4, 12);
  });

  it("models Passage 3 right-censoring without fabricating times and converges to untimed when unlimited", () => {
    const slowBeliefs = makeIeltsBeliefs({ abilityMean: -1.1, logStability: Math.log(5) });
    const timed = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: slowBeliefs,
      evidence: makeIndependentSectionEvidence(),
      examAtMs: 3 * DAY_MS,
      numDraws: 200,
      seed: 99,
    });
    expect(timed.rightCensoringRateBySection["reading"]).toBeGreaterThan(0.3);
    expect(timed.sectionSummaries["reading"]!.partCensoringRates["reading-passage-3"]).toBeGreaterThan(0);
    expect(timed.sampleRightCensoredItems.length).toBeGreaterThan(0);
    for (const item of timed.sampleRightCensoredItems) {
      expect(item.rightCensored).toBe(true);
      expect(item.attempted).toBe(false);
      expect(item.observedTimeSeconds).toBeNull();
    }
    expect(timed.timeSqueezeDelta).toBeGreaterThan(0);

    const untimed = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: slowBeliefs,
      evidence: makeIndependentSectionEvidence(),
      examAtMs: 3 * DAY_MS,
      numDraws: 400,
      seed: 99,
      forceUntimed: true,
    });
    expect(Math.abs(untimed.timedExpectedScore - untimed.untimedExpectedScore)).toBeLessThan(0.05);
  });
});

describe("3-State Split CQR 80% calibration & monotonic joint pass", () => {
  it("returns insufficient_blueprint when required fields or covariance are invalid", () => {
    const broken = { ...IELTS_ACADEMIC_V1_BLUEPRINT, thetaCovariance: [[1, 1.5], [1.5, 1]] };
    const result = evaluateExamForecast({
      blueprint: broken,
      learnerId: "learner-target",
      beliefs: makeIeltsBeliefs(),
      evidence: makeIndependentSectionEvidence(),
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: DAY_MS,
    });
    expect(result.status).toBe("insufficient_blueprint");
    if (result.status === "insufficient_blueprint") {
      expect(result.missingFields).toContain("thetaCovariance");
      expect(result.officialExamCalibrated).toBe(false);
    }
  });

  it("rejects practice_feedback, same-learner/family leakage, < 4 calibration samples, and excessive width", () => {
    const onlyAssistedReading = makeIndependentSectionEvidence().map((e) =>
      e.sectionId === "reading" ? { ...e, assisted: true } : e,
    );
    const missingRead = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: makeIeltsBeliefs(),
      evidence: onlyAssistedReading,
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: DAY_MS,
    });
    expect(missingRead.status).toBe("insufficient_independent_evidence");
    if (missingRead.status === "insufficient_independent_evidence") {
      expect(missingRead.missingSections).toEqual(["reading"]);
      expect(missingRead.nextDiagnosticAction.recommendedItemIds.some((id) => id.includes("reading"))).toBe(true);
    }

    const pollutedCal = [
      ...makeCalibrationRecords(3),
      { ...makeCalibrationRecords(1)[0]!, recordId: "leak-learner", learnerId: "learner-target" },
      { ...makeCalibrationRecords(1)[0]!, recordId: "leak-family", paperFamilyId: "diag-family-a" },
      { ...makeCalibrationRecords(1)[0]!, recordId: "leak-pf", evidenceKind: "practice_feedback" as const },
    ];
    const tooFew = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: makeIeltsBeliefs(),
      evidence: makeIndependentSectionEvidence(),
      calibrationRecords: pollutedCal,
      examAtMs: DAY_MS,
    });
    expect(tooFew.status).toBe("insufficient_independent_evidence");
    if (tooFew.status === "insufficient_independent_evidence") {
      expect(tooFew.calibrationCount).toBe(3);
    }

    const wideCal = makeCalibrationRecords(4).map((r) => ({ ...r, observedScore: { kind: "exact" as const, score: 1.0 } }));
    const tooWide = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: makeIeltsBeliefs(),
      evidence: makeIndependentSectionEvidence(),
      calibrationRecords: wideCal,
      examAtMs: DAY_MS,
      maxInformativeWidth: 3.0,
    });
    expect(tooWide.status).toBe("insufficient_independent_evidence");
    if (tooWide.status === "insufficient_independent_evidence") {
      expect(tooWide.widthGateExceeded).toBe(true);
    }
  });

  it("computes C6 worst-case interval-censored residuals (never midpoint) and honest mock scope", () => {
    const intervalCal: WholePaperCalibrationRecord = {
      ...makeCalibrationRecords(1)[0]!,
      predictedQuantiles: { q10: 6.0, q50: 6.5, q90: 7.0 },
      observedScore: { kind: "interval_only", low: 5.5, high: 8.0 },
    };
    // Midpoint would be 6.75 (residual -0.25); worst-case max(6.0 - 5.5, 8.0 - 7.0) = 1.0.
    expect(cqrWorstCaseNonconformity(intervalCal)).toBeCloseTo(1.0, 12);

    const ready = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: makeIeltsBeliefs({ abilityMean: 1.0 }),
      evidence: makeIndependentSectionEvidence(),
      calibrationRecords: [...makeCalibrationRecords(4), intervalCal],
      examAtMs: 2 * DAY_MS,
      jointPassTarget: { targetOverall: 7.0, targetMinSection: 6.5 },
    });
    expect(ready.status).toBe("calibrated_forecast_ready");
    if (ready.status === "calibrated_forecast_ready") {
      expect(ready.forecastTargetKind).toBe("same_blueprint_mock");
      expect(ready.labelScope).toBe("同蓝图限时模考预估区间");
      expect(ready.officialExamCalibrated).toBe(false);
      expect(ready.interval80.low % 0.5).toBe(0);
      expect(ready.interval80.high % 0.5).toBe(0);
      expect(ready.interval80.low).toBeLessThanOrEqual(ready.timedSimulation.q10);
      expect(ready.interval80.high).toBeGreaterThanOrEqual(ready.timedSimulation.q90);
    }

    const officialBlocked = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: makeIeltsBeliefs({ abilityMean: 1.0 }),
      evidence: makeIndependentSectionEvidence(),
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: 2 * DAY_MS,
      targetKind: "official_exam",
    });
    expect(officialBlocked.status).toBe("insufficient_independent_evidence");
    expect(officialBlocked.officialExamCalibrated).toBe(false);

    const officialCal = makeCalibrationRecords(4).map((r) => ({
      ...r,
      targetKind: "official_exam" as const,
      evidenceKind: "official_exam" as const,
    }));
    const officialReady = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: makeIeltsBeliefs({ abilityMean: 1.0 }),
      evidence: makeIndependentSectionEvidence(),
      calibrationRecords: officialCal,
      examAtMs: 2 * DAY_MS,
      targetKind: "official_exam",
    });
    expect(officialReady.status).toBe("calibrated_forecast_ready");
    expect(officialReady.officialExamCalibrated).toBe(true);
  });

  it("enforces PAV monotonic joint pass probabilities across harder targets", () => {
    const sim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: makeIeltsBeliefs({ abilityMean: 0.8 }),
      evidence: makeIndependentSectionEvidence(),
      examAtMs: 2 * DAY_MS,
      numDraws: 150,
      seed: 12,
    });
    const noisyCal: WholePaperCalibrationRecord[] = [
      { ...makeCalibrationRecords(1)[0]!, recordId: "c1", paperFamilyId: "f1", predictedTargetPassProbs: [{ targetOverall: 6.5, targetMinSection: 6.0, rawProbability: 0.7 }, { targetOverall: 7.0, targetMinSection: 6.5, rawProbability: 0.4 }, { targetOverall: 7.5, targetMinSection: 7.0, rawProbability: 0.3 }], observedScore: { kind: "exact", score: 6.5 }, observedSectionScores: { listening: 6.5, reading: 6.5, writing: 6.0, speaking: 6.5 } },
      { ...makeCalibrationRecords(1)[0]!, recordId: "c2", learnerId: "l2", paperFamilyId: "f2", predictedTargetPassProbs: [{ targetOverall: 6.5, targetMinSection: 6.0, rawProbability: 0.8 }, { targetOverall: 7.0, targetMinSection: 6.5, rawProbability: 0.5 }, { targetOverall: 7.5, targetMinSection: 7.0, rawProbability: 0.4 }], observedScore: { kind: "exact", score: 7.0 }, observedSectionScores: { listening: 7.0, reading: 7.0, writing: 6.5, speaking: 7.0 } },
      { ...makeCalibrationRecords(1)[0]!, recordId: "c3", learnerId: "l3", paperFamilyId: "f3", predictedTargetPassProbs: [{ targetOverall: 6.5, targetMinSection: 6.0, rawProbability: 0.4 }, { targetOverall: 7.0, targetMinSection: 6.5, rawProbability: 0.6 }, { targetOverall: 7.5, targetMinSection: 7.0, rawProbability: 0.5 }], observedScore: { kind: "exact", score: 7.5 }, observedSectionScores: { listening: 7.5, reading: 7.5, writing: 7.0, speaking: 7.0 } },
      { ...makeCalibrationRecords(1)[0]!, recordId: "c4", learnerId: "l4", paperFamilyId: "f4", predictedTargetPassProbs: [{ targetOverall: 6.5, targetMinSection: 6.0, rawProbability: 0.5 }, { targetOverall: 7.0, targetMinSection: 6.5, rawProbability: 0.2 }, { targetOverall: 7.5, targetMinSection: 7.0, rawProbability: 0.1 }], observedScore: { kind: "exact", score: 6.0 }, observedSectionScores: { listening: 6.0, reading: 6.0, writing: 5.5, speaking: 6.0 } },
    ];
    const ladder = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: noisyCal,
      targets: [
        { targetOverall: 6.5, targetMinSection: 6.0 },
        { targetOverall: 7.0, targetMinSection: 6.5 },
        { targetOverall: 7.5, targetMinSection: 7.0 },
      ],
    });
    expect(ladder.every((item) => item.isCalibrated && item.calibratedProbability !== null)).toBe(true);
    expect(ladder[0]!.calibratedProbability!).toBeGreaterThanOrEqual(ladder[1]!.calibratedProbability!);
    expect(ladder[1]!.calibratedProbability!).toBeGreaterThanOrEqual(ladder[2]!.calibratedProbability!);
  });
});

describe("CRN marginal ROI sandbox & UnifiedDecisionSnapshotV1", () => {
  it("evaluates paired CRN ROI, captures superlinear time-release synergy, and enforces sprint_72h recovery cap", () => {
    const speedDrill: CandidateStudyAction = {
      actionId: "reading-speed-drill",
      title: "Timed Passage Pacing Drill",
      durationHours: 2,
      kind: "speed_drill",
      expectedSpeedShift: 1.1,
    };
    const inferenceRepair: CandidateStudyAction = {
      actionId: "reading-inference-repair",
      title: "Passage 3 Inference Repair",
      durationHours: 2,
      kind: "skill_repair",
      skillEffects: { "ielts.reading.inference": { abilityDelta: 1.2 }, "ielts.reading.pacing": { abilityDelta: 0.8 } },
    };
    const recoveryBreak: CandidateStudyAction = {
      actionId: "sleep-recovery",
      title: "Consolidation & Sleep Recovery",
      durationHours: 4,
      kind: "recovery",
      recoveryMinutes: 240,
    };
    const beliefs = makeIeltsBeliefs({ abilityMean: -0.9, logStability: Math.log(6) });
    const speedEval = evaluateCrnActionRoi({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: makeIndependentSectionEvidence(),
      examAtMs: 2 * DAY_MS,
      baselineActions: [],
      candidateAction: speedDrill,
      crnSeed: 12345,
      numDraws: 150,
    });
    expect(speedEval.pairedMeanGain).toBeGreaterThan(0);
    expect(speedEval.timeSqueezeReduction).toBeGreaterThan(0);
    expect(speedEval.superlinearSynergy).toBeGreaterThan(0);
    expect(speedEval.roiBandPerHour).toBeCloseTo(speedEval.pairedMeanGain / speedDrill.durationHours, 12);

    const sprint = buildUnifiedDecisionSnapshot({
      decisionId: "dec-72h",
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: makeIndependentSectionEvidence(),
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: 2 * DAY_MS,
      crnSeed: 12345,
      horizonHours: 72,
      executableMinutes: 600,
      candidateActions: [speedDrill, inferenceRepair, recoveryBreak],
      numDraws: 120,
    });
    expect(sprint.policyMode).toBe("sprint_72h");
    expect(sprint.maxRecoveryMinutes).toBe(180);
    expect(sprint.allocatedRecoveryMinutes).toBeLessThanOrEqual(Math.floor(0.3 * sprint.executableMinutes));
    expect(sprint.rankedActions[0]!.roiBandPerHour).toBeGreaterThanOrEqual(sprint.rankedActions[1]!.roiBandPerHour);

    const cycle = buildUnifiedDecisionSnapshot({
      decisionId: "dec-90d",
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: makeIndependentSectionEvidence(),
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: 30 * DAY_MS,
      crnSeed: 12345,
      horizonHours: 90 * 24,
      executableMinutes: 1000,
      candidateActions: [speedDrill, recoveryBreak],
      numDraws: 100,
    });
    expect(cycle.policyMode).toBe("cycle_90d");
    expect(cycle.allocatedRecoveryMinutes).toBe(240);
    expect(cycle.allocatedRecoveryMinutes).toBeLessThanOrEqual(300);
  });

  it("reproduces and guards all Round-2 P1 & P2 invariants", () => {
    // [P1-1] Cholesky rejects NaN upper triangle and indefinite zero-diagonal Schur complements.
    expect(() => choleskyDecompose([[1, Number.NaN], [0, 1]])).toThrow(RangeError);
    expect(() => choleskyDecompose([[0, 1], [1, 0]])).toThrow(/positive semidefinite/);
    expect(() => choleskyDecompose([[1, 1, 0], [1, 1, 1], [0, 1, 1]])).toThrow(/positive semidefinite/);
    expect(choleskyDecompose([[1, 1], [1, 1]])).toEqual([[1, 0], [1, 0]]);

    // [P1-2] Anchored Writing/Speaking preserves [low, high] at observedAtMs, decays +180d, and yields positive CRN ROI.
    const anchorMs = 1_000;
    const beliefs = makeIeltsBeliefs({ abilityMean: 0.5, logStability: Math.log(14), lastDirectRecallAtMs: 0 });
    const anchoredEvidence = makeIndependentSectionEvidence(anchorMs);
    const atAnchor = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: anchoredEvidence,
      examAtMs: anchorMs,
      numDraws: 200,
      seed: 31,
    });
    const after180d = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: anchoredEvidence,
      examAtMs: anchorMs + 180 * DAY_MS,
      numDraws: 200,
      seed: 31,
    });
    expect(atAnchor.sectionSummaries["writing"]!.untimedMeanScore).toBeGreaterThanOrEqual(6.0);
    expect(atAnchor.sectionSummaries["writing"]!.untimedMeanScore).toBeLessThanOrEqual(7.0);
    expect(after180d.sectionSummaries["writing"]!.untimedMeanScore).toBeLessThan(
      atAnchor.sectionSummaries["writing"]!.untimedMeanScore,
    );
    expect(after180d.sectionSummaries["speaking"]!.untimedMeanScore).toBeLessThan(
      atAnchor.sectionSummaries["speaking"]!.untimedMeanScore,
    );

    const writingRepair: CandidateStudyAction = {
      actionId: "writing-task2-repair",
      title: "Task 2 Argument Repair",
      durationHours: 2,
      kind: "skill_repair",
      skillEffects: {
        "ielts.writing.task2_argument": { abilityDelta: 2.0 },
        "ielts.writing.cohesion_lexis": { abilityDelta: 1.5 },
      },
    };
    const writingRoi = evaluateCrnActionRoi({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: anchoredEvidence,
      examAtMs: anchorMs + 20 * DAY_MS,
      baselineActions: [],
      candidateAction: writingRepair,
      crnSeed: 77,
      numDraws: 120,
    });
    expect(writingRoi.pairedMeanGain).toBeGreaterThan(0);
    expect(writingRoi.roiBandPerHour).toBeGreaterThan(0);

    // [P1-3] convolveLordWingersky validates probabilities & non-negative integer points; blueprint rejects fractional points.
    expect(() => convolveLordWingersky([0.5], [0.5])).toThrow(RangeError);
    expect(() => convolveLordWingersky([0.5], [-1])).toThrow(RangeError);
    expect(() => convolveLordWingersky([Number.NaN], [1])).toThrow(RangeError);
    expect(convolveLordWingersky([0.7], [0])).toEqual([1]);

    const badPointsBlueprint = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) =>
        sec.sectionId === "listening" && sec.items
          ? { ...sec, items: [{ ...sec.items[0]!, points: 0.5 }, ...sec.items.slice(1)] }
          : sec,
      ),
    };
    expect(validateExamBlueprint(badPointsBlueprint).some((f) => f.endsWith(".points"))).toBe(true);

    // [P1-4] Reject spoofed evidenceKind and NaN/out-of-range/disordered calibration numbers.
    const spoofedCal = makeCalibrationRecords(4).map((r) => ({
      ...r,
      targetKind: "official_exam" as const,
      evidenceKind: "diagnostic_item" as const,
    }));
    const spoofedRes = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: anchoredEvidence,
      calibrationRecords: spoofedCal,
      examAtMs: DAY_MS,
      targetKind: "official_exam",
    });
    expect(spoofedRes.status).toBe("insufficient_independent_evidence");

    const nanCal = makeCalibrationRecords(4).map((r, idx) =>
      idx === 0 ? { ...r, observedScore: { kind: "exact" as const, score: Number.NaN } } : r,
    );
    const nanRes = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: anchoredEvidence,
      calibrationRecords: nanCal,
      examAtMs: DAY_MS,
    });
    expect(nanRes.status).toBe("insufficient_independent_evidence");
    if (nanRes.status === "insufficient_independent_evidence") {
      expect(nanRes.calibrationCount).toBe(3);
    }

    // [P1-5] Corrupt NaN section scores must be skipped (null), while provable failures return 0.
    const sim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: anchoredEvidence,
      examAtMs: DAY_MS,
      numDraws: 60,
      seed: 19,
    });
    const incompleteSectionsCal: WholePaperCalibrationRecord[] = makeCalibrationRecords(4).map((r) => ({
      ...r,
      observedScore: { kind: "exact" as const, score: 7.0 },
      observedSectionScores: { listening: 7.0, reading: Number.NaN, writing: 7.0, speaking: 7.0 },
    }));
    const ladder = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: incompleteSectionsCal,
      targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
    });
    expect(ladder[0]!.calibrationSampleCount).toBe(0);
    expect(ladder[0]!.isCalibrated).toBe(false);
    expect(ladder[0]!.calibratedProbability).toBeNull();

    // [P2-1] computeWritingBand & computeIeltsOverallBand clamp finite [0, 9] and throw on non-finite.
    expect(() => computeWritingBand(Number.NaN, 7)).toThrow(RangeError);
    expect(() => computeIeltsOverallBand({ listening: 7, reading: 7, writing: 7, speaking: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(computeIeltsOverallBand({ listening: 12, reading: 12, writing: 12, speaking: 12 })).toBe(9);
    const badPartBlueprint = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      scoreRange: [9, 0] as const,
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) =>
        sec.sectionId === "speaking"
          ? { ...sec, parts: [{ ...sec.parts[0]!, weight: 0, skillIds: ["missing.skill"] }] }
          : sec,
      ),
    };
    const badFields = validateExamBlueprint(badPartBlueprint);
    expect(badFields).toContain("scoreRange");
    expect(badFields).toContain("sections.speaking.parts.speaking-part-1.weight");

    // [P2-2] shared_full_paper threads clock through rubric sections and uses independent score/time normals.
    const sharedRubricBp = createSharedFullPaperBlueprint({
      blueprintId: "shared-rubric-v1",
      title: "Shared Clock With Rubric Section",
      totalTimeLimitMinutes: 30,
      totalPoints: 20,
      skillIds: ["s1", "s2"],
      sections: [
        {
          sectionId: "mcq",
          label: "MCQ",
          scoringKind: "item_raw_table",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 10],
          scoreStep: 1,
          parts: [{ partId: "mcq-p1", label: "P1", weight: 1, skillIds: ["s1"] }],
          items: Array.from({ length: 2 }, (_, idx) => ({
            itemId: `m-${idx}`,
            sectionId: "mcq",
            partId: "mcq-p1",
            skillIds: ["s1"],
            guess: 0,
            lapse: 0,
            points: 5,
            timeModel: { mu: Math.log(950), speedLoading: 0.1, skillLoading: { s1: 0.1 }, sigma: 0.05 },
          })),
          rawToBandTable: Array.from({ length: 11 }, (_, raw) => ({ rawMin: raw, rawMax: raw, score: raw })),
        },
        {
          sectionId: "essay",
          label: "Essay",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 10],
          scoreStep: 1,
          parts: [
            {
              partId: "essay-p1",
              label: "Essay",
              weight: 1,
              skillIds: ["s2"],
              timeModel: { mu: Math.log(900), speedLoading: 0.1, skillLoading: { s2: 0.1 }, sigma: 0.05 },
            },
          ],
        },
      ],
    });
    const sharedSim = simulateExamPaper({
      blueprint: sharedRubricBp,
      learnerId: "l",
      beliefs: {
        s1: createSkillBelief({ workspaceId: "w", learnerId: "l", courseId: "c", confirmedSkillVersion: 1, abilityMean: 1, lastDirectRecallAtMs: 0 }),
        s2: createSkillBelief({ workspaceId: "w", learnerId: "l", courseId: "c", confirmedSkillVersion: 1, abilityMean: 1, lastDirectRecallAtMs: 0 }),
      },
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 40,
      seed: 13,
    });
    expect(sharedSim.rightCensoringRateBySection["essay"]).toBeGreaterThan(0.5);

    // [P2-3] Cross-learner isolation, target-keyed raw prob isolation, and non-IELTS seed isolation.
    const crossLearner = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: anchoredEvidence.map((e) => (e.sectionId === "reading" ? { ...e, learnerId: "other-learner" } : e)),
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: DAY_MS,
    });
    expect(crossLearner.status).toBe("insufficient_independent_evidence");
    if (crossLearner.status === "insufficient_independent_evidence") {
      expect(crossLearner.missingSections).toEqual(["reading"]);
    }

    const unmatchedTargetLadder = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: makeCalibrationRecords(5),
      targets: [{ targetOverall: 8.0, targetMinSection: 7.5 }],
    });
    expect(unmatchedTargetLadder[0]!.calibrationSampleCount).toBe(0);

    const nonIeltsBlocked = evaluateExamForecast({
      blueprint: sharedRubricBp,
      learnerId: "learner-target",
      beliefs: {},
      evidence: [],
      calibrationRecords: [],
      examAtMs: DAY_MS,
    });
    expect(nonIeltsBlocked.status).toBe("insufficient_independent_evidence");
    if (nonIeltsBlocked.status === "insufficient_independent_evidence") {
      expect(nonIeltsBlocked.nextDiagnosticAction.recommendedItemIds).toEqual([]);
    }

    // [P2-4] Zero recovery allocation when uncalibrated; recovery-only works when calibrated.
    const recoveryAction: CandidateStudyAction = {
      actionId: "sleep-recovery",
      title: "Consolidation & Sleep Recovery",
      durationHours: 4,
      kind: "recovery",
      recoveryMinutes: 240,
    };
    const uncalibratedSnap = buildUnifiedDecisionSnapshot({
      decisionId: "dec-uncal",
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: [],
      calibrationRecords: [],
      examAtMs: DAY_MS,
      crnSeed: 1,
      horizonHours: 48,
      executableMinutes: Number.NaN,
      candidateActions: [recoveryAction],
    });
    expect(uncalibratedSnap.allocatedRecoveryMinutes).toBe(0);
    expect(uncalibratedSnap.maxRecoveryMinutes).toBe(0);
    expect(uncalibratedSnap.executableMinutes).toBe(0);
    expect(uncalibratedSnap.selectedActionIds).toEqual([]);

    const recoveryOnlySnap = buildUnifiedDecisionSnapshot({
      decisionId: "dec-rec-only",
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: anchoredEvidence,
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: 2 * DAY_MS,
      crnSeed: 1,
      horizonHours: 72,
      executableMinutes: 1000,
      candidateActions: [recoveryAction],
      numDraws: 60,
    });
    expect(recoveryOnlySnap.forecast.status).toBe("calibrated_forecast_ready");
    expect(recoveryOnlySnap.allocatedRecoveryMinutes).toBe(240);
    expect(recoveryOnlySnap.selectedActionIds).toEqual(["sleep-recovery"]);
  });

  it("enforces Round-3 MNAR joint-pass, quantile range, learner CRN isolation, and blueprint timeModel bounds", () => {
    const beliefs = makeIeltsBeliefs({ abilityMean: 0.4, logStability: Math.log(14), lastDirectRecallAtMs: 0 });
    const evidence = makeIndependentSectionEvidence(1_000);
    const sim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      numDraws: 50,
      seed: 21,
    });

    // [R3 P1-1 / R4 P1-4] Provable failures with missing sections count as 0; inverted intervals return null; < minCalibrationSamples yields null.
    const target7 = { targetOverall: 7.0, targetMinSection: 6.5 };
    const mnarCal: WholePaperCalibrationRecord[] = [
      {
        ...makeCalibrationRecords(1)[0]!,
        recordId: "mnar-fail-missing-speaking",
        observedScore: { kind: "exact", score: 6.5 },
        observedSectionScores: { listening: 5.5, reading: 7.0, writing: 7.0 },
      },
      {
        ...makeCalibrationRecords(1)[0]!,
        recordId: "mnar-inverted-overall",
        observedScore: { kind: "interval_only", low: 8.0, high: 5.0 },
        observedSectionScores: { listening: 7.0, reading: 7.0, writing: 7.0, speaking: 7.0 },
      },
      {
        ...makeCalibrationRecords(1)[0]!,
        recordId: "mnar-inverted-section",
        observedScore: { kind: "exact", score: 7.0 },
        observedSectionScores: { listening: 5.5, reading: { low: 7.5, high: 6.0 }, writing: 7.0, speaking: 7.0 },
      },
    ];
    const mnarRes = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: mnarCal,
      targets: [target7],
      minCalibrationSamples: 1,
    });
    expect(mnarRes[0]!.calibrationSampleCount).toBe(1);
    expect(mnarRes[0]!.calibratedProbability).toBe(0);
    const uncalibratedJoint = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: mnarCal.slice(1),
      targets: [target7],
    });
    expect(uncalibratedJoint[0]!.isCalibrated).toBe(false);
    expect(uncalibratedJoint[0]!.calibratedProbability).toBeNull();

    // [R3 P1-2] Reject calibration records whose predictedQuantiles fall outside blueprint.scoreRange.
    const outOfRangeQuantilesCal = makeCalibrationRecords(4).map((r, idx) =>
      idx === 0 ? { ...r, predictedQuantiles: { q10: -10, q50: 6.5, q90: 20 } } : r,
    );
    const filteredQuantiles = filterIndependentCalibrationRecords({
      records: outOfRangeQuantilesCal,
      blueprintId: IELTS_ACADEMIC_V1_BLUEPRINT.blueprintId,
      targetKind: "same_blueprint_mock",
      scoreRange: IELTS_ACADEMIC_V1_BLUEPRINT.scoreRange,
    });
    expect(filteredQuantiles.length).toBe(3);

    // [R3 P1-3] buildUnifiedDecisionSnapshot isolates input.evidence by trimmed learnerId before CRN ROI.
    const foreignHighWritingEvidence: ExamEvidenceRecord = {
      evidenceId: "foreign-w-9",
      learnerId: "other-learner-9",
      paperFamilyId: "foreign-family",
      sectionId: "writing",
      partId: "writing-task-2",
      countsTowardMastery: true,
      assisted: false,
      evidenceKind: "rubric_assessment",
      observedAtMs: 1_000,
      rubricScore: { kind: "exact", score: 9.0 },
    };
    const writingRepair: CandidateStudyAction = {
      actionId: "w-repair",
      title: "Writing Coherence Drill",
      durationHours: 2,
      kind: "skill_repair",
      skillEffects: { "ielts.writing.task2_argument": { abilityDelta: 1.5 } },
    };
    const cleanSnap = buildUnifiedDecisionSnapshot({
      decisionId: "dec-iso-clean",
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: " learner-target ",
      beliefs,
      evidence,
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: 2 * DAY_MS,
      crnSeed: 55,
      horizonHours: 72,
      candidateActions: [writingRepair],
      numDraws: 60,
    });
    const pollutedSnap = buildUnifiedDecisionSnapshot({
      decisionId: "dec-iso-polluted",
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: " learner-target ",
      beliefs,
      evidence: [...evidence, foreignHighWritingEvidence],
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: 2 * DAY_MS,
      crnSeed: 55,
      horizonHours: 72,
      candidateActions: [writingRepair],
      numDraws: 60,
    });
    expect(pollutedSnap.rankedActions).toEqual(cleanSnap.rankedActions);
    expect(pollutedSnap.selectedActionIds).toEqual(cleanSnap.selectedActionIds);
    const blankLearnerSnap = buildUnifiedDecisionSnapshot({
      decisionId: "dec-blank",
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "   ",
      beliefs,
      evidence,
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: 2 * DAY_MS,
      crnSeed: 55,
      horizonHours: 72,
      candidateActions: [writingRepair],
      numDraws: 40,
    });
    expect(blankLearnerSnap.rankedActions).toEqual([]);

    // [R3 P2-1] Non-finite pauseRatio does not poison speakingFluencyShift into NaN.
    const nanPauseEvidence: ExamEvidenceRecord[] = [
      ...evidence.filter((e) => e.sectionId !== "speaking"),
      {
        evidenceId: "sp-nan-pause",
        learnerId: "learner-target",
        sectionId: "speaking",
        countsTowardMastery: true,
        assisted: false,
        evidenceKind: "speech_timing",
        observedAtMs: 1_000,
        speechTimingReceipt: {
          receiptId: "sr-nan",
          durationSeconds: 110,
          speechRateWpm: 130,
          pauseRatio: Number.NaN,
          calibrated: true,
        },
      },
    ];
    const nanPauseSim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: nanPauseEvidence,
      examAtMs: DAY_MS,
      numDraws: 40,
      seed: 7,
    });
    expect(Number.isFinite(nanPauseSim.timedExpectedScore)).toBe(true);

    // [R3 P2-2] Whitespace-padded learnerId / paperFamilyId cannot bypass exclusion.
    const paddedCal = makeCalibrationRecords(4).map((r, idx) =>
      idx === 0
        ? { ...r, learnerId: " learner-target " }
        : idx === 1
          ? { ...r, paperFamilyId: " diag-family-a " }
          : r,
    );
    const paddedFiltered = filterIndependentCalibrationRecords({
      records: paddedCal,
      blueprintId: IELTS_ACADEMIC_V1_BLUEPRINT.blueprintId,
      targetKind: "same_blueprint_mock",
      scoreRange: IELTS_ACADEMIC_V1_BLUEPRINT.scoreRange,
      excludeLearnerId: "learner-target",
      excludePaperFamilyIds: new Set(["diag-family-a"]),
    });
    expect(paddedFiltered.length).toBe(2);

    // [R3 P2-3] Honest official_exam calibration remediation & formatJointTargetKey / predictedJointPassByTarget.
    const officialMissing = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: DAY_MS,
      targetKind: "official_exam",
    });
    expect(officialMissing.status).toBe("insufficient_independent_evidence");
    if (officialMissing.status === "insufficient_independent_evidence") {
      expect(officialMissing.nextDiagnosticAction.kind).toBe("insufficient_official_exam_calibration");
      expect(officialMissing.nextDiagnosticAction.message).toContain("同蓝图");
    }

    const keyedTarget = { targetOverall: 7, targetMinSection: 6.5 };
    expect(formatJointTargetKey(keyedTarget)).toBe("7:6.5");
    const byTargetCal: WholePaperCalibrationRecord[] = makeCalibrationRecords(4).map((r, idx) => ({
      ...r,
      predictedTargetPassProbs: undefined,
      predictedJointPassByTarget: { "7.0:6.5": 0.2 + idx * 0.2 },
    }));
    const keyedLadder = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: byTargetCal,
      targets: [keyedTarget],
    });
    expect(keyedLadder[0]!.calibrationSampleCount).toBe(4);

    // [R3 P2-4] validateExamBlueprint rejects Infinity sigma on items and invalid timeModel on rubric parts.
    const infItemSigmaBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) =>
        sec.sectionId === "listening" && sec.items
          ? {
              ...sec,
              items: [{ ...sec.items[0]!, timeModel: { ...sec.items[0]!.timeModel, sigma: Number.POSITIVE_INFINITY } }, ...sec.items.slice(1)],
            }
          : sec,
      ),
    };
    expect(validateExamBlueprint(infItemSigmaBp)).toContain("sections.listening.items.ielts-l-1.timeModel");

    const badRubricTimeBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) =>
        sec.sectionId === "writing"
          ? {
              ...sec,
              parts: [{ ...sec.parts[0]!, timeModel: { ...sec.parts[0]!.timeModel!, mu: Number.NaN } }, ...sec.parts.slice(1)],
            }
          : sec,
      ),
    };
    expect(validateExamBlueprint(badRubricTimeBp)).toContain("sections.writing.parts.writing-task-1.timeModel");
  });

  it("enforces all Round-4 7 P1 & 6 P2 edge-case and security invariants", () => {
    const beliefs = makeIeltsBeliefs({ abilityMean: 0.4, logStability: Math.log(14), lastDirectRecallAtMs: 0 });
    const evidence = makeIndependentSectionEvidence(1_000);

    // [R4 P1-1] Mandatory learnerId isolation on beliefs and evidence in simulateExamPaper & evaluateCrnActionRoi.
    expect(() =>
      simulateExamPaper({ blueprint: IELTS_ACADEMIC_V1_BLUEPRINT, learnerId: "  ", beliefs, evidence, examAtMs: DAY_MS }),
    ).toThrow(RangeError);
    expect(() =>
      evaluateCrnActionRoi({
        blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
        learnerId: "",
        beliefs,
        evidence,
        examAtMs: DAY_MS,
        baselineActions: [],
        candidateAction: { actionId: "a", title: "A", durationHours: 1, kind: "skill_repair" },
        crnSeed: 1,
      }),
    ).toThrow(RangeError);

    const foreignBeliefs: SkillBeliefMap = Object.fromEntries(
      Object.entries(makeIeltsBeliefs({ abilityMean: 4.0 })).map(([k, v]) => [k, { ...v, learnerId: "other-learner" }]),
    );
    const foreignSimA = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: foreignBeliefs,
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 40,
      seed: 17,
    });
    const emptyBeliefSim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: {},
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 40,
      seed: 17,
    });
    expect(foreignSimA.timedScores).toEqual(emptyBeliefSim.timedScores);

    // [R4 P1-2] Future timestamp cutoff (observedAtMs > examAtMs) & metadata-only shell rejection.
    const futureOrShellEvidence: ExamEvidenceRecord[] = [
      ...evidence.filter((e) => e.sectionId !== "reading" && e.sectionId !== "writing"),
      {
        evidenceId: "shell-reading",
        learnerId: "learner-target",
        sectionId: "reading",
        countsTowardMastery: true,
        assisted: false,
        evidenceKind: "diagnostic_item",
        observedAtMs: 500,
      },
      {
        evidenceId: "future-writing",
        learnerId: "learner-target",
        sectionId: "writing",
        partId: "writing-task-2",
        countsTowardMastery: true,
        assisted: false,
        evidenceKind: "rubric_assessment",
        observedAtMs: 10 * DAY_MS,
        rubricScore: { kind: "exact", score: 9.0 },
      },
    ];
    const blockedFutureShell = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: futureOrShellEvidence,
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: 2 * DAY_MS,
    });
    expect(blockedFutureShell.status).toBe("insufficient_independent_evidence");
    if (blockedFutureShell.status === "insufficient_independent_evidence") {
      expect(blockedFutureShell.missingSections).toEqual(["reading", "writing"]);
    }

    // [R4 P1-3] Deduplicate calibration observations by recordId and (learnerId, paperFamilyId).
    const dupById = Array.from({ length: 4 }, () => makeCalibrationRecords(1)[0]!);
    const dupByPair = Array.from({ length: 4 }, (_, idx) => ({ ...makeCalibrationRecords(1)[0]!, recordId: `dup-${idx}` }));
    expect(
      filterIndependentCalibrationRecords({
        records: dupById,
        blueprintId: IELTS_ACADEMIC_V1_BLUEPRINT.blueprintId,
        targetKind: "same_blueprint_mock",
      }).length,
    ).toBe(1);
    expect(
      filterIndependentCalibrationRecords({
        records: dupByPair,
        blueprintId: IELTS_ACADEMIC_V1_BLUEPRINT.blueprintId,
        targetKind: "same_blueprint_mock",
      }).length,
    ).toBe(1);

    // [R4 P1-5] Reject non-finite speedLoading and skillLoading on items and rubric parts.
    const badLoadBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) =>
        sec.sectionId === "listening" && sec.items
          ? {
              ...sec,
              items: [{ ...sec.items[0]!, timeModel: { ...sec.items[0]!.timeModel, speedLoading: Number.NaN } }, ...sec.items.slice(1)],
            }
          : sec.sectionId === "writing"
            ? {
                ...sec,
                parts: [{ ...sec.parts[0]!, timeModel: { ...sec.parts[0]!.timeModel!, skillLoading: { "ielts.writing.task1_overview": Number.POSITIVE_INFINITY } } }, ...sec.parts.slice(1)],
              }
            : sec,
      ),
    };
    const loadMissing = validateExamBlueprint(badLoadBp);
    expect(loadMissing).toContain("sections.listening.items.ielts-l-1.timeModel");
    expect(loadMissing).toContain("sections.writing.parts.writing-task-1.timeModel");

    // [R4 P1-6] shared_full_paper requires rubric part timeModel; exhausted clock awards score floor 0 & rightCensored: true.
    const missingRubricTimeBp = createSharedFullPaperBlueprint({
      blueprintId: "shared-no-rubric-tm",
      title: "Missing Rubric TM",
      totalTimeLimitMinutes: 30,
      totalPoints: 20,
      skillIds: ["s1"],
      sections: [
        {
          sectionId: "essay",
          label: "Essay",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 20],
          scoreStep: 1,
          parts: [{ partId: "e1", label: "E1", weight: 1, skillIds: ["s1"] }],
        },
      ],
    });
    expect(validateExamBlueprint(missingRubricTimeBp)).toContain("sections.essay.parts.e1.timeModel");

    const exhaustedRubricBp = createSharedFullPaperBlueprint({
      blueprintId: "shared-exhausted-rubric",
      title: "Exhausted Clock Rubric Floor",
      totalTimeLimitMinutes: 10,
      totalPoints: 20,
      skillIds: ["s1", "s2"],
      sections: [
        {
          sectionId: "mcq",
          label: "MCQ",
          scoringKind: "item_raw_table",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 10],
          scoreStep: 1,
          parts: [{ partId: "mcq-p1", label: "P1", weight: 1, skillIds: ["s1"] }],
          items: [
            {
              itemId: "m-long",
              sectionId: "mcq",
              partId: "mcq-p1",
              skillIds: ["s1"],
              guess: 0,
              lapse: 0,
              points: 10,
              timeModel: { mu: Math.log(900), speedLoading: 0, skillLoading: { s1: 0 }, sigma: 0.01 },
            },
          ],
          rawToBandTable: Array.from({ length: 11 }, (_, raw) => ({ rawMin: raw, rawMax: raw, score: raw })),
        },
        {
          sectionId: "essay",
          label: "Essay",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 10],
          scoreStep: 1,
          parts: [
            {
              partId: "essay-unstarted",
              label: "Essay",
              weight: 1,
              skillIds: ["s2"],
              timeModel: { mu: Math.log(300), speedLoading: 0, skillLoading: { s2: 0 }, sigma: 0.01 },
            },
          ],
        },
      ],
    });
    const exhaustedSim = simulateExamPaper({
      blueprint: exhaustedRubricBp,
      learnerId: "l",
      beliefs: {
        s1: createSkillBelief({ workspaceId: "w", learnerId: "l", courseId: "c", confirmedSkillVersion: 1, abilityMean: 3, lastDirectRecallAtMs: 0 }),
        s2: createSkillBelief({ workspaceId: "w", learnerId: "l", courseId: "c", confirmedSkillVersion: 1, abilityMean: 3, lastDirectRecallAtMs: 0 }),
      },
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 10,
      seed: 3,
    });
    expect(exhaustedSim.sectionSummaries["essay"]!.timedMeanScore).toBe(0);
    expect(exhaustedSim.sampleRightCensoredItems.some((o) => o.partId === "essay-unstarted" && o.rightCensored && o.observedTimeSeconds === null)).toBe(true);

    // [R4 P1-7 & P2-2] Prototype-safe Map accumulation & set-union action deduplication by actionId.
    const protoAction: CandidateStudyAction = {
      actionId: "dup-action",
      title: "Prototype Safe Action",
      durationHours: 1,
      kind: "skill_repair",
      skillEffects: {
        constructor: { abilityDelta: 0.5 },
        "ielts.reading.inference": { abilityDelta: 1.0 },
      },
    };
    const dupEval = evaluateCrnActionRoi({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: 2 * DAY_MS,
      baselineActions: [protoAction],
      candidateAction: { ...protoAction, actionId: " dup-action " },
      crnSeed: 11,
      numDraws: 40,
    });
    expect(dupEval.pairedMeanGain).toBe(0);
    expect(dupEval.monteCarloSe).toBe(0);
    expect(({} as { abilityDelta?: number }).abilityDelta).toBeUndefined();

    // [R4 P2-1] Matched CRN untimed counterfactual yields exact 0 difference when zero draws censor.
    const ampleClockBlueprint = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((section) => ({
        ...section,
        timeLimitMinutes: 600,
      })),
    };
    const uncensoredSim = simulateExamPaper({
      blueprint: ampleClockBlueprint,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      numDraws: 40,
      seed: 9,
    });
    expect(Object.values(uncensoredSim.rightCensoringRateBySection).every((rate) => rate === 0)).toBe(true);
    expect(uncensoredSim.matchedTimeSqueezeDelta).toBe(0);
    const uncensoredRoi = evaluateCrnActionRoi({
      blueprint: ampleClockBlueprint,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      baselineActions: [],
      candidateAction: { actionId: "speed-noop", title: "Speed", durationHours: 1, kind: "speed_drill", expectedSpeedShift: 0.5 },
      crnSeed: 9,
      numDraws: 40,
    });
    expect(uncensoredRoi.timeSqueezeReduction).toBe(0);

    // [R4 P2-3] Exact numeric target-key lookup: 7.04:6.5 must NOT match "7.0:6.5".
    const sim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      numDraws: 30,
      seed: 1,
    });
    const fixedKeyCal = makeCalibrationRecords(4).map((r, idx) => ({
      ...r,
      predictedTargetPassProbs: undefined,
      predictedJointPassByTarget: { "7.0:6.5": 0.2 + idx * 0.2 },
    }));
    const mismatchKeyRes = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: fixedKeyCal,
      targets: [{ targetOverall: 7.04, targetMinSection: 6.5 }],
    });
    expect(mismatchKeyRes[0]!.calibrationSampleCount).toBe(0);
    expect(mismatchKeyRes[0]!.calibratedProbability).toBeNull();

    // [R4 P2-4] Scale-aware Cholesky preserves tiny positive pivots in valid rank-one PSD matrices.
    const scaledPsd = choleskyDecompose([
      [2 ** -82, 2 ** -21],
      [2 ** -21, 2 ** 40],
    ]);
    expect(scaledPsd[0]![0]).toBeCloseTo(2 ** -41, 15);
    expect(scaledPsd[1]![0]).toBeCloseTo(2 ** 20, 5);
    expect(scaledPsd[1]![1]).toBe(0);

    // [R4 P2-5] Reject invalid numDraws & empty draws in calibrateJointPassTargets.
    expect(() =>
      simulateExamPaper({ blueprint: IELTS_ACADEMIC_V1_BLUEPRINT, learnerId: "learner-target", beliefs, evidence, examAtMs: DAY_MS, numDraws: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      simulateExamPaper({ blueprint: IELTS_ACADEMIC_V1_BLUEPRINT, learnerId: "learner-target", beliefs, evidence, examAtMs: DAY_MS, numDraws: 50_001 }),
    ).toThrow(RangeError);
    expect(() =>
      calibrateJointPassTargets({
        simulation: { ...sim, timedScores: [], drawSectionScores: [] },
        blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
        calibrationRecords: makeCalibrationRecords(4),
        targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
      }),
    ).toThrow(RangeError);
  });

  it("enforces all Round-5 4 P1 & 7 P2 invariants", () => {
    const beliefs = makeIeltsBeliefs({ abilityMean: 0.4, logStability: Math.log(14), lastDirectRecallAtMs: 0 });
    const evidence = makeIndependentSectionEvidence(1_000);

    // [R5 P1-1] Scope anchors to (sectionId, partId) & reject mismatched partId records.
    const crossSectionAnchorSpoof: ExamEvidenceRecord = {
      evidenceId: "ev-listening-spoof-w2",
      learnerId: "learner-target",
      paperFamilyId: "diag-family-spoof",
      sectionId: "listening",
      partId: "writing-task-2",
      countsTowardMastery: true,
      assisted: false,
      evidenceKind: "rubric_assessment",
      observedAtMs: 2_000,
      observedScore: { kind: "exact", score: 9.0 },
    };
    const lowWritingEvidence: ExamEvidenceRecord[] = [
      ...evidence.filter((e) => e.sectionId !== "writing"),
      {
        evidenceId: "ev-w-low",
        learnerId: "learner-target",
        paperFamilyId: "diag-family-w",
        sectionId: "writing",
        partId: "writing-task-2",
        countsTowardMastery: true,
        assisted: false,
        evidenceKind: "rubric_assessment",
        observedAtMs: 1_000,
        rubricScore: { kind: "exact", score: 4.0 },
      },
      crossSectionAnchorSpoof,
    ];
    const anchoredLowSim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: lowWritingEvidence,
      examAtMs: DAY_MS,
      numDraws: 40,
      seed: 19,
    });
    const cleanLowSim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: lowWritingEvidence.filter((e) => e.evidenceId !== "ev-listening-spoof-w2"),
      examAtMs: DAY_MS,
      numDraws: 40,
      seed: 19,
    });
    expect(anchoredLowSim.sectionSummaries["writing"]!.timedMeanScore).toBeCloseTo(
      cleanLowSim.sectionSummaries["writing"]!.timedMeanScore,
      8,
    );
    expect(anchoredLowSim.sectionSummaries["writing"]!.timedMeanScore).toBeLessThan(5.0);

    const mismatchedCoverage = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: [
        ...evidence.filter((e) => e.sectionId !== "writing" && e.sectionId !== "listening"),
        crossSectionAnchorSpoof,
      ],
      calibrationRecords: makeCalibrationRecords(4),
      examAtMs: DAY_MS,
    });
    expect(mismatchedCoverage.status).toBe("insufficient_independent_evidence");
    if (mismatchedCoverage.status === "insufficient_independent_evidence") {
      expect(mismatchedCoverage.missingSections).toEqual(["listening", "writing"]);
    }

    // [R5 P1-2] Reject out-of-range fluencyScore / pauseRatio / speechRateWpm & match scoring predicate.
    const invalidFluencyReceipt: ExamEvidenceRecord = {
      evidenceId: "sp-bad-fluency",
      learnerId: "learner-target",
      sectionId: "speaking",
      countsTowardMastery: true,
      assisted: false,
      evidenceKind: "speech_timing",
      observedAtMs: 1_000,
      speechTimingReceipt: {
        receiptId: "sr-bad-f",
        durationSeconds: 120,
        speechRateWpm: 125,
        fluencyScore: 99,
        calibrated: true,
      },
    };
    const invalidPauseReceipt: ExamEvidenceRecord = {
      ...invalidFluencyReceipt,
      evidenceId: "sp-bad-pause",
      speechTimingReceipt: {
        receiptId: "sr-bad-p",
        durationSeconds: 120,
        speechRateWpm: 125,
        pauseRatio: 1.5,
        calibrated: true,
      },
    };
    const invalidWpmReceipt: ExamEvidenceRecord = {
      ...invalidFluencyReceipt,
      evidenceId: "sp-bad-wpm",
      speechTimingReceipt: {
        receiptId: "sr-bad-w",
        durationSeconds: 120,
        speechRateWpm: -5,
        fluencyScore: 7.0,
        calibrated: true,
      },
    };
    expect(partitionExamEvidence([invalidFluencyReceipt, invalidPauseReceipt, invalidWpmReceipt]).admitted).toEqual([]);
    const speakingBaseline = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: {},
      evidence: evidence.filter((e) => e.sectionId !== "speaking"),
      examAtMs: DAY_MS,
      numDraws: 40,
      seed: 21,
    });
    const speakingWithInvalidFluency = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs: {},
      evidence: [...evidence.filter((e) => e.sectionId !== "speaking"), invalidFluencyReceipt],
      examAtMs: DAY_MS,
      numDraws: 40,
      seed: 21,
    });
    expect(speakingWithInvalidFluency.sectionSummaries["speaking"]!.timedMeanScore).toBeCloseTo(
      speakingBaseline.sectionSummaries["speaking"]!.timedMeanScore,
      8,
    );

    // [R5 P1-3] Direct simulateExamPaper and evaluateCrnActionRoi enforce validateExamBlueprint.
    const invalidSharedBp = createSharedFullPaperBlueprint({
      blueprintId: "shared-invalid-entry",
      title: "Missing Rubric TM",
      totalTimeLimitMinutes: 30,
      totalPoints: 20,
      skillIds: ["s1"],
      sections: [
        {
          sectionId: "essay",
          label: "Essay",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 20],
          scoreStep: 1,
          parts: [{ partId: "e1", label: "E1", weight: 1, skillIds: ["s1"] }],
        },
      ],
    });
    expect(() =>
      simulateExamPaper({ blueprint: invalidSharedBp, learnerId: "l", beliefs: {}, evidence: [], examAtMs: DAY_MS }),
    ).toThrow(RangeError);
    expect(() =>
      evaluateCrnActionRoi({
        blueprint: invalidSharedBp,
        learnerId: "l",
        beliefs: {},
        evidence: [],
        examAtMs: DAY_MS,
        baselineActions: [],
        candidateAction: { actionId: "a", title: "A", durationHours: 1, kind: "skill_repair" },
        crnSeed: 1,
      }),
    ).toThrow(RangeError);

    // [R5 P1-4] Direct calibrateJointPassTargets deduplicates recordId and (learnerId, paperFamilyId).
    const sim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      numDraws: 30,
      seed: 5,
    });
    const oneRec = makeCalibrationRecords(1)[0]!;
    const dupJointSameId = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: [oneRec, oneRec, oneRec, oneRec],
      targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
    });
    const dupJointSamePair = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: Array.from({ length: 4 }, (_, idx) => ({ ...oneRec, recordId: `dup-joint-${idx}` })),
      targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
    });
    expect(dupJointSameId[0]!.calibrationSampleCount).toBe(1);
    expect(dupJointSameId[0]!.isCalibrated).toBe(false);
    expect(dupJointSameId[0]!.calibratedProbability).toBeNull();
    expect(dupJointSamePair[0]!.calibrationSampleCount).toBe(1);
    expect(dupJointSamePair[0]!.isCalibrated).toBe(false);

    // [R5 P2-1] Exact numeric equality on array-backed target lookup.
    const exactMatchCal = makeCalibrationRecords(4);
    const fuzzyTargetRes = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: exactMatchCal,
      targets: [{ targetOverall: 7.0000000005, targetMinSection: 6.5 }],
    });
    expect(fuzzyTargetRes[0]!.calibrationSampleCount).toBe(0);
    expect(fuzzyTargetRes[0]!.calibratedProbability).toBeNull();

    // [R5 P2-2] Entry-local Cauchy-Schwarz zero-pivot tolerance vs scaled rank-1 PSD.
    expect(() =>
      choleskyDecompose([
        [0, 5e-5, 0],
        [5e-5, 1e-8, 0],
        [0, 0, 1e8],
      ]),
    ).toThrow(/positive semidefinite/);
    const scaledPsd = choleskyDecompose([
      [2 ** -82, 2 ** -21],
      [2 ** -21, 2 ** 40],
    ]);
    expect(scaledPsd[0]![0]).toBeCloseTo(2 ** -41, 15);
    expect(scaledPsd[1]![0]).toBeCloseTo(2 ** 20, 5);
    expect(scaledPsd[1]![1]).toBe(0);
    expect(() =>
      choleskyDecompose([
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ]),
    ).not.toThrow();

    // [R5 P2-3] Independent numDraws & precomputedDraws.length validation.
    const oneDraw = [
      {
        zLatent: Array.from({ length: IELTS_ACADEMIC_SKILL_IDS.length }, () => 0),
        nuSpeed: 0,
        itemUniforms: Array.from({ length: 80 }, () => 0.5),
        itemTimeNormals: Array.from({ length: 80 }, () => 0),
        rubricScoreNormals: Array.from({ length: 5 }, () => 0),
        rubricTimeNormals: Array.from({ length: 5 }, () => 0),
      },
    ];
    expect(() =>
      simulateExamPaper({
        blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
        learnerId: "learner-target",
        beliefs,
        evidence,
        examAtMs: DAY_MS,
        numDraws: 0,
        precomputedDraws: oneDraw,
      }),
    ).toThrow(RangeError);
    expect(() =>
      evaluateCrnActionRoi({
        blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
        learnerId: "learner-target",
        beliefs,
        evidence,
        examAtMs: DAY_MS,
        baselineActions: [],
        candidateAction: { actionId: "valid", title: "Valid", durationHours: 1, kind: "skill_repair" },
        crnSeed: 1,
        numDraws: 2,
        precomputedDraws: oneDraw,
      }),
    ).toThrow(RangeError);

    // [R5 P2-4] Recovery allocation excludes trimmed baseline action IDs.
    const restSnap = buildUnifiedDecisionSnapshot({
      decisionId: "dec-rest-dedup",
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      calibrationRecords: makeCalibrationRecords(5),
      examAtMs: DAY_MS,
      crnSeed: 3,
      horizonHours: 48,
      executableMinutes: 600,
      baselineActions: [{ actionId: "rest", title: "Baseline Rest", durationHours: 1, kind: "recovery", recoveryMinutes: 60 }],
      candidateActions: [{ actionId: " rest ", title: "Dup Rest", durationHours: 1, kind: "recovery", recoveryMinutes: 60 }],
      numDraws: 30,
    });
    expect(restSnap.allocatedRecoveryMinutes).toBe(0);
    expect(restSnap.selectedActionIds).toEqual([]);

    // [R5 P2-5] Populate partCensoringRates for censored rubric parts.
    const exhaustedRubricBp = createSharedFullPaperBlueprint({
      blueprintId: "shared-rubric-part-rate",
      title: "Rubric Part Censoring Rate",
      totalTimeLimitMinutes: 10,
      totalPoints: 20,
      skillIds: ["s1", "s2"],
      sections: [
        {
          sectionId: "mcq",
          label: "MCQ",
          scoringKind: "item_raw_table",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 10],
          scoreStep: 1,
          parts: [{ partId: "mcq-p1", label: "P1", weight: 1, skillIds: ["s1"] }],
          items: [
            {
              itemId: "m-long",
              sectionId: "mcq",
              partId: "mcq-p1",
              skillIds: ["s1"],
              guess: 0,
              lapse: 0,
              points: 10,
              timeModel: { mu: Math.log(900), speedLoading: 0, skillLoading: { s1: 0 }, sigma: 0.01 },
            },
          ],
          rawToBandTable: Array.from({ length: 11 }, (_, raw) => ({ rawMin: raw, rawMax: raw, score: raw })),
        },
        {
          sectionId: "essay",
          label: "Essay",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 10],
          scoreStep: 1,
          parts: [
            {
              partId: "essay-unstarted",
              label: "Essay",
              weight: 1,
              skillIds: ["s2"],
              timeModel: { mu: Math.log(300), speedLoading: 0, skillLoading: { s2: 0 }, sigma: 0.01 },
            },
          ],
        },
      ],
    });
    const rubricRateSim = simulateExamPaper({
      blueprint: exhaustedRubricBp,
      learnerId: "l",
      beliefs: {
        s1: createSkillBelief({ workspaceId: "w", learnerId: "l", courseId: "c", confirmedSkillVersion: 1, abilityMean: 3, lastDirectRecallAtMs: 0 }),
        s2: createSkillBelief({ workspaceId: "w", learnerId: "l", courseId: "c", confirmedSkillVersion: 1, abilityMean: 3, lastDirectRecallAtMs: 0 }),
      },
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 10,
      seed: 3,
    });
    expect(rubricRateSim.sectionSummaries["essay"]!.partCensoringRates["essay-unstarted"]).toBe(1);
    expect(rubricRateSim.sectionSummaries["essay"]!.censoredItemFraction).toBe(1);

    // [R5 P2-6] Prototype-safe itemSuccessProbability on external direct calls.
    const protoProb = itemSuccessProbability(
      {
        itemId: "proto-item",
        sectionId: "reading",
        partId: "reading-passage-1",
        skillIds: ["constructor"],
        guess: 0.25,
        lapse: 0.05,
        timeModel: { mu: 4, speedLoading: 0.1, skillLoading: {}, sigma: 0.1 },
      },
      {},
    );
    expect(protoProb).toBeCloseTo(0.25 + 0.7 * 0.5, 10);

    // [R5 P2-7] Blank candidateAction.actionId throws RangeError in evaluateCrnActionRoi.
    expect(() =>
      evaluateCrnActionRoi({
        blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
        learnerId: "learner-target",
        beliefs,
        evidence,
        examAtMs: DAY_MS,
        baselineActions: [],
        candidateAction: { actionId: "   ", title: "Blank ID", durationHours: 1, kind: "skill_repair" },
        crnSeed: 1,
      }),
    ).toThrow(RangeError);
  });

  it("enforces all Round-6 2 P1 & 4 P2 invariants", () => {
    const beliefs = makeIeltsBeliefs({ abilityMean: 0.4, logStability: Math.log(14), lastDirectRecallAtMs: 0 });
    const evidence = makeIndependentSectionEvidence(1_000);

    // [R6 P1-1] Gate speech_timing receipt coverage strictly on sectionId === "speaking".
    const writingSpeechReceipt: ExamEvidenceRecord = {
      evidenceId: "ev-writing-speech-receipt",
      learnerId: "learner-target",
      paperFamilyId: "diag-family-writing-speech",
      sectionId: "writing",
      partId: "writing-task-2",
      countsTowardMastery: true,
      assisted: false,
      evidenceKind: "speech_timing",
      observedAtMs: 1_500,
      speechTimingReceipt: {
        receiptId: "sr-writing",
        durationSeconds: 90,
        speechRateWpm: 120,
        calibrated: true,
      },
    };
    expect(partitionExamEvidence([writingSpeechReceipt]).admitted).toEqual([]);
    const writingSpeechForecast = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence: [...evidence.filter((e) => e.sectionId !== "writing"), writingSpeechReceipt],
      calibrationRecords: makeCalibrationRecords(4),
      examAtMs: DAY_MS,
    });
    expect(writingSpeechForecast.status).toBe("insufficient_independent_evidence");
    if (writingSpeechForecast.status === "insufficient_independent_evidence") {
      expect(writingSpeechForecast.missingSections).toContain("writing");
    }

    // [R6 P1-2] calibrateJointPassTargets enforces whole-paper source & targetKind scope even when targetKind is omitted.
    const sim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      numDraws: 30,
      seed: 11,
    });
    const nonWholePaperCal = makeCalibrationRecords(4).map((r, idx) => ({
      ...r,
      targetKind: idx < 2 ? ("official_exam" as const) : ("same_blueprint_mock" as const),
      evidenceKind: "diagnostic_item" as const,
    }));
    const rejectedDiagnosticJoint = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: nonWholePaperCal,
      targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
    });
    expect(rejectedDiagnosticJoint[0]!.calibrationSampleCount).toBe(0);
    expect(rejectedDiagnosticJoint[0]!.isCalibrated).toBe(false);

    const officialCal = makeCalibrationRecords(4).map((r) => ({
      ...r,
      targetKind: "official_exam" as const,
      evidenceKind: "official_exam" as const,
    }));
    const defaultScopeExcludesOfficial = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: officialCal,
      targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
    });
    expect(defaultScopeExcludesOfficial[0]!.calibrationSampleCount).toBe(0);
    const explicitOfficialCal = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: officialCal,
      targetKind: "official_exam",
      targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
    });
    expect(explicitOfficialCal[0]!.calibrationSampleCount).toBe(4);
    expect(explicitOfficialCal[0]!.isCalibrated).toBe(true);

    // [R6 P2-1] Cholesky off-diagonal tolerance avoids product overflow on huge variances (2 ** 1020).
    const bigS = 2 ** 1020;
    expect(() =>
      choleskyDecompose([
        [bigS, bigS, 0],
        [bigS, bigS, bigS / 2],
        [0, bigS / 2, bigS],
      ]),
    ).toThrow(/positive semidefinite/);

    // [R6 P2-2] No \u0000 or : pair-key collisions across anchors, calibration dedup, or part censoring rates.
    const anchorCollisionBp = createSharedFullPaperBlueprint({
      blueprintId: "collision-anchors-bp",
      title: "Anchor Collision Test",
      totalTimeLimitMinutes: 120,
      totalPoints: 18,
      skillIds: ["s1", "s2"],
      sections: [
        {
          sectionId: "a\u0000b",
          label: "Sec AB",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 0.5,
          scoreRange: [0, 9],
          scoreStep: 0.5,
          parts: [{ partId: "c", label: "Part C", weight: 1, skillIds: ["s1"], timeModel: { mu: Math.log(120), speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
        },
        {
          sectionId: "a",
          label: "Sec A",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 0.5,
          scoreRange: [0, 9],
          scoreStep: 0.5,
          parts: [{ partId: "b\u0000c", label: "Part BC", weight: 1, skillIds: ["s2"], timeModel: { mu: Math.log(120), speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
        },
      ],
    });
    const collidedAnchorSim = simulateExamPaper({
      blueprint: anchorCollisionBp,
      learnerId: "learner-target",
      beliefs: {
        s1: createSkillBelief({ workspaceId: "w", learnerId: "learner-target", courseId: "c", confirmedSkillVersion: 1, abilityMean: 0, lastDirectRecallAtMs: 0 }),
        s2: createSkillBelief({ workspaceId: "w", learnerId: "learner-target", courseId: "c", confirmedSkillVersion: 1, abilityMean: 0, lastDirectRecallAtMs: 0 }),
      },
      evidence: [
        {
          evidenceId: "anc-1",
          learnerId: "learner-target",
          sectionId: "a\u0000b",
          partId: "c",
          countsTowardMastery: true,
          assisted: false,
          evidenceKind: "rubric_assessment",
          observedAtMs: 1_000,
          rubricScore: { kind: "exact", score: 8.5 },
        },
        {
          evidenceId: "anc-2",
          learnerId: "learner-target",
          sectionId: "a",
          partId: "b\u0000c",
          countsTowardMastery: true,
          assisted: false,
          evidenceKind: "rubric_assessment",
          observedAtMs: 1_000,
          rubricScore: { kind: "exact", score: 2.0 },
        },
      ],
      examAtMs: DAY_MS,
      numDraws: 15,
      seed: 13,
    });
    expect(collidedAnchorSim.sectionSummaries["a\u0000b"]!.timedMeanScore).toBeGreaterThan(7.0);
    expect(collidedAnchorSim.sectionSummaries["a"]!.timedMeanScore).toBeLessThan(4.0);

    const baseCal = makeCalibrationRecords(1)[0]!;
    const pairCollisionCal: WholePaperCalibrationRecord[] = [
      { ...baseCal, recordId: "pc-1", learnerId: "a", paperFamilyId: "b\u0000c" },
      { ...baseCal, recordId: "pc-2", learnerId: "a\u0000b", paperFamilyId: "c" },
    ];
    expect(
      filterIndependentCalibrationRecords({
        records: pairCollisionCal,
        blueprintId: IELTS_ACADEMIC_V1_BLUEPRINT.blueprintId,
        targetKind: "same_blueprint_mock",
        scoreRange: IELTS_ACADEMIC_V1_BLUEPRINT.scoreRange,
        sectionRanges: new Map(IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((s) => [s.sectionId, s.scoreRange] as const)),
      }).length,
    ).toBe(2);
    expect(
      calibrateJointPassTargets({
        simulation: sim,
        blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
        calibrationRecords: pairCollisionCal,
        targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
      })[0]!.calibrationSampleCount,
    ).toBe(2);

    const colonCollisionBp = createSharedFullPaperBlueprint({
      blueprintId: "colon-censor-collision",
      title: "Colon Pair Censor Collision",
      totalTimeLimitMinutes: 10,
      totalPoints: 20,
      skillIds: ["s1", "s2"],
      sections: [
        {
          sectionId: "a",
          label: "Sec A",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 10],
          scoreStep: 1,
          parts: [
            { partId: "b:c", label: "Fast", weight: 0.5, skillIds: ["s1"], timeModel: { mu: Math.log(120), speedLoading: 0, skillLoading: {}, sigma: 0.01 } },
            { partId: "burn", label: "Burn", weight: 0.5, skillIds: ["s1"], timeModel: { mu: Math.log(800), speedLoading: 0, skillLoading: {}, sigma: 0.01 } },
          ],
        },
        {
          sectionId: "a:b",
          label: "Sec AB",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 10],
          scoreStep: 1,
          parts: [
            { partId: "c", label: "Unstarted", weight: 1, skillIds: ["s2"], timeModel: { mu: Math.log(300), speedLoading: 0, skillLoading: {}, sigma: 0.01 } },
          ],
        },
      ],
    });
    const colonSim = simulateExamPaper({
      blueprint: colonCollisionBp,
      learnerId: "l",
      beliefs: {},
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 12,
      seed: 17,
    });
    expect(colonSim.sectionSummaries["a"]!.partCensoringRates["b:c"]).toBe(0);
    expect(colonSim.sectionSummaries["a:b"]!.partCensoringRates["c"]).toBe(1);

    // [R6 P2-3] Raw conversion table scores must be finite and within section.scoreRange.
    const badRawScoreBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) =>
        sec.sectionId === "listening" && sec.rawToBandTable
          ? {
              ...sec,
              rawToBandTable: sec.rawToBandTable.map((row, idx) => (idx === 0 ? { ...row, score: 90 } : row)),
            }
          : sec,
      ),
    };
    expect(validateExamBlueprint(badRawScoreBp)).toContain("sections.listening.rawToBandTable");

    // [R6 P2-4] Reject out-of-range observedScore and observedSectionScores in calibration.
    const outOfRangeCal = makeCalibrationRecords(4).map((r, idx) =>
      idx === 0
        ? { ...r, observedSectionScores: { listening: 7.0, reading: 99, writing: 7.0, speaking: 7.0 } }
        : idx === 1
          ? { ...r, observedScore: { kind: "exact" as const, score: 12 } }
          : r,
    );
    expect(
      filterIndependentCalibrationRecords({
        records: outOfRangeCal,
        blueprintId: IELTS_ACADEMIC_V1_BLUEPRINT.blueprintId,
        targetKind: "same_blueprint_mock",
        scoreRange: IELTS_ACADEMIC_V1_BLUEPRINT.scoreRange,
        sectionRanges: new Map(IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((s) => [s.sectionId, s.scoreRange] as const)),
      }).length,
    ).toBe(2);
    const outOfRangeJoint = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: outOfRangeCal,
      targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
    });
    expect(outOfRangeJoint[0]!.calibrationSampleCount).toBe(2);
    expect(outOfRangeJoint[0]!.isCalibrated).toBe(false);
    expect(outOfRangeJoint[0]!.calibratedProbability).toBeNull();
    const outOfRangeForecast = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      calibrationRecords: outOfRangeCal,
      examAtMs: DAY_MS,
    });
    expect(outOfRangeForecast.status).toBe("insufficient_independent_evidence");
    if (outOfRangeForecast.status === "insufficient_independent_evidence") {
      expect(outOfRangeForecast.calibrationCount).toBe(2);
    }
  });

  it("enforces all Round-7 5 P1 & 6 P2 invariants", () => {
    const beliefs = makeIeltsBeliefs({ abilityMean: 0.4, logStability: Math.log(14), lastDirectRecallAtMs: 0 });
    const evidence = makeIndependentSectionEvidence(1_000);

    // [R7 P1-1] Missing canonical IELTS section fails validateExamBlueprint, evaluateExamForecast, and simulateExamPaper.
    const noListeningBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.filter((sec) => sec.sectionId !== "listening"),
    };
    expect(validateExamBlueprint(noListeningBp)).toContain("sections.listening");
    const noListeningForecast = evaluateExamForecast({
      blueprint: noListeningBp,
      learnerId: "learner-target",
      beliefs,
      evidence: evidence.filter((e) => e.sectionId !== "listening"),
      calibrationRecords: makeCalibrationRecords(4),
      examAtMs: DAY_MS,
    });
    expect(noListeningForecast.status).toBe("insufficient_blueprint");
    expect(() =>
      simulateExamPaper({ blueprint: noListeningBp, learnerId: "learner-target", beliefs, evidence, examAtMs: DAY_MS }),
    ).toThrow(RangeError);

    // [R7 P1-2] Prototype-safe dictionaries for sectionId/partId "__proto__".
    const protoSectionBp = createSharedFullPaperBlueprint({
      blueprintId: "proto-section-bp",
      title: "Prototype-Safe Section Key",
      totalTimeLimitMinutes: 60,
      totalPoints: 9,
      skillIds: ["__proto__"],
      sections: [
        {
          sectionId: "__proto__",
          label: "Proto Section",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 9],
          scoreStep: 0.5,
          parts: [
            {
              partId: "__proto__",
              label: "Proto Part",
              weight: 1,
              skillIds: ["__proto__"],
              timeModel: { mu: Math.log(60), speedLoading: 0, skillLoading: {}, sigma: 0.01 },
            },
          ],
        },
      ],
      thetaCovariance: [[0]],
    });
    const protoAnchoredSim = simulateExamPaper({
      blueprint: protoSectionBp,
      learnerId: "learner-target",
      beliefs: {
        ["__proto__"]: createSkillBelief({
          workspaceId: "w",
          learnerId: "learner-target",
          courseId: "c",
          confirmedSkillVersion: 1,
          abilityMean: 0,
          abilityVariance: 0,
          lastDirectRecallAtMs: 0,
        }),
      },
      evidence: [
        {
          evidenceId: "ev-proto",
          learnerId: "learner-target",
          sectionId: "__proto__",
          partId: "__proto__",
          countsTowardMastery: true,
          assisted: false,
          evidenceKind: "rubric_assessment",
          observedAtMs: 1_000,
          rubricScore: { kind: "exact", score: 7 },
        },
      ],
      examAtMs: 1_000,
      numDraws: 12,
      seed: 19,
    });
    expect(protoAnchoredSim.timedExpectedScore).toBe(7);
    expect(Object.getPrototypeOf(protoAnchoredSim.sectionSummaries)).toBe(Object.prototype);
    expect(Object.hasOwn(protoAnchoredSim.sectionSummaries, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(protoAnchoredSim.sectionSummaries, "__proto__")?.value.timedMeanScore).toBe(7);
    expect(Object.hasOwn(protoAnchoredSim.rightCensoringRateBySection, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)["timedMeanScore"]).toBeUndefined();

    // [R7 P1-3] Reject huge item points (2 ** 53) immediately without hanging hasCompleteRawTable.
    const hugePointsBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) =>
        sec.sectionId === "listening" && sec.items
          ? {
              ...sec,
              items: [{ ...sec.items[0]!, points: 2 ** 53 }, ...sec.items.slice(1)],
            }
          : sec,
      ),
    };
    const hugeStart = performance.now();
    const hugeErrors = validateExamBlueprint(hugePointsBp);
    expect(performance.now() - hugeStart).toBeLessThan(100);
    expect(hugeErrors).toContain("sections.listening.items.ielts-l-1.points");
    expect(hugeErrors).toContain("sections.listening.rawToBandTable");

    // [R7 P1-4] Reject post-exam / future calibration records (recordedAtMs > examAtMs).
    const futureCal = makeCalibrationRecords(4).map((rec) => ({
      ...rec,
      recordedAtMs: DAY_MS + 1,
    }));
    expect(
      filterIndependentCalibrationRecords({
        records: futureCal,
        blueprintId: IELTS_ACADEMIC_V1_BLUEPRINT.blueprintId,
        targetKind: "same_blueprint_mock",
        scoreRange: IELTS_ACADEMIC_V1_BLUEPRINT.scoreRange,
        sectionRanges: new Map(IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((s) => [s.sectionId, s.scoreRange] as const)),
        examAtMs: DAY_MS,
      }),
    ).toEqual([]);
    const simDefault = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      seed: 42,
    });
    const futureJoint = calibrateJointPassTargets({
      simulation: simDefault,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: futureCal,
      targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
      examAtMs: DAY_MS,
    });
    expect(futureJoint[0]!.calibrationSampleCount).toBe(0);
    expect(futureJoint[0]!.isCalibrated).toBe(false);
    const futureForecast = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      calibrationRecords: futureCal,
      examAtMs: DAY_MS,
    });
    expect(futureForecast.status).toBe("insufficient_independent_evidence");
    if (futureForecast.status === "insufficient_independent_evidence") {
      expect(futureForecast.calibrationCount).toBe(0);
    }

    // [R7 P1-5] Section floor checks each section's scoreRange[0], never blueprint.scoreRange[0].
    const signedSplitBp = createSharedFullPaperBlueprint({
      blueprintId: "signed-split-bp",
      title: "Signed Split Sections",
      totalTimeLimitMinutes: 60,
      totalPoints: 20,
      skillIds: ["s1", "s2"],
      sections: [
        {
          sectionId: "sec1",
          label: "Sec 1",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 0.5,
          scoreRange: [-5, 5],
          scoreStep: 1,
          parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["s1"], timeModel: { mu: Math.log(120), speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
        },
        {
          sectionId: "sec2",
          label: "Sec 2",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 0.5,
          scoreRange: [0, 10],
          scoreStep: 1,
          parts: [{ partId: "p2", label: "P2", weight: 1, skillIds: ["s2"], timeModel: { mu: Math.log(120), speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
        },
      ],
    });
    const signedSim = simulateExamPaper({ blueprint: signedSplitBp, learnerId: "l", beliefs: {}, evidence: [], examAtMs: DAY_MS, numDraws: 20, seed: 3 });
    const signedOmittedSec = calibrateJointPassTargets({
      simulation: signedSim,
      blueprint: signedSplitBp,
      calibrationRecords: [
        {
          recordId: "signed-1",
          learnerId: "cal-u1",
          paperFamilyId: "fam-1",
          blueprintId: "signed-split-bp",
          targetKind: "same_blueprint_mock",
          evidenceKind: "independent_mock",
          assisted: false,
          countsTowardMastery: true,
          predictedQuantiles: { q10: 2, q50: 5, q90: 8 },
          predictedTargetPassProbs: [{ targetOverall: 5, targetMinSection: 0, rawProbability: 0.6 }],
          observedScore: { kind: "exact", score: 5 },
          recordedAtMs: 1_000,
        },
      ],
      targets: [{ targetOverall: 5, targetMinSection: 0 }],
      minCalibrationSamples: 1,
    });
    expect(signedOmittedSec[0]!.calibratedProbability).toBe(0);

    const greBp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "gre-like-bp",
        title: "GRE Scale",
        totalTimeLimitMinutes: 120,
        totalPoints: 340,
        skillIds: ["v", "q"],
        sections: [
          {
            sectionId: "verbal",
            label: "Verbal",
            scoringKind: "rubric_band",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [130, 170],
            scoreStep: 1,
            parts: [{ partId: "vp", label: "VP", weight: 1, skillIds: ["v"], timeModel: { mu: Math.log(120), speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
          },
          {
            sectionId: "quant",
            label: "Quant",
            scoringKind: "rubric_band",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [130, 170],
            scoreStep: 1,
            parts: [{ partId: "qp", label: "QP", weight: 1, skillIds: ["q"], timeModel: { mu: Math.log(120), speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
          },
        ],
      }),
      scoreRange: [260, 340] as const,
    };
    const greSim = simulateExamPaper({ blueprint: greBp, learnerId: "l", beliefs: {}, evidence: [], examAtMs: DAY_MS, numDraws: 20, seed: 5 });
    const greOmittedSec = calibrateJointPassTargets({
      simulation: greSim,
      blueprint: greBp,
      calibrationRecords: [
        {
          recordId: "gre-1",
          learnerId: "cal-u2",
          paperFamilyId: "fam-gre",
          blueprintId: "gre-like-bp",
          targetKind: "same_blueprint_mock",
          evidenceKind: "independent_mock",
          assisted: false,
          countsTowardMastery: true,
          predictedQuantiles: { q10: 310, q50: 325, q90: 335 },
          predictedTargetPassProbs: [{ targetOverall: 320, targetMinSection: 160, rawProbability: 0.8 }],
          observedScore: { kind: "exact", score: 325 },
          recordedAtMs: 1_000,
        },
      ],
      targets: [{ targetOverall: 320, targetMinSection: 160 }],
      minCalibrationSamples: 1,
    });
    expect(greOmittedSec[0]!.calibratedProbability).toBe(0);

    // [R7 P2-1 + P2-2] Zero 1e-9 boundary slack: 9 + 5e-10 strictly rejected.
    const tinyOver = 9 + 5e-10;
    const slackTableBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) =>
        sec.sectionId === "listening" && sec.rawToBandTable
          ? {
              ...sec,
              rawToBandTable: sec.rawToBandTable.map((row, idx) =>
                idx === sec.rawToBandTable!.length - 1 ? { ...row, score: tinyOver } : row,
              ),
            }
          : sec,
      ),
    };
    expect(validateExamBlueprint(slackTableBp)).toContain("sections.listening.rawToBandTable");
    const slackCal = makeCalibrationRecords(4).map((rec, idx) =>
      idx === 0
        ? { ...rec, observedScore: { kind: "exact" as const, score: tinyOver } }
        : idx === 1
          ? { ...rec, observedSectionScores: { listening: tinyOver, reading: 7, writing: 7, speaking: 7 } }
          : rec,
    );
    expect(
      filterIndependentCalibrationRecords({
        records: slackCal,
        blueprintId: IELTS_ACADEMIC_V1_BLUEPRINT.blueprintId,
        targetKind: "same_blueprint_mock",
        scoreRange: IELTS_ACADEMIC_V1_BLUEPRINT.scoreRange,
        sectionRanges: new Map(IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((s) => [s.sectionId, s.scoreRange] as const)),
      }).length,
    ).toBe(2);
    expect(
      calibrateJointPassTargets({
        simulation: simDefault,
        blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
        calibrationRecords: slackCal,
        targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
      })[0]!.calibrationSampleCount,
    ).toBe(2);

    // [R7 P2-3] Default simulation draw count is 512 across all entry points.
    expect(simDefault.numDraws).toBe(512);
    const cal5 = makeCalibrationRecords(5);
    const forecastOmitted = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      calibrationRecords: cal5,
      examAtMs: DAY_MS,
      seed: 42,
    });
    const forecastExplicit512 = evaluateExamForecast({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      calibrationRecords: cal5,
      examAtMs: DAY_MS,
      numDraws: 512,
      seed: 42,
    });
    expect(forecastOmitted).toEqual(forecastExplicit512);
    const roiOmitted = evaluateCrnActionRoi({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      baselineActions: [],
      candidateAction: { actionId: "drill", title: "Drill", durationHours: 1, kind: "speed_drill", expectedSpeedShift: 0.5 },
      crnSeed: 42,
    });
    const roiExplicit512 = evaluateCrnActionRoi({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      baselineActions: [],
      candidateAction: { actionId: "drill", title: "Drill", durationHours: 1, kind: "speed_drill", expectedSpeedShift: 0.5 },
      crnSeed: 42,
      numDraws: 512,
    });
    expect(roiOmitted).toEqual(roiExplicit512);

    // [R7 P2-4] Scale-relative & permutation-invariant symmetry check rejects tiny-diagonal asymmetry.
    expect(() =>
      choleskyDecompose([
        [1e-12, 5e-9],
        [0, 1e-12],
      ]),
    ).toThrow(/symmetric/);
    expect(() =>
      choleskyDecompose([
        [1e-12, 0],
        [5e-9, 1e-12],
      ]),
    ).toThrow(/symmetric/);

    // [R7 P2-5] Partially completed rubric clock-overrun items are captured in sampleRightCensoredItems.
    const overrunRubricBp = createSharedFullPaperBlueprint({
      blueprintId: "overrun-rubric-bp",
      title: "Overrun Rubric Capture",
      totalTimeLimitMinutes: 1,
      totalPoints: 10,
      skillIds: ["s1"],
      sections: [
        {
          sectionId: "essay",
          label: "Essay",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 10],
          scoreStep: 1,
          parts: [
            {
              partId: "essay-overrun",
              label: "Essay",
              weight: 1,
              skillIds: ["s1"],
              timeModel: { mu: Math.log(120), speedLoading: 0, skillLoading: {}, sigma: 0.001 },
            },
          ],
        },
      ],
    });
    const overrunSim = simulateExamPaper({
      blueprint: overrunRubricBp,
      learnerId: "l",
      beliefs: {},
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 10,
      seed: 7,
    });
    expect(overrunSim.rightCensoringRateBySection["essay"]).toBe(1);
    expect(overrunSim.sampleRightCensoredItems.length).toBeGreaterThan(0);
    expect(overrunSim.sampleRightCensoredItems[0]).toMatchObject({
      sectionId: "essay",
      partId: "essay-overrun",
      attempted: true,
      rightCensored: true,
      observedTimeSeconds: 60,
    });

    // [R7 Neon P2-3] Reject non-finite JointPassTarget thresholds up front.
    expect(() =>
      calibrateJointPassTargets({
        simulation: simDefault,
        blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
        calibrationRecords: cal5,
        targets: [{ targetOverall: Number.NaN, targetMinSection: 6.5 }],
      }),
    ).toThrow(RangeError);
  });

  it("enforces all Round-8 4 P1 & 4 P2 invariants", () => {
    const beliefs = makeIeltsBeliefs({ abilityMean: 0.4, logStability: Math.log(14), lastDirectRecallAtMs: 0 });
    const evidence = makeIndependentSectionEvidence(1_000);

    // [R8 P1-1] Require monotonically non-decreasing rawToBandTable scores across raw scores.
    const invertedBandBp = createSharedFullPaperBlueprint({
      blueprintId: "inverted-raw-band",
      title: "Inverted Raw Band",
      totalTimeLimitMinutes: 30,
      totalPoints: 9,
      skillIds: ["s1"],
      sections: [
        {
          sectionId: "mcq",
          label: "MCQ",
          scoringKind: "item_raw_table",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 9],
          scoreStep: 1,
          parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["s1"] }],
          items: [
            {
              itemId: "q1",
              sectionId: "mcq",
              partId: "p1",
              skillIds: ["s1"],
              guess: 0,
              lapse: 0,
              points: 1,
              timeModel: { mu: 4, speedLoading: 0.1, skillLoading: {}, sigma: 0.1 },
            },
          ],
          rawToBandTable: [
            { rawMin: 0, rawMax: 0, score: 9 },
            { rawMin: 1, rawMax: 1, score: 0 },
          ],
        },
      ],
    });
    expect(validateExamBlueprint(invertedBandBp)).toContain("sections.mcq.rawToBandTable");
    expect(() =>
      simulateExamPaper({ blueprint: invertedBandBp, learnerId: "l", beliefs: {}, evidence: [], examAtMs: DAY_MS }),
    ).toThrow(RangeError);

    // [R8 P1-2] Validate precomputedDraws dimensions and uniform [0, 1) bounds upfront.
    const baseValidDraw = {
      zLatent: Array.from({ length: IELTS_ACADEMIC_SKILL_IDS.length }, () => 0),
      nuSpeed: 0,
      itemUniforms: Array.from({ length: 80 }, () => 0.5),
      itemTimeNormals: Array.from({ length: 80 }, () => 0),
      rubricScoreNormals: Array.from({ length: 5 }, () => 0),
      rubricTimeNormals: Array.from({ length: 5 }, () => 0),
    };
    for (const badDraw of [
      { ...baseValidDraw, itemUniforms: [] },
      { ...baseValidDraw, itemUniforms: Array.from({ length: 80 }, () => -1) },
      { ...baseValidDraw, itemUniforms: Array.from({ length: 80 }, () => 1) },
      { ...baseValidDraw, rubricScoreNormals: [] },
    ]) {
      expect(() =>
        simulateExamPaper({
          blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
          learnerId: "learner-target",
          beliefs,
          evidence,
          examAtMs: DAY_MS,
          precomputedDraws: [badDraw],
        }),
      ).toThrow(RangeError);
      expect(() =>
        evaluateCrnActionRoi({
          blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
          learnerId: "learner-target",
          beliefs,
          evidence,
          examAtMs: DAY_MS,
          baselineActions: [],
          candidateAction: { actionId: "a", title: "A", durationHours: 1, kind: "skill_repair" },
          crnSeed: 1,
          precomputedDraws: [badDraw],
        }),
      ).toThrow(RangeError);
    }

    // [R8 P1-3] Reject cross-blueprint simulation and incomplete drawSectionScores in calibration.
    const greBp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "gre-r8-bp",
        title: "GRE R8",
        totalTimeLimitMinutes: 120,
        totalPoints: 340,
        skillIds: ["v"],
        sections: [
          {
            sectionId: "verbal",
            label: "Verbal",
            scoringKind: "rubric_band",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [130, 170],
            scoreStep: 1,
            parts: [{ partId: "vp", label: "VP", weight: 1, skillIds: ["v"], timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
          },
        ],
      }),
      scoreRange: [260, 340] as const,
    };
    const greSim = simulateExamPaper({ blueprint: greBp, learnerId: "l", beliefs: {}, evidence: [], examAtMs: DAY_MS, numDraws: 10, seed: 2 });
    const cal5 = makeCalibrationRecords(5);
    expect(() =>
      calibrateJointPassTargets({
        simulation: greSim,
        blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
        calibrationRecords: cal5,
        targets: [{ targetOverall: 7, targetMinSection: 0 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeConformalBandInterval({
        simulation: greSim,
        blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
        calibrationRecords: cal5,
      }),
    ).toThrow(RangeError);

    // [R8 P1-4] Enforce blueprint caps & pre-allocation simulation DP/eval bounds, while hoisting deterministic DP once.
    const tooManyItemsBp = createSharedFullPaperBlueprint({
      blueprintId: "too-many-items",
      title: "Too Many Items",
      totalTimeLimitMinutes: 60,
      totalPoints: 600,
      skillIds: ["s1"],
      sections: [
        {
          sectionId: "mcq",
          label: "MCQ",
          scoringKind: "item_raw_table",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 600],
          scoreStep: 1,
          parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["s1"] }],
          items: Array.from({ length: 501 }, (_, idx) => ({
            itemId: `q-${idx}`,
            sectionId: "mcq",
            partId: "p1",
            skillIds: ["s1"],
            guess: 0,
            lapse: 0,
            points: 1,
            timeModel: { mu: 2, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
          })),
          rawToBandTable: [{ rawMin: 0, rawMax: 501, score: 1 }],
        },
      ],
    });
    expect(validateExamBlueprint(tooManyItemsBp)).toContain("sections.mcq.items.count");

    const heavyStochasticBp = createSharedFullPaperBlueprint({
      blueprintId: "heavy-stochastic-dp",
      title: "Heavy Stochastic DP",
      totalTimeLimitMinutes: 60,
      totalPoints: 2_000,
      skillIds: ["s1"],
      sections: [
        {
          sectionId: "mcq",
          label: "MCQ",
          scoringKind: "item_raw_table",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 2_000],
          scoreStep: 1,
          parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["s1"] }],
          items: Array.from({ length: 500 }, (_, idx) => ({
            itemId: `h-${idx}`,
            sectionId: "mcq",
            partId: "p1",
            skillIds: ["s1"],
            guess: 0.1,
            lapse: 0.05,
            points: 4,
            timeModel: { mu: 1, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
          })),
          rawToBandTable: [
            { rawMin: 0, rawMax: 1_000, score: 0 },
            { rawMin: 1_001, rawMax: 2_000, score: 2_000 },
          ],
        },
      ],
    });
    expect(validateExamBlueprint(heavyStochasticBp)).toEqual([]);
    expect(() =>
      simulateExamPaper({ blueprint: heavyStochasticBp, learnerId: "l", beliefs: {}, evidence: [], examAtMs: DAY_MS }),
    ).toThrow(RangeError);
    expect(() =>
      convolveLordWingersky(
        Array.from({ length: 500 }, () => 0.5),
        Array.from({ length: 500 }, () => 25),
      ),
    ).toThrow(RangeError);

    const deterministicHeavyBp = createSharedFullPaperBlueprint({
      blueprintId: "deterministic-hoist-dp",
      title: "Deterministic DP Hoist",
      totalTimeLimitMinutes: 600,
      totalPoints: 100,
      skillIds: ["s1"],
      thetaCovariance: [[0]],
      sections: [
        {
          sectionId: "mcq",
          label: "MCQ",
          scoringKind: "item_raw_table",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 100],
          scoreStep: 1,
          parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["s1"] }],
          items: Array.from({ length: 100 }, (_, idx) => ({
            itemId: `d-${idx}`,
            sectionId: "mcq",
            partId: "p1",
            skillIds: ["s1"],
            guess: 0.2,
            lapse: 0.05,
            points: 1,
            timeModel: { mu: 1, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
          })),
          rawToBandTable: Array.from({ length: 101 }, (_, raw) => ({ rawMin: raw, rawMax: raw, score: raw })),
        },
      ],
    });
    const hoistedSim = simulateExamPaper({
      blueprint: deterministicHeavyBp,
      learnerId: "l",
      beliefs: {},
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 1_000,
      seed: 9,
    });
    expect(hoistedSim.numDraws).toBe(1_000);
    expect(Number.isFinite(hoistedSim.untimedExpectedScore)).toBe(true);

    // [R8 P2-1] Overflow-safe Cholesky midpoint and tolerance for v = 2 ** 1023.
    const bigV = 2 ** 1023;
    const hugeValidPsd = choleskyDecompose([
      [bigV, bigV],
      [bigV, bigV],
    ]);
    expect(Number.isFinite(hugeValidPsd[0]![0])).toBe(true);
    expect(Number.isFinite(hugeValidPsd[1]![0])).toBe(true);
    expect(Number.isFinite(hugeValidPsd[1]![1])).toBe(true);
    expect(hugeValidPsd[1]![0]! / hugeValidPsd[0]![0]!).toBeCloseTo(1, 12);
    expect(hugeValidPsd[1]![1]! / hugeValidPsd[0]![0]!).toBeLessThan(1e-6);

    const evenBigV = 2 ** 1022;
    expect(() =>
      choleskyDecompose([
        [evenBigV, evenBigV, evenBigV],
        [evenBigV, evenBigV, -evenBigV],
        [evenBigV, -evenBigV, bigV],
      ]),
    ).toThrow(RangeError);

    // [R8 P2-2] Preserve fine step precision and strict [minScore, maxScore] bounds in snapToScoreGrid.
    expect(snapToScoreGrid(0.0000006, [0, 0.0000006], 0.0000001, "ceil")).toBeLessThanOrEqual(0.0000006);
    expect(snapToScoreGrid(0.0000006, [0, 0.0000006], 0.0000001, "ceil")).toBe(0.0000006);
    expect(snapToScoreGrid(0.00000059, [0, 0.0000006], 0.0000001, "floor")).toBe(0.0000005);

    // [R8 P2-3] Locale-independent UTF-16 code-unit tie-breaking ("z" < "ä") in CRN action ranking.
    const tiedÄ: CandidateStudyAction = {
      actionId: "ä",
      title: "Tie A-umlaut",
      durationHours: 1,
      kind: "skill_repair",
      skillEffects: { "ielts.reading.inference": { abilityDelta: 1.0 } },
    };
    const tiedZ: CandidateStudyAction = {
      actionId: "z",
      title: "Tie Z",
      durationHours: 1,
      kind: "skill_repair",
      skillEffects: { "ielts.reading.inference": { abilityDelta: 1.0 } },
    };
    const tieSnap = buildUnifiedDecisionSnapshot({
      decisionId: "dec-tie",
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      calibrationRecords: cal5,
      examAtMs: DAY_MS,
      crnSeed: 11,
      horizonHours: 48,
      executableMinutes: 60,
      candidateActions: [tiedÄ, tiedZ],
      numDraws: 30,
    });
    expect(tieSnap.rankedActions.map((r) => r.actionId)).toEqual(["z", "ä"]);
    expect(tieSnap.selectedActionIds).toEqual(["z"]);

    // [R8 P2-4 + Neon P2-1/P2-3] Standalone computeConformalBandInterval & direct calibrateJointPassTargets enforce cutoff & finite overrides.
    const sim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      numDraws: 30,
      seed: 12,
    });
    const futureCalOnly = cal5.map((r) => ({ ...r, recordedAtMs: DAY_MS + 1 }));
    const blockedConformal = computeConformalBandInterval({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: futureCalOnly,
      examAtMs: DAY_MS,
    });
    expect(blockedConformal.status).toBe("insufficient_calibration");
    expect(blockedConformal.n).toBe(0);
    const readyConformal = computeConformalBandInterval({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: cal5,
      examAtMs: DAY_MS,
    });
    expect(readyConformal.status).toBe("ready");
    if (readyConformal.status === "ready") {
      expect(readyConformal.low).toBeLessThanOrEqual(readyConformal.high);
    }
    const implicitCutoffJoint = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: futureCalOnly,
      targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
    });
    expect(implicitCutoffJoint[0]!.calibrationSampleCount).toBe(0);
    expect(() =>
      simulateExamPaper({
        blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
        learnerId: "learner-target",
        beliefs,
        evidence,
        examAtMs: DAY_MS,
        skillOverrides: { "ielts.reading.inference": { abilityDelta: Number.NaN } },
      }),
    ).toThrow(RangeError);
  });

  it("enforces all Round-9 3 P1 & 2 P2 invariants", () => {
    // [R9 P1-1] Bound score grid step count, reject non-finite values, and preserve large-offset exactness in snapToScoreGrid.
    expect(() => snapToScoreGrid(5, [0, 1e300], 1e-20, "nearest")).toThrow(RangeError);
    expect(() => snapToScoreGrid(0.5, [0, 1.000000000006], 1e-16, "nearest")).toThrow(RangeError);
    expect(() => snapToScoreGrid(Number.NaN, [0, 9], 0.5, "nearest")).toThrow(RangeError);
    expect(() => snapToScoreGrid(Number.POSITIVE_INFINITY, [0, 9], 0.5, "ceil")).toThrow(RangeError);
    expect(() => snapToScoreGrid(Number.NEGATIVE_INFINITY, [0, 9], 0.5, "floor")).toThrow(RangeError);
    expect(snapToScoreGrid(1e13 + 6, [1e13, 1e13 + 10], 1, "ceil")).toBe(1e13 + 6);
    expect(snapToScoreGrid(0.0000006, [0, 0.0000006], 0.0000001, "ceil")).toBe(0.0000006);
    expect(snapToScoreGrid(0.00000059, [0, 0.0000006], 0.0000001, "floor")).toBe(0.0000005);
    const excessiveGridBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      blueprintId: "excessive-grid-bp",
      aggregationMode: "weighted_sum" as const,
      scoreRange: [0, 1e9] as const,
      scoreStep: 1,
    };
    expect(validateExamBlueprint(excessiveGridBp)).toContain("scoreStep");

    // [R9 P1-2 & P2-1] Bound cross-section PMF convolution against coprime OOM while hoisting deterministic overall PMFs across simulateExamPaper & evaluateCrnActionRoi.
    const makeDeterministicWeightedSections = (itemCountPerSection: number, weights: readonly [number, number, number, number]) =>
      (["s0", "s1", "s2", "s3"] as const).map((sectionId, sIdx) => ({
        sectionId,
        label: sectionId.toUpperCase(),
        scoringKind: "item_raw_table" as const,
        timeLimitMinutes: null,
        weight: weights[sIdx]!,
        scoreRange: [0, itemCountPerSection] as const,
        scoreStep: 1,
        parts: [{ partId: `${sectionId}-p1`, label: "P1", weight: 1, skillIds: ["k0"] }],
        items: Array.from({ length: itemCountPerSection }, (_, i) => ({
          itemId: `${sectionId}-q${i + 1}`,
          sectionId,
          partId: `${sectionId}-p1`,
          skillIds: ["k0"],
          guess: 0.1,
          lapse: 0.02,
          points: 1,
          timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
        })),
        rawToBandTable: Array.from({ length: itemCountPerSection + 1 }, (_, raw) => ({
          rawMin: raw,
          rawMax: raw,
          score: raw,
        })),
      }));

    const irrationalBp = createSharedFullPaperBlueprint({
      blueprintId: "irrational-pmf-blowup",
      title: "Irrational PMF Blowup",
      totalTimeLimitMinutes: 240,
      totalPoints: 100,
      skillIds: ["k0"],
      thetaCovariance: [[0]],
      sections: makeDeterministicWeightedSections(100, [
        Math.SQRT2 / 10,
        Math.E / 10,
        Math.PI / 10,
        Math.LN2 / 10,
      ]),
    });
    expect(() =>
      simulateExamPaper({
        blueprint: irrationalBp,
        learnerId: "l",
        beliefs: {},
        evidence: [],
        examAtMs: DAY_MS,
        numDraws: 1,
        seed: 3,
      }),
    ).toThrow(RangeError);

    const heavyHoistedBp = createSharedFullPaperBlueprint({
      blueprintId: "heavy-4x500-hoisted",
      title: "Heavy 4x500 Hoisted",
      totalTimeLimitMinutes: 300,
      totalPoints: 2_000,
      skillIds: ["k0"],
      thetaCovariance: [[0]],
      sections: makeDeterministicWeightedSections(500, [1, 1, 1, 1]),
    });
    const heavySim = simulateExamPaper({
      blueprint: heavyHoistedBp,
      learnerId: "l",
      beliefs: {},
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 1_000,
      seed: 4,
    });
    expect(heavySim.numDraws).toBe(1_000);
    expect(Number.isFinite(heavySim.untimedExpectedScore)).toBe(true);
    const heavyCrn = evaluateCrnActionRoi({
      blueprint: heavyHoistedBp,
      learnerId: "l",
      beliefs: {},
      evidence: [],
      examAtMs: DAY_MS,
      baselineActions: [],
      candidateAction: {
        actionId: "k0-boost",
        title: "Boost K0",
        durationHours: 1,
        kind: "skill_repair",
        skillEffects: { k0: { abilityDelta: 0.4 } },
      },
      crnSeed: 4,
      numDraws: 1_000,
    });
    expect(heavyCrn.pairedMeanGain).toBeGreaterThanOrEqual(0);

    // [R9 P1-3 & P2-2] Validate simulation quantiles/mean in CQR calibration & validate blueprint upfront in calibrateJointPassTargets.
    const beliefs = makeIeltsBeliefs({ abilityMean: 0.4, logStability: Math.log(14), lastDirectRecallAtMs: 0 });
    const evidence = makeIndependentSectionEvidence(1_000);
    const baseSim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      learnerId: "learner-target",
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      numDraws: 20,
      seed: 5,
    });
    const cal5 = makeCalibrationRecords(5);
    for (const badSim of [
      { ...baseSim, q10: Number.NaN },
      { ...baseSim, q90: Number.POSITIVE_INFINITY },
      { ...baseSim, timedExpectedScore: 99 },
      { ...baseSim, q10: 8.0, q90: 6.0 },
    ]) {
      expect(() =>
        computeConformalBandInterval({
          simulation: badSim,
          blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
          calibrationRecords: cal5,
        }),
      ).toThrow(RangeError);
      expect(() =>
        calibrateJointPassTargets({
          simulation: badSim,
          blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
          calibrationRecords: cal5,
          targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
        }),
      ).toThrow(RangeError);
    }
    expect(() =>
      calibrateJointPassTargets({
        simulation: baseSim,
        blueprint: { ...IELTS_ACADEMIC_V1_BLUEPRINT, sections: [] },
        calibrationRecords: cal5,
        targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
      }),
    ).toThrow(RangeError);
  });

  it("enforces all Round-10 2 P1 & 2 P2 invariants", () => {
    // [R10 P1-1] Ensure percentileSorted never inverts q10 > q90 on tied draws (e.g. 6.5 / 7.0 with numDraws = 2 or 3).
    const makeZeroVarBeliefs = (abilityMean: number): SkillBeliefMap => {
      const map: Record<string, SkillBeliefV1> = {};
      for (const skillId of IELTS_ACADEMIC_SKILL_IDS) {
        map[skillId] = createSkillBelief({
          workspaceId: "ws-1",
          learnerId: "learner-tied",
          courseId: "ielts-academic",
          confirmedSkillVersion: 1,
          abilityMean,
          abilityVariance: 0,
          logStability: Math.log(14),
          implicitLogCredit: 0,
          lastDirectRecallAtMs: DAY_MS,
        });
      }
      return map;
    };
    const tiedBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      thetaCovariance: IELTS_ACADEMIC_SKILL_IDS.map(() => IELTS_ACADEMIC_SKILL_IDS.map(() => 0)),
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) =>
        sec.scoringKind === "item_raw_table" && sec.items
          ? {
              ...sec,
              items: sec.items.map((item) => ({ ...item, guess: 0, lapse: 0 })),
            }
          : sec,
      ),
    };
    const tiedBeliefs = makeZeroVarBeliefs(100);
    const tiedEvidence: ExamEvidenceRecord[] = IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) => ({
      evidenceId: `tied-ev-${sec.sectionId}`,
      learnerId: "learner-tied",
      sectionId: sec.sectionId,
      evidenceKind: "rubric_assessment",
      observedAtMs: DAY_MS,
      countsTowardMastery: true,
      assisted: false,
      exposed: false,
      rubricScore: { kind: "exact", score: 6.5 },
    }));
    const tiedCal5 = makeCalibrationRecords(5).map((r) => ({ ...r, recordedAtMs: DAY_MS - 10 }));
    for (const [numDraws, band] of [
      [2, 6.5],
      [3, 7.0],
    ] as const) {
      const targetRaw = band === 6.5 ? 28 : 31;
      const halfSectionUniforms = Array.from({ length: 40 }, (_, i) => (i < targetRaw ? 0.1 : 0.9));
      const bandBeliefs = makeZeroVarBeliefs(0);
      const bandEvidence: ExamEvidenceRecord[] = IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) => ({
        evidenceId: `tied-ev-${band}-${sec.sectionId}`,
        learnerId: "learner-tied",
        sectionId: sec.sectionId,
        evidenceKind: "rubric_assessment",
        observedAtMs: DAY_MS,
        countsTowardMastery: true,
        assisted: false,
        exposed: false,
        rubricScore: { kind: "exact", score: band },
      }));
      const tiedDraw = {
        zLatent: Array.from({ length: IELTS_ACADEMIC_SKILL_IDS.length }, () => 0),
        nuSpeed: 0,
        itemUniforms: [...halfSectionUniforms, ...halfSectionUniforms],
        itemTimeNormals: Array.from({ length: 80 }, () => 0),
        rubricScoreNormals: Array.from({ length: 5 }, () => 0),
        rubricTimeNormals: Array.from({ length: 5 }, () => 0),
      };
      const tiedSim = simulateExamPaper({
        blueprint: tiedBp,
        learnerId: "learner-tied",
        beliefs: bandBeliefs,
        evidence: bandEvidence,
        examAtMs: DAY_MS,
        precomputedDraws: Array.from({ length: numDraws }, () => tiedDraw),
      });
      expect(tiedSim.timedScores.every((s) => s === band)).toBe(true);
      expect(tiedSim.q10).toBe(band);
      expect(tiedSim.q50).toBe(band);
      expect(tiedSim.q90).toBe(band);
      const interval = computeConformalBandInterval({
        simulation: tiedSim,
        blueprint: tiedBp,
        calibrationRecords: tiedCal5,
      });
      expect(interval.status).toBe("ready");
      const joint = calibrateJointPassTargets({
        simulation: tiedSim,
        blueprint: tiedBp,
        calibrationRecords: tiedCal5,
        targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
      });
      expect(joint[0]!.isCalibrated).toBe(true);
      const forecast = evaluateExamForecast({
        blueprint: tiedBp,
        learnerId: "learner-tied",
        beliefs: bandBeliefs,
        evidence: bandEvidence,
        calibrationRecords: tiedCal5,
        examAtMs: DAY_MS,
        numDraws,
        seed: 1,
      });
      expect(forecast.status).toBe("calibrated_forecast_ready");
    }

    // [R10 P1-2] Charge pmfOpsBudget & cap states across IELTS PMF convolution loops (including 11 binary-weighted items) and hoist all-det 4-section IELTS.
    const binaryWeights = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 977] as const;
    const makeBinaryIeltsItemSection = (sectionId: "listening" | "reading", slopeNumerator: number) => ({
      ...IELTS_ACADEMIC_V1_BLUEPRINT.sections.find((s) => s.sectionId === sectionId)!,
      parts: [{ partId: `${sectionId}-p1`, label: "P1", weight: 1, skillIds: [IELTS_ACADEMIC_SKILL_IDS[0]!] }],
      items: binaryWeights.map((pts, idx) => ({
        itemId: `${sectionId}-bin-${idx}`,
        sectionId,
        partId: `${sectionId}-p1`,
        skillIds: [IELTS_ACADEMIC_SKILL_IDS[0]!],
        guess: 0.1,
        lapse: 0.02,
        points: pts,
        timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
      })),
      rawToBandTable: Array.from({ length: 2_001 }, (_, raw) => ({
        rawMin: raw,
        rawMax: raw,
        score: (raw * slopeNumerator) / 2_000,
      })),
    });
    const binaryExplosionIeltsBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      blueprintId: "binary-explosion-ielts",
      thetaCovariance: IELTS_ACADEMIC_SKILL_IDS.map(() => IELTS_ACADEMIC_SKILL_IDS.map(() => 0)),
      sections: [
        makeBinaryIeltsItemSection("listening", 9),
        makeBinaryIeltsItemSection("reading", Math.E * 3),
        ...IELTS_ACADEMIC_V1_BLUEPRINT.sections.filter((s) => s.scoringKind === "rubric_band"),
      ],
    };
    expect(() =>
      simulateExamPaper({
        blueprint: binaryExplosionIeltsBp,
        learnerId: "learner-tied",
        beliefs: {},
        evidence: [],
        examAtMs: DAY_MS,
        numDraws: 1,
        seed: 7,
      }),
    ).toThrow(RangeError);

    const allDetIeltsSim = simulateExamPaper({
      blueprint: tiedBp,
      learnerId: "learner-tied",
      beliefs: tiedBeliefs,
      evidence: tiedEvidence,
      examAtMs: DAY_MS,
      numDraws: 1_000,
      seed: 8,
    });
    expect(allDetIeltsSim.numDraws).toBe(1_000);
    expect(allDetIeltsSim.untimedExpectedScore).toBeGreaterThan(0);

    // [R10 P2-1] Overflow-safe clamping before snapToScoreGrid on extreme [0, 1e308] range.
    const hugeBp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "huge-range-bp",
        title: "Huge Range",
        totalTimeLimitMinutes: 60,
        totalPoints: 1,
        skillIds: ["s"],
        sections: [
          {
            sectionId: "sec",
            label: "Sec",
            scoringKind: "rubric_band",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 1e308] as const,
            scoreStep: 1e308,
            parts: [
              {
                partId: "p",
                label: "P",
                weight: 1,
                skillIds: ["s"],
                timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
          },
        ],
      }),
      scoreRange: [0, 1e308] as const,
      scoreStep: 1e308,
    };
    const hugeSim: ReturnType<typeof simulateExamPaper> = {
      ...simulateExamPaper({
        blueprint: hugeBp,
        learnerId: "l-huge",
        beliefs: {},
        evidence: [],
        examAtMs: DAY_MS,
        numDraws: 2,
        seed: 9,
      }),
      q10: 0,
      q50: 1e308,
      q90: 1e308,
      timedExpectedScore: 1e308,
      timedScores: [0, 1e308],
      drawSectionScores: [{ sec: 0 }, { sec: 1e308 }],
    };
    const hugeCals: WholePaperCalibrationRecord[] = [0, 1, 2, 3, 4].map((idx) => ({
      recordId: `huge-cal-${idx}`,
      blueprintId: "huge-range-bp",
      learnerId: `other-${idx}`,
      paperFamilyId: `fam-${idx}`,
      targetKind: "same_blueprint_mock",
      evidenceKind: "independent_mock",
      recordedAtMs: DAY_MS - 10,
      countsTowardMastery: true,
      assisted: false,
      exposed: false,
      predictedQuantiles: { q10: 0, q50: 0, q90: 0 },
      observedScore: { kind: "exact", score: 1e308 },
    }));
    const hugeInterval = computeConformalBandInterval({
      simulation: hugeSim,
      blueprint: hugeBp,
      calibrationRecords: hugeCals,
      examAtMs: DAY_MS,
    });
    expect(hugeInterval.status).toBe("ready");
    if (hugeInterval.status === "ready") {
      expect(hugeInterval.high).toBe(1e308);
    }

    // [R10 P2-2] Clamp untimedExpectedScore strictly within blueprint.scoreRange despite floating-point PMF drift.
    const driftZeroPt6Bp = createSharedFullPaperBlueprint({
      blueprintId: "drift-06-bp",
      title: "Drift 0.6",
      totalTimeLimitMinutes: 30,
      totalPoints: 1,
      skillIds: ["s"],
      sections: [
        {
          sectionId: "sec",
          label: "Sec",
          scoringKind: "item_raw_table",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 0.6] as const,
          scoreStep: 0.6,
          parts: [{ partId: "p", label: "P", weight: 1, skillIds: ["s"] }],
          items: [
            {
              itemId: "q1",
              sectionId: "sec",
              partId: "p",
              skillIds: ["s"],
              guess: 0,
              lapse: 0,
              points: 1,
              timeModel: { mu: 2, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
            },
          ],
          rawToBandTable: [
            { rawMin: 0, rawMax: 0, score: 0.6 },
            { rawMin: 1, rawMax: 1, score: 0.6 },
          ],
        },
      ],
    });
    const finalDriftBp = {
      ...driftZeroPt6Bp,
      scoreRange: [0, 0.6] as const,
      scoreStep: 0.6,
    };
    const driftSim = simulateExamPaper({
      blueprint: finalDriftBp,
      learnerId: "l-drift",
      beliefs: {},
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 3,
      seed: 10,
    });
    expect(driftSim.untimedExpectedScore).toBeLessThanOrEqual(0.6);
    expect(driftSim.timedExpectedScore).toBeLessThanOrEqual(0.6);
    expect(driftSim.q10).toBeLessThanOrEqual(driftSim.q90);
  });

  it("enforces all Round-11 4 P1 & 1 P2 invariants", () => {
    // [R11 P1-1] Exact IELTS Writing (W1 + 2 * W2) / 3 and overall (3L + 3R + W1 + 2*W2 + 3S) / 12 arithmetic across timed/untimed/joint-pass.
    const exactWritingBeliefs: Record<string, SkillBeliefV1> = {};
    for (const skillId of IELTS_ACADEMIC_SKILL_IDS) {
      exactWritingBeliefs[skillId] = createSkillBelief({
        workspaceId: "ws-1",
        learnerId: "learner-exact-w",
        courseId: "ielts-academic",
        confirmedSkillVersion: 1,
        abilityMean: 0,
        abilityVariance: 0,
        logStability: Math.log(14),
        implicitLogCredit: 0,
        lastDirectRecallAtMs: DAY_MS,
      });
    }
    const zeroCovIeltsBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      thetaCovariance: IELTS_ACADEMIC_SKILL_IDS.map(() => IELTS_ACADEMIC_SKILL_IDS.map(() => 0)),
    };
    const exactAll7Evidence: ExamEvidenceRecord[] = IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) => ({
      evidenceId: `exact7-${sec.sectionId}`,
      learnerId: "learner-exact-w",
      sectionId: sec.sectionId,
      evidenceKind: "rubric_assessment",
      observedAtMs: DAY_MS,
      countsTowardMastery: true,
      assisted: false,
      exposed: false,
      rubricScore: { kind: "exact", score: 7 },
    }));
    const raw31Uniforms = Array.from({ length: 40 }, (_, i) => (i < 31 ? 0.1 : 0.9));
    const exactAll7Draw = {
      zLatent: Array.from({ length: IELTS_ACADEMIC_SKILL_IDS.length }, () => 0),
      nuSpeed: 0,
      itemUniforms: [...raw31Uniforms, ...raw31Uniforms],
      itemTimeNormals: Array.from({ length: 80 }, () => 0),
      rubricScoreNormals: Array.from({ length: 5 }, () => 0),
      rubricTimeNormals: Array.from({ length: 5 }, () => 0),
    };
    const exactAll7Sim = simulateExamPaper({
      blueprint: zeroCovIeltsBp,
      learnerId: "learner-exact-w",
      beliefs: exactWritingBeliefs,
      evidence: exactAll7Evidence,
      examAtMs: DAY_MS,
      precomputedDraws: [exactAll7Draw],
    });
    expect(exactAll7Sim.drawSectionScores[0]!["writing"]).toBe(7);
    expect(exactAll7Sim.timedScores[0]).toBe(7);
    const exactCal = makeCalibrationRecords(5).map((r) => ({ ...r, recordedAtMs: DAY_MS - 10 }));
    const exactJoint7 = calibrateJointPassTargets({
      simulation: exactAll7Sim,
      blueprint: zeroCovIeltsBp,
      calibrationRecords: exactCal,
      targets: [{ targetOverall: 7, targetMinSection: 7 }],
    });
    expect(exactJoint7[0]!.rawProbability).toBe(1);

    // [0, 0, W1=7/W2=7, 0] -> (0 + 0 + 7 + 14 + 0) / 12 = 1.75 -> rounds up to 2.0 (never 1.5).
    const writingOnlyEvidence: ExamEvidenceRecord[] = IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) => ({
      evidenceId: `w-only-${sec.sectionId}`,
      learnerId: "learner-exact-w",
      sectionId: sec.sectionId,
      evidenceKind: "rubric_assessment",
      observedAtMs: DAY_MS,
      countsTowardMastery: true,
      assisted: false,
      exposed: false,
      rubricScore: { kind: "exact", score: sec.sectionId === "writing" ? 7 : 0 },
    }));
    const noGuessItemBp = {
      ...zeroCovIeltsBp,
      sections: zeroCovIeltsBp.sections.map((sec) =>
        sec.scoringKind === "item_raw_table" && sec.items
          ? {
              ...sec,
              items: sec.items.map((item) => ({ ...item, guess: 0, lapse: 0 })),
              rawToBandTable: sec.rawToBandTable!.map((row) => ({ ...row, score: 0 })),
            }
          : sec,
      ),
    };
    const writingOnlyDraw = {
      ...exactAll7Draw,
      itemUniforms: Array.from({ length: 80 }, () => 0.99),
    };
    const writingOnlySim = simulateExamPaper({
      blueprint: noGuessItemBp,
      learnerId: "learner-exact-w",
      beliefs: exactWritingBeliefs,
      evidence: writingOnlyEvidence,
      examAtMs: DAY_MS,
      precomputedDraws: [writingOnlyDraw],
    });
    expect(writingOnlySim.drawSectionScores[0]!["writing"]).toBe(7);
    expect(writingOnlySim.timedScores[0]).toBe(2.0);
    expect(writingOnlySim.untimedScores[0]).toBe(2.0);
    expect(writingOnlySim.untimedExpectedScore).toBe(2.0);

    // [R11 P1-2] Reject unaligned blueprint/section scoreStep in validateExamBlueprint and prevent inward CQR outward snapping.
    const unalignedBp = createSharedFullPaperBlueprint({
      blueprintId: "unaligned-step-3",
      title: "Unaligned Step 3",
      totalTimeLimitMinutes: 30,
      totalPoints: 10,
      skillIds: ["s"],
      sections: [
        {
          sectionId: "sec",
          label: "Sec",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 10],
          scoreStep: 3,
          parts: [{ partId: "p", label: "P", weight: 1, skillIds: ["s"], timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
        },
      ],
    });
    const unalignedWithStep3 = { ...unalignedBp, scoreStep: 3 };
    const unalignedErrors = validateExamBlueprint(unalignedWithStep3);
    expect(unalignedErrors).toContain("scoreStep");
    expect(unalignedErrors).toContain("sections.sec.scoreStep");
    const alignedDecimalBp = createSharedFullPaperBlueprint({
      blueprintId: "aligned-01",
      title: "Aligned 0.1",
      totalTimeLimitMinutes: 30,
      totalPoints: 1,
      skillIds: ["s"],
      sections: [
        {
          sectionId: "sec",
          label: "Sec",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 0.3],
          scoreStep: 0.1,
          parts: [{ partId: "p", label: "P", weight: 1, skillIds: ["s"], timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
        },
      ],
    });
    expect(validateExamBlueprint({ ...alignedDecimalBp, scoreRange: [0, 0.3], scoreStep: 0.1 })).toEqual([]);
    expect(snapToScoreGrid(10, [0, 10], 3, "ceil")).toBe(10);
    expect(snapToScoreGrid(8, [0, 10], 3, "floor")).toBe(6);

    // [R11 P1-3] Speaking rubric parts execute shared 11-14m timeModel and right-censor when Speaking budget is tightened to 60s.
    const speakingSection = IELTS_ACADEMIC_V1_BLUEPRINT.sections.find((s) => s.sectionId === "speaking")!;
    expect(speakingSection.parts.every((p) => p.timeModel !== undefined)).toBe(true);
    const tightSpeakingBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) =>
        sec.sectionId === "speaking" ? { ...sec, timeLimitMinutes: 1 } : sec,
      ),
    };
    const tightSpeakingSim = simulateExamPaper({
      blueprint: tightSpeakingBp,
      learnerId: "learner-exact-w",
      beliefs: exactWritingBeliefs,
      evidence: exactAll7Evidence,
      examAtMs: DAY_MS,
      numDraws: 16,
      seed: 13,
    });
    expect(tightSpeakingSim.rightCensoringRateBySection["speaking"]).toBeGreaterThan(0);
    expect(tightSpeakingSim.sectionSummaries["speaking"]!.timedMeanScore).toBeLessThan(
      tightSpeakingSim.sectionSummaries["speaking"]!.untimedMeanScore,
    );

    // [R11 P1-4] Cap targetPmf across multi-draw accumulation when continuous rubric draws exceed MAX_PMF_CONVOLUTION_STATES.
    const crossDrawExplosionBp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "cross-draw-target-pmf-cap",
        title: "Cross-Draw Target PMF Cap",
        totalTimeLimitMinutes: 120,
        totalPoints: 1_000,
        skillIds: ["kDet", "kRubric"],
        thetaCovariance: [
          [0, 0],
          [0, 1],
        ],
        sections: [
          {
            sectionId: "det-item",
            label: "Det Item",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 25,
            scoreRange: [0, 20],
            scoreStep: 1,
            parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["kDet"] }],
            items: [
              {
                itemId: "q1",
                sectionId: "det-item",
                partId: "p1",
                skillIds: ["kDet"],
                guess: 0.1,
                lapse: 0.05,
                points: 1,
                timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
              {
                itemId: "q2",
                sectionId: "det-item",
                partId: "p1",
                skillIds: ["kDet"],
                guess: 0.1,
                lapse: 0.05,
                points: 1,
                timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
            rawToBandTable: [
              { rawMin: 0, rawMax: 0, score: 0 },
              { rawMin: 1, rawMax: 1, score: 10 },
              { rawMin: 2, rawMax: 2, score: 20 },
            ],
          },
          {
            sectionId: "stoch-rubric",
            label: "Stoch Rubric",
            scoringKind: "rubric_band",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 500],
            scoreStep: 0.001,
            parts: [
              {
                partId: "p2",
                label: "P2",
                weight: 1,
                skillIds: ["kRubric"],
                timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
          },
        ],
      }),
      scoreRange: [0, 1_000] as const,
      scoreStep: 0.001,
    };
    expect(() =>
      simulateExamPaper({
        blueprint: crossDrawExplosionBp,
        learnerId: "l-cross-pmf",
        beliefs: {},
        evidence: [],
        examAtMs: DAY_MS,
        numDraws: 26_000,
        seed: 14,
      }),
    ).toThrow(RangeError);
  });

  it("enforces all Round-12 3 P1 IEEE-754 invariants", () => {
    // [R12 P1-1] Exact bit-for-bit IEEE-754 evaluation order parity between per-draw IELTS and hoisted LR PMF for L=0.2, R=2.8, W1=W2=S=0.
    const parityBeliefs: Record<string, SkillBeliefV1> = {};
    for (const skillId of IELTS_ACADEMIC_SKILL_IDS) {
      parityBeliefs[skillId] = createSkillBelief({
        workspaceId: "ws-1",
        learnerId: "learner-r12",
        courseId: "ielts-academic",
        confirmedSkillVersion: 1,
        abilityMean: 0,
        abilityVariance: 0,
        logStability: Math.log(14),
        implicitLogCredit: 0,
        lastDirectRecallAtMs: DAY_MS,
      });
    }
    const parityBp = {
      ...IELTS_ACADEMIC_V1_BLUEPRINT,
      thetaCovariance: IELTS_ACADEMIC_SKILL_IDS.map(() => IELTS_ACADEMIC_SKILL_IDS.map(() => 0)),
      sections: IELTS_ACADEMIC_V1_BLUEPRINT.sections.map((sec) => {
        if (sec.sectionId === "listening" && sec.items && sec.rawToBandTable) {
          return {
            ...sec,
            items: sec.items.map((item) => ({ ...item, guess: 0, lapse: 0 })),
            rawToBandTable: sec.rawToBandTable.map((row) => ({ ...row, score: 0.2 })),
          };
        }
        if (sec.sectionId === "reading" && sec.items && sec.rawToBandTable) {
          return {
            ...sec,
            items: sec.items.map((item) => ({ ...item, guess: 0, lapse: 0 })),
            rawToBandTable: sec.rawToBandTable.map((row) => ({ ...row, score: 2.8 })),
          };
        }
        return sec;
      }),
    };
    const zeroWsEvidence: ExamEvidenceRecord[] = [
      {
        evidenceId: "parity-w",
        learnerId: "learner-r12",
        sectionId: "writing",
        evidenceKind: "rubric_assessment",
        observedAtMs: DAY_MS,
        countsTowardMastery: true,
        assisted: false,
        exposed: false,
        rubricScore: { kind: "exact", score: 0 },
      },
      {
        evidenceId: "parity-s",
        learnerId: "learner-r12",
        sectionId: "speaking",
        evidenceKind: "rubric_assessment",
        observedAtMs: DAY_MS,
        countsTowardMastery: true,
        assisted: false,
        exposed: false,
        rubricScore: { kind: "exact", score: 0 },
      },
    ];
    const paritySim = simulateExamPaper({
      blueprint: parityBp,
      learnerId: "learner-r12",
      beliefs: parityBeliefs,
      evidence: zeroWsEvidence,
      examAtMs: DAY_MS,
      numDraws: 10,
      seed: 15,
    });
    expect(paritySim.timedExpectedScore).toBe(0.5);
    expect(paritySim.matchedUntimedExpectedScore).toBe(0.5);
    expect(paritySim.untimedExpectedScore).toBe(0.5);

    // [R12 P1-2] Share endpoint alignment between validateExamBlueprint and snapToScoreGrid ([0, 2000.1] step 0.1 accepted, [0, 1 - 2^-31] step 0.125 rejected).
    const bp20001 = createSharedFullPaperBlueprint({
      blueprintId: "aligned-2000-1",
      title: "Aligned 2000.1",
      totalTimeLimitMinutes: 30,
      totalPoints: 2000.1,
      skillIds: ["s"],
      sections: [
        {
          sectionId: "sec",
          label: "Sec",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 2000.1],
          scoreStep: 0.1,
          parts: [
            {
              partId: "p",
              label: "P",
              weight: 1,
              skillIds: ["s"],
              timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
            },
          ],
        },
      ],
    });
    expect(validateExamBlueprint({ ...bp20001, scoreRange: [0, 2000.1], scoreStep: 0.1 })).toEqual([]);
    expect(snapToScoreGrid(2000.1, [0, 2000.1], 0.1, "nearest")).toBe(2000.1);
    expect(snapToScoreGrid(2000.1, [0, 2000.1], 0.1, "floor")).toBe(2000.1);
    expect(snapToScoreGrid(2000.09, [0, 2000.1], 0.1, "ceil")).toBe(2000.1);

    const nearBinaryMax = 1 - 2 ** -31;
    const unalignedBinaryBp = createSharedFullPaperBlueprint({
      blueprintId: "unaligned-binary-eps",
      title: "Unaligned Binary",
      totalTimeLimitMinutes: 30,
      totalPoints: nearBinaryMax,
      skillIds: ["s"],
      sections: [
        {
          sectionId: "sec",
          label: "Sec",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, nearBinaryMax],
          scoreStep: 0.125,
          parts: [
            {
              partId: "p",
              label: "P",
              weight: 1,
              skillIds: ["s"],
              timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
            },
          ],
        },
      ],
    });
    const binaryErrors = validateExamBlueprint({ ...unalignedBinaryBp, scoreRange: [0, nearBinaryMax], scoreStep: 0.125 });
    expect(binaryErrors).toContain("scoreStep");
    expect(binaryErrors).toContain("sections.sec.scoreStep");

    // [R12 P1-3] Overflow fallback in rubric weighted averaging when 1/3 + 2/3 parts sum past MAX_VALUE ([8e307, 9e307]).
    const hugeWeightedBp = createSharedFullPaperBlueprint({
      blueprintId: "huge-rubric-weighted",
      title: "Huge Rubric Weighted",
      totalTimeLimitMinutes: 60,
      totalPoints: 1e308,
      skillIds: ["kHuge"],
      thetaCovariance: [[0]],
      sections: [
        {
          sectionId: "sec",
          label: "Sec",
          scoringKind: "rubric_band",
          timeLimitMinutes: null,
          weight: 1,
          scoreRange: [0, 1e308],
          scoreStep: 1e308,
          parts: [
            {
              partId: "p1",
              label: "P1",
              weight: 1 / 3,
              skillIds: ["kHuge"],
              timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
            },
            {
              partId: "p2",
              label: "P2",
              weight: 2 / 3,
              skillIds: ["kHuge"],
              timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
            },
          ],
        },
      ],
    });
    const hugeWeightedEvidence: ExamEvidenceRecord[] = [
      {
        evidenceId: "huge-p1",
        learnerId: "l-huge-w",
        sectionId: "sec",
        partId: "p1",
        evidenceKind: "rubric_assessment",
        observedAtMs: DAY_MS,
        countsTowardMastery: true,
        assisted: false,
        exposed: false,
        rubricScore: { kind: "exact", score: 8e307 },
      },
      {
        evidenceId: "huge-p2",
        learnerId: "l-huge-w",
        sectionId: "sec",
        partId: "p2",
        evidenceKind: "rubric_assessment",
        observedAtMs: DAY_MS,
        countsTowardMastery: true,
        assisted: false,
        exposed: false,
        rubricScore: { kind: "exact", score: 9e307 },
      },
    ];
    const hugeWeightedSim = simulateExamPaper({
      blueprint: { ...hugeWeightedBp, scoreRange: [0, 1e308], scoreStep: 1e308 },
      learnerId: "l-huge-w",
      beliefs: {
        kHuge: createSkillBelief({
          workspaceId: "ws-1",
          learnerId: "l-huge-w",
          courseId: "huge",
          confirmedSkillVersion: 1,
          abilityMean: 0,
          abilityVariance: 0,
          logStability: Math.log(14),
          implicitLogCredit: 0,
          lastDirectRecallAtMs: DAY_MS,
        }),
      },
      evidence: hugeWeightedEvidence,
      examAtMs: DAY_MS,
      numDraws: 2,
      seed: 16,
    });
    expect(Number.isFinite(hugeWeightedSim.sectionSummaries["sec"]!.timedMeanScore)).toBe(true);
    expect(hugeWeightedSim.sectionSummaries["sec"]!.timedMeanScore).toBeCloseTo((8 / 3 + 6) * 1e307, -295);
    expect(hugeWeightedSim.sectionSummaries["sec"]!.timedMeanScore).toBeGreaterThan(8e307);
    expect(hugeWeightedSim.sectionSummaries["sec"]!.timedMeanScore).toBeLessThan(9e307);
  });

  it("enforces all Round-13 3 P1 IEEE-754 parity & overflow invariants", () => {
    // [R13 P1-1] Parity between validateExamBlueprint and snapToScoreGrid at exact MAX_SCORE_GRID_STEPS (e.g. [0, 700000] step 0.7).
    for (const [maxScore, step] of [
      [700_000, 0.7],
      [290_000, 0.29],
      [350_000, 0.35],
      [820_000, 0.82],
    ] as const) {
      expect(snapToScoreGrid(maxScore, [0, maxScore], step, "nearest")).toBe(maxScore);
      expect(snapToScoreGrid(maxScore, [0, maxScore], step, "floor")).toBe(maxScore);
      expect(snapToScoreGrid(maxScore, [0, maxScore], step, "ceil")).toBe(maxScore);
    }
    const boundary700kBp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "grid-700k-07",
        title: "Grid 700k Step 0.7",
        totalTimeLimitMinutes: 60,
        totalPoints: 700_000,
        skillIds: ["sGrid"],
        thetaCovariance: [[0]],
        sections: [
          {
            sectionId: "sec",
            label: "Sec",
            scoringKind: "rubric_band",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 700_000],
            scoreStep: 0.7,
            parts: [
              {
                partId: "p",
                label: "P",
                weight: 1,
                skillIds: ["sGrid"],
                timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
          },
        ],
      }),
      scoreRange: [0, 700_000] as const,
      scoreStep: 0.7,
    };
    expect(validateExamBlueprint(boundary700kBp)).toEqual([]);
    const boundarySim = simulateExamPaper({
      blueprint: boundary700kBp,
      learnerId: "l-grid",
      beliefs: {},
      evidence: [
        {
          evidenceId: "ev-grid",
          learnerId: "l-grid",
          sectionId: "sec",
          evidenceKind: "rubric_assessment",
          observedAtMs: DAY_MS - 10,
          countsTowardMastery: true,
          assisted: false,
          exposed: false,
          rubricScore: { kind: "exact", score: 700_000 },
        },
      ],
      examAtMs: DAY_MS,
      numDraws: 4,
      seed: 17,
    });
    const gridCals: WholePaperCalibrationRecord[] = [0, 1, 2, 3, 4].map((idx) => ({
      recordId: `grid-cal-${idx}`,
      blueprintId: "grid-700k-07",
      learnerId: `other-grid-${idx}`,
      paperFamilyId: `fam-grid-${idx}`,
      targetKind: "same_blueprint_mock",
      evidenceKind: "independent_mock",
      recordedAtMs: DAY_MS - 10,
      countsTowardMastery: true,
      assisted: false,
      exposed: false,
      predictedQuantiles: { q10: 600_000, q50: 650_000, q90: 700_000 },
      observedScore: { kind: "exact", score: 699_999.3 },
    }));
    const gridInterval = computeConformalBandInterval({
      simulation: boundarySim,
      blueprint: boundary700kBp,
      calibrationRecords: gridCals,
      examAtMs: DAY_MS,
    });
    expect(gridInterval.status).toBe("ready");
    const gridForecast = evaluateExamForecast({
      blueprint: boundary700kBp,
      learnerId: "l-grid",
      beliefs: {},
      evidence: [
        {
          evidenceId: "ev-grid-f",
          learnerId: "l-grid",
          sectionId: "sec",
          evidenceKind: "rubric_assessment",
          observedAtMs: DAY_MS - 10,
          countsTowardMastery: true,
          assisted: false,
          exposed: false,
          rubricScore: { kind: "exact", score: 700_000 },
        },
      ],
      calibrationRecords: gridCals,
      examAtMs: DAY_MS,
      maxInformativeWidth: 700_000,
      numDraws: 4,
      seed: 17,
    });
    expect(gridForecast.status).toBe("calibrated_forecast_ready");
    expect(() => snapToScoreGrid(700_001, [0, 700_001], 0.7, "nearest")).toThrow(RangeError);

    // [R13 P1-2 & P1-3] Extreme rubric weights (1e308, 1e-320, 11x MAX_VALUE) & cross-draw means (numDraws = 3 & 11) stay finite and exact.
    const makeWeightAndDrawBp = (id: string, weights: readonly number[], range: readonly [number, number], step: number) => ({
      ...createSharedFullPaperBlueprint({
        blueprintId: id,
        title: id,
        totalTimeLimitMinutes: 60,
        totalPoints: range[1],
        skillIds: ["kExt"],
        thetaCovariance: [[0]],
        sections: [
          {
            sectionId: "sec",
            label: "Sec",
            scoringKind: "rubric_band",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: range,
            scoreStep: step,
            parts: weights.map((w, idx) => ({
              partId: `p${idx + 1}`,
              label: `P${idx + 1}`,
              weight: w,
              skillIds: ["kExt"],
              timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
            })),
          },
        ],
      }),
      scoreRange: range,
      scoreStep: step,
    });
    const zeroVarExtBelief = {
      kExt: createSkillBelief({
        workspaceId: "ws-1",
        learnerId: "l-ext",
        courseId: "ext",
        confirmedSkillVersion: 1,
        abilityMean: 0,
        abilityVariance: 0,
        logStability: Math.log(14),
        implicitLogCredit: 0,
        lastDirectRecallAtMs: DAY_MS,
      }),
    };

    // Case A: [1e308, 1e308] with scores [5, 7] -> 6 (never 0).
    const maxWeightBp = makeWeightAndDrawBp("max-w-1e308", [1e308, 1e308], [4, 9], 0.5);
    const maxWeightSim = simulateExamPaper({
      blueprint: maxWeightBp,
      learnerId: "l-ext",
      beliefs: zeroVarExtBelief,
      evidence: [
        {
          evidenceId: "mw1",
          learnerId: "l-ext",
          sectionId: "sec",
          partId: "p1",
          evidenceKind: "rubric_assessment",
          observedAtMs: DAY_MS,
          countsTowardMastery: true,
          assisted: false,
          exposed: false,
          rubricScore: { kind: "exact", score: 5 },
        },
        {
          evidenceId: "mw2",
          learnerId: "l-ext",
          sectionId: "sec",
          partId: "p2",
          evidenceKind: "rubric_assessment",
          observedAtMs: DAY_MS,
          countsTowardMastery: true,
          assisted: false,
          exposed: false,
          rubricScore: { kind: "exact", score: 7 },
        },
      ],
      examAtMs: DAY_MS,
      numDraws: 3,
      seed: 18,
    });
    expect(maxWeightSim.sectionSummaries["sec"]!.timedMeanScore).toBeCloseTo(6, 12);
    expect(maxWeightSim.sectionSummaries["sec"]!.untimedMeanScore).toBeCloseTo(6, 12);

    // Case B: Tiny subnormal weights [1e-320, 2e-320] with [1e-10, 2e-10] -> ~1.6666666666666667e-10 (never 0).
    const tinyWeightBp = makeWeightAndDrawBp("tiny-w", [1e-320, 2e-320], [0, 1], 0.1);
    const tinyWeightSim = simulateExamPaper({
      blueprint: tinyWeightBp,
      learnerId: "l-ext",
      beliefs: zeroVarExtBelief,
      evidence: [
        {
          evidenceId: "tw1",
          learnerId: "l-ext",
          sectionId: "sec",
          partId: "p1",
          evidenceKind: "rubric_assessment",
          observedAtMs: DAY_MS,
          countsTowardMastery: true,
          assisted: false,
          exposed: false,
          rubricScore: { kind: "exact", score: 1e-10 },
        },
        {
          evidenceId: "tw2",
          learnerId: "l-ext",
          sectionId: "sec",
          partId: "p2",
          evidenceKind: "rubric_assessment",
          observedAtMs: DAY_MS,
          countsTowardMastery: true,
          assisted: false,
          exposed: false,
          rubricScore: { kind: "exact", score: 2e-10 },
        },
      ],
      examAtMs: DAY_MS,
      numDraws: 3,
      seed: 19,
    });
    expect(tinyWeightSim.sectionSummaries["sec"]!.untimedMeanScore).toBeGreaterThan(1e-10);
    expect(tinyWeightSim.sectionSummaries["sec"]!.untimedMeanScore).toBeLessThan(2e-10);

    // Case C: 11 parts near Number.MAX_VALUE with numDraws = 3 and numDraws = 3 on [8e307, 9e307] [1/3, 2/3] fixture.
    const elevenWeights = Array.from({ length: 11 }, () => 1);
    const elevenMaxBp = makeWeightAndDrawBp("eleven-max-val", elevenWeights, [0, Number.MAX_VALUE], Number.MAX_VALUE);
    const elevenEvidence: ExamEvidenceRecord[] = elevenWeights.map((_, idx) => ({
      evidenceId: `em-${idx}`,
      learnerId: "l-ext",
      sectionId: "sec",
      partId: `p${idx + 1}`,
      evidenceKind: "rubric_assessment",
      observedAtMs: DAY_MS,
      countsTowardMastery: true,
      assisted: false,
      exposed: false,
      rubricScore: {
        kind: "exact",
        score: idx === 0 ? Number.MAX_VALUE : Number.MAX_VALUE * (1 - 1e-15),
      },
    }));
    const elevenMaxSim = simulateExamPaper({
      blueprint: elevenMaxBp,
      learnerId: "l-ext",
      beliefs: zeroVarExtBelief,
      evidence: elevenEvidence,
      examAtMs: DAY_MS,
      numDraws: 11,
      seed: 20,
    });
    expect(Number.isFinite(elevenMaxSim.sectionSummaries["sec"]!.timedMeanScore)).toBe(true);
    expect(Number.isFinite(elevenMaxSim.sectionSummaries["sec"]!.untimedMeanScore)).toBe(true);
    expect(Number.isFinite(elevenMaxSim.timedExpectedScore)).toBe(true);
    expect(Number.isFinite(elevenMaxSim.untimedExpectedScore)).toBe(true);

    const r13HugeThreeDrawBp = makeWeightAndDrawBp("r13-huge-3draws", [1 / 3, 2 / 3], [0, 1e308], 1e308);
    const r13HugeEvidence: ExamEvidenceRecord[] = [
      {
        evidenceId: "r13-hp1",
        learnerId: "l-huge-w",
        sectionId: "sec",
        partId: "p1",
        evidenceKind: "rubric_assessment",
        observedAtMs: DAY_MS,
        countsTowardMastery: true,
        assisted: false,
        exposed: false,
        rubricScore: { kind: "exact", score: 8e307 },
      },
      {
        evidenceId: "r13-hp2",
        learnerId: "l-huge-w",
        sectionId: "sec",
        partId: "p2",
        evidenceKind: "rubric_assessment",
        observedAtMs: DAY_MS,
        countsTowardMastery: true,
        assisted: false,
        exposed: false,
        rubricScore: { kind: "exact", score: 9e307 },
      },
    ];
    const r13HugeBeliefs = {
      kExt: createSkillBelief({
        workspaceId: "ws-1",
        learnerId: "l-huge-w",
        courseId: "huge",
        confirmedSkillVersion: 1,
        abilityMean: 0,
        abilityVariance: 0,
        logStability: Math.log(14),
        implicitLogCredit: 0,
        lastDirectRecallAtMs: DAY_MS,
      }),
    };
    const r13ThreeDrawHugeSim = simulateExamPaper({
      blueprint: r13HugeThreeDrawBp,
      learnerId: "l-huge-w",
      beliefs: r13HugeBeliefs,
      evidence: r13HugeEvidence,
      examAtMs: DAY_MS,
      numDraws: 3,
      seed: 21,
    });
    expect(Number.isFinite(r13ThreeDrawHugeSim.sectionSummaries["sec"]!.timedMeanScore)).toBe(true);
    expect(Number.isFinite(r13ThreeDrawHugeSim.sectionSummaries["sec"]!.untimedMeanScore)).toBe(true);
    expect(Number.isFinite(r13ThreeDrawHugeSim.timedExpectedScore)).toBe(true);
    expect(Number.isFinite(r13ThreeDrawHugeSim.untimedExpectedScore)).toBe(true);
    expect(r13ThreeDrawHugeSim.sectionSummaries["sec"]!.timedMeanScore / 1e307).toBeCloseTo(8 + 2 / 3, 12);
    const r13Crn = evaluateCrnActionRoi({
      blueprint: r13HugeThreeDrawBp,
      learnerId: "l-huge-w",
      beliefs: r13HugeBeliefs,
      evidence: r13HugeEvidence,
      examAtMs: DAY_MS,
      baselineActions: [],
      candidateAction: { actionId: "ext-boost", title: "Ext", durationHours: 1, kind: "skill_repair" },
      crnSeed: 21,
      numDraws: 3,
    });
    expect(Number.isFinite(r13Crn.pairedMeanGain)).toBe(true);
    expect(Number.isFinite(r13Crn.monteCarloSe)).toBe(true);
  });

  it("enforces all Round-14 3 P1 extreme-scale IEEE-754 overflow invariants", () => {
    // [R14 P1-1] Exact CRN diffs [1.5e308, 1.5e308, -1.5e308] scale before subtracting in monteCarloSe (= 1e308, never NaN).
    const r14TwoSecBp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "r14-crn-se-scale",
        title: "R14 CRN SE Scale",
        totalTimeLimitMinutes: 60,
        totalPoints: 1.5e308,
        skillIds: ["kUp", "kDown"],
        thetaCovariance: [
          [0, 0],
          [0, 0],
        ],
        sections: [
          {
            sectionId: "sUp",
            label: "Up",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 1.5e308],
            scoreStep: 1.5e308,
            parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["kUp"] }],
            items: [
              {
                itemId: "qUp",
                sectionId: "sUp",
                partId: "p1",
                skillIds: ["kUp"],
                guess: 0,
                lapse: 0,
                points: 1,
                timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
            rawToBandTable: [
              { rawMin: 0, rawMax: 0, score: 0 },
              { rawMin: 1, rawMax: 1, score: 1.5e308 },
            ],
          },
          {
            sectionId: "sDown",
            label: "Down",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 1.5e308],
            scoreStep: 1.5e308,
            parts: [{ partId: "p2", label: "P2", weight: 1, skillIds: ["kDown"] }],
            items: [
              {
                itemId: "qDown",
                sectionId: "sDown",
                partId: "p2",
                skillIds: ["kDown"],
                guess: 0,
                lapse: 0,
                points: 1,
                timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
            rawToBandTable: [
              { rawMin: 0, rawMax: 0, score: 0 },
              { rawMin: 1, rawMax: 1, score: 1.5e308 },
            ],
          },
        ],
      }),
      scoreRange: [0, 1.5e308] as const,
      scoreStep: 1.5e308,
    };
    const r14DiffDraws = [
      { zLatent: [0, 0], nuSpeed: 0, itemUniforms: [0.6, 0.999999], itemTimeNormals: [0, 0], rubricScoreNormals: [], rubricTimeNormals: [] },
      { zLatent: [0, 0], nuSpeed: 0, itemUniforms: [0.6, 0.999999], itemTimeNormals: [0, 0], rubricScoreNormals: [], rubricTimeNormals: [] },
      { zLatent: [0, 0], nuSpeed: 0, itemUniforms: [0.999999, 0.4], itemTimeNormals: [0, 0], rubricScoreNormals: [], rubricTimeNormals: [] },
    ];
    const r14CrnBeliefs = {
      kUp: createSkillBelief({
        workspaceId: "ws-1",
        learnerId: "l-r14",
        courseId: "r14",
        confirmedSkillVersion: 1,
        abilityMean: 0,
        abilityVariance: 0,
        logStability: Math.log(14),
        implicitLogCredit: 0,
        lastDirectRecallAtMs: DAY_MS,
      }),
      kDown: createSkillBelief({
        workspaceId: "ws-1",
        learnerId: "l-r14",
        courseId: "r14",
        confirmedSkillVersion: 1,
        abilityMean: 0,
        abilityVariance: 0,
        logStability: Math.log(14),
        implicitLogCredit: 0,
        lastDirectRecallAtMs: DAY_MS,
      }),
    };
    const r14CrnRes = evaluateCrnActionRoi({
      blueprint: r14TwoSecBp,
      learnerId: "l-r14",
      beliefs: r14CrnBeliefs,
      evidence: [],
      examAtMs: DAY_MS,
      baselineActions: [],
      candidateAction: {
        actionId: "tradeoff-shift",
        title: "Shift",
        durationHours: 1,
        kind: "skill_repair",
        skillEffects: {
          kUp: { abilityDelta: 10 },
          kDown: { abilityDelta: -10 },
        },
      },
      crnSeed: 1,
      precomputedDraws: r14DiffDraws,
    });
    expect(r14CrnRes.pairedMeanGain / 1e307).toBeCloseTo(5, 10);
    expect(r14CrnRes.monteCarloSe / 1e308).toBeCloseTo(1, 10);

    // Minor guard: tiny weight 1e-12 paired with 1 is not rounded to 0 in rational loop.
    const tinyRatioBp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "r14-tiny-ratio",
        title: "R14 Tiny Ratio",
        totalTimeLimitMinutes: 30,
        totalPoints: 1e6,
        skillIds: ["kR"],
        thetaCovariance: [[0]],
        sections: [
          {
            sectionId: "sec",
            label: "Sec",
            scoringKind: "rubric_band",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 1e6],
            scoreStep: 1,
            parts: [
              { partId: "p1", label: "P1", weight: 1e-12, skillIds: ["kR"], timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 } },
              { partId: "p2", label: "P2", weight: 1, skillIds: ["kR"], timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 } },
            ],
          },
        ],
      }),
      scoreRange: [0, 1e6] as const,
      scoreStep: 1,
    };
    const tinyRatioSim = simulateExamPaper({
      blueprint: tinyRatioBp,
      learnerId: "l-r14",
      beliefs: {
        kR: createSkillBelief({
          workspaceId: "ws-1",
          learnerId: "l-r14",
          courseId: "r14",
          confirmedSkillVersion: 1,
          abilityMean: 0,
          abilityVariance: 0,
          logStability: Math.log(14),
          implicitLogCredit: 0,
          lastDirectRecallAtMs: DAY_MS,
        }),
      },
      evidence: [
        {
          evidenceId: "tr-1",
          learnerId: "l-r14",
          sectionId: "sec",
          partId: "p1",
          evidenceKind: "rubric_assessment",
          observedAtMs: DAY_MS,
          countsTowardMastery: true,
          assisted: false,
          exposed: false,
          rubricScore: { kind: "exact", score: 1e6 },
        },
        {
          evidenceId: "tr-2",
          learnerId: "l-r14",
          sectionId: "sec",
          partId: "p2",
          evidenceKind: "rubric_assessment",
          observedAtMs: DAY_MS,
          countsTowardMastery: true,
          assisted: false,
          exposed: false,
          rubricScore: { kind: "exact", score: 0 },
        },
      ],
      examAtMs: DAY_MS,
      numDraws: 1,
      seed: 1,
    });
    expect(tinyRatioSim.sectionSummaries["sec"]!.timedMeanScore).toBeGreaterThan(5e-7);

    // [R14 P1-2] Discrete DP/PMF expectation stays finite at Number.MAX_VALUE when merged item probabilities sum to 1 + eps (p = 0.25, 0.325).
    const p25_325Bp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "r14-maxval-prob-eps",
        title: "R14 MAX_VALUE prob eps",
        totalTimeLimitMinutes: 30,
        totalPoints: Number.MAX_VALUE,
        skillIds: ["sA", "sB"],
        thetaCovariance: [
          [0, 0],
          [0, 0],
        ],
        sections: [
          {
            sectionId: "sec",
            label: "Sec",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, Number.MAX_VALUE],
            scoreStep: Number.MAX_VALUE,
            parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["sA", "sB"] }],
            items: [
              {
                itemId: "i1",
                sectionId: "sec",
                partId: "p1",
                skillIds: ["sA"],
                guess: 0,
                lapse: 0,
                points: 1,
                timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
              {
                itemId: "i2",
                sectionId: "sec",
                partId: "p1",
                skillIds: ["sB"],
                guess: 0,
                lapse: 0,
                points: 1,
                timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
            rawToBandTable: [
              { rawMin: 0, rawMax: 0, score: Number.MAX_VALUE },
              { rawMin: 1, rawMax: 2, score: Number.MAX_VALUE },
            ],
          },
        ],
      }),
      scoreRange: [0, Number.MAX_VALUE] as const,
      scoreStep: Number.MAX_VALUE,
    };
    const epsBeliefs = {
      sA: createSkillBelief({
        workspaceId: "ws-1",
        learnerId: "l-eps",
        courseId: "eps",
        confirmedSkillVersion: 1,
        abilityMean: Math.log(0.25 / 0.75),
        abilityVariance: 0,
        logStability: Math.log(14),
        implicitLogCredit: 0,
        lastDirectRecallAtMs: DAY_MS,
      }),
      sB: createSkillBelief({
        workspaceId: "ws-1",
        learnerId: "l-eps",
        courseId: "eps",
        confirmedSkillVersion: 1,
        abilityMean: Math.log(0.325 / 0.675),
        abilityVariance: 0,
        logStability: Math.log(14),
        implicitLogCredit: 0,
        lastDirectRecallAtMs: DAY_MS,
      }),
    };
    const epsSim = simulateExamPaper({
      blueprint: p25_325Bp,
      learnerId: "l-eps",
      beliefs: epsBeliefs,
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 1,
      seed: 22,
    });
    expect(epsSim.sectionSummaries["sec"]!.untimedMeanScore).toBe(Number.MAX_VALUE);
    expect(epsSim.untimedExpectedScore).toBe(Number.MAX_VALUE);

    // [R14 P1-3] Three weighted_sum sections scoring [1e308, 1e308, -1e308] cancel safely to 1e308 across timed, matched-untimed, & PMF convolution.
    const cancelBp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "r14-cancel-1e308",
        title: "R14 Cancel 1e308",
        totalTimeLimitMinutes: 90,
        totalPoints: 1e308,
        skillIds: ["kC"],
        thetaCovariance: [[0]],
        sections: [
          {
            sectionId: "s1",
            label: "S1",
            scoringKind: "rubric_band",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 1e308],
            scoreStep: 1e308,
            parts: [
              {
                partId: "p1",
                label: "P1",
                weight: 1,
                skillIds: ["kC"],
                timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
          },
          {
            sectionId: "s2",
            label: "S2",
            scoringKind: "rubric_band",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 1e308],
            scoreStep: 1e308,
            parts: [
              {
                partId: "p2",
                label: "P2",
                weight: 1,
                skillIds: ["kC"],
                timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
          },
          {
            sectionId: "s3",
            label: "S3",
            scoringKind: "rubric_band",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [-1e308, 0],
            scoreStep: 1e308,
            parts: [
              {
                partId: "p3",
                label: "P3",
                weight: 1,
                skillIds: ["kC"],
                timeModel: { mu: 4, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
          },
        ],
      }),
      scoreRange: [0, 1e308] as const,
      scoreStep: 1e308,
    };
    const cancelEvidence: ExamEvidenceRecord[] = [
      {
        evidenceId: "ce-1",
        learnerId: "l-cancel",
        sectionId: "s1",
        partId: "p1",
        evidenceKind: "rubric_assessment",
        observedAtMs: DAY_MS,
        countsTowardMastery: true,
        assisted: false,
        exposed: false,
        rubricScore: { kind: "exact", score: 1e308 },
      },
      {
        evidenceId: "ce-2",
        learnerId: "l-cancel",
        sectionId: "s2",
        partId: "p2",
        evidenceKind: "rubric_assessment",
        observedAtMs: DAY_MS,
        countsTowardMastery: true,
        assisted: false,
        exposed: false,
        rubricScore: { kind: "exact", score: 1e308 },
      },
      {
        evidenceId: "ce-3",
        learnerId: "l-cancel",
        sectionId: "s3",
        partId: "p3",
        evidenceKind: "rubric_assessment",
        observedAtMs: DAY_MS,
        countsTowardMastery: true,
        assisted: false,
        exposed: false,
        rubricScore: { kind: "exact", score: -1e308 },
      },
    ];
    const cancelSim = simulateExamPaper({
      blueprint: cancelBp,
      learnerId: "l-cancel",
      beliefs: {
        kC: createSkillBelief({
          workspaceId: "ws-1",
          learnerId: "l-cancel",
          courseId: "cancel",
          confirmedSkillVersion: 1,
          abilityMean: 0,
          abilityVariance: 0,
          logStability: Math.log(14),
          implicitLogCredit: 0,
          lastDirectRecallAtMs: DAY_MS,
        }),
      },
      evidence: cancelEvidence,
      examAtMs: DAY_MS,
      numDraws: 2,
      seed: 23,
    });
    expect(cancelSim.timedScores.every((s) => s === 1e308)).toBe(true);
    expect(cancelSim.untimedScores.every((s) => s === 1e308)).toBe(true);
    expect(cancelSim.timedExpectedScore).toBe(1e308);
    expect(cancelSim.matchedUntimedExpectedScore).toBe(1e308);
    expect(cancelSim.untimedExpectedScore).toBe(1e308);
  });

  it("enforces all Round-15 2 P1 fast-path & ScaledFloat invariants", () => {
    // [R15 P1-1 Case A] Inactive large section w=1e308, score=0 paired with active w=1, score=1 preserves 1 exact.
    const r15CaseABp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "r15-case-a",
        title: "R15 Case A",
        totalTimeLimitMinutes: 60,
        totalPoints: 1,
        skillIds: ["kR15"],
        thetaCovariance: [[0]],
        sections: [
          {
            sectionId: "sBigZero",
            label: "BigZero",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 1e308,
            scoreRange: [0, 1e308],
            scoreStep: 1e308,
            parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["kR15"] }],
            items: [
              {
                itemId: "q1",
                sectionId: "sBigZero",
                partId: "p1",
                skillIds: ["kR15"],
                guess: 0,
                lapse: 0,
                points: 1,
                timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
            rawToBandTable: [
              { rawMin: 0, rawMax: 1, score: 0 },
            ],
          },
          {
            sectionId: "sUnitOne",
            label: "UnitOne",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 1],
            scoreStep: 1,
            parts: [{ partId: "p2", label: "P2", weight: 1, skillIds: ["kR15"] }],
            items: [
              {
                itemId: "q2",
                sectionId: "sUnitOne",
                partId: "p2",
                skillIds: ["kR15"],
                guess: 0,
                lapse: 0,
                points: 1,
                timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 },
              },
            ],
            rawToBandTable: [
              { rawMin: 0, rawMax: 1, score: 1 },
            ],
          },
        ],
      }),
      scoreRange: [0, 1] as const,
      scoreStep: 1,
    };
    const r15CaseASim = simulateExamPaper({
      blueprint: r15CaseABp,
      learnerId: "l-r15",
      beliefs: {},
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 2,
      seed: 24,
    });
    expect(r15CaseASim.timedExpectedScore).toBe(1);
    expect(r15CaseASim.matchedUntimedExpectedScore).toBe(1);
    expect(r15CaseASim.untimedExpectedScore).toBe(1);

    // [R15 P1-1 Case B] 3-section [1e308*0, 1*0, 100] AND 50/50 s1 (w=1e308, P(0)=0.5, P(1e308)=0.5) + s2 (w=1, 100) on [0, 200] -> 150.
    const r15ThreeZeroBp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "r15-3sec-100",
        title: "R15 3sec 100",
        totalTimeLimitMinutes: 90,
        totalPoints: 200,
        skillIds: ["kR15"],
        thetaCovariance: [[0]],
        sections: [
          {
            sectionId: "s1",
            label: "S1",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 1e308,
            scoreRange: [0, 1],
            scoreStep: 1,
            parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["kR15"] }],
            items: [{ itemId: "q1", sectionId: "s1", partId: "p1", skillIds: ["kR15"], guess: 0, lapse: 0, points: 1, timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
            rawToBandTable: [{ rawMin: 0, rawMax: 1, score: 0 }],
          },
          {
            sectionId: "s2",
            label: "S2",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 1e308],
            scoreStep: 1e308,
            parts: [{ partId: "p2", label: "P2", weight: 1, skillIds: ["kR15"] }],
            items: [{ itemId: "q2", sectionId: "s2", partId: "p2", skillIds: ["kR15"], guess: 0, lapse: 0, points: 1, timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
            rawToBandTable: [{ rawMin: 0, rawMax: 1, score: 0 }],
          },
          {
            sectionId: "s3",
            label: "S3",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 100],
            scoreStep: 1,
            parts: [{ partId: "p3", label: "P3", weight: 1, skillIds: ["kR15"] }],
            items: [{ itemId: "q3", sectionId: "s3", partId: "p3", skillIds: ["kR15"], guess: 0, lapse: 0, points: 1, timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 } }],
            rawToBandTable: [{ rawMin: 0, rawMax: 1, score: 100 }],
          },
        ],
      }),
      scoreRange: [0, 200] as const,
      scoreStep: 1,
    };
    const r15ThreeZeroSim = simulateExamPaper({
      blueprint: r15ThreeZeroBp,
      learnerId: "l-r15",
      beliefs: {},
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 2,
      seed: 25,
    });
    expect(r15ThreeZeroSim.untimedExpectedScore).toBe(100);
    expect(r15ThreeZeroSim.matchedUntimedExpectedScore).toBe(100);

    const r15HalfBlowupBp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "r15-50-50-150",
        title: "R15 50/50 150",
        totalTimeLimitMinutes: 60,
        totalPoints: 200,
        skillIds: ["kHalf"],
        thetaCovariance: [[0]],
        sections: [
          {
            sectionId: "s1",
            label: "S1",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 1e308,
            scoreRange: [0, 1e308],
            scoreStep: 1e308,
            parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["kHalf"] }],
            items: [
              { itemId: "q1", sectionId: "s1", partId: "p1", skillIds: ["kHalf"], guess: 0, lapse: 0, points: 1, timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 } },
            ],
            rawToBandTable: [
              { rawMin: 0, rawMax: 0, score: 0 },
              { rawMin: 1, rawMax: 1, score: 1e308 },
            ],
          },
          {
            sectionId: "s2",
            label: "S2",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [0, 100],
            scoreStep: 1,
            parts: [{ partId: "p2", label: "P2", weight: 1, skillIds: ["kHalf"] }],
            items: [
              { itemId: "q2", sectionId: "s2", partId: "p2", skillIds: ["kHalf"], guess: 0, lapse: 0, points: 1, timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 } },
            ],
            rawToBandTable: [{ rawMin: 0, rawMax: 1, score: 100 }],
          },
        ],
      }),
      scoreRange: [0, 200] as const,
      scoreStep: 1,
    };
    const r15HalfBeliefs = {
      kHalf: createSkillBelief({
        workspaceId: "ws-1",
        learnerId: "l-r15",
        courseId: "r15",
        confirmedSkillVersion: 1,
        abilityMean: 0,
        abilityVariance: 0,
        logStability: Math.log(14),
        implicitLogCredit: 0,
        lastDirectRecallAtMs: DAY_MS,
      }),
    };
    const r15HalfDraws = [
      { zLatent: [0], nuSpeed: 0, itemUniforms: [0.25, 0.25], itemTimeNormals: [0, 0], rubricScoreNormals: [], rubricTimeNormals: [] },
      { zLatent: [0], nuSpeed: 0, itemUniforms: [0.75, 0.75], itemTimeNormals: [0, 0], rubricScoreNormals: [], rubricTimeNormals: [] },
    ];
    const r15HalfSim = simulateExamPaper({
      blueprint: r15HalfBlowupBp,
      learnerId: "l-r15",
      beliefs: r15HalfBeliefs,
      evidence: [],
      examAtMs: DAY_MS,
      precomputedDraws: r15HalfDraws,
    });
    expect(r15HalfSim.untimedExpectedScore).toBe(150);
    expect(r15HalfSim.matchedUntimedExpectedScore).toBe(150);

    // [R15 P1-2] [-2^80, 0] with 2 items at p = 1 - 2^-41 preserves -0.25 without catastrophic cancellation.
    const negPow80 = -(2 ** 80);
    const lapsePow41 = 2 ** -41;
    const negCancelBp = {
      ...createSharedFullPaperBlueprint({
        blueprintId: "r15-neg-pow80",
        title: "R15 Neg 2^80",
        totalTimeLimitMinutes: 30,
        totalPoints: 2 ** 80,
        skillIds: ["kNeg80"],
        thetaCovariance: [[0]],
        sections: [
          {
            sectionId: "sec",
            label: "Sec",
            scoringKind: "item_raw_table",
            timeLimitMinutes: null,
            weight: 1,
            scoreRange: [negPow80, 0],
            scoreStep: 2 ** 80,
            parts: [{ partId: "p1", label: "P1", weight: 1, skillIds: ["kNeg80"] }],
            items: [
              { itemId: "q1", sectionId: "sec", partId: "p1", skillIds: ["kNeg80"], guess: 0, lapse: lapsePow41, points: 1, timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 } },
              { itemId: "q2", sectionId: "sec", partId: "p1", skillIds: ["kNeg80"], guess: 0, lapse: lapsePow41, points: 1, timeModel: { mu: 3, speedLoading: 0, skillLoading: {}, sigma: 0.01 } },
            ],
            rawToBandTable: [
              { rawMin: 0, rawMax: 0, score: negPow80 },
              { rawMin: 1, rawMax: 2, score: 0 },
            ],
          },
        ],
      }),
      scoreRange: [negPow80, 0] as const,
      scoreStep: 2 ** 80,
    };
    const negCancelBeliefs = {
      kNeg80: createSkillBelief({
        workspaceId: "ws-1",
        learnerId: "l-r15",
        courseId: "r15",
        confirmedSkillVersion: 1,
        abilityMean: 100,
        abilityVariance: 0,
        logStability: Math.log(14),
        implicitLogCredit: 0,
        lastDirectRecallAtMs: DAY_MS,
      }),
    };
    const negCancelSim = simulateExamPaper({
      blueprint: negCancelBp,
      learnerId: "l-r15",
      beliefs: negCancelBeliefs,
      evidence: [],
      examAtMs: DAY_MS,
      numDraws: 1,
      seed: 26,
    });
    expect(negCancelSim.sectionSummaries["sec"]!.untimedMeanScore).toBe(-0.25);
    expect(negCancelSim.untimedExpectedScore).toBe(-0.25);
  });
});
