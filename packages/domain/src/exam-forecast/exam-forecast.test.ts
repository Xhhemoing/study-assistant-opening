import { describe, expect, it } from "vitest";
import { createSkillBelief, DAY_MS, type SkillBeliefV1 } from "../epistemic/belief";
import {
  buildUnifiedDecisionSnapshot,
  calibrateJointPassTargets,
  choleskyDecompose,
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
    const sim = simulateExamPaper({ blueprint: mathBlueprint, beliefs, evidence: [], examAtMs: DAY_MS, numDraws: 120, seed: 7 });
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
      { evidenceId: "bad-pf", sectionId: "reading", countsTowardMastery: true, assisted: false, evidenceKind: "practice_feedback", observedAtMs: 100 },
      { evidenceId: "bad-sr", sectionId: "reading", countsTowardMastery: true, assisted: false, evidenceKind: "self_report", observedAtMs: 100 },
      { evidenceId: "bad-ast", sectionId: "reading", countsTowardMastery: true, assisted: true, evidenceKind: "diagnostic_item", observedAtMs: 100 },
      { evidenceId: "bad-exp", sectionId: "reading", countsTowardMastery: true, assisted: false, exposed: true, evidenceKind: "diagnostic_item", observedAtMs: 100 },
    ];
    expect(partitionExamEvidence(contaminated).rejectedCount).toBe(4);

    const noCredit = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      beliefs: makeIeltsBeliefs({ implicitLogCredit: 0 }),
      evidence: clean,
      examAtMs: 10 * DAY_MS,
      numDraws: 120,
      seed: 42,
    });
    const withImplicitCredit = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
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
      beliefs: makeIeltsBeliefs({ abilityMean: 0.8 }),
      evidence: makeIndependentSectionEvidence(),
      examAtMs: 2 * DAY_MS,
      numDraws: 150,
      seed: 12,
    });
    const noisyCal: WholePaperCalibrationRecord[] = [
      { ...makeCalibrationRecords(1)[0]!, recordId: "c1", predictedTargetPassProbs: [{ targetOverall: 6.5, targetMinSection: 6.0, rawProbability: 0.7 }, { targetOverall: 7.0, targetMinSection: 6.5, rawProbability: 0.4 }], observedScore: { kind: "exact", score: 6.5 }, observedSectionScores: { listening: 6.5, reading: 6.5, writing: 6.0, speaking: 6.5 } },
      { ...makeCalibrationRecords(1)[0]!, recordId: "c2", learnerId: "l2", predictedTargetPassProbs: [{ targetOverall: 6.5, targetMinSection: 6.0, rawProbability: 0.8 }, { targetOverall: 7.0, targetMinSection: 6.5, rawProbability: 0.5 }], observedScore: { kind: "exact", score: 7.0 }, observedSectionScores: { listening: 7.0, reading: 7.0, writing: 6.5, speaking: 7.0 } },
      { ...makeCalibrationRecords(1)[0]!, recordId: "c3", learnerId: "l3", predictedTargetPassProbs: [{ targetOverall: 6.5, targetMinSection: 6.0, rawProbability: 0.4 }, { targetOverall: 7.0, targetMinSection: 6.5, rawProbability: 0.6 }], observedScore: { kind: "exact", score: 7.5 }, observedSectionScores: { listening: 7.5, reading: 7.5, writing: 7.0, speaking: 7.0 } },
      { ...makeCalibrationRecords(1)[0]!, recordId: "c4", learnerId: "l4", predictedTargetPassProbs: [{ targetOverall: 6.5, targetMinSection: 6.0, rawProbability: 0.5 }, { targetOverall: 7.0, targetMinSection: 6.5, rawProbability: 0.2 }], observedScore: { kind: "exact", score: 6.0 }, observedSectionScores: { listening: 6.0, reading: 6.0, writing: 5.5, speaking: 6.0 } },
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
    expect(ladder[0]!.calibratedProbability).toBeGreaterThanOrEqual(ladder[1]!.calibratedProbability);
    expect(ladder[1]!.calibratedProbability).toBeGreaterThanOrEqual(ladder[2]!.calibratedProbability);
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
      beliefs,
      evidence: anchoredEvidence,
      examAtMs: anchorMs,
      numDraws: 200,
      seed: 31,
    });
    const after180d = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
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

    // [P1-5] Missing or NaN section scores must be skipped when targetMinSection > scoreRange[0].
    const sim = simulateExamPaper({
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      beliefs,
      evidence: anchoredEvidence,
      examAtMs: DAY_MS,
      numDraws: 60,
      seed: 19,
    });
    const incompleteSectionsCal: WholePaperCalibrationRecord[] = makeCalibrationRecords(4).map((r, idx) => ({
      ...r,
      observedSectionScores: idx === 0 ? undefined : { listening: 7.0, reading: 7.0, writing: 7.0 },
    }));
    const ladder = calibrateJointPassTargets({
      simulation: sim,
      blueprint: IELTS_ACADEMIC_V1_BLUEPRINT,
      calibrationRecords: incompleteSectionsCal,
      targets: [{ targetOverall: 7.0, targetMinSection: 6.5 }],
    });
    expect(ladder[0]!.calibrationSampleCount).toBe(0);

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
      beliefs,
      evidence,
      examAtMs: DAY_MS,
      numDraws: 50,
      seed: 21,
    });

    // [R3 P1-1] MNAR bias guard & inverted interval rejection in observedPassesJointTarget.
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
    });
    expect(mnarRes[0]!.calibrationSampleCount).toBe(0);

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
});
