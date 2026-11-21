import { snapToScoreGrid, validateExamBlueprint } from "./ielts-blueprint";
import { IELTS_ACADEMIC_DIAGNOSTIC_SEEDS } from "./ielts-diagnostic-seeds";
import { partitionExamEvidence, simulateExamPaper } from "./simulator";
import type {
  ExamBlueprintV1,
  ExamEvidenceRecord,
  ExamScoreForecastV1,
  ForecastTargetKind,
  JointPassProbabilityEstimate,
  JointPassTarget,
  PaperSimulationSummary,
  SkillBeliefMap,
  WholePaperCalibrationRecord,
} from "./types";

const TARGET_COVERAGE = 0.8;

/**
 * Pool-Adjacent-Violators (PAV) isotonic regression (monotonically non-decreasing in x).
 * Merges ties in x first so identical scores always map identically.
 */
export function fitPavIsotonic(
  points: readonly { readonly x: number; readonly y: number; readonly weight?: number }[],
): readonly { readonly xMin: number; readonly xMax: number; readonly xMid: number; readonly value: number }[] {
  const valid = points
    .filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y))
    .map((pt) => ({ x: pt.x, y: Math.min(1, Math.max(0, pt.y)), w: Math.max(1e-9, pt.weight ?? 1) }))
    .sort((a, b) => a.x - b.x);
  if (valid.length === 0) return [];

  const grouped: Array<{ xMin: number; xMax: number; sumW: number; sumWY: number; sumWX: number }> = [];
  for (const pt of valid) {
    const prev = grouped[grouped.length - 1];
    if (prev && Math.abs(pt.x - prev.xMax) <= 1e-12) {
      prev.xMax = pt.x;
      prev.sumW += pt.w;
      prev.sumWY += pt.w * pt.y;
      prev.sumWX += pt.w * pt.x;
    } else {
      grouped.push({ xMin: pt.x, xMax: pt.x, sumW: pt.w, sumWY: pt.w * pt.y, sumWX: pt.w * pt.x });
    }
  }

  const blocks: typeof grouped = [];
  for (const block of grouped) {
    blocks.push({ ...block });
    while (blocks.length >= 2) {
      const top = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (prev.sumWY / prev.sumW <= top.sumWY / top.sumW) break;
      blocks.pop();
      prev.xMax = top.xMax;
      prev.sumW += top.sumW;
      prev.sumWY += top.sumWY;
      prev.sumWX += top.sumWX;
    }
  }

  return blocks.map((b) => ({
    xMin: b.xMin,
    xMax: b.xMax,
    xMid: b.sumWX / b.sumW,
    value: Math.min(1, Math.max(0, b.sumWY / b.sumW)),
  }));
}

export function evaluatePavIsotonic(
  blocks: readonly { readonly xMin: number; readonly xMax: number; readonly xMid: number; readonly value: number }[],
  x: number,
): number {
  if (blocks.length === 0) return Math.min(1, Math.max(0, x));
  if (x <= blocks[0]!.xMid) return blocks[0]!.value;
  const last = blocks[blocks.length - 1]!;
  if (x >= last.xMid) return last.value;
  for (let i = 0; i < blocks.length - 1; i++) {
    const a = blocks[i]!;
    const b = blocks[i + 1]!;
    if (x >= a.xMid && x <= b.xMid) {
      const span = b.xMid - a.xMid;
      if (span <= 1e-12) return b.value;
      return a.value + ((x - a.xMid) / span) * (b.value - a.value);
    }
  }
  return last.value;
}

/** Worst-case interval-censored CQR nonconformity score: never midpoint! */
export function cqrWorstCaseNonconformity(record: WholePaperCalibrationRecord): number {
  const { q10, q90 } = record.predictedQuantiles;
  const yLow =
    record.observedScore.kind === "exact"
      ? record.observedScore.score
      : Math.min(record.observedScore.low, record.observedScore.high);
  const yHigh =
    record.observedScore.kind === "exact"
      ? record.observedScore.score
      : Math.max(record.observedScore.low, record.observedScore.high);
  return Math.max(q10 - yLow, yHigh - q90);
}

