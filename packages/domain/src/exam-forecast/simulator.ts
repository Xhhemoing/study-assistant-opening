import { retrievability, type SkillBeliefV1 } from "../epistemic/belief";
import {
  choleskyDecompose,
  computeIeltsOverallBand,
  defineRecordEntry,
  rawScoreToBand,
  snapToScoreGrid,
  validateExamBlueprint,
} from "./ielts-blueprint";
import type {
  ExamBlueprintV1,
  ExamEvidenceRecord,
  ExamItemSpec,
  ExamSectionBlueprint,
  PaperSimulationSummary,
  ScoreBucketProbability,
  ScoreObservationValue,
  SectionSimulationSummary,
  SimulatedItemOutcome,
  SkillBeliefMap,
  SpeechTimingReceiptV1,
} from "./types";

export const MAX_SIMULATION_DRAWS = 50_000;
export const DEFAULT_EXAM_SIMULATION_DRAWS = 512;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const sigmoid = (x: number): number => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));

export function validateNumDraws(numDraws: number | undefined, fallback = DEFAULT_EXAM_SIMULATION_DRAWS): number {
  const n = numDraws ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > MAX_SIMULATION_DRAWS) {
    throw new RangeError(`numDraws must be an integer in [1, ${MAX_SIMULATION_DRAWS}]`);
  }
  return n;
}

export function resolveDrawsCount(
  numDraws: number | undefined,
  precomputedDraws?: readonly PaperRandomDraw[],
  fallback = DEFAULT_EXAM_SIMULATION_DRAWS,
): number {
  const explicitCount = numDraws !== undefined ? validateNumDraws(numDraws, fallback) : undefined;
  if (precomputedDraws !== undefined) {
    const actualCount = validateNumDraws(precomputedDraws.length, fallback);
    if (explicitCount !== undefined && actualCount !== explicitCount) {
      throw new RangeError(`precomputedDraws.length (${actualCount}) must match numDraws (${explicitCount})`);
    }
    return actualCount;
  }
  return explicitCount ?? validateNumDraws(undefined, fallback);
}

function isValidFluencyScore(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 9;
}

function isValidPauseRatio(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidSpeechRateWpm(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasValidDefinedSpeechMetrics(receipt: SpeechTimingReceiptV1): boolean {
  if (!Number.isFinite(receipt.durationSeconds) || receipt.durationSeconds <= 0) return false;
  if (receipt.fluencyScore !== undefined && !isValidFluencyScore(receipt.fluencyScore)) return false;
  if (receipt.pauseRatio !== undefined && !isValidPauseRatio(receipt.pauseRatio)) return false;
  if (receipt.speechRateWpm !== undefined && !isValidSpeechRateWpm(receipt.speechRateWpm)) return false;
  return true;
}

function isUsableSpeechTimingReceipt(receipt: SpeechTimingReceiptV1 | undefined): receipt is SpeechTimingReceiptV1 {
  if (!receipt || receipt.calibrated !== true) return false;
  if (!hasValidDefinedSpeechMetrics(receipt)) return false;
  return receipt.fluencyScore !== undefined || receipt.speechRateWpm !== undefined;
}

function parseScoreObservationBounds(
  value: ScoreObservationValue | number | undefined,
  range?: readonly [number, number],
): { readonly low: number; readonly high: number } | null {
  if (value === undefined) return null;
  let low: number;
  let high: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    low = value;
    high = value;
  } else if (value.kind === "exact") {
    if (!Number.isFinite(value.score)) return null;
    low = value.score;
    high = value.score;
  } else {
    if (!Number.isFinite(value.low) || !Number.isFinite(value.high) || value.low > value.high) return null;
    low = value.low;
    high = value.high;
  }
  if (range && (low < range[0] || high > range[1])) return null;
  return { low, high };
}

export function hasUsableObservedPayload(
  record: ExamEvidenceRecord,
  sectionRange?: readonly [number, number],
  allowedParts?: ReadonlySet<string>,
): boolean {
  if (allowedParts) {
    if (record.partId !== undefined && !allowedParts.has(record.partId)) return false;
    if (record.speechTimingReceipt?.partId !== undefined && !allowedParts.has(record.speechTimingReceipt.partId)) {
      return false;
    }
  }
  const scoreBounds = parseScoreObservationBounds(
    record.rubricScore ?? record.observedScore ?? record.observedBand,
    sectionRange,
  );
  if (record.evidenceKind === "rubric_assessment") {
    return scoreBounds !== null;
  }
  if (record.evidenceKind === "speech_timing") {
    const receipt = record.speechTimingReceipt;
    if (receipt !== undefined && !hasValidDefinedSpeechMetrics(receipt)) return false;
    return (record.sectionId === "speaking" && isUsableSpeechTimingReceipt(receipt)) || scoreBounds !== null;
  }
  if (record.evidenceKind === "diagnostic_item") {
    return typeof record.correct === "boolean" || scoreBounds !== null;
  }
  if (record.evidenceKind === "independent_mock" || record.evidenceKind === "official_exam") {
    return typeof record.correct === "boolean" || scoreBounds !== null;
  }
  return false;
}

export type EvidenceFilterOptions = {
  readonly learnerId?: string;
  readonly examAtMs?: number;
  readonly sectionRanges?: ReadonlyMap<string, readonly [number, number]>;
  readonly sectionParts?: ReadonlyMap<string, ReadonlySet<string>>;
};

export function isIndependentExamEvidence(
  record: ExamEvidenceRecord,
  learnerIdOrOptions?: string | EvidenceFilterOptions,
): boolean {
  const options: EvidenceFilterOptions =
    typeof learnerIdOrOptions === "string"
      ? { learnerId: learnerIdOrOptions }
      : (learnerIdOrOptions ?? {});
  const trimmedTarget = options.learnerId?.trim();
  const learnerMatches =
    options.learnerId === undefined ||
    (trimmedTarget !== undefined && trimmedTarget.length > 0 && record.learnerId?.trim() === trimmedTarget);
  if (!learnerMatches) return false;
  if (!Number.isFinite(record.observedAtMs)) return false;
  if (options.examAtMs !== undefined) {
    if (!Number.isFinite(options.examAtMs) || record.observedAtMs > options.examAtMs) return false;
  }
  if (options.sectionRanges && !options.sectionRanges.has(record.sectionId)) return false;
  const allowedParts = options.sectionParts ? options.sectionParts.get(record.sectionId) : undefined;
  if (options.sectionParts && !allowedParts) return false;
  return (
    record.countsTowardMastery === true &&
    record.assisted === false &&
    record.exposed !== true &&
    record.evidenceKind !== "practice_feedback" &&
    record.evidenceKind !== "self_report" &&
    hasUsableObservedPayload(record, options.sectionRanges?.get(record.sectionId), allowedParts)
  );
}

export function partitionExamEvidence(
  records: readonly ExamEvidenceRecord[],
  options: EvidenceFilterOptions = {},
): {
  readonly admitted: readonly ExamEvidenceRecord[];
  readonly rejectedCount: number;
} {
  const admitted: ExamEvidenceRecord[] = [];
  let rejectedCount = 0;
  for (const record of records) {
    if (isIndependentExamEvidence(record, options)) admitted.push(record);
    else rejectedCount += 1;
  }
  return { admitted, rejectedCount };
}

export function sectionRangesMap(blueprint: ExamBlueprintV1): ReadonlyMap<string, readonly [number, number]> {
  return new Map(blueprint.sections.map((section) => [section.sectionId, section.scoreRange] as const));
}

export function sectionPartIdsMap(blueprint: ExamBlueprintV1): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    blueprint.sections.map((section) => [section.sectionId, new Set(section.parts.map((part) => part.partId))] as const),
  );
}

