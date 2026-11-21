import { retrievability, type SkillBeliefV1 } from "../epistemic/belief";
import {
  choleskyDecompose,
  computeIeltsOverallBand,
  computeWritingBand,
  rawScoreToBand,
  snapToScoreGrid,
} from "./ielts-blueprint";
import type {
  ExamBlueprintV1,
  ExamEvidenceRecord,
  ExamItemSpec,
  ExamSectionBlueprint,
  PaperSimulationSummary,
  ScoreBucketProbability,
  SectionSimulationSummary,
  SimulatedItemOutcome,
  SkillBeliefMap,
} from "./types";

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const sigmoid = (x: number): number => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));

export function isIndependentExamEvidence(record: ExamEvidenceRecord): boolean {
  return (
    record.countsTowardMastery === true &&
    record.assisted === false &&
    record.exposed !== true &&
    record.evidenceKind !== "practice_feedback" &&
    record.evidenceKind !== "self_report" &&
    Number.isFinite(record.observedAtMs)
  );
}

export function partitionExamEvidence(records: readonly ExamEvidenceRecord[]): {
  readonly admitted: readonly ExamEvidenceRecord[];
  readonly rejectedCount: number;
} {
  const admitted: ExamEvidenceRecord[] = [];
  let rejectedCount = 0;
  for (const record of records) {
    if (isIndependentExamEvidence(record)) admitted.push(record);
    else rejectedCount += 1;
  }
  return { admitted, rejectedCount };
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
  readonly rubricNormals: readonly number[];
};