export function filterIndependentCalibrationRecords(input: {
  readonly records: readonly WholePaperCalibrationRecord[];
  readonly blueprintId: string;
  readonly targetKind: ForecastTargetKind;
  readonly excludeLearnerId?: string;
  readonly excludePaperFamilyIds?: ReadonlySet<string>;
}): WholePaperCalibrationRecord[] {
  return input.records.filter((rec) => {
    if (rec.blueprintId !== input.blueprintId) return false;
    if (rec.targetKind !== input.targetKind) return false;
    if (!rec.countsTowardMastery || rec.assisted || rec.exposed === true) return false;
    if (rec.evidenceKind === "practice_feedback" || rec.evidenceKind === "self_report") return false;
    if (input.excludeLearnerId && rec.learnerId === input.excludeLearnerId) return false;
    if (input.excludePaperFamilyIds && input.excludePaperFamilyIds.has(rec.paperFamilyId)) return false;
    if (!Number.isFinite(rec.predictedQuantiles.q10) || !Number.isFinite(rec.predictedQuantiles.q90)) return false;
    return true;
  });
}

function observedPassesJointTarget(record: WholePaperCalibrationRecord, target: JointPassTarget): number | null {
  const overallLow =
    record.observedScore.kind === "exact"
      ? record.observedScore.score
      : Math.min(record.observedScore.low, record.observedScore.high);
  const overallHigh =
    record.observedScore.kind === "exact"
      ? record.observedScore.score
      : Math.max(record.observedScore.low, record.observedScore.high);
  let overallPass: number;
  if (overallLow >= target.targetOverall) overallPass = 1;
  else if (overallHigh < target.targetOverall) overallPass = 0;
  else overallPass = 0; // Conservative for interval-censored straddling scores.

  if (!record.observedSectionScores) return overallPass;
  const entries = Object.values(record.observedSectionScores);
  if (entries.length === 0) return overallPass;
  for (const val of entries) {
    const secLow = typeof val === "number" ? val : Math.min(val.low, val.high);
    if (secLow < target.targetMinSection) return 0;
  }
  return overallPass;
}

function rawJointPassFromSimulation(
  simulation: PaperSimulationSummary,
  blueprint: ExamBlueprintV1,
  target: JointPassTarget,
): number {
  const n = simulation.timedScores.length;
  if (n === 0) return 0;
  let passed = 0;
  for (let i = 0; i < n; i++) {
    const overall = simulation.timedScores[i]!;
    if (overall < target.targetOverall) continue;
    const secMap = simulation.drawSectionScores[i] ?? {};
    const allSectionsPass = blueprint.sections.every(
      (section) => (secMap[section.sectionId] ?? 0) >= target.targetMinSection,
    );
    if (allSectionsPass) passed += 1;
  }
  return passed / n;
}

function recordRawProbForTarget(record: WholePaperCalibrationRecord, target: JointPassTarget): number {
  const matched = record.predictedTargetPassProbs?.find(
    (entry) =>
      Math.abs(entry.targetOverall - target.targetOverall) <= 1e-9 &&
      Math.abs(entry.targetMinSection - target.targetMinSection) <= 1e-9,
  );
  if (matched) return Math.min(1, Math.max(0, matched.rawProbability));
  if (record.predictedJointPassProb !== undefined) return Math.min(1, Math.max(0, record.predictedJointPassProb));
  const { q10, q50, q90 } = record.predictedQuantiles;
  const spread = Math.max(0.25, (q90 - q10) / 2.56);
  const z = (q50 - Math.max(target.targetOverall, target.targetMinSection)) / spread;
  return 1 / (1 + Math.exp(-1.7 * z));
}

