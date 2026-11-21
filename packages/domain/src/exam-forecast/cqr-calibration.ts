import { IELTS_ACADEMIC_V1_BLUEPRINT, snapToScoreGrid, validateExamBlueprint } from "./ielts-blueprint";
import { IELTS_ACADEMIC_DIAGNOSTIC_SEEDS } from "./ielts-diagnostic-seeds";
import {
  DEFAULT_EXAM_SIMULATION_DRAWS,
  partitionExamEvidence,
  sectionPartIdsMap,
  sectionRangesMap,
  simulateExamPaper,
  validateNumDraws,
} from "./simulator";
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

type NumericBounds = { readonly low: number; readonly high: number };

function assertFiniteJointPassTarget(target: JointPassTarget): void {
  if (!Number.isFinite(target.targetOverall) || !Number.isFinite(target.targetMinSection)) {
    throw new RangeError("JointPassTarget thresholds must be finite numbers");
  }
}

function parseObservedOverallBounds(
  observedScore: WholePaperCalibrationRecord["observedScore"],
  scoreRange?: readonly [number, number],
): NumericBounds | null {
  let low: number;
  let high: number;
  if (observedScore.kind === "exact") {
    if (!Number.isFinite(observedScore.score)) return null;
    low = observedScore.score;
    high = observedScore.score;
  } else {
    if (!Number.isFinite(observedScore.low) || !Number.isFinite(observedScore.high) || observedScore.low > observedScore.high) {
      return null;
    }
    low = observedScore.low;
    high = observedScore.high;
  }
  if (scoreRange && (low < scoreRange[0] || high > scoreRange[1])) {
    return null;
  }
  return { low, high };
}

function parseObservedSectionBounds(
  sectionMap: WholePaperCalibrationRecord["observedSectionScores"],
  sectionRanges?: ReadonlyMap<string, readonly [number, number]>,
): ReadonlyMap<string, NumericBounds> | null {
  const parsedSections = new Map<string, NumericBounds>();
  if (!sectionMap) return parsedSections;
  for (const [secId, val] of Object.entries(sectionMap)) {
    if (!Object.hasOwn(sectionMap, secId) || val === undefined) continue;
    const secRange = sectionRanges?.get(secId);
    if (sectionRanges && !secRange) return null;
    let low: number;
    let high: number;
    if (typeof val === "number") {
      if (!Number.isFinite(val)) return null;
      low = val;
      high = val;
    } else {
      if (!Number.isFinite(val.low) || !Number.isFinite(val.high) || val.low > val.high) return null;
      low = val.low;
      high = val.high;
    }
    if (secRange && (low < secRange[0] || high > secRange[1])) return null;
    parsedSections.set(secId, { low, high });
  }
  return parsedSections;
}

function hasPairSeen(seenPairs: ReadonlyMap<string, ReadonlySet<string>>, first: string, second: string): boolean {
  return seenPairs.get(first)?.has(second) === true;
}

function markPairSeen(seenPairs: Map<string, Set<string>>, first: string, second: string): void {
  let bucket = seenPairs.get(first);
  if (!bucket) {
    bucket = new Set<string>();
    seenPairs.set(first, bucket);
  }
  bucket.add(second);
}