export function generatePaperRandomDraws(
  blueprint: ExamBlueprintV1,
  numDraws: number,
  seed: number,
): PaperRandomDraw[] {
  const lower = choleskyDecompose(blueprint.thetaCovariance);
  const nSkills = blueprint.skillIds.length;
  const totalItems = blueprint.sections.reduce((sum, s) => sum + (s.items?.length ?? 0), 0);
  const totalParts = blueprint.sections.reduce((sum, s) => sum + s.parts.length, 0);
  const rng = createSeededRng(seed);
  const draws: PaperRandomDraw[] = [];
  for (let d = 0; d < numDraws; d++) {
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
      rubricNormals: Array.from({ length: totalParts }, () => sampleStandardNormal(rng)),
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
  const itemPoints = probabilities.map((_, idx) => Math.max(1, Math.round(points[idx] ?? 1)));
  const maxPoints = itemPoints.reduce((a, b) => a + b, 0);
  const dp = new Array<number>(maxPoints + 1).fill(0);
  dp[0] = 1;
  let runningMax = 0;
  for (let idx = 0; idx < probabilities.length; idx++) {
    const p = clamp(probabilities[idx] ?? 0, 0, 1);
    const pts = itemPoints[idx]!;
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
  for (const skillId of item.skillIds) prod *= clamp(mBySkill[skillId] ?? 0.5, 0, 1);
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
  let skillTerm = 0;
  for (const [skillId, loading] of Object.entries(item.timeModel.skillLoading)) {
    skillTerm += loading * (mBySkill[skillId] ?? 0.5);
  }
  const logT = item.timeModel.mu - item.timeModel.speedLoading * nuSpeed - skillTerm + item.timeModel.sigma * epsNormal;
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

type RubricEvidenceSummary = {
  readonly partAnchors: ReadonlyMap<string, { readonly low: number; readonly high: number }>;
  readonly sectionAnchors: ReadonlyMap<string, { readonly low: number; readonly high: number }>;
  readonly speakingFluencyShift: number;
};

function summarizeRubricAndTimingEvidence(admitted: readonly ExamEvidenceRecord[]): RubricEvidenceSummary {
  const partAnchors = new Map<string, { low: number; high: number }>();
  const sectionAnchors = new Map<string, { low: number; high: number }>();
  let speakingShiftSum = 0;
  let speakingCount = 0;

  for (const record of admitted) {
    if (record.rubricScore) {
      const bounds =
        record.rubricScore.kind === "exact"
          ? { low: record.rubricScore.score, high: record.rubricScore.score }
          : { low: Math.min(record.rubricScore.low, record.rubricScore.high), high: Math.max(record.rubricScore.low, record.rubricScore.high) };
      if (record.partId) partAnchors.set(record.partId, bounds);
      else sectionAnchors.set(record.sectionId, bounds);
    }
    if (record.sectionId === "speaking" && record.speechTimingReceipt?.calibrated) {
      const receipt = record.speechTimingReceipt;
      if (receipt.fluencyScore !== undefined && Number.isFinite(receipt.fluencyScore)) {
        speakingShiftSum += clamp((receipt.fluencyScore - 6) * 0.25, -1, 1);
        speakingCount += 1;
      } else if (receipt.speechRateWpm !== undefined && Number.isFinite(receipt.speechRateWpm)) {
        const wpmDelta = clamp((receipt.speechRateWpm - 125) / 80, -0.5, 0.5);
        const pausePenalty = receipt.pauseRatio !== undefined ? clamp((receipt.pauseRatio - 0.18) * 1.5, -0.2, 0.5) : 0;
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

function buildDecayedSkillParams(
  blueprint: ExamBlueprintV1,
  beliefs: SkillBeliefMap,
  examAtMs: number,
  skillOverrides?: Readonly<Record<string, { readonly abilityDelta?: number; readonly logStabilityDelta?: number }>>,
): { readonly rd: readonly number[]; readonly mu: readonly number[]; readonly sd: readonly number[] } {
  const rd: number[] = [];
  const mu: number[] = [];
  const sd: number[] = [];
  for (const skillId of blueprint.skillIds) {
    const belief: SkillBeliefV1 | undefined = beliefs[skillId];
    const override = skillOverrides?.[skillId];
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

type DrawItemSectionInput = {
  readonly section: ExamSectionBlueprint;
  readonly mBySkill: Readonly<Record<string, number>>;
  readonly nu: number;
  readonly draw: PaperRandomDraw;
  readonly itemCursorStart: number;
  readonly sectionLimitSec: number;
  readonly initialClockUsedSec: number;
  readonly captureCensored: boolean;
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
  readonly untimedDist: ReadonlyMap<number, number>;
  readonly untimedMean: number;
};

function simulateItemSectionDraw(input: DrawItemSectionInput): DrawItemSectionResult {
  const items = input.section.items ?? [];
  let itemCursor = input.itemCursorStart;
  let clockUsedSec = input.initialClockUsedSec;
  let rawTimed = 0;
  let anyCensored = false;
  let censoredCount = 0;
  const itemProbs: number[] = [];
  const itemPoints: number[] = [];
  const censoredItems: SimulatedItemOutcome[] = [];
  const partCensoredCounts = new Map<string, number>();
  const partTotalCounts = new Map<string, number>();

  for (const item of items) {
    const u = input.draw.itemUniforms[itemCursor] ?? 0.5;
    const eps = input.draw.itemTimeNormals[itemCursor] ?? 0;
    itemCursor += 1;

    const pSuccess = itemSuccessProbability(item, input.mBySkill);
    const pts = item.points ?? 1;
    itemProbs.push(pSuccess);
    itemPoints.push(pts);

    const stepSec = sampleLogNormalStepTimeSeconds(item, input.nu, input.mBySkill, eps);
    const partKey = `${input.section.sectionId}:${item.partId}`;
    partTotalCounts.set(partKey, (partTotalCounts.get(partKey) ?? 0) + 1);

    if (clockUsedSec + stepSec > input.sectionLimitSec) {
      anyCensored = true;
      censoredCount += 1;
      clockUsedSec = input.sectionLimitSec;
      partCensoredCounts.set(partKey, (partCensoredCounts.get(partKey) ?? 0) + 1);
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
      if (u < pSuccess) rawTimed += pts;
    }
  }

  const timedScore = input.section.rawToBandTable ? rawScoreToBand(rawTimed, input.section.rawToBandTable) : rawTimed;
  const untimedDist = collapseRawDistributionToScoreMap(convolveLordWingersky(itemProbs, itemPoints), input.section);
  let untimedMean = 0;
  for (const [score, prob] of untimedDist.entries()) untimedMean += score * prob;

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
    untimedDist,
    untimedMean,
  };
}

function simulateRubricSectionDraw(input: {
  readonly section: ExamSectionBlueprint;
  readonly mBySkill: Readonly<Record<string, number>>;
  readonly nu: number;
  readonly draw: PaperRandomDraw;
  readonly rubricCursorStart: number;
  readonly sectionLimitSec: number;
  readonly rubricSummary: RubricEvidenceSummary;
}): { readonly nextRubricCursor: number; readonly anyCensored: boolean; readonly timedScore: number; readonly untimedScore: number } {
  let rubricCursor = input.rubricCursorStart;
  let usedSec = 0;
  let partWeightedSum = 0;
  let untimedWeightedSum = 0;
  let weightSum = 0;
  let anyCensored = false;
  const sectionAnchor = input.rubricSummary.sectionAnchors.get(input.section.sectionId);
  const [minB, maxB] = input.section.scoreRange;
  const speakingShift = input.section.sectionId === "speaking" ? input.rubricSummary.speakingFluencyShift : 0;

  for (const part of input.section.parts) {
    const epsPart = input.draw.rubricNormals[rubricCursor] ?? 0;
    rubricCursor += 1;
    const partAnchor = input.rubricSummary.partAnchors.get(part.partId) ?? sectionAnchor;
    const skillVals = part.skillIds.map((id) => input.mBySkill[id] ?? 0.5);
    const meanMastery = skillVals.length > 0 ? skillVals.reduce((a, b) => a + b, 0) / skillVals.length : 0.5;
    let untimedPartScore: number;
    if (partAnchor) {
      const span = partAnchor.high - partAnchor.low;
      const anchorPos = span > 0 ? partAnchor.low + span * clamp(0.5 + 0.25 * epsPart, 0, 1) : partAnchor.low;
      untimedPartScore = clamp(anchorPos + speakingShift * 0.25, minB, maxB);
    } else {
      untimedPartScore = clamp(minB + 3 + (maxB - (minB + 3)) * meanMastery + speakingShift + 0.2 * epsPart, minB, maxB);
    }

    let timedPartScore = untimedPartScore;
    if (part.timeModel && Number.isFinite(input.sectionLimitSec)) {
      let skillTerm = 0;
      for (const [id, load] of Object.entries(part.timeModel.skillLoading)) {
        skillTerm += load * (input.mBySkill[id] ?? 0.5);
      }
      const partDuration = Math.exp(
        clamp(part.timeModel.mu - part.timeModel.speedLoading * input.nu - skillTerm + part.timeModel.sigma * epsPart, 4, 10),
      );
      const remaining = Math.max(0, input.sectionLimitSec - usedSec);
      usedSec += partDuration;
      if (partDuration > remaining) {
        anyCensored = true;
        timedPartScore = clamp(untimedPartScore * clamp(remaining / partDuration, 0.35, 1), minB, maxB);
      }
    }
    untimedWeightedSum += part.weight * untimedPartScore;
    partWeightedSum += part.weight * timedPartScore;
    weightSum += part.weight;
  }

  const normalize = input.section.sectionId === "writing" && input.section.parts.length === 2 ? 1 : weightSum || 1;
  return {
    nextRubricCursor: rubricCursor,
    anyCensored,
    timedScore: partWeightedSum / normalize,
    untimedScore: untimedWeightedSum / normalize,
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

export function simulateExamPaper(input: {
  readonly blueprint: ExamBlueprintV1;
  readonly beliefs: SkillBeliefMap;
  readonly evidence: readonly ExamEvidenceRecord[];
  readonly examAtMs: number;
  readonly numDraws?: number;
  readonly seed?: number;
  readonly precomputedDraws?: readonly PaperRandomDraw[];
  readonly skillOverrides?: Readonly<Record<string, { readonly abilityDelta?: number; readonly logStabilityDelta?: number }>>;
  readonly speedShift?: number;
  readonly forceUntimed?: boolean;
}): PaperSimulationSummary {
  const { blueprint, beliefs, examAtMs } = input;
  const numDraws = Math.max(1, Math.round(input.numDraws ?? 400));
  const draws = input.precomputedDraws ?? generatePaperRandomDraws(blueprint, numDraws, input.seed ?? 20261121);
  const { admitted } = partitionExamEvidence(input.evidence);
  const rubricSummary = summarizeRubricAndTimingEvidence(admitted);
  const skillParams = buildDecayedSkillParams(blueprint, beliefs, examAtMs, input.skillOverrides);
  const speedShift = input.speedShift ?? 0;

  const timedScores: number[] = [];
  const drawSectionScores: Array<Record<string, number>> = [];
  let sampleRightCensoredItems: SimulatedItemOutcome[] = [];

  const sectionCensoredDraws = new Map<string, number>();
  const sectionTimedTotal = new Map<string, number>();
  const sectionUntimedTotal = new Map<string, number>();
  const partCensoredItemCounts = new Map<string, number>();
  const partTotalItemCounts = new Map<string, number>();
  const sectionCensoredItemsCount = new Map<string, number>();
  const sectionTotalItemsCount = new Map<string, number>();
  for (const section of blueprint.sections) {
    sectionCensoredDraws.set(section.sectionId, 0);
    sectionTimedTotal.set(section.sectionId, 0);
    sectionUntimedTotal.set(section.sectionId, 0);
    sectionCensoredItemsCount.set(section.sectionId, 0);
    sectionTotalItemsCount.set(section.sectionId, 0);
    for (const part of section.parts) {
      partCensoredItemCounts.set(`${section.sectionId}:${part.partId}`, 0);
      partTotalItemCounts.set(`${section.sectionId}:${part.partId}`, 0);
    }
  }

  const untimedOverallPmf = new Map<number, number>();
  let untimedExpectedTotal = 0;

  for (const draw of draws) {
    const mBySkill: Record<string, number> = {};
    for (let k = 0; k < blueprint.skillIds.length; k++) {
      const z = draw.zLatent[k] ?? 0;
      mBySkill[blueprint.skillIds[k]!] = clamp(skillParams.rd[k]! * sigmoid(skillParams.mu[k]! + skillParams.sd[k]! * z), 0, 1);
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
        });
        itemCursor = res.nextItemCursor;
        if (blueprint.clockMode === "shared_full_paper") sharedClockUsedSec = res.finalClockUsedSec;
        if (res.anyCensored) sectionCensoredDraws.set(section.sectionId, (sectionCensoredDraws.get(section.sectionId) ?? 0) + 1);
        for (const [pk, cnt] of res.partTotalCounts.entries()) partTotalItemCounts.set(pk, (partTotalItemCounts.get(pk) ?? 0) + cnt);
        for (const [pk, cnt] of res.partCensoredCounts.entries()) partCensoredItemCounts.set(pk, (partCensoredItemCounts.get(pk) ?? 0) + cnt);
        sectionTotalItemsCount.set(section.sectionId, (sectionTotalItemsCount.get(section.sectionId) ?? 0) + res.totalItems);
        sectionCensoredItemsCount.set(section.sectionId, (sectionCensoredItemsCount.get(section.sectionId) ?? 0) + res.censoredCount);
        drawCensoredItems.push(...res.censoredItems);
        timedSectionBand[section.sectionId] = res.timedScore;
        sectionTimedTotal.set(section.sectionId, (sectionTimedTotal.get(section.sectionId) ?? 0) + res.timedScore);
        untimedSectionDistributions.set(section.sectionId, res.untimedDist);
        sectionUntimedTotal.set(section.sectionId, (sectionUntimedTotal.get(section.sectionId) ?? 0) + res.untimedMean);
      } else {
        const res = simulateRubricSectionDraw({ section, mBySkill, nu, draw, rubricCursorStart: rubricCursor, sectionLimitSec, rubricSummary });
        rubricCursor = res.nextRubricCursor;
        if (res.anyCensored) sectionCensoredDraws.set(section.sectionId, (sectionCensoredDraws.get(section.sectionId) ?? 0) + 1);
        timedSectionBand[section.sectionId] = res.timedScore;
        untimedContinuousSections.set(section.sectionId, res.untimedScore);
        sectionTimedTotal.set(section.sectionId, (sectionTimedTotal.get(section.sectionId) ?? 0) + res.timedScore);
        sectionUntimedTotal.set(section.sectionId, (sectionUntimedTotal.get(section.sectionId) ?? 0) + res.untimedScore);
      }
    }

    if (sampleRightCensoredItems.length === 0 && drawCensoredItems.length > 0) sampleRightCensoredItems = drawCensoredItems;
    drawSectionScores.push(timedSectionBand);

    const drawWeight = 1 / draws.length;
    if (blueprint.aggregationMode === "ielts_overall_half_up") {
      const listening = timedSectionBand["listening"] ?? 0;
      const reading = timedSectionBand["reading"] ?? 0;
      const writing = timedSectionBand["writing"] ?? computeWritingBand(0, 0);
      const speaking = timedSectionBand["speaking"] ?? 0;
      timedScores.push(computeIeltsOverallBand({ listening, reading, writing, speaking }));

      const lDist = untimedSectionDistributions.get("listening") ?? new Map([[listening, 1]]);
      const rDist = untimedSectionDistributions.get("reading") ?? new Map([[reading, 1]]);
      const uW = untimedContinuousSections.get("writing") ?? writing;
      const uS = untimedContinuousSections.get("speaking") ?? speaking;
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
      const totalTimed = blueprint.sections.reduce((s, sec) => s + sec.weight * (timedSectionBand[sec.sectionId] ?? 0), 0);
      timedScores.push(snapToScoreGrid(totalTimed, blueprint.scoreRange, blueprint.scoreStep, "nearest"));
      untimedExpectedTotal += accumulateWeightedUntimedPmf(blueprint, untimedSectionDistributions, untimedContinuousSections, drawWeight, untimedOverallPmf);
    }
  }

  const sortedTimed = [...timedScores].sort((a, b) => a - b);
  const timedExpectedScore = timedScores.reduce((a, b) => a + b, 0) / draws.length;
  const untimedExpectedScore = untimedExpectedTotal;
  const sectionSummaries: Record<string, SectionSimulationSummary> = {};
  const rightCensoringRateBySection: Record<string, number> = {};

  for (const section of blueprint.sections) {
    const sid = section.sectionId;
    const rate = (sectionCensoredDraws.get(sid) ?? 0) / draws.length;
    const totalSecItems = sectionTotalItemsCount.get(sid) ?? 0;
    const censoredSecItems = sectionCensoredItemsCount.get(sid) ?? 0;
    const partRates: Record<string, number> = {};
    for (const part of section.parts) {
      const pk = `${sid}:${part.partId}`;
      const pTotal = partTotalItemCounts.get(pk) ?? 0;
      partRates[part.partId] = pTotal > 0 ? (partCensoredItemCounts.get(pk) ?? 0) / pTotal : 0;
    }
    rightCensoringRateBySection[sid] = rate;
    sectionSummaries[sid] = {
      sectionId: sid,
      timedMeanScore: (sectionTimedTotal.get(sid) ?? 0) / draws.length,
      untimedMeanScore: (sectionUntimedTotal.get(sid) ?? 0) / draws.length,
      rightCensoringRate: rate,
      censoredItemFraction: totalSecItems > 0 ? censoredSecItems / totalSecItems : 0,
      partCensoringRates: partRates,
    };
  }

  const untimedScoreDistribution: ScoreBucketProbability[] = [...untimedOverallPmf.entries()]
    .sort(([a], [b]) => a - b)
    .map(([score, probability]) => ({ score, probability }));

  return {
    blueprintId: blueprint.blueprintId,
    examAtMs,
    numDraws: draws.length,
    timedScores,
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