export function calibrateJointPassTargets(input: {
  readonly simulation: PaperSimulationSummary;
  readonly blueprint: ExamBlueprintV1;
  readonly calibrationRecords: readonly WholePaperCalibrationRecord[];
  readonly targets: readonly JointPassTarget[];
}): JointPassProbabilityEstimate[] {
  const rawEstimates = input.targets.map((target) => {
    const rawProbability = rawJointPassFromSimulation(input.simulation, input.blueprint, target);
    const points: Array<{ x: number; y: number }> = [];
    for (const rec of input.calibrationRecords) {
      const y = observedPassesJointTarget(rec, target);
      if (y === null) continue;
      points.push({ x: recordRawProbForTarget(rec, target), y });
    }
    const blocks = fitPavIsotonic(points);
    const calibratedProbability = points.length > 0 ? evaluatePavIsotonic(blocks, rawProbability) : rawProbability;
    return {
      targetOverall: target.targetOverall,
      targetMinSection: target.targetMinSection,
      rawProbability,
      calibratedProbability,
      calibrationSampleCount: points.length,
    };
  });

  // Enforce poset monotonicity: whenever target B dominates target A (B >= A), P(B) <= P(A).
  const indexed = rawEstimates.map((est, idx) => ({ est, idx, calibrated: est.calibratedProbability }));
  indexed.sort(
    (a, b) =>
      a.est.targetOverall - b.est.targetOverall || a.est.targetMinSection - b.est.targetMinSection,
  );
  for (let i = 0; i < indexed.length; i++) {
    for (let j = 0; j < i; j++) {
      const easier = indexed[j]!;
      const harder = indexed[i]!;
      if (
        harder.est.targetOverall >= easier.est.targetOverall &&
        harder.est.targetMinSection >= easier.est.targetMinSection &&
        harder.calibrated > easier.calibrated
      ) {
        harder.calibrated = easier.calibrated;
      }
    }
  }
  const restored = new Array<JointPassProbabilityEstimate>(rawEstimates.length);
  for (const item of indexed) {
    restored[item.idx] = { ...item.est, calibratedProbability: item.calibrated };
  }
  return restored;
}