export function filterIndependentCalibrationRecords(input: {
  readonly records: readonly WholePaperCalibrationRecord[];
  readonly blueprintId: string;
  readonly targetKind: ForecastTargetKind;
  readonly scoreRange?: readonly [number, number];
  readonly sectionRanges?: ReadonlyMap<string, readonly [number, number]>;
  readonly examAtMs?: number;
  readonly excludeLearnerId?: string;
  readonly excludePaperFamilyIds?: ReadonlySet<string>;
}): WholePaperCalibrationRecord[] {
  const requiredEvidenceKind = input.targetKind === "official_exam" ? "official_exam" : "independent_mock";
  const excludedLearner = input.excludeLearnerId?.trim();
  const excludedFamilies = input.excludePaperFamilyIds
    ? new Set([...input.excludePaperFamilyIds].map((id) => id.trim()).filter(Boolean))
    : null;
  const seenRecordIds = new Set<string>();
  const seenLearnerFamilies = new Map<string, Set<string>>();

  return input.records.filter((rec) => {
    if (rec.blueprintId !== input.blueprintId) return false;
    if (rec.targetKind !== input.targetKind) return false;
    if (rec.evidenceKind !== requiredEvidenceKind) return false;
    if (!rec.countsTowardMastery || rec.assisted || rec.exposed === true) return false;
    if (!Number.isFinite(rec.recordedAtMs)) return false;
    if (input.examAtMs !== undefined && (!Number.isFinite(input.examAtMs) || rec.recordedAtMs > input.examAtMs)) {
      return false;
    }

    const recId = rec.recordId?.trim() ?? "";
    const recLearner = rec.learnerId?.trim() ?? "";
    const recFamily = rec.paperFamilyId?.trim() ?? "";
    if (!recId || !recLearner || !recFamily) return false;
    if (excludedLearner && recLearner === excludedLearner) return false;
    if (excludedFamilies && excludedFamilies.has(recFamily)) return false;

    const { q10, q50, q90 } = rec.predictedQuantiles;
    if (!Number.isFinite(q10) || !Number.isFinite(q50) || !Number.isFinite(q90)) return false;
    if (q10 > q50 || q50 > q90) return false;

    const range = input.scoreRange;
    if (range && (q10 < range[0] || q90 > range[1])) return false;

    if (!parseObservedOverallBounds(rec.observedScore, range)) return false;
    if (!parseObservedSectionBounds(rec.observedSectionScores, input.sectionRanges)) return false;

    if (seenRecordIds.has(recId) || hasPairSeen(seenLearnerFamilies, recLearner, recFamily)) return false;
    seenRecordIds.add(recId);
    markPairSeen(seenLearnerFamilies, recLearner, recFamily);
    return true;
  });
}

function observedPassesJointTarget(
  record: WholePaperCalibrationRecord,
  target: JointPassTarget,
  blueprint: ExamBlueprintV1,
  sectionRanges: ReadonlyMap<string, readonly [number, number]>,
): number | null {
  assertFiniteJointPassTarget(target);
  const overallBounds = parseObservedOverallBounds(record.observedScore, blueprint.scoreRange);
  if (!overallBounds) return null;
  const parsedSections = parseObservedSectionBounds(record.observedSectionScores, sectionRanges);
  if (!parsedSections) return null;

  // Provable failure check before checking missing sections (prevents MNAR bias).
  if (overallBounds.high < target.targetOverall) return 0;
  for (const section of blueprint.sections) {
    const secBounds = parsedSections.get(section.sectionId);
    if (secBounds !== undefined && secBounds.high < target.targetMinSection) return 0;
  }

  if (overallBounds.low >= target.targetOverall) {
    const allPass = blueprint.sections.every((section) => {
      if (target.targetMinSection <= section.scoreRange[0]) return true;
      const secBounds = parsedSections.get(section.sectionId);
      return secBounds !== undefined && secBounds.low >= target.targetMinSection;
    });
    if (allPass) return 1;
  }

  // Remaining straddling or missing-required-section cases default to worst-case lower bound.
  return 0;
}

function assertValidExamBlueprint(blueprint: ExamBlueprintV1): void {
  const missingFields = validateExamBlueprint(blueprint);
  if (missingFields.length > 0) {
    throw new RangeError(`Invalid exam blueprint: ${missingFields.join(", ")}`);
  }
}