export { choleskyDecompose };

export function createSeededRng(seed: number): () => number {
  let state = (Math.floor(seed) >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function sampleStandardNormal(nextU: () => number): number {
  const u1 = Math.max(1e-12, nextU());
  const u2 = nextU();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export type PaperRandomDraw = {
  readonly zLatent: readonly number[];
  readonly nuSpeed: number;
  readonly itemUniforms: readonly number[];
  readonly itemTimeNormals: readonly number[];
  readonly rubricScoreNormals: readonly number[];
  readonly rubricTimeNormals: readonly number[];
};

export const MAX_SIMULATION_DP_CELLS = 5_000_000;
export const MAX_SIMULATION_ITEM_EVALS = 25_000_000;

export function assertSimulationWorkloadWithinBounds(
  blueprint: ExamBlueprintV1,
  numDraws: number,
  deterministicItemSections?: ReadonlySet<string>,
): void {
  const validDraws = validateNumDraws(numDraws);
  let totalItems = 0;
  let totalDpCells = 0;
  for (const section of blueprint.sections) {
    if (section.scoringKind !== "item_raw_table" || !section.items) continue;
    const itemCount = section.items.length;
    totalItems += itemCount;
    let secPoints = 0;
    for (const item of section.items) {
      secPoints += item.points ?? 1;
    }
    const dpPerRun = itemCount * (secPoints + 1);
    const runs = deterministicItemSections?.has(section.sectionId) ? 1 : validDraws;
    totalDpCells += runs * dpPerRun;
    if (totalDpCells > MAX_SIMULATION_DP_CELLS) {
      throw new RangeError(`Simulation DP workload exceeds limit (${MAX_SIMULATION_DP_CELLS} cells)`);
    }
  }
  if (validDraws * totalItems > MAX_SIMULATION_ITEM_EVALS) {
    throw new RangeError(`Simulation item evaluation workload exceeds limit (${MAX_SIMULATION_ITEM_EVALS})`);
  }
}

export function validatePrecomputedDraws(blueprint: ExamBlueprintV1, draws: readonly PaperRandomDraw[]): void {
  const nSkills = blueprint.skillIds.length;
  const totalItems = blueprint.sections.reduce((sum, s) => sum + (s.items?.length ?? 0), 0);
  const totalParts = blueprint.sections.reduce((sum, s) => sum + s.parts.length, 0);
  const consumedRubricParts = blueprint.sections
    .filter((s) => s.scoringKind !== "item_raw_table")
    .reduce((sum, s) => sum + s.parts.length, 0);

  for (let d = 0; d < draws.length; d++) {
    const draw = draws[d];
    if (!draw || typeof draw !== "object") {
      throw new RangeError(`precomputedDraws[${d}] must be an object`);
    }
    if (!Number.isFinite(draw.nuSpeed)) {
      throw new RangeError(`precomputedDraws[${d}].nuSpeed must be finite`);
    }
    if (!Array.isArray(draw.zLatent) || draw.zLatent.length !== nSkills) {
      throw new RangeError(`precomputedDraws[${d}].zLatent length must equal ${nSkills}`);
    }
    for (const z of draw.zLatent) {
      if (typeof z !== "number" || !Number.isFinite(z)) {
        throw new RangeError(`precomputedDraws[${d}].zLatent values must be finite numbers`);
      }
    }
    if (!Array.isArray(draw.itemUniforms) || draw.itemUniforms.length !== totalItems) {
      throw new RangeError(`precomputedDraws[${d}].itemUniforms length must equal ${totalItems}`);
    }
    for (const u of draw.itemUniforms) {
      if (typeof u !== "number" || !Number.isFinite(u) || u < 0 || u >= 1) {
        throw new RangeError(`precomputedDraws[${d}].itemUniforms values must be finite in [0, 1)`);
      }
    }
    if (!Array.isArray(draw.itemTimeNormals) || draw.itemTimeNormals.length !== totalItems) {
      throw new RangeError(`precomputedDraws[${d}].itemTimeNormals length must equal ${totalItems}`);
    }
    for (const t of draw.itemTimeNormals) {
      if (typeof t !== "number" || !Number.isFinite(t)) {
        throw new RangeError(`precomputedDraws[${d}].itemTimeNormals values must be finite numbers`);
      }
    }
    const validRubricLen = (len: number): boolean => len === consumedRubricParts || len === totalParts;
    if (!Array.isArray(draw.rubricScoreNormals) || !validRubricLen(draw.rubricScoreNormals.length)) {
      throw new RangeError(`precomputedDraws[${d}].rubricScoreNormals length mismatch`);
    }
    for (const r of draw.rubricScoreNormals) {
      if (typeof r !== "number" || !Number.isFinite(r)) {
        throw new RangeError(`precomputedDraws[${d}].rubricScoreNormals values must be finite numbers`);
      }
    }
    if (!Array.isArray(draw.rubricTimeNormals) || !validRubricLen(draw.rubricTimeNormals.length)) {
      throw new RangeError(`precomputedDraws[${d}].rubricTimeNormals length mismatch`);
    }
    for (const rt of draw.rubricTimeNormals) {
      if (typeof rt !== "number" || !Number.isFinite(rt)) {
        throw new RangeError(`precomputedDraws[${d}].rubricTimeNormals values must be finite numbers`);
      }
    }
  }
}

export function generatePaperRandomDraws(
  blueprint: ExamBlueprintV1,
  numDraws: number,
  seed: number,
): PaperRandomDraw[] {
  const validDraws = validateNumDraws(numDraws);
  const lower = choleskyDecompose(blueprint.thetaCovariance);
  const nSkills = blueprint.skillIds.length;
  const totalItems = blueprint.sections.reduce((sum, s) => sum + (s.items?.length ?? 0), 0);
  const totalParts = blueprint.sections.reduce((sum, s) => sum + s.parts.length, 0);
  if (validDraws * totalItems > MAX_SIMULATION_ITEM_EVALS) {
    throw new RangeError(`Draw generation workload exceeds item limit (${MAX_SIMULATION_ITEM_EVALS})`);
  }
  const rng = createSeededRng(seed);
  const draws: PaperRandomDraw[] = [];
  for (let d = 0; d < validDraws; d++) {
    const xi = Array.from({ length: nSkills }, () => sampleStandardNormal(rng));
    const zLatent = Array.from({ length: nSkills }, (_, i) => {
      let acc = 0;
      for (let j = 0; j <= i; j++) acc += lower[i]![j]! * xi[j]!;
      return acc;
    });
    draws.push({
      zLatent,
      nuSpeed: sampleStandardNormal(rng),
      itemUniforms: Array.from({ length: totalItems }, () => rng()),
      itemTimeNormals: Array.from({ length: totalItems }, () => sampleStandardNormal(rng)),
      rubricScoreNormals: Array.from({ length: totalParts }, () => sampleStandardNormal(rng)),
      rubricTimeNormals: Array.from({ length: totalParts }, () => sampleStandardNormal(rng)),
    });
  }
  return draws;
}

/**
 * Exact Lord-Wingersky DP convolution for untimed integer-point items.
 * Returns P(rawScore = s) for s = 0..maxPoints.
 */
export function convolveLordWingersky(
  probabilities: readonly number[],
  points: readonly number[] = [],
): number[] {
  const itemPoints = probabilities.map((p, idx) => {
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new RangeError("Item success probability must be finite in [0, 1]");
    }
    const pts = points[idx] ?? 1;
    if (!Number.isFinite(pts) || !Number.isInteger(pts) || pts < 0) {
      throw new RangeError("Item points must be finite non-negative integers");
    }
    return pts;
  });
  const maxPoints = itemPoints.reduce((a, b) => a + b, 0);
  if (probabilities.length * (maxPoints + 1) > MAX_SIMULATION_DP_CELLS) {
    throw new RangeError(`Lord-Wingersky DP exceeds max cell budget (${MAX_SIMULATION_DP_CELLS})`);
  }
  const dp = new Array<number>(maxPoints + 1).fill(0);
  dp[0] = 1;
  let runningMax = 0;
  for (let idx = 0; idx < probabilities.length; idx++) {
    const pts = itemPoints[idx]!;
    if (pts === 0) continue;
    const p = probabilities[idx]!;
    for (let s = runningMax; s >= 0; s--) {
      const mass = dp[s]!;
      if (mass === 0) continue;
      dp[s] = mass * (1 - p);
      dp[s + pts] = (dp[s + pts] ?? 0) + mass * p;
    }
    runningMax += pts;
  }
  return dp;
}

export function itemSuccessProbability(item: ExamItemSpec, mBySkill: Readonly<Record<string, number>>): number {
  let prod = 1;
  for (const skillId of item.skillIds) {
    const mastery = Object.hasOwn(mBySkill, skillId) ? mBySkill[skillId]! : 0.5;
    prod *= clamp(mastery, 0, 1);
  }
  const g = clamp(item.guess, 0, 1);
  const l = clamp(item.lapse, 0, Math.max(0, 1 - g));
  return clamp(g + (1 - l - g) * prod, 0, 1);
}

export function sampleLogNormalStepTimeSeconds(
  item: ExamItemSpec,
  nuSpeed: number,
  mBySkill: Readonly<Record<string, number>>,
  epsNormal: number,
): number {
  const { mu, speedLoading, skillLoading, sigma } = item.timeModel;
  if (!Number.isFinite(mu) || !Number.isFinite(sigma) || sigma <= 0 || !Number.isFinite(nuSpeed) || !Number.isFinite(epsNormal)) {
    throw new RangeError("Non-finite time-model predictor");
  }
  const safeSpeedLoading = (speedLoading as number | undefined) === undefined ? 0 : speedLoading;
  if (!Number.isFinite(safeSpeedLoading)) throw new RangeError("Non-finite speedLoading");
  let skillTerm = 0;
  for (const [skillId, loading] of Object.entries(skillLoading)) {
    if (!Number.isFinite(loading)) throw new RangeError("Non-finite skillLoading");
    const mastery = Object.hasOwn(mBySkill, skillId) ? mBySkill[skillId]! : 0.5;
    skillTerm += loading * mastery;
  }
  const logT = mu - safeSpeedLoading * nuSpeed - skillTerm + sigma * epsNormal;
  if (!Number.isFinite(logT)) throw new RangeError("Non-finite log-normal step time");
  return Math.exp(clamp(logT, -6, 12));
}

function percentileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

type RubricAnchor = {
  readonly low: number;
  readonly high: number;
  readonly observedAtMs: number;
};

type RubricEvidenceSummary = {
  readonly partAnchors: ReadonlyMap<string, ReadonlyMap<string, RubricAnchor>>;
  readonly sectionAnchors: ReadonlyMap<string, RubricAnchor>;
  readonly speakingFluencyShift: number;
};

function summarizeRubricAndTimingEvidence(
  admitted: readonly ExamEvidenceRecord[],
  sectionRanges: ReadonlyMap<string, readonly [number, number]>,
  sectionParts: ReadonlyMap<string, ReadonlySet<string>>,
): RubricEvidenceSummary {
  const partAnchors = new Map<string, Map<string, RubricAnchor>>();
  const sectionAnchors = new Map<string, RubricAnchor>();
  let speakingShiftSum = 0;
  let speakingCount = 0;

  for (const record of admitted) {
    if (!sectionRanges.has(record.sectionId)) continue;
    const allowedParts = sectionParts.get(record.sectionId);
    if (!allowedParts) continue;
    if (record.partId !== undefined && !allowedParts.has(record.partId)) continue;
    if (record.speechTimingReceipt?.partId !== undefined && !allowedParts.has(record.speechTimingReceipt.partId)) {
      continue;
    }

    const scoreBounds = parseScoreObservationBounds(
      record.rubricScore ?? record.observedScore ?? record.observedBand,
      sectionRanges.get(record.sectionId),
    );
    if (scoreBounds) {
      const anchor: RubricAnchor = { low: scoreBounds.low, high: scoreBounds.high, observedAtMs: record.observedAtMs };
      if (record.partId !== undefined) {
        let sectionBucket = partAnchors.get(record.sectionId);
        if (!sectionBucket) {
          sectionBucket = new Map<string, RubricAnchor>();
          partAnchors.set(record.sectionId, sectionBucket);
        }
        const existing = sectionBucket.get(record.partId);
        if (!existing || anchor.observedAtMs >= existing.observedAtMs) {
          sectionBucket.set(record.partId, anchor);
        }
      } else {
        const existing = sectionAnchors.get(record.sectionId);
        if (!existing || anchor.observedAtMs >= existing.observedAtMs) {
          sectionAnchors.set(record.sectionId, anchor);
        }
      }
    }
    if (record.sectionId === "speaking" && isUsableSpeechTimingReceipt(record.speechTimingReceipt)) {
      const receipt = record.speechTimingReceipt;
      if (isValidFluencyScore(receipt.fluencyScore)) {
        speakingShiftSum += clamp((receipt.fluencyScore - 6) * 0.25, -1, 1);
        speakingCount += 1;
      } else if (isValidSpeechRateWpm(receipt.speechRateWpm)) {
        const wpmDelta = clamp((receipt.speechRateWpm - 125) / 80, -0.5, 0.5);
        const pausePenalty = isValidPauseRatio(receipt.pauseRatio)
          ? clamp((receipt.pauseRatio - 0.18) * 1.5, -0.2, 0.5)
          : 0;
        speakingShiftSum += wpmDelta - pausePenalty;
        speakingCount += 1;
      }
    }
  }
  return {
    partAnchors,
    sectionAnchors,
    speakingFluencyShift: speakingCount > 0 ? speakingShiftSum / speakingCount : 0,
  };
}

export type SkillDeltaOverride = {
  readonly abilityDelta?: number;
  readonly logStabilityDelta?: number;
};

function readSkillOverride(
  skillOverrides: ReadonlyMap<string, SkillDeltaOverride> | Readonly<Record<string, SkillDeltaOverride>> | undefined,
  skillId: string,
): SkillDeltaOverride | undefined {
  if (!skillOverrides) return undefined;
  if (skillOverrides instanceof Map) return skillOverrides.get(skillId);
  const record = skillOverrides as Readonly<Record<string, SkillDeltaOverride>>;
  return Object.hasOwn(record, skillId) ? record[skillId] : undefined;
}

function readLearnerBelief(beliefs: SkillBeliefMap, skillId: string, trimmedLearnerId: string): SkillBeliefV1 | undefined {
  if (!Object.hasOwn(beliefs, skillId)) return undefined;
  const belief = beliefs[skillId];
  if (!belief || belief.learnerId?.trim() !== trimmedLearnerId) return undefined;
  return belief;
}

function buildDecayedSkillParams(
  blueprint: ExamBlueprintV1,
  beliefs: SkillBeliefMap,
  trimmedLearnerId: string,
  examAtMs: number,
  skillOverrides?: ReadonlyMap<string, SkillDeltaOverride> | Readonly<Record<string, SkillDeltaOverride>>,
): { readonly rd: readonly number[]; readonly mu: readonly number[]; readonly sd: readonly number[] } {
  const rd: number[] = [];
  const mu: number[] = [];
  const sd: number[] = [];
  for (const skillId of blueprint.skillIds) {
    const belief = readLearnerBelief(beliefs, skillId, trimmedLearnerId);
    const override = readSkillOverride(skillOverrides, skillId);
    if (override?.abilityDelta !== undefined && !Number.isFinite(override.abilityDelta)) {
      throw new RangeError(`Non-finite abilityDelta override for skill "${skillId}"`);
    }
    if (override?.logStabilityDelta !== undefined && !Number.isFinite(override.logStabilityDelta)) {
      throw new RangeError(`Non-finite logStabilityDelta override for skill "${skillId}"`);
    }
    if (!belief) {
      rd.push(0.5);
      mu.push(override?.abilityDelta ?? 0);
      sd.push(1);
      continue;
    }
    const adjustedBelief: SkillBeliefV1 =
      override?.logStabilityDelta !== undefined
        ? { ...belief, logStability: belief.logStability + override.logStabilityDelta }
        : belief;
    // Direct retrievability excludes implicitLogCredit per HSRS-FIRe-DCM policy.
    rd.push(retrievability(adjustedBelief, examAtMs));
    mu.push(belief.abilityMean + (override?.abilityDelta ?? 0));
    sd.push(Math.sqrt(Math.max(0, belief.abilityVariance)));
  }
  return { rd, mu, sd };
}

function collapseRawDistributionToScoreMap(
  rawDist: readonly number[],
  section: ExamSectionBlueprint,
): ReadonlyMap<number, number> {
  const map = new Map<number, number>();
  for (let raw = 0; raw < rawDist.length; raw++) {
    const prob = rawDist[raw]!;
    if (prob <= 0) continue;
    const score = section.rawToBandTable ? rawScoreToBand(raw, section.rawToBandTable) : raw;
    map.set(score, (map.get(score) ?? 0) + prob);
  }
  return map;
}

type PrecomputedUntimedSection = {
  readonly untimedDist: ReadonlyMap<number, number>;
  readonly untimedMean: number;
};

function computeStaticUntimedSection(
  section: ExamSectionBlueprint,
  staticMasteryBySkill: Readonly<Record<string, number>>,
): PrecomputedUntimedSection {
  const items = section.items ?? [];
  const itemProbs: number[] = [];
  const itemPoints: number[] = [];
  for (const item of items) {
    itemProbs.push(itemSuccessProbability(item, staticMasteryBySkill));
    itemPoints.push(item.points ?? 1);
  }
  const untimedDist = collapseRawDistributionToScoreMap(convolveLordWingersky(itemProbs, itemPoints), section);
  let untimedMean = 0;
  for (const [score, prob] of untimedDist.entries()) untimedMean += score * prob;
  return { untimedDist, untimedMean };
}

type DrawItemSectionInput = {
  readonly section: ExamSectionBlueprint;
  readonly mBySkill: Readonly<Record<string, number>>;
  readonly nu: number;
  readonly draw: PaperRandomDraw;
  readonly itemCursorStart: number;
  readonly sectionLimitSec: number;
  readonly initialClockUsedSec: number;
  readonly captureCensored: boolean;
  readonly precomputedUntimed?: PrecomputedUntimedSection;
};

type DrawItemSectionResult = {
  readonly nextItemCursor: number;
  readonly finalClockUsedSec: number;
  readonly anyCensored: boolean;
  readonly censoredItems: readonly SimulatedItemOutcome[];
  readonly partCensoredCounts: ReadonlyMap<string, number>;
  readonly partTotalCounts: ReadonlyMap<string, number>;
  readonly totalItems: number;
  readonly censoredCount: number;
  readonly timedScore: number;
  readonly matchedUntimedScore: number;
  readonly untimedDist: ReadonlyMap<number, number>;
  readonly untimedMean: number;
};

function simulateItemSectionDraw(input: DrawItemSectionInput): DrawItemSectionResult {
  const items = input.section.items ?? [];
  let itemCursor = input.itemCursorStart;
  let clockUsedSec = input.initialClockUsedSec;
  let rawTimed = 0;
  let rawUntimed = 0;
  let anyCensored = false;
  let censoredCount = 0;
  const itemProbs: number[] | null = input.precomputedUntimed ? null : [];
  const itemPoints: number[] | null = input.precomputedUntimed ? null : [];
  const censoredItems: SimulatedItemOutcome[] = [];
  const partCensoredCounts = new Map<string, number>();
  const partTotalCounts = new Map<string, number>();

  for (const item of items) {
    const u = input.draw.itemUniforms[itemCursor];
    const eps = input.draw.itemTimeNormals[itemCursor];
    if (u === undefined || !Number.isFinite(u) || u < 0 || u >= 1) {
      throw new RangeError(`Missing or out-of-range itemUniforms at index ${itemCursor}`);
    }
    if (eps === undefined || !Number.isFinite(eps)) {
      throw new RangeError(`Missing or non-finite itemTimeNormals at index ${itemCursor}`);
    }
    itemCursor += 1;

    const pSuccess = itemSuccessProbability(item, input.mBySkill);
    const pts = item.points ?? 1;
    if (!Number.isFinite(pts) || !Number.isInteger(pts) || pts < 0) {
      throw new RangeError("Item points must be finite non-negative integers");
    }
    if (itemProbs && itemPoints) {
      itemProbs.push(pSuccess);
      itemPoints.push(pts);
    }

    const untimedCorrect = u < pSuccess;
    if (untimedCorrect) rawUntimed += pts;

    const stepSec = sampleLogNormalStepTimeSeconds(item, input.nu, input.mBySkill, eps);
    partTotalCounts.set(item.partId, (partTotalCounts.get(item.partId) ?? 0) + 1);

    if (clockUsedSec + stepSec > input.sectionLimitSec) {
      anyCensored = true;
      censoredCount += 1;
      clockUsedSec = input.sectionLimitSec;
      partCensoredCounts.set(item.partId, (partCensoredCounts.get(item.partId) ?? 0) + 1);
      if (input.captureCensored) {
        censoredItems.push({
          itemId: item.itemId,
          sectionId: input.section.sectionId,
          partId: item.partId,
          attempted: false,
          correct: false,
          rightCensored: true,
          observedTimeSeconds: null,
          successProbability: pSuccess,
        });
      }
    } else {
      clockUsedSec += stepSec;
      if (untimedCorrect) rawTimed += pts;
    }
  }

  const timedScore = input.section.rawToBandTable ? rawScoreToBand(rawTimed, input.section.rawToBandTable) : rawTimed;
  const matchedUntimedScore = input.section.rawToBandTable
    ? rawScoreToBand(rawUntimed, input.section.rawToBandTable)
    : rawUntimed;
  let untimedDist: ReadonlyMap<number, number>;
  let untimedMean: number;
  if (input.precomputedUntimed) {
    untimedDist = input.precomputedUntimed.untimedDist;
    untimedMean = input.precomputedUntimed.untimedMean;
  } else {
    untimedDist = collapseRawDistributionToScoreMap(convolveLordWingersky(itemProbs!, itemPoints!), input.section);
    untimedMean = 0;
    for (const [score, prob] of untimedDist.entries()) untimedMean += score * prob;
  }

  return {
    nextItemCursor: itemCursor,
    finalClockUsedSec: clockUsedSec,
    anyCensored,
    censoredItems,
    partCensoredCounts,
    partTotalCounts,
    totalItems: items.length,
    censoredCount,
    timedScore,
    matchedUntimedScore,
    untimedDist,
    untimedMean,
  };
}

function referenceSkillMasteryAt(
  beliefs: SkillBeliefMap,
  skillId: string,
  observedAtMs: number,
  trimmedLearnerId: string,
): number {
  const belief = readLearnerBelief(beliefs, skillId, trimmedLearnerId);
  if (!belief) return 0.5 * sigmoid(0);
  return clamp(retrievability(belief, observedAtMs) * sigmoid(belief.abilityMean), 0, 1);
}

function simulateRubricSectionDraw(input: {
  readonly section: ExamSectionBlueprint;
  readonly beliefs: SkillBeliefMap;
  readonly trimmedLearnerId: string;
  readonly mBySkill: Readonly<Record<string, number>>;
  readonly nu: number;
  readonly draw: PaperRandomDraw;
  readonly rubricCursorStart: number;
  readonly sectionLimitSec: number;
  readonly initialClockUsedSec: number;
  readonly rubricSummary: RubricEvidenceSummary;
  readonly captureCensored: boolean;
}): {
  readonly nextRubricCursor: number;
  readonly finalClockUsedSec: number;
  readonly anyCensored: boolean;
  readonly censoredItems: readonly SimulatedItemOutcome[];
  readonly partCensoredCounts: ReadonlyMap<string, number>;
  readonly partTotalCounts: ReadonlyMap<string, number>;
  readonly totalItems: number;
  readonly censoredCount: number;
  readonly timedScore: number;
  readonly untimedScore: number;
} {
  let rubricCursor = input.rubricCursorStart;
  let usedSec = input.initialClockUsedSec;
  let partWeightedSum = 0;
  let untimedWeightedSum = 0;
  let weightSum = 0;
  let anyCensored = false;
  let censoredCount = 0;
  const censoredItems: SimulatedItemOutcome[] = [];
  const partCensoredCounts = new Map<string, number>();
  const partTotalCounts = new Map<string, number>();
  const sectionAnchor = input.rubricSummary.sectionAnchors.get(input.section.sectionId);
  const [minB, maxB] = input.section.scoreRange;
  const baseOffset = maxB > minB + 3 ? minB + 3 : minB;
  const bandScale = maxB - baseOffset;
  const speakingShift = input.section.sectionId === "speaking" ? input.rubricSummary.speakingFluencyShift : 0;

  for (const part of input.section.parts) {
    const epsScore = input.draw.rubricScoreNormals[rubricCursor];
    const epsTime = input.draw.rubricTimeNormals[rubricCursor];
    if (epsScore === undefined || !Number.isFinite(epsScore)) {
      throw new RangeError(`Missing or non-finite rubricScoreNormals at index ${rubricCursor}`);
    }
    if (epsTime === undefined || !Number.isFinite(epsTime)) {
      throw new RangeError(`Missing or non-finite rubricTimeNormals at index ${rubricCursor}`);
    }
    rubricCursor += 1;
    const partAnchor = input.rubricSummary.partAnchors.get(input.section.sectionId)?.get(part.partId) ?? sectionAnchor;
    partTotalCounts.set(part.partId, (partTotalCounts.get(part.partId) ?? 0) + 1);
    const skillVals = part.skillIds.map((id) => (Object.hasOwn(input.mBySkill, id) ? input.mBySkill[id]! : 0.5 * sigmoid(0)));
    const meanMastery = skillVals.length > 0 ? skillVals.reduce((a, b) => a + b, 0) / skillVals.length : 0.5 * sigmoid(0);

    let untimedPartScore: number;
    if (partAnchor) {
      const refVals = part.skillIds.map((id) =>
        referenceSkillMasteryAt(input.beliefs, id, partAnchor.observedAtMs, input.trimmedLearnerId),
      );
      const refMastery = refVals.length > 0 ? refVals.reduce((a, b) => a + b, 0) / refVals.length : 0.5 * sigmoid(0);
      const span = partAnchor.high - partAnchor.low;
      const anchorPos = span > 0 ? partAnchor.low + span * clamp(0.5 + 0.25 * epsScore, 0, 1) : partAnchor.low;
      const masteryDeltaBand = bandScale * (meanMastery - refMastery);
      untimedPartScore = clamp(anchorPos + masteryDeltaBand + speakingShift * 0.25, minB, maxB);
    } else {
      untimedPartScore = clamp(baseOffset + bandScale * meanMastery + speakingShift + 0.2 * epsScore, minB, maxB);
    }

    let timedPartScore = untimedPartScore;
    if (part.timeModel && Number.isFinite(input.sectionLimitSec)) {
      const remaining = Math.max(0, input.sectionLimitSec - usedSec);
      if (remaining <= 0) {
        anyCensored = true;
        censoredCount += 1;
        partCensoredCounts.set(part.partId, (partCensoredCounts.get(part.partId) ?? 0) + 1);
        timedPartScore = minB;
        if (input.captureCensored) {
          censoredItems.push({
            itemId: part.partId,
            sectionId: input.section.sectionId,
            partId: part.partId,
            attempted: false,
            correct: false,
            rightCensored: true,
            observedTimeSeconds: null,
            successProbability: 0,
          });
        }
      } else {
        const { mu, speedLoading, skillLoading, sigma } = part.timeModel;
        if (!Number.isFinite(mu) || !Number.isFinite(sigma) || sigma <= 0 || !Number.isFinite(input.nu) || !Number.isFinite(epsTime)) {
          throw new RangeError("Non-finite rubric time-model predictor");
        }
        const safeSpeedLoading = (speedLoading as number | undefined) === undefined ? 0 : speedLoading;
        if (!Number.isFinite(safeSpeedLoading)) throw new RangeError("Non-finite rubric speedLoading");
        let skillTerm = 0;
        for (const [id, load] of Object.entries(skillLoading)) {
          if (!Number.isFinite(load)) throw new RangeError("Non-finite rubric skillLoading");
          const mastery = Object.hasOwn(input.mBySkill, id) ? input.mBySkill[id]! : 0.5;
          skillTerm += load * mastery;
        }
        const logDuration = mu - safeSpeedLoading * input.nu - skillTerm + sigma * epsTime;
        if (!Number.isFinite(logDuration)) throw new RangeError("Non-finite rubric log duration");
        const partDuration = Math.exp(clamp(logDuration, 4, 10));
        if (partDuration > remaining) {
          anyCensored = true;
          censoredCount += 1;
          partCensoredCounts.set(part.partId, (partCensoredCounts.get(part.partId) ?? 0) + 1);
          usedSec = input.sectionLimitSec;
          const completionRatio = clamp(remaining / partDuration, 0.35, 1);
          timedPartScore = clamp(minB + (untimedPartScore - minB) * completionRatio, minB, maxB);
          if (input.captureCensored) {
            censoredItems.push({
              itemId: part.partId,
              sectionId: input.section.sectionId,
              partId: part.partId,
              attempted: true,
              correct: false,
              rightCensored: true,
              observedTimeSeconds: remaining,
              successProbability: 0,
            });
          }
        } else {
          usedSec += partDuration;
        }
      }
    }
    untimedWeightedSum += part.weight * untimedPartScore;
    partWeightedSum += part.weight * timedPartScore;
    weightSum += part.weight;
  }

  return {
    nextRubricCursor: rubricCursor,
    finalClockUsedSec: usedSec,
    anyCensored,
    censoredItems,
    partCensoredCounts,
    partTotalCounts,
    totalItems: input.section.parts.length,
    censoredCount,
    timedScore: weightSum > 0 ? partWeightedSum / weightSum : 0,
    untimedScore: weightSum > 0 ? untimedWeightedSum / weightSum : 0,
  };
}

function accumulateWeightedUntimedPmf(
  blueprint: ExamBlueprintV1,
  untimedSectionDistributions: ReadonlyMap<string, ReadonlyMap<number, number>>,
  untimedContinuousSections: ReadonlyMap<string, number>,
  drawWeight: number,
  targetPmf: Map<number, number>,
): number {
  let dist = new Map<number, number>([[0, 1]]);
  for (const section of blueprint.sections) {
    const secDist = untimedSectionDistributions.get(section.sectionId);
    const next = new Map<number, number>();
    if (!secDist) {
      const val = untimedContinuousSections.get(section.sectionId) ?? 0;
      for (const [s, p] of dist.entries()) next.set(s + section.weight * val, p);
    } else {
      for (const [s0, p0] of dist.entries()) {
        for (const [s1, p1] of secDist.entries()) {
          const combined = s0 + section.weight * s1;
          next.set(combined, (next.get(combined) ?? 0) + p0 * p1);
        }
      }
    }
    dist = next;
  }
  let expectedAdd = 0;
  for (const [score, p] of dist.entries()) {
    const snapped = snapToScoreGrid(score, blueprint.scoreRange, blueprint.scoreStep, "nearest");
    const prob = p * drawWeight;
    targetPmf.set(snapped, (targetPmf.get(snapped) ?? 0) + prob);
    expectedAdd += snapped * prob;
  }
  return expectedAdd;
}

export type SimulateExamPaperInput = {
  readonly blueprint: ExamBlueprintV1;
  readonly learnerId: string;
  readonly beliefs: SkillBeliefMap;
  readonly evidence: readonly ExamEvidenceRecord[];
  readonly examAtMs: number;
  readonly numDraws?: number;
  readonly seed?: number;
  readonly precomputedDraws?: readonly PaperRandomDraw[];
  readonly skillOverrides?: ReadonlyMap<string, SkillDeltaOverride> | Readonly<Record<string, SkillDeltaOverride>>;
  readonly speedShift?: number;
  readonly forceUntimed?: boolean;
};

export function simulateExamPaper(input: SimulateExamPaperInput): PaperSimulationSummary {
  const { blueprint, beliefs, examAtMs } = input;
  const blueprintIssues = validateExamBlueprint(blueprint);
  if (blueprintIssues.length > 0) {
    throw new RangeError(`Invalid exam blueprint: ${blueprintIssues.join(", ")}`);
  }
  const trimmedLearnerId = input.learnerId.trim();
  if (!trimmedLearnerId) {
    throw new RangeError("learnerId must be a non-empty string");
  }
  const speedShift = input.speedShift ?? 0;
  if (!Number.isFinite(speedShift)) {
    throw new RangeError("speedShift must be finite");
  }
  const numDraws = resolveDrawsCount(input.numDraws, input.precomputedDraws, DEFAULT_EXAM_SIMULATION_DRAWS);
  if (input.precomputedDraws !== undefined) {
    validatePrecomputedDraws(blueprint, input.precomputedDraws);
  }
  const skillParams = buildDecayedSkillParams(blueprint, beliefs, trimmedLearnerId, examAtMs, input.skillOverrides);
  const skillIndexById = new Map<string, number>();
  const isSkillDeterministic: boolean[] = [];
  const staticMasteryBySkill: Record<string, number> = Object.create(null) as Record<string, number>;
  for (let k = 0; k < blueprint.skillIds.length; k++) {
    const sid = blueprint.skillIds[k]!;
    skillIndexById.set(sid, k);
    const covZero = input.precomputedDraws === undefined && (blueprint.thetaCovariance[k]?.[k] ?? 0) === 0;
    const isDet = skillParams.sd[k]! === 0 || covZero;
    isSkillDeterministic.push(isDet);
    if (isDet) {
      defineRecordEntry(staticMasteryBySkill, sid, clamp(skillParams.rd[k]! * sigmoid(skillParams.mu[k]!), 0, 1));
    }
  }
  const deterministicItemSections = new Set<string>();
  for (const section of blueprint.sections) {
    if (section.scoringKind !== "item_raw_table" || !section.items) continue;
    const allDet = section.items.every((item) =>
      item.skillIds.every((id) => {
        const idx = skillIndexById.get(id);
        return idx === undefined || isSkillDeterministic[idx] === true;
      }),
    );
    if (allDet) deterministicItemSections.add(section.sectionId);
  }
  assertSimulationWorkloadWithinBounds(blueprint, numDraws, deterministicItemSections);

  const precomputedUntimedSections = new Map<string, PrecomputedUntimedSection>();
  for (const section of blueprint.sections) {
    if (deterministicItemSections.has(section.sectionId)) {
      precomputedUntimedSections.set(section.sectionId, computeStaticUntimedSection(section, staticMasteryBySkill));
    }
  }

  const draws = input.precomputedDraws ?? generatePaperRandomDraws(blueprint, numDraws, input.seed ?? 20261121);
  const ranges = sectionRangesMap(blueprint);
  const partIds = sectionPartIdsMap(blueprint);
  const { admitted } = partitionExamEvidence(input.evidence, {
    learnerId: trimmedLearnerId,
    examAtMs,
    sectionRanges: ranges,
    sectionParts: partIds,
  });
  const rubricSummary = summarizeRubricAndTimingEvidence(admitted, ranges, partIds);

  const timedScores: number[] = [];
  const untimedScores: number[] = [];
  const drawSectionScores: Array<Record<string, number>> = [];
  let sampleRightCensoredItems: SimulatedItemOutcome[] = [];

  const sectionCensoredDraws = new Map<string, number>();
  const sectionTimedTotal = new Map<string, number>();
  const sectionUntimedTotal = new Map<string, number>();
  const partCensoredItemCounts = new Map<string, Map<string, number>>();
  const partTotalItemCounts = new Map<string, Map<string, number>>();
  const sectionCensoredItemsCount = new Map<string, number>();
  const sectionTotalItemsCount = new Map<string, number>();
  for (const section of blueprint.sections) {
    sectionCensoredDraws.set(section.sectionId, 0);
    sectionTimedTotal.set(section.sectionId, 0);
    sectionUntimedTotal.set(section.sectionId, 0);
    sectionCensoredItemsCount.set(section.sectionId, 0);
    sectionTotalItemsCount.set(section.sectionId, 0);
    const secCensoredParts = new Map<string, number>();
    const secTotalParts = new Map<string, number>();
    for (const part of section.parts) {
      secCensoredParts.set(part.partId, 0);
      secTotalParts.set(part.partId, 0);
    }
    partCensoredItemCounts.set(section.sectionId, secCensoredParts);
    partTotalItemCounts.set(section.sectionId, secTotalParts);
  }

  const untimedOverallPmf = new Map<number, number>();
  let untimedExpectedTotal = 0;

  const accumulatePartCounts = (
    targetBySection: Map<string, Map<string, number>>,
    sectionId: string,
    deltaByPart: ReadonlyMap<string, number>,
  ): void => {
    let secMap = targetBySection.get(sectionId);
    if (!secMap) {
      secMap = new Map<string, number>();
      targetBySection.set(sectionId, secMap);
    }
    for (const [partId, cnt] of deltaByPart.entries()) {
      secMap.set(partId, (secMap.get(partId) ?? 0) + cnt);
    }
  };

  const recordCensoringStats = (
    sectionId: string,
    drawCensoredItems: SimulatedItemOutcome[],
    res: {
      readonly anyCensored: boolean;
      readonly partTotalCounts: ReadonlyMap<string, number>;
      readonly partCensoredCounts: ReadonlyMap<string, number>;
      readonly totalItems: number;
      readonly censoredCount: number;
      readonly censoredItems: readonly SimulatedItemOutcome[];
    },
  ): void => {
    if (res.anyCensored) sectionCensoredDraws.set(sectionId, (sectionCensoredDraws.get(sectionId) ?? 0) + 1);
    accumulatePartCounts(partTotalItemCounts, sectionId, res.partTotalCounts);
    accumulatePartCounts(partCensoredItemCounts, sectionId, res.partCensoredCounts);
    sectionTotalItemsCount.set(sectionId, (sectionTotalItemsCount.get(sectionId) ?? 0) + res.totalItems);
    sectionCensoredItemsCount.set(sectionId, (sectionCensoredItemsCount.get(sectionId) ?? 0) + res.censoredCount);
    drawCensoredItems.push(...res.censoredItems);
  };

  const readRequiredOwnScore = (map: Readonly<Record<string, number>>, sectionId: string): number => {
    if (!Object.hasOwn(map, sectionId)) {
      throw new RangeError(`Missing IELTS section score for "${sectionId}"`);
    }
    const value = map[sectionId]!;
    if (!Number.isFinite(value)) {
      throw new RangeError(`Non-finite IELTS section score for "${sectionId}"`);
    }
    return value;
  };

  for (const draw of draws) {
    const mBySkill: Record<string, number> = Object.create(null) as Record<string, number>;
    for (let k = 0; k < blueprint.skillIds.length; k++) {
      const z = draw.zLatent[k] ?? 0;
      defineRecordEntry(
        mBySkill,
        blueprint.skillIds[k]!,
        clamp(skillParams.rd[k]! * sigmoid(skillParams.mu[k]! + skillParams.sd[k]! * z), 0, 1),
      );
    }

    const nu = draw.nuSpeed + speedShift;
    let itemCursor = 0;
    let rubricCursor = 0;
    let sharedClockUsedSec = 0;
    const sharedLimitSec =
      !input.forceUntimed && blueprint.clockMode === "shared_full_paper" && blueprint.totalTimeLimitMinutes != null
        ? blueprint.totalTimeLimitMinutes * 60
        : Infinity;

    const timedSectionBand: Record<string, number> = {};
    const matchedUntimedSectionBand: Record<string, number> = Object.create(null) as Record<string, number>;
    const untimedSectionDistributions = new Map<string, ReadonlyMap<number, number>>();
    const untimedContinuousSections = new Map<string, number>();
    const drawCensoredItems: SimulatedItemOutcome[] = [];

    for (const section of blueprint.sections) {
      const sectionLimitSec = input.forceUntimed
        ? Infinity
        : blueprint.clockMode === "section_independent"
          ? (section.timeLimitMinutes ?? Infinity) * 60
          : sharedLimitSec;

      if (section.scoringKind === "item_raw_table") {
        const res = simulateItemSectionDraw({
          section,
          mBySkill,
          nu,
          draw,
          itemCursorStart: itemCursor,
          sectionLimitSec,
          initialClockUsedSec: blueprint.clockMode === "shared_full_paper" ? sharedClockUsedSec : 0,
          captureCensored: sampleRightCensoredItems.length === 0,
          precomputedUntimed: precomputedUntimedSections.get(section.sectionId),
        });
        itemCursor = res.nextItemCursor;
        if (blueprint.clockMode === "shared_full_paper") sharedClockUsedSec = res.finalClockUsedSec;
        recordCensoringStats(section.sectionId, drawCensoredItems, res);
        defineRecordEntry(timedSectionBand, section.sectionId, res.timedScore);
        defineRecordEntry(matchedUntimedSectionBand, section.sectionId, res.matchedUntimedScore);
        sectionTimedTotal.set(section.sectionId, (sectionTimedTotal.get(section.sectionId) ?? 0) + res.timedScore);
        untimedSectionDistributions.set(section.sectionId, res.untimedDist);
        sectionUntimedTotal.set(section.sectionId, (sectionUntimedTotal.get(section.sectionId) ?? 0) + res.untimedMean);
      } else {
        const res = simulateRubricSectionDraw({
          section,
          beliefs,
          trimmedLearnerId,
          mBySkill,
          nu,
          draw,
          rubricCursorStart: rubricCursor,
          sectionLimitSec,
          initialClockUsedSec: blueprint.clockMode === "shared_full_paper" ? sharedClockUsedSec : 0,
          rubricSummary,
          captureCensored: sampleRightCensoredItems.length === 0,
        });
        rubricCursor = res.nextRubricCursor;
        if (blueprint.clockMode === "shared_full_paper") sharedClockUsedSec = res.finalClockUsedSec;
        recordCensoringStats(section.sectionId, drawCensoredItems, res);
        defineRecordEntry(timedSectionBand, section.sectionId, res.timedScore);
        defineRecordEntry(matchedUntimedSectionBand, section.sectionId, res.untimedScore);
        untimedContinuousSections.set(section.sectionId, res.untimedScore);
        sectionTimedTotal.set(section.sectionId, (sectionTimedTotal.get(section.sectionId) ?? 0) + res.timedScore);
        sectionUntimedTotal.set(section.sectionId, (sectionUntimedTotal.get(section.sectionId) ?? 0) + res.untimedScore);
      }
    }

    if (sampleRightCensoredItems.length === 0 && drawCensoredItems.length > 0) sampleRightCensoredItems = drawCensoredItems;
    drawSectionScores.push(timedSectionBand);

    const drawWeight = 1 / draws.length;
    if (blueprint.aggregationMode === "ielts_overall_half_up") {
      const listening = readRequiredOwnScore(timedSectionBand, "listening");
      const reading = readRequiredOwnScore(timedSectionBand, "reading");
      const writing = readRequiredOwnScore(timedSectionBand, "writing");
      const speaking = readRequiredOwnScore(timedSectionBand, "speaking");
      timedScores.push(computeIeltsOverallBand({ listening, reading, writing, speaking }));

      const uL = readRequiredOwnScore(matchedUntimedSectionBand, "listening");
      const uR = readRequiredOwnScore(matchedUntimedSectionBand, "reading");
      const uW = untimedContinuousSections.get("writing");
      const uS = untimedContinuousSections.get("speaking");
      if (uW === undefined || uS === undefined || !Number.isFinite(uW) || !Number.isFinite(uS)) {
        throw new RangeError("Missing continuous IELTS rubric section score");
      }
      untimedScores.push(computeIeltsOverallBand({ listening: uL, reading: uR, writing: uW, speaking: uS }));

      const lDist = untimedSectionDistributions.get("listening");
      const rDist = untimedSectionDistributions.get("reading");
      if (!lDist || !rDist) {
        throw new RangeError("Missing IELTS untimed section distribution");
      }
      for (const [bL, pL] of lDist.entries()) {
        for (const [bR, pR] of rDist.entries()) {
          const prob = pL * pR * drawWeight;
          if (prob <= 0) continue;
          const overall = computeIeltsOverallBand({ listening: bL, reading: bR, writing: uW, speaking: uS });
          untimedOverallPmf.set(overall, (untimedOverallPmf.get(overall) ?? 0) + prob);
          untimedExpectedTotal += overall * prob;
        }
      }
    } else {
      const totalTimed = blueprint.sections.reduce(
        (s, sec) => s + sec.weight * (Object.hasOwn(timedSectionBand, sec.sectionId) ? timedSectionBand[sec.sectionId]! : 0),
        0,
      );
      timedScores.push(snapToScoreGrid(totalTimed, blueprint.scoreRange, blueprint.scoreStep, "nearest"));
      const totalMatchedUntimed = blueprint.sections.reduce(
        (s, sec) =>
          s +
          sec.weight *
            (Object.hasOwn(matchedUntimedSectionBand, sec.sectionId) ? matchedUntimedSectionBand[sec.sectionId]! : 0),
        0,
      );
      untimedScores.push(snapToScoreGrid(totalMatchedUntimed, blueprint.scoreRange, blueprint.scoreStep, "nearest"));
      untimedExpectedTotal += accumulateWeightedUntimedPmf(blueprint, untimedSectionDistributions, untimedContinuousSections, drawWeight, untimedOverallPmf);
    }
  }

  const sortedTimed = [...timedScores].sort((a, b) => a - b);
  const timedExpectedScore = timedScores.reduce((a, b) => a + b, 0) / draws.length;
  const matchedUntimedExpectedScore = untimedScores.reduce((a, b) => a + b, 0) / draws.length;
  const untimedExpectedScore = untimedExpectedTotal;
  const sectionSummaries: Record<string, SectionSimulationSummary> = {};
  const rightCensoringRateBySection: Record<string, number> = {};

  for (const section of blueprint.sections) {
    const sid = section.sectionId;
    const rate = (sectionCensoredDraws.get(sid) ?? 0) / draws.length;
    const totalSecItems = sectionTotalItemsCount.get(sid) ?? 0;
    const censoredSecItems = sectionCensoredItemsCount.get(sid) ?? 0;
    const partRates: Record<string, number> = {};
    const secTotalParts = partTotalItemCounts.get(sid);
    const secCensoredParts = partCensoredItemCounts.get(sid);
    for (const part of section.parts) {
      const pTotal = secTotalParts?.get(part.partId) ?? 0;
      const rateValue = pTotal > 0 ? (secCensoredParts?.get(part.partId) ?? 0) / pTotal : 0;
      defineRecordEntry(partRates, part.partId, rateValue);
    }
    defineRecordEntry(rightCensoringRateBySection, sid, rate);
    defineRecordEntry(sectionSummaries, sid, {
      sectionId: sid,
      timedMeanScore: (sectionTimedTotal.get(sid) ?? 0) / draws.length,
      untimedMeanScore: (sectionUntimedTotal.get(sid) ?? 0) / draws.length,
      rightCensoringRate: rate,
      censoredItemFraction: totalSecItems > 0 ? censoredSecItems / totalSecItems : 0,
      partCensoringRates: partRates,
    });
  }

  const untimedScoreDistribution: ScoreBucketProbability[] = [...untimedOverallPmf.entries()]
    .sort(([a], [b]) => a - b)
    .map(([score, probability]) => ({ score, probability }));

  return {
    blueprintId: blueprint.blueprintId,
    examAtMs,
    numDraws: draws.length,
    timedScores,
    untimedScores,
    matchedUntimedExpectedScore,
    matchedTimeSqueezeDelta: matchedUntimedExpectedScore - timedExpectedScore,
    untimedExpectedScore,
    timedExpectedScore,
    timeSqueezeDelta: untimedExpectedScore - timedExpectedScore,
    q10: percentileSorted(sortedTimed, 0.1),
    q50: percentileSorted(sortedTimed, 0.5),
    q90: percentileSorted(sortedTimed, 0.9),
    sectionSummaries,
    rightCensoringRateBySection,
    sampleRightCensoredItems,
    untimedScoreDistribution,
    drawSectionScores,
  };
}