export function evaluateExamForecast(input: {
  readonly blueprint: ExamBlueprintV1;
  readonly learnerId: string;
  readonly beliefs: SkillBeliefMap;
  readonly evidence: readonly ExamEvidenceRecord[];
  readonly calibrationRecords: readonly WholePaperCalibrationRecord[];
  readonly examAtMs: number;
  readonly targetKind?: ForecastTargetKind;
  readonly targetPaperFamilyIds?: readonly string[];
  readonly jointPassTarget?: JointPassTarget;
  readonly jointPassLadder?: readonly JointPassTarget[];
  readonly maxInformativeWidth?: number;
  readonly numDraws?: number;
  readonly seed?: number;
}): ExamScoreForecastV1 {
  const missingFields = validateExamBlueprint(input.blueprint);
  if (missingFields.length > 0) {
    return {
      schemaVersion: 1,
      blueprintId: input.blueprint.blueprintId,
      status: "insufficient_blueprint",
      missingFields,
      officialExamCalibrated: false,
    };
  }

  const targetKind: ForecastTargetKind = input.targetKind ?? "same_blueprint_mock";
  const { admitted, rejectedCount } = partitionExamEvidence(input.evidence);
  const coveredSections = new Set(admitted.map((e) => e.sectionId));
  const missingSections = input.blueprint.sections
    .map((s) => s.sectionId)
    .filter((sid) => !coveredSections.has(sid));

  const excludeFamilies = new Set<string>(input.targetPaperFamilyIds ?? []);
  for (const rec of input.evidence) {
    if (rec.paperFamilyId) excludeFamilies.add(rec.paperFamilyId);
  }
  const validCalibrations = filterIndependentCalibrationRecords({
    records: input.calibrationRecords,
    blueprintId: input.blueprint.blueprintId,
    targetKind,
    excludeLearnerId: input.learnerId,
    excludePaperFamilyIds: excludeFamilies,
  });

  const n = validCalibrations.length;
  const k = Math.ceil(TARGET_COVERAGE * (n + 1));
  const recommendedSeedIds = IELTS_ACADEMIC_DIAGNOSTIC_SEEDS.filter((seed) =>
    missingSections.includes(seed.sectionId),
  ).map((seed) => seed.seedId);

  if (missingSections.length > 0 || n < 4 || k > n) {
    const kind = missingSections.length > 0 ? "run_diagnostic_items" : "submit_independent_mock";
    return {
      schemaVersion: 1,
      blueprintId: input.blueprint.blueprintId,
      status: "insufficient_independent_evidence",
      missingSections,
      rejectedEvidenceCount: rejectedCount,
      calibrationCount: n,
      requiredCalibrationCount: 4,
      nextDiagnosticAction: {
        kind,
        sectionIds: missingSections.length > 0 ? missingSections : input.blueprint.sections.map((s) => s.sectionId),
        recommendedItemIds: recommendedSeedIds,
        message:
          missingSections.length > 0
            ? `请先完成缺口部分的独立诊断作答（${missingSections.join("、")}），再生成区间预估。`
            : "当前同蓝图独立整卷标定样本不足 4 份，请再完成独立限时模考以建立 80% 区间。",
      },
      officialExamCalibrated: false,
    };
  }

  const simulation = simulateExamPaper({
    blueprint: input.blueprint,
    beliefs: input.beliefs,
    evidence: admitted,
    examAtMs: input.examAtMs,
    numDraws: input.numDraws,
    seed: input.seed,
  });

  const residuals = validCalibrations.map(cqrWorstCaseNonconformity).sort((a, b) => a - b);
  const rK = residuals[k - 1] ?? 0;

  const rawLow = simulation.q10 - rK;
  const rawHigh = simulation.q90 + rK;
  const safeLow = rawLow <= rawHigh ? rawLow : (rawLow + rawHigh) / 2;
  const safeHigh = rawLow <= rawHigh ? rawHigh : (rawLow + rawHigh) / 2;
  const low = snapToScoreGrid(safeLow, input.blueprint.scoreRange, input.blueprint.scoreStep, "floor");
  const high = snapToScoreGrid(safeHigh, input.blueprint.scoreRange, input.blueprint.scoreStep, "ceil");
  const width = Math.round((high - low) * 1_000_000) / 1_000_000;
  const [minScore, maxScore] = input.blueprint.scoreRange;
  const maxInformativeWidth = input.maxInformativeWidth ?? (maxScore - minScore) * 0.5;

  if (width > maxInformativeWidth) {
    return {
      schemaVersion: 1,
      blueprintId: input.blueprint.blueprintId,
      status: "insufficient_independent_evidence",
      missingSections: [],
      rejectedEvidenceCount: rejectedCount,
      calibrationCount: n,
      requiredCalibrationCount: 4,
      widthGateExceeded: true,
      observedIntervalWidth: width,
      maxInformativeWidth,
      nextDiagnosticAction: {
        kind: "collect_section_evidence",
        sectionIds: input.blueprint.sections.map((s) => s.sectionId),
        recommendedItemIds: IELTS_ACADEMIC_DIAGNOSTIC_SEEDS.map((s) => s.seedId),
        message: "当前标定波动过宽，建议补充高区分度独立诊断或限时模考以收窄预估区间。",
      },
      officialExamCalibrated: false,
    };
  }

  const pointEstimate = snapToScoreGrid(
    simulation.timedExpectedScore,
    input.blueprint.scoreRange,
    input.blueprint.scoreStep,
    "nearest",
  );

  const combinedTargets: JointPassTarget[] = [
    ...(input.jointPassLadder ?? []),
    ...(input.jointPassTarget ? [input.jointPassTarget] : []),
  ];
  const calibratedTargets =
    combinedTargets.length > 0
      ? calibrateJointPassTargets({
          simulation,
          blueprint: input.blueprint,
          calibrationRecords: validCalibrations,
          targets: combinedTargets,
        })
      : [];

  const ladderCount = input.jointPassLadder?.length ?? 0;
  const jointPassLadder = ladderCount > 0 ? calibratedTargets.slice(0, ladderCount) : undefined;
  const jointPassTarget = input.jointPassTarget ? calibratedTargets[ladderCount] : undefined;

  return {
    schemaVersion: 1,
    blueprintId: input.blueprint.blueprintId,
    status: "calibrated_forecast_ready",
    forecastTargetKind: targetKind,
    labelScope: targetKind === "same_blueprint_mock" ? "同蓝图限时模考预估区间" : "官方考试历史标定预估区间",
    officialExamCalibrated: targetKind === "official_exam",
    confidenceLevel: TARGET_COVERAGE,
    examAtMs: input.examAtMs,
    pointEstimate,
    rawPointEstimate: simulation.timedExpectedScore,
    interval80: { low, high, width, conformalMargin: rK },
    untimedBaseline: {
      expectedScore: simulation.untimedExpectedScore,
      timeSqueezeDelta: simulation.timeSqueezeDelta,
      scoreDistribution: simulation.untimedScoreDistribution,
    },
    timedSimulation: {
      expectedScore: simulation.timedExpectedScore,
      q10: simulation.q10,
      q50: simulation.q50,
      q90: simulation.q90,
      rightCensoringRateBySection: simulation.rightCensoringRateBySection,
      sectionSummaries: simulation.sectionSummaries,
    },
    ...(jointPassTarget ? { jointPassTarget } : {}),
    ...(jointPassLadder ? { jointPassLadder } : {}),
    calibrationReceipt: { n, k, nonconformityRadius: rK, maxInformativeWidth },
  };
}