function validateSimulationForBlueprint(simulation: PaperSimulationSummary, blueprint: ExamBlueprintV1): number {
  if (simulation.blueprintId !== blueprint.blueprintId) {
    throw new RangeError(
      `Simulation blueprint "${simulation.blueprintId}" does not match expected blueprint "${blueprint.blueprintId}"`,
    );
  }
  const [minScore, maxScore] = blueprint.scoreRange;
  for (const [field, val] of [
    ["q10", simulation.q10],
    ["q90", simulation.q90],
    ["timedExpectedScore", simulation.timedExpectedScore],
  ] as const) {
    if (typeof val !== "number" || !Number.isFinite(val) || val < minScore || val > maxScore) {
      throw new RangeError(`simulation.${field} must be finite within blueprint.scoreRange`);
    }
  }
  if (simulation.q10 > simulation.q90) {
    throw new RangeError("simulation.q10 must be <= simulation.q90");
  }
  const n = simulation.timedScores.length;
  if (n === 0 || simulation.drawSectionScores.length !== n) {
    throw new RangeError("simulation must contain non-empty matching draws");
  }
  for (let i = 0; i < n; i++) {
    const overall = simulation.timedScores[i];
    if (overall === undefined || !Number.isFinite(overall)) {
      throw new RangeError("simulation.timedScores must contain finite numbers");
    }
    const secMap = simulation.drawSectionScores[i];
    if (!secMap || typeof secMap !== "object") {
      throw new RangeError("simulation.drawSectionScores entries must be objects");
    }
    for (const section of blueprint.sections) {
      if (!Object.hasOwn(secMap, section.sectionId)) {
        throw new RangeError(`Simulation draw ${i} is missing section score "${section.sectionId}"`);
      }
      const secScore = secMap[section.sectionId];
      if (secScore === undefined || !Number.isFinite(secScore)) {
        throw new RangeError(`Simulation draw ${i} has non-finite score for section "${section.sectionId}"`);
      }
    }
  }
  return n;
}

function rawJointPassFromSimulation(
  simulation: PaperSimulationSummary,
  blueprint: ExamBlueprintV1,
  target: JointPassTarget,
): number {
  assertFiniteJointPassTarget(target);
  const n = validateSimulationForBlueprint(simulation, blueprint);
  let passed = 0;
  for (let i = 0; i < n; i++) {
    const overall = simulation.timedScores[i]!;
    if (overall < target.targetOverall) continue;
    const secMap = simulation.drawSectionScores[i]!;
    const allSectionsPass = blueprint.sections.every((section) => secMap[section.sectionId]! >= target.targetMinSection);
    if (allSectionsPass) passed += 1;
  }
  return passed / n;
}

export function formatJointTargetKey(target: JointPassTarget): string {
  return `${Number(target.targetOverall)}:${Number(target.targetMinSection)}`;
}

function recordRawProbForTarget(record: WholePaperCalibrationRecord, target: JointPassTarget): number | null {
  if (!Number.isFinite(target.targetOverall) || !Number.isFinite(target.targetMinSection)) return null;
  const canonicalKey = formatJointTargetKey(target);
  const canUseFixedKey =
    Number(target.targetOverall.toFixed(1)) === target.targetOverall &&
    Number(target.targetMinSection.toFixed(1)) === target.targetMinSection;
  const fixedKey = canUseFixedKey
    ? `${target.targetOverall.toFixed(1)}:${target.targetMinSection.toFixed(1)}`
    : null;
  const keyed =
    (record.predictedJointPassByTarget && Object.hasOwn(record.predictedJointPassByTarget, canonicalKey)
      ? record.predictedJointPassByTarget[canonicalKey]
      : undefined) ??
    (fixedKey !== null &&
    record.predictedJointPassByTarget &&
    Object.hasOwn(record.predictedJointPassByTarget, fixedKey)
      ? record.predictedJointPassByTarget[fixedKey]
      : undefined);
  if (keyed !== undefined && Number.isFinite(keyed) && keyed >= 0 && keyed <= 1) return keyed;

  const matched = record.predictedTargetPassProbs?.find(
    (entry) =>
      entry.targetOverall === target.targetOverall &&
      entry.targetMinSection === target.targetMinSection,
  );
  if (matched && Number.isFinite(matched.rawProbability) && matched.rawProbability >= 0 && matched.rawProbability <= 1) {
    return matched.rawProbability;
  }
  return null;
}

export function calibrateJointPassTargets(input: {
  readonly simulation: PaperSimulationSummary;
  readonly blueprint: ExamBlueprintV1;
  readonly calibrationRecords: readonly WholePaperCalibrationRecord[];
  readonly targets: readonly JointPassTarget[];
  readonly minCalibrationSamples?: number;
  readonly examAtMs?: number;
  readonly excludeLearnerId?: string;
  readonly excludePaperFamilyIds?: ReadonlySet<string>;
  readonly targetKind?: ForecastTargetKind;
}): JointPassProbabilityEstimate[] {
  assertValidExamBlueprint(input.blueprint);
  validateSimulationForBlueprint(input.simulation, input.blueprint);
  input.targets.forEach(assertFiniteJointPassTarget);
  const cutoffMs = input.examAtMs ?? input.simulation.examAtMs;
  const minSamples = Math.max(1, Math.round(input.minCalibrationSamples ?? 4));
  const excludedLearner = input.excludeLearnerId?.trim();
  const excludedFamilies = input.excludePaperFamilyIds
    ? new Set([...input.excludePaperFamilyIds].map((id) => id.trim()).filter(Boolean))
    : null;
  const effectiveTargetKind: ForecastTargetKind = input.targetKind ?? "same_blueprint_mock";
  const requiredEvidenceKind = effectiveTargetKind === "official_exam" ? "official_exam" : "independent_mock";
  const sectionRanges = sectionRangesMap(input.blueprint);

  const rawEstimates = input.targets.map((target) => {
    const rawProbability = rawJointPassFromSimulation(input.simulation, input.blueprint, target);
    const seenRecordIds = new Set<string>();
    const seenLearnerFamilies = new Map<string, Set<string>>();
    const points: Array<{ x: number; y: number }> = [];
    for (const rec of input.calibrationRecords) {
      if (rec.blueprintId !== input.blueprint.blueprintId) continue;
      if (!rec.countsTowardMastery || rec.assisted || rec.exposed === true) continue;
      if (!Number.isFinite(rec.recordedAtMs) || !Number.isFinite(cutoffMs) || rec.recordedAtMs > cutoffMs) {
        continue;
      }
      if (rec.targetKind !== effectiveTargetKind || rec.evidenceKind !== requiredEvidenceKind) continue;
      const recId = rec.recordId?.trim() ?? "";
      const recLearner = rec.learnerId?.trim() ?? "";
      const recFamily = rec.paperFamilyId?.trim() ?? "";
      if (!recId || !recLearner || !recFamily) continue;
      if (excludedLearner && recLearner === excludedLearner) continue;
      if (excludedFamilies && excludedFamilies.has(recFamily)) continue;

      const y = observedPassesJointTarget(rec, target, input.blueprint, sectionRanges);
      if (y === null) continue;
      const rawProb = recordRawProbForTarget(rec, target);
      if (rawProb === null) continue;

      if (seenRecordIds.has(recId) || hasPairSeen(seenLearnerFamilies, recLearner, recFamily)) continue;
      seenRecordIds.add(recId);
      markPairSeen(seenLearnerFamilies, recLearner, recFamily);
      points.push({ x: rawProb, y });
    }
    const isCalibrated = points.length >= minSamples;
    const blocks = isCalibrated ? fitPavIsotonic(points) : [];
    const calibratedProbability = isCalibrated ? evaluatePavIsotonic(blocks, rawProbability) : null;
    return {
      targetOverall: target.targetOverall,
      targetMinSection: target.targetMinSection,
      rawProbability,
      calibratedProbability,
      isCalibrated,
      calibrationSampleCount: points.length,
    };
  });

  // Enforce poset monotonicity across calibrated targets: whenever B >= A, P(B) <= P(A).
  const indexed = rawEstimates.map((est, idx) => ({ est, idx, calibrated: est.calibratedProbability }));
  indexed.sort(
    (a, b) =>
      a.est.targetOverall - b.est.targetOverall || a.est.targetMinSection - b.est.targetMinSection,
  );
  for (let i = 0; i < indexed.length; i++) {
    const harder = indexed[i]!;
    if (harder.calibrated === null) continue;
    for (let j = 0; j < i; j++) {
      const easier = indexed[j]!;
      if (easier.calibrated === null) continue;
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

export type ConformalBandIntervalResult =
  | {
      readonly status: "ready";
      readonly n: number;
      readonly k: number;
      readonly conformalMargin: number;
      readonly low: number;
      readonly high: number;
      readonly width: number;
      readonly pointEstimate: number;
      readonly validCalibrations: readonly WholePaperCalibrationRecord[];
    }
  | {
      readonly status: "insufficient_calibration";
      readonly n: number;
      readonly k: number;
      readonly validCalibrations: readonly WholePaperCalibrationRecord[];
    };

function computeIntervalFromCalibrations(
  simulation: PaperSimulationSummary,
  blueprint: ExamBlueprintV1,
  validCalibrations: readonly WholePaperCalibrationRecord[],
): ConformalBandIntervalResult {
  const n = validCalibrations.length;
  const k = Math.ceil(TARGET_COVERAGE * (n + 1));
  if (n < 4 || k > n) {
    return { status: "insufficient_calibration", n, k, validCalibrations };
  }
  const residuals = validCalibrations.map(cqrWorstCaseNonconformity).sort((a, b) => a - b);
  const rK = residuals[k - 1] ?? 0;

  const [minScore, maxScore] = blueprint.scoreRange;
  const clampedLow = Math.min(maxScore, Math.max(minScore, simulation.q10 - rK));
  const clampedHigh = Math.min(maxScore, Math.max(minScore, simulation.q90 + rK));
  const safeMid =
    Math.sign(clampedLow) === Math.sign(clampedHigh)
      ? clampedLow + 0.5 * (clampedHigh - clampedLow)
      : 0.5 * clampedLow + 0.5 * clampedHigh;
  const safeLow = clampedLow <= clampedHigh ? clampedLow : safeMid;
  const safeHigh = clampedLow <= clampedHigh ? clampedHigh : safeMid;
  let low = snapToScoreGrid(safeLow, blueprint.scoreRange, blueprint.scoreStep, "floor");
  let high = snapToScoreGrid(safeHigh, blueprint.scoreRange, blueprint.scoreStep, "ceil");
  if (low > safeLow) low = minScore;
  if (high < safeHigh) high = maxScore;
  const rawWidth = Math.max(0, high - low);
  const width = rawWidth === 0 ? 0 : Number(rawWidth.toPrecision(12));
  const pointEstimate = snapToScoreGrid(
    simulation.timedExpectedScore,
    blueprint.scoreRange,
    blueprint.scoreStep,
    "nearest",
  );
  return { status: "ready", n, k, conformalMargin: rK, low, high, width, pointEstimate, validCalibrations };
}

export function computeConformalBandInterval(input: {
  readonly simulation: PaperSimulationSummary;
  readonly blueprint: ExamBlueprintV1;
  readonly calibrationRecords: readonly WholePaperCalibrationRecord[];
  readonly targetKind?: ForecastTargetKind;
  readonly examAtMs?: number;
  readonly excludeLearnerId?: string;
  readonly excludePaperFamilyIds?: ReadonlySet<string>;
}): ConformalBandIntervalResult {
  assertValidExamBlueprint(input.blueprint);
  validateSimulationForBlueprint(input.simulation, input.blueprint);
  const cutoffMs = input.examAtMs ?? input.simulation.examAtMs;
  const targetKind: ForecastTargetKind = input.targetKind ?? "same_blueprint_mock";
  const validCalibrations = filterIndependentCalibrationRecords({
    records: input.calibrationRecords,
    blueprintId: input.blueprint.blueprintId,
    targetKind,
    scoreRange: input.blueprint.scoreRange,
    sectionRanges: sectionRangesMap(input.blueprint),
    examAtMs: cutoffMs,
    excludeLearnerId: input.excludeLearnerId,
    excludePaperFamilyIds: input.excludePaperFamilyIds,
  });
  return computeIntervalFromCalibrations(input.simulation, input.blueprint, validCalibrations);
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
  const [minScore, maxScore] = input.blueprint.scoreRange;
  const maxInformativeWidth = input.maxInformativeWidth ?? (maxScore - minScore) * 0.5;
  if (!Number.isFinite(maxInformativeWidth) || maxInformativeWidth <= 0) {
    throw new RangeError("maxInformativeWidth must be finite and positive");
  }
  const numDraws = validateNumDraws(input.numDraws, DEFAULT_EXAM_SIMULATION_DRAWS);
  if (input.jointPassTarget) assertFiniteJointPassTarget(input.jointPassTarget);
  if (input.jointPassLadder) input.jointPassLadder.forEach(assertFiniteJointPassTarget);

  const trimmedLearnerId = input.learnerId.trim();
  const isIeltsBlueprint = input.blueprint.blueprintId === IELTS_ACADEMIC_V1_BLUEPRINT.blueprintId;
  const recommendedSeedIdsFor = (sections: readonly string[]): readonly string[] =>
    isIeltsBlueprint
      ? IELTS_ACADEMIC_DIAGNOSTIC_SEEDS.filter((seed) => sections.includes(seed.sectionId)).map((seed) => seed.seedId)
      : [];

  if (!trimmedLearnerId) {
    const allSectionIds = input.blueprint.sections.map((s) => s.sectionId);
    return {
      schemaVersion: 1,
      blueprintId: input.blueprint.blueprintId,
      status: "insufficient_independent_evidence",
      missingSections: allSectionIds,
      rejectedEvidenceCount: input.evidence.length,
      calibrationCount: 0,
      requiredCalibrationCount: 4,
      nextDiagnosticAction: {
        kind: "run_diagnostic_items",
        sectionIds: allSectionIds,
        recommendedItemIds: recommendedSeedIdsFor(allSectionIds),
        message: "请先登录学习账号并完成各部分独立诊断作答，再生成预估区间。",
      },
      officialExamCalibrated: false,
    };
  }

  const { admitted, rejectedCount } = partitionExamEvidence(input.evidence, {
    learnerId: trimmedLearnerId,
    examAtMs: input.examAtMs,
    sectionRanges: sectionRangesMap(input.blueprint),
    sectionParts: sectionPartIdsMap(input.blueprint),
  });
  const coveredSections = new Set(admitted.map((e) => e.sectionId));
  const missingSections = input.blueprint.sections
    .map((s) => s.sectionId)
    .filter((sid) => !coveredSections.has(sid));

  const excludeFamilies = new Set<string>(
    (input.targetPaperFamilyIds ?? []).map((id) => id.trim()).filter(Boolean),
  );
  for (const rec of admitted) {
    const familyId = rec.paperFamilyId?.trim();
    if (familyId) excludeFamilies.add(familyId);
  }
  const validCalibrations = filterIndependentCalibrationRecords({
    records: input.calibrationRecords,
    blueprintId: input.blueprint.blueprintId,
    targetKind,
    scoreRange: input.blueprint.scoreRange,
    sectionRanges: sectionRangesMap(input.blueprint),
    examAtMs: input.examAtMs,
    excludeLearnerId: trimmedLearnerId,
    excludePaperFamilyIds: excludeFamilies,
  });

  const n = validCalibrations.length;
  const k = Math.ceil(TARGET_COVERAGE * (n + 1));
  const recommendedSeedIds = recommendedSeedIdsFor(missingSections);

  if (missingSections.length > 0 || n < 4 || k > n) {
    const kind =
      missingSections.length > 0
        ? "run_diagnostic_items"
        : targetKind === "official_exam"
          ? "insufficient_official_exam_calibration"
          : "submit_independent_mock";
    const message =
      missingSections.length > 0
        ? `请先完成缺口部分的独立诊断作答（${missingSections.join("、")}），再生成区间预估。`
        : targetKind === "official_exam"
          ? "官方考试历史标定样本不足，请切换同蓝图限时模考预估口径。"
          : "当前同蓝图独立整卷标定样本不足 4 份，请再完成独立限时模考以建立 80% 区间。";
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
        message,
      },
      officialExamCalibrated: false,
    };
  }

  const simulation = simulateExamPaper({
    blueprint: input.blueprint,
    learnerId: trimmedLearnerId,
    beliefs: input.beliefs,
    evidence: admitted,
    examAtMs: input.examAtMs,
    numDraws,
    seed: input.seed,
  });

  const interval = computeIntervalFromCalibrations(simulation, input.blueprint, validCalibrations);
  if (interval.status !== "ready") {
    throw new RangeError("Unexpected insufficient calibration after pre-check");
  }
  const { k: effectiveK, conformalMargin: rK, low, high, width, pointEstimate } = interval;

  if (width > maxInformativeWidth) {
    const allSectionIds = input.blueprint.sections.map((s) => s.sectionId);
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
        sectionIds: allSectionIds,
        recommendedItemIds: recommendedSeedIdsFor(allSectionIds),
        message: "当前标定波动过宽，建议补充高区分度独立诊断或限时模考以收窄预估区间。",
      },
      officialExamCalibrated: false,
    };
  }

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
          examAtMs: input.examAtMs,
          excludeLearnerId: trimmedLearnerId,
          excludePaperFamilyIds: excludeFamilies,
          targetKind,
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
    calibrationReceipt: { n, k: effectiveK, nonconformityRadius: rK, maxInformativeWidth },
  };
}
