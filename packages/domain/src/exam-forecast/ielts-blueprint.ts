import type {
  ExamBlueprintV1,
  ExamItemSpec,
  ExamSectionBlueprint,
  ExamTimeModel,
  RawToScoreBand,
} from "./types";

export const IELTS_LISTENING_RAW_TO_BAND: readonly RawToScoreBand[] = [
  { rawMin: 0, rawMax: 0, score: 0.0 },
  { rawMin: 1, rawMax: 1, score: 1.0 },
  { rawMin: 2, rawMax: 3, score: 2.0 },
  { rawMin: 4, rawMax: 5, score: 2.5 },
  { rawMin: 6, rawMax: 7, score: 3.0 },
  { rawMin: 8, rawMax: 9, score: 3.5 },
  { rawMin: 10, rawMax: 12, score: 4.0 },
  { rawMin: 13, rawMax: 15, score: 4.5 },
  { rawMin: 16, rawMax: 17, score: 5.0 },
  { rawMin: 18, rawMax: 22, score: 5.5 },
  { rawMin: 23, rawMax: 25, score: 6.0 },
  { rawMin: 26, rawMax: 29, score: 6.5 },
  { rawMin: 30, rawMax: 31, score: 7.0 },
  { rawMin: 32, rawMax: 34, score: 7.5 },
  { rawMin: 35, rawMax: 36, score: 8.0 },
  { rawMin: 37, rawMax: 38, score: 8.5 },
  { rawMin: 39, rawMax: 40, score: 9.0 },
];

export const IELTS_ACADEMIC_READING_RAW_TO_BAND: readonly RawToScoreBand[] = [
  { rawMin: 0, rawMax: 0, score: 0.0 },
  { rawMin: 1, rawMax: 1, score: 1.0 },
  { rawMin: 2, rawMax: 3, score: 2.0 },
  { rawMin: 4, rawMax: 5, score: 2.5 },
  { rawMin: 6, rawMax: 7, score: 3.0 },
  { rawMin: 8, rawMax: 9, score: 3.5 },
  { rawMin: 10, rawMax: 12, score: 4.0 },
  { rawMin: 13, rawMax: 14, score: 4.5 },
  { rawMin: 15, rawMax: 18, score: 5.0 },
  { rawMin: 19, rawMax: 22, score: 5.5 },
  { rawMin: 23, rawMax: 26, score: 6.0 },
  { rawMin: 27, rawMax: 29, score: 6.5 },
  { rawMin: 30, rawMax: 32, score: 7.0 },
  { rawMin: 33, rawMax: 34, score: 7.5 },
  { rawMin: 35, rawMax: 36, score: 8.0 },
  { rawMin: 37, rawMax: 38, score: 8.5 },
  { rawMin: 39, rawMax: 40, score: 9.0 },
];

/** Official IELTS overall rounding: continuous 4-section mean rounded half-up to nearest 0.5 in [0, 9]. */
export function roundHalfUp05(score: number): number {
  if (!Number.isFinite(score)) return 0;
  const clamped = Math.min(9, Math.max(0, score));
  return Math.floor(clamped * 2 + 0.5) / 2;
}

const FLOAT64_VIEW = new DataView(new ArrayBuffer(8));
export const MIN_BINARY64_UNIT_EXPONENT = -1074;

// Finite binary64 values are signed integer significands times a power of two.
export function decomposeFiniteFloat(value: number): { significand: number; exponent: number } {
  FLOAT64_VIEW.setFloat64(0, value);
  const hi = FLOAT64_VIEW.getUint32(0);
  const lo = FLOAT64_VIEW.getUint32(4);
  const sign = (hi >>> 31) === 0 ? 1 : -1;
  const rawExponent = (hi >>> 20) & 0x7ff;
  const fraction = (hi & 0xfffff) * 2 ** 32 + lo;
  if (rawExponent === 0) {
    return { significand: sign * fraction, exponent: MIN_BINARY64_UNIT_EXPONENT };
  }
  return { significand: sign * (2 ** 52 + fraction), exponent: rawExponent - 1075 };
}

export function addToExponentBucket(buckets: bigint[], offset: number, significand: bigint): void {
  const index = offset >> 5;
  buckets[index] = (buckets[index] ?? 0n) + (significand << BigInt(offset & 31));
}

export function foldExponentBuckets(buckets: readonly bigint[]): bigint {
  let total = 0n;
  let previousIndex = buckets.length - 1;
  for (let index = previousIndex; index >= 0; index--) {
    const coefficient = buckets[index];
    if (coefficient === undefined || coefficient === 0n) continue;
    total = (total << BigInt((previousIndex - index) * 32)) + coefficient;
    previousIndex = index;
  }
  return total === 0n ? 0n : total << BigInt(previousIndex * 32);
}

export function exactRationalPow2ToNumber(
  num: bigint,
  den: bigint,
  pow2Offset: number,
  direction: "nearest" | "floor" | "ceil" = "nearest",
): number {
  if (num === 0n) return 0;
  const sign = num < 0n ? -1 : 1;
  const magnitude = num < 0n ? -num : num;
  const bitLengthDiff = magnitude.toString(2).length - den.toString(2).length;
  const belowPower = bitLengthDiff >= 0
    ? magnitude < (den << BigInt(bitLengthDiff))
    : (magnitude << BigInt(-bitLengthDiff)) < den;
  const exponent = bitLengthDiff + pow2Offset - (belowPower ? 1 : 0);
  const awayFromZero = direction === (sign < 0 ? "floor" : "ceil");
  if (exponent > 1023) return sign * (direction === "nearest" || awayFromZero ? Infinity : Number.MAX_VALUE);

  // Round in units of one ULP, including the fixed spacing of subnormals.
  const unitExponent = Math.max(MIN_BINARY64_UNIT_EXPONENT, exponent - 52);
  const shift = pow2Offset - unitExponent;
  const dividend = shift >= 0 ? magnitude << BigInt(shift) : magnitude;
  const divisor = shift < 0 ? den << BigInt(-shift) : den;
  let significand = dividend / divisor;
  const twiceRemainder = (dividend % divisor) << 1n;
  const roundUp = direction === "nearest"
    ? twiceRemainder > divisor || (twiceRemainder === divisor && (significand & 1n) === 1n)
    : awayFromZero && twiceRemainder !== 0n;
  if (roundUp) {
    significand += 1n;
  }
  // The rounded integer (including a carry to 2^53) is exactly representable.
  return sign * Number(significand) * 2 ** unitExponent;
}

export function toBinary64Units(value: number): bigint {
  const { significand, exponent } = decomposeFiniteFloat(value);
  return BigInt(significand) << BigInt(exponent - MIN_BINARY64_UNIT_EXPONENT);
}

export function addFiniteFloatToExponentBuckets(buckets: bigint[], value: number): void {
  if (value === 0) return;
  const { significand, exponent } = decomposeFiniteFloat(value);
  addToExponentBucket(buckets, exponent - MIN_BINARY64_UNIT_EXPONENT, BigInt(significand));
}

/** Arithmetic mean with exact finite accumulation and one binary64 rounding. */
export function safeArithmeticMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0]!;
  const buckets = new Array<bigint>(68);
  let nonFiniteSum = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      addFiniteFloatToExponentBuckets(buckets, value);
    } else {
      nonFiniteSum += value;
    }
  }
  if (nonFiniteSum !== 0) return nonFiniteSum;
  return exactRationalPow2ToNumber(foldExponentBuckets(buckets), BigInt(values.length), MIN_BINARY64_UNIT_EXPONENT);
}

export const MAX_SECTION_ITEMS = 500;
export const MAX_BLUEPRINT_ITEMS = 2_000;
export const MAX_ITEM_POINTS = 1_000;
export const MAX_SECTION_TOTAL_POINTS = 2_000;
export const MAX_SCORE_GRID_STEPS = 1_000_000;

function decimalPlaces(value: number): number | null {
  const str = value.toString();
  if (/[^0-9eE+\-.]/.test(str)) return null;
  const match = /^[-+]?\d+(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(str);
  if (!match) return null;
  const fracLen = match[1]?.length ?? 0;
  const exp = match[2] ? Number.parseInt(match[2], 10) : 0;
  return Math.max(0, fracLen - exp);
}

function cleanGridPoint(raw: number, minScore: number, step: number): number {
  if (!Number.isFinite(raw)) {
    throw new RangeError("Score grid point overflowed finite precision");
  }
  if (raw === 0) return 0;
  if (step < 1 && Math.abs(raw) < 1e9) {
    const dStep = decimalPlaces(step);
    const dMin = decimalPlaces(minScore);
    if (dStep !== null && dMin !== null) {
      const dec = Math.max(dStep, dMin);
      if (dec <= 12) {
        const cleaned = Number(raw.toFixed(dec));
        return cleaned === 0 ? 0 : cleaned;
      }
    }
  }
  return Object.is(raw, -0) ? 0 : raw;
}

function rawGridPointAt(minScore: number, step: number, index: number): number {
  const offset = index * step;
  if (Number.isFinite(offset)) return minScore + offset;
  // The offset may overflow even though adding the negative origin gives a finite point.
  const exactPoint = toBinary64Units(minScore) + BigInt(index) * toBinary64Units(step);
  return exactRationalPow2ToNumber(exactPoint, 1n, MIN_BINARY64_UNIT_EXPONENT);
}

function gridPointAt(minScore: number, step: number, index: number): number {
  return cleanGridPoint(rawGridPointAt(minScore, step, index), minScore, step);
}

function scoreGridUnits(score: number, origin: number, step: number): number {
  const span = score - origin;
  if (Number.isFinite(span)) return span / step;
  return exactRationalPow2ToNumber(toBinary64Units(score) - toBinary64Units(origin), toBinary64Units(step), 0);
}

function resolveAlignedScoreGridSteps(minScore: number, maxScore: number, step: number): number | null {
  if (!Number.isFinite(minScore) || !Number.isFinite(maxScore) || minScore >= maxScore) {
    return null;
  }
  if (!Number.isFinite(step) || step <= 0) {
    return null;
  }
  const rawSteps = scoreGridUnits(maxScore, minScore, step);
  if (!Number.isFinite(rawSteps)) {
    return null;
  }
  const nearestSteps = Math.round(rawSteps);
  if (nearestSteps < 1 || nearestSteps > MAX_SCORE_GRID_STEPS) {
    return null;
  }
  const rawMax = rawGridPointAt(minScore, step, nearestSteps);
  if (!Number.isFinite(rawMax)) {
    return null;
  }
  const reconstructedMax = cleanGridPoint(rawMax, minScore, step);
  const tol = Number.EPSILON * 8 * Math.max(1, Math.abs(minScore), Math.abs(maxScore));
  if (Math.abs(reconstructedMax - maxScore) > tol) {
    return null;
  }
  return nearestSteps;
}

export function snapToScoreGrid(
  value: number,
  range: readonly [number, number],
  step: number,
  direction: "nearest" | "floor" | "ceil",
): number {
  const [minScore, maxScore] = range;
  if (range.length !== 2 || !Number.isFinite(minScore) || !Number.isFinite(maxScore) || minScore > maxScore) {
    throw new RangeError("Score range must satisfy finite min <= max");
  }
  if (!Number.isFinite(step) || step <= 0) {
    throw new RangeError("Score step must be finite and positive");
  }
  if (!Number.isFinite(value)) {
    throw new RangeError("Score value must be finite");
  }
  if (minScore === maxScore) {
    return minScore === 0 ? 0 : minScore;
  }
  const alignedSteps = resolveAlignedScoreGridSteps(minScore, maxScore, step);
  let maxK: number;
  if (alignedSteps !== null) {
    maxK = alignedSteps;
  } else {
    const rawSteps = scoreGridUnits(maxScore, minScore, step);
    if (!Number.isFinite(rawSteps) || rawSteps > MAX_SCORE_GRID_STEPS) {
      throw new RangeError(`Score grid step count exceeds limit (${MAX_SCORE_GRID_STEPS})`);
    }
    maxK = Math.floor(rawSteps + 1e-12);
    for (let iter = 0; iter < 2 && maxK >= 0 && gridPointAt(minScore, step, maxK) > maxScore; iter += 1) {
      maxK -= 1;
    }
    if (maxK < 0 || gridPointAt(minScore, step, maxK) > maxScore) {
      throw new RangeError("Score range contains no valid grid point");
    }
  }
  const pointAt = (k: number): number => {
    if (k <= 0) return minScore === 0 ? 0 : minScore;
    if (alignedSteps !== null && k >= maxK) return maxScore === 0 ? 0 : maxScore;
    return gridPointAt(minScore, step, k);
  };

  const clampedValue = Math.min(maxScore, Math.max(minScore, value));
  if (clampedValue <= minScore) return pointAt(0);
  if (alignedSteps !== null && clampedValue >= maxScore) return pointAt(maxK);

  const relUnits = scoreGridUnits(clampedValue, minScore, step);
  const clampK = (candidate: number): number => Math.min(maxK, Math.max(0, candidate));
  const kFloor = clampK(Math.floor(relUnits));
  const kCeil = clampK(Math.ceil(relUnits));
  const kPrev = clampK(kFloor - 1);
  const kNext = clampK(kCeil + 1);

  if (direction === "floor") {
    for (const candidate of [kNext, kCeil, kFloor, kPrev]) {
      const pt = pointAt(candidate);
      if (pt <= clampedValue) return pt;
    }
    return minScore === 0 ? 0 : minScore;
  }

  if (direction === "ceil") {
    for (const candidate of [kPrev, kFloor, kCeil, kNext]) {
      const pt = pointAt(candidate);
      if (pt >= clampedValue) return pt;
    }
    return maxScore === 0 ? 0 : maxScore;
  }

  let bestScore = pointAt(kPrev);
  let bestDist = Math.abs(bestScore - clampedValue);
  for (const candidate of [kFloor, kCeil, kNext]) {
    const pt = pointAt(candidate);
    const dist = Math.abs(pt - clampedValue);
    if (dist <= bestDist) {
      bestDist = dist;
      bestScore = pt;
    }
  }
  return bestScore;
}

export function computeWritingBand(
  task1Band: number,
  task2Band: number,
  options: { readonly roundSection?: boolean } = {},
): number {
  if (!Number.isFinite(task1Band) || !Number.isFinite(task2Band)) {
    throw new RangeError("Writing task bands must be finite");
  }
  const t1 = Math.min(9, Math.max(0, task1Band));
  const t2 = Math.min(9, Math.max(0, task2Band));
  const continuous = (t1 + 2 * t2) / 3;
  return options.roundSection ? roundHalfUp05(continuous) : continuous;
}

export function computeIeltsOverallBand(sections: {
  readonly listening: number;
  readonly reading: number;
  readonly writing: number;
  readonly speaking: number;
}): number {
  const values = [sections.listening, sections.reading, sections.writing, sections.speaking];
  if (values.some((v) => !Number.isFinite(v))) {
    throw new RangeError("All four IELTS section bands must be finite");
  }
  const clampedSum = values.reduce((sum, v) => sum + Math.min(9, Math.max(0, v)), 0);
  return roundHalfUp05(clampedSum / 4);
}

export function rawScoreToBand(rawScore: number, table: readonly RawToScoreBand[]): number {
  if (!Number.isFinite(rawScore) || table.length === 0) return 0;
  const rounded = Math.round(rawScore);
  for (const band of table) {
    if (rounded >= band.rawMin && rounded <= band.rawMax) return band.score;
  }
  const first = table[0];
  const last = table[table.length - 1];
  if (first && rounded < first.rawMin) return first.score;
  return last ? last.score : 0;
}

export const IELTS_ACADEMIC_SKILL_IDS = [
  "ielts.listening.detail",
  "ielts.listening.distractor",
  "ielts.listening.academic_monologue",
  "ielts.reading.tfng",
  "ielts.reading.heading",
  "ielts.reading.inference",
  "ielts.reading.pacing",
  "ielts.writing.task1_overview",
  "ielts.writing.task2_argument",
  "ielts.writing.cohesion_lexis",
  "ielts.speaking.fluency_structure",
  "ielts.speaking.abstract_extension",
] as const;

const SKILL_SECTION_GROUP: readonly number[] = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3];

const IELTS_THETA_COVARIANCE: readonly (readonly number[])[] = IELTS_ACADEMIC_SKILL_IDS.map((_, i) =>
  IELTS_ACADEMIC_SKILL_IDS.map((__, j) => {
    if (i === j) return 1;
    const sameSection = SKILL_SECTION_GROUP[i] === SKILL_SECTION_GROUP[j];
    const receptivePair = (SKILL_SECTION_GROUP[i]! <= 1 && SKILL_SECTION_GROUP[j]! <= 1);
    return sameSection ? 0.55 : receptivePair ? 0.35 : 0.25;
  }),
);

function buildListeningItems(): ExamItemSpec[] {
  const partConfigs = [
    { partId: "listening-part-1", count: 10, skills: ["ielts.listening.detail", "ielts.listening.distractor"], mu: Math.log(38), g: 0.1, l: 0.03 },
    { partId: "listening-part-2", count: 10, skills: ["ielts.listening.detail", "ielts.listening.distractor"], mu: Math.log(40), g: 0.15, l: 0.04 },
    { partId: "listening-part-3", count: 10, skills: ["ielts.listening.distractor", "ielts.listening.academic_monologue"], mu: Math.log(43), g: 0.2, l: 0.05 },
    { partId: "listening-part-4", count: 10, skills: ["ielts.listening.academic_monologue"], mu: Math.log(45), g: 0.1, l: 0.05 },
  ] as const;
  const items: ExamItemSpec[] = [];
  let seq = 1;
  for (const part of partConfigs) {
    for (let idx = 0; idx < part.count; idx++) {
      const skillLoading: Record<string, number> = {};
      for (const skillId of part.skills) skillLoading[skillId] = 0.15;
      items.push({
        itemId: `ielts-l-${seq++}`,
        sectionId: "listening",
        partId: part.partId,
        skillIds: part.skills,
        guess: part.g,
        lapse: part.l,
        points: 1,
        timeModel: { mu: part.mu, speedLoading: 0.12, skillLoading, sigma: 0.14 },
      });
    }
  }
  return items;
}

function buildReadingItems(): ExamItemSpec[] {
  const passageConfigs = [
    { partId: "reading-passage-1", count: 13, skills: ["ielts.reading.tfng", "ielts.reading.pacing"], mu: Math.log(90), g: 0.2, l: 0.04, speedLoading: 0.3, load: 0.42 },
    { partId: "reading-passage-2", count: 13, skills: ["ielts.reading.heading", "ielts.reading.pacing"], mu: Math.log(112), g: 0.18, l: 0.05, speedLoading: 0.35, load: 0.45 },
    { partId: "reading-passage-3", count: 14, skills: ["ielts.reading.inference", "ielts.reading.pacing"], mu: Math.log(138), g: 0.2, l: 0.06, speedLoading: 0.4, load: 0.48 },
  ] as const;
  const items: ExamItemSpec[] = [];
  let seq = 1;
  for (const passage of passageConfigs) {
    for (let idx = 0; idx < passage.count; idx++) {
      const skillLoading: Record<string, number> = {};
      for (const skillId of passage.skills) skillLoading[skillId] = passage.load / passage.skills.length;
      items.push({
        itemId: `ielts-r-${seq++}`,
        sectionId: "reading",
        partId: passage.partId,
        skillIds: passage.skills,
        guess: passage.g,
        lapse: passage.l,
        points: 1,
        timeModel: { mu: passage.mu, speedLoading: passage.speedLoading, skillLoading, sigma: 0.22 },
      });
    }
  }
  return items;
}

export const IELTS_ACADEMIC_V1_BLUEPRINT: ExamBlueprintV1 = {
  schemaVersion: 1,
  blueprintId: "ielts-academic-v1",
  title: "IELTS Academic (4-Section Timed Blueprint)",
  clockMode: "section_independent",
  totalTimeLimitMinutes: null,
  aggregationMode: "ielts_overall_half_up",
  scoreRange: [0, 9],
  scoreStep: 0.5,
  skillIds: IELTS_ACADEMIC_SKILL_IDS,
  thetaCovariance: IELTS_THETA_COVARIANCE,
  sections: [
    {
      sectionId: "listening",
      label: "Listening",
      scoringKind: "item_raw_table",
      timeLimitMinutes: 30,
      weight: 0.25,
      scoreRange: [0, 9],
      scoreStep: 0.5,
      parts: [
        { partId: "listening-part-1", label: "Part 1", weight: 0.25, targetItemCount: 10, skillIds: ["ielts.listening.detail", "ielts.listening.distractor"] },
        { partId: "listening-part-2", label: "Part 2", weight: 0.25, targetItemCount: 10, skillIds: ["ielts.listening.detail", "ielts.listening.distractor"] },
        { partId: "listening-part-3", label: "Part 3", weight: 0.25, targetItemCount: 10, skillIds: ["ielts.listening.distractor", "ielts.listening.academic_monologue"] },
        { partId: "listening-part-4", label: "Part 4", weight: 0.25, targetItemCount: 10, skillIds: ["ielts.listening.academic_monologue"] },
      ],
      items: buildListeningItems(),
      rawToBandTable: IELTS_LISTENING_RAW_TO_BAND,
    },
    {
      sectionId: "reading",
      label: "Academic Reading",
      scoringKind: "item_raw_table",
      timeLimitMinutes: 60,
      weight: 0.25,
      scoreRange: [0, 9],
      scoreStep: 0.5,
      parts: [
        { partId: "reading-passage-1", label: "Passage 1", weight: 13 / 40, targetItemCount: 13, skillIds: ["ielts.reading.tfng", "ielts.reading.pacing"] },
        { partId: "reading-passage-2", label: "Passage 2", weight: 13 / 40, targetItemCount: 13, skillIds: ["ielts.reading.heading", "ielts.reading.pacing"] },
        { partId: "reading-passage-3", label: "Passage 3", weight: 14 / 40, targetItemCount: 14, skillIds: ["ielts.reading.inference", "ielts.reading.pacing"] },
      ],
      items: buildReadingItems(),
      rawToBandTable: IELTS_ACADEMIC_READING_RAW_TO_BAND,
    },
    {
      sectionId: "writing",
      label: "Academic Writing",
      scoringKind: "rubric_band",
      timeLimitMinutes: 60,
      weight: 0.25,
      scoreRange: [0, 9],
      scoreStep: 0.5,
      parts: [
        {
          partId: "writing-task-1",
          label: "Task 1 (1/3)",
          weight: 1 / 3,
          skillIds: ["ielts.writing.task1_overview", "ielts.writing.cohesion_lexis"],
          timeModel: { mu: Math.log(1150), speedLoading: 0.2, skillLoading: { "ielts.writing.task1_overview": 0.2 }, sigma: 0.15 },
        },
        {
          partId: "writing-task-2",
          label: "Task 2 (2/3)",
          weight: 2 / 3,
          skillIds: ["ielts.writing.task2_argument", "ielts.writing.cohesion_lexis"],
          timeModel: { mu: Math.log(2350), speedLoading: 0.25, skillLoading: { "ielts.writing.task2_argument": 0.25 }, sigma: 0.16 },
        },
      ],
    },
    {
      sectionId: "speaking",
      label: "Speaking",
      scoringKind: "rubric_band",
      timeLimitMinutes: 14,
      timeWindowMinutes: [11, 14],
      weight: 0.25,
      scoreRange: [0, 9],
      scoreStep: 0.5,
      parts: [
        {
          partId: "speaking-part-1",
          label: "Part 1",
          weight: 0.25,
          skillIds: ["ielts.speaking.fluency_structure"],
          timeModel: { mu: Math.log(255), speedLoading: 0.15, skillLoading: { "ielts.speaking.fluency_structure": 0.12 }, sigma: 0.08 },
        },
        {
          partId: "speaking-part-2",
          label: "Part 2",
          weight: 0.35,
          skillIds: ["ielts.speaking.fluency_structure"],
          timeModel: { mu: Math.log(210), speedLoading: 0.15, skillLoading: { "ielts.speaking.fluency_structure": 0.12 }, sigma: 0.08 },
        },
        {
          partId: "speaking-part-3",
          label: "Part 3",
          weight: 0.4,
          skillIds: ["ielts.speaking.fluency_structure", "ielts.speaking.abstract_extension"],
          timeModel: {
            mu: Math.log(255),
            speedLoading: 0.18,
            skillLoading: { "ielts.speaking.fluency_structure": 0.1, "ielts.speaking.abstract_extension": 0.12 },
            sigma: 0.08,
          },
        },
      ],
    },
  ],
};

export function defineRecordEntry<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function hasCompleteRawTable(section: ExamSectionBlueprint): boolean {
  const table = section.rawToBandTable;
  const items = section.items;
  if (!table || table.length === 0 || !items || items.length === 0) return false;
  if (items.length > MAX_SECTION_ITEMS) return false;
  if (!isValidScoreRange(section.scoreRange)) return false;
  const [minScore, maxScore] = section.scoreRange;
  let maxRaw = 0;
  for (const item of items) {
    const pts = item.points ?? 1;
    if (!Number.isSafeInteger(pts) || pts < 1 || pts > MAX_ITEM_POINTS) return false;
    maxRaw += pts;
    if (!Number.isSafeInteger(maxRaw) || maxRaw > MAX_SECTION_TOTAL_POINTS) return false;
  }
  const normalizedRows: Array<{ readonly rawMin: number; readonly rawMax: number; readonly score: number }> = [];
  for (const row of table) {
    if (!Number.isSafeInteger(row.rawMin) || !Number.isSafeInteger(row.rawMax) || row.rawMin > row.rawMax) {
      return false;
    }
    if (!Number.isFinite(row.score) || row.score < minScore || row.score > maxScore) return false;
    normalizedRows.push({ rawMin: row.rawMin, rawMax: row.rawMax, score: row.score });
  }
  normalizedRows.sort((a, b) => a.rawMin - b.rawMin || a.rawMax - b.rawMax);
  if (normalizedRows[0]!.rawMin !== 0) return false;
  for (let i = 1; i < normalizedRows.length; i++) {
    if (normalizedRows[i]!.rawMin !== normalizedRows[i - 1]!.rawMax + 1) return false;
    if (normalizedRows[i]!.score < normalizedRows[i - 1]!.score) return false;
  }
  return normalizedRows[normalizedRows.length - 1]!.rawMax === maxRaw;
}

function overflowSafeMidpoint(a: number, b: number): number {
  return Math.sign(a) === Math.sign(b) ? a + 0.5 * (b - a) : 0.5 * a + 0.5 * b;
}

/** Cholesky factor L such that L * L^T ≈ matrix. Rejects asymmetric or non-PSD matrices. */
export function choleskyDecompose(matrix: readonly (readonly number[])[]): number[][] {
  const n = matrix.length;
  for (let i = 0; i < n; i++) {
    const row = matrix[i];
    if (!row || row.length !== n) throw new RangeError("thetaCovariance must be square");
    for (let j = 0; j < n; j++) {
      const entry = row[j];
      if (entry === undefined || !Number.isFinite(entry)) {
        throw new RangeError("thetaCovariance must be finite and symmetric");
      }
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      const a = matrix[i]![j]!;
      const b = matrix[j]![i]!;
      const symTol =
        (1e-10 * Math.sqrt(Math.max(0, matrix[i]![i]!))) * Math.sqrt(Math.max(0, matrix[j]![j]!));
      if (!Number.isFinite(symTol) || Math.abs(a - b) > symTol) {
        throw new RangeError("thetaCovariance must be finite and symmetric");
      }
    }
  }
  const lower: number[][] = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    const diagEntry = matrix[i]![i]!;
    for (let j = 0; j <= i; j++) {
      const symEntry = i === j ? diagEntry : overflowSafeMidpoint(matrix[i]![j]!, matrix[j]![i]!);
      let sum = symEntry;
      for (let k = 0; k < j; k++) sum -= lower[i]![k]! * lower[j]![k]!;
      if (i === j) {
        const localPivotTol = 1e-12 * Math.max(0, diagEntry);
        if (sum > 0) {
          lower[i]![j] = Math.sqrt(sum);
        } else if (sum >= -localPivotTol) {
          lower[i]![j] = 0;
        } else {
          throw new RangeError("thetaCovariance must be positive semidefinite");
        }
      } else {
        const diag = lower[j]![j]!;
        if (diag === 0) {
          const localOffDiagTol =
            (1e-10 * Math.sqrt(Math.max(0, diagEntry))) * Math.sqrt(Math.max(0, matrix[j]![j]!));
          if (!Number.isFinite(localOffDiagTol) || Math.abs(sum) > localOffDiagTol) {
            throw new RangeError("thetaCovariance must be positive semidefinite");
          }
          lower[i]![j] = 0;
        } else {
          lower[i]![j] = sum / diag;
        }
      }
    }
  }
  return lower;
}

function isSymmetricPsdMatrix(matrix: readonly (readonly number[])[]): boolean {
  try {
    choleskyDecompose(matrix);
    return true;
  } catch {
    return false;
  }
}

function isValidScoreRange(range: readonly [number, number]): boolean {
  return range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] < range[1];
}

function isValidTimeModel(tm: ExamTimeModel): boolean {
  if (!Number.isFinite(tm.mu) || !Number.isFinite(tm.sigma) || tm.sigma <= 0) return false;
  if ((tm.speedLoading as number | undefined) !== undefined && !Number.isFinite(tm.speedLoading)) return false;
  for (const loading of Object.values(tm.skillLoading)) {
    if (!Number.isFinite(loading)) return false;
  }
  return true;
}

function isAlignedScoreGrid(range: readonly [number, number], step: number): boolean {
  return resolveAlignedScoreGridSteps(range[0], range[1], step) !== null;
}

const CANONICAL_IELTS_SECTIONS = [
  { sectionId: "listening", scoringKind: "item_raw_table" },
  { sectionId: "reading", scoringKind: "item_raw_table" },
  { sectionId: "writing", scoringKind: "rubric_band" },
  { sectionId: "speaking", scoringKind: "rubric_band" },
] as const;

export function validateExamBlueprint(blueprint: ExamBlueprintV1): string[] {
  const missing: string[] = [];
  if (blueprint.schemaVersion !== 1 || !blueprint.blueprintId.trim()) missing.push("blueprintId");
  const bpRangeValid = isValidScoreRange(blueprint.scoreRange);
  if (!bpRangeValid) missing.push("scoreRange");
  const bpStepValid = Number.isFinite(blueprint.scoreStep) && blueprint.scoreStep > 0;
  if (!bpStepValid || (bpRangeValid && !isAlignedScoreGrid(blueprint.scoreRange, blueprint.scoreStep))) {
    missing.push("scoreStep");
  }
  if (blueprint.skillIds.length === 0) missing.push("skillIds");
  if (blueprint.sections.length === 0) missing.push("sections");
  if (blueprint.clockMode === "shared_full_paper") {
    if (blueprint.totalTimeLimitMinutes == null || !Number.isFinite(blueprint.totalTimeLimitMinutes) || blueprint.totalTimeLimitMinutes <= 0) {
      missing.push("totalTimeLimitMinutes");
    }
  }
  const nSkills = blueprint.skillIds.length;
  if (
    blueprint.thetaCovariance.length !== nSkills ||
    blueprint.thetaCovariance.some((row) => row.length !== nSkills) ||
    !isSymmetricPsdMatrix(blueprint.thetaCovariance)
  ) {
    missing.push("thetaCovariance");
  }
  const isCanonicalIelts =
    blueprint.aggregationMode === "ielts_overall_half_up" ||
    blueprint.blueprintId === "ielts-academic-v1" ||
    blueprint.blueprintId === "ielts_academic_v1";
  if (isCanonicalIelts) {
    if (blueprint.aggregationMode !== "ielts_overall_half_up") missing.push("aggregationMode");
    if (blueprint.scoreRange[0] !== 0 || blueprint.scoreRange[1] !== 9) missing.push("scoreRange");
    if (blueprint.scoreStep !== 0.5) missing.push("scoreStep");
    const byId = new Map<string, ExamSectionBlueprint>();
    for (const sec of blueprint.sections) {
      if (byId.has(sec.sectionId)) {
        missing.push(`sections.${sec.sectionId}.duplicate`);
      } else {
        byId.set(sec.sectionId, sec);
      }
    }
    if (blueprint.sections.length !== CANONICAL_IELTS_SECTIONS.length) {
      missing.push("sections.ieltsCanonicalCount");
    }
    for (const expected of CANONICAL_IELTS_SECTIONS) {
      const found = byId.get(expected.sectionId);
      if (!found) {
        missing.push(`sections.${expected.sectionId}`);
        continue;
      }
      if (found.scoringKind !== expected.scoringKind) {
        missing.push(`sections.${expected.sectionId}.scoringKind`);
      }
      if (found.scoreRange[0] !== 0 || found.scoreRange[1] !== 9) {
        missing.push(`sections.${expected.sectionId}.scoreRange`);
      }
      if (found.scoreStep !== 0.5) {
        missing.push(`sections.${expected.sectionId}.scoreStep`);
      }
    }
  }
  const seenSectionIds = new Set<string>();
  const skillSet = new Set(blueprint.skillIds);
  let totalBlueprintItems = 0;
  for (const section of blueprint.sections) {
    if (seenSectionIds.has(section.sectionId)) {
      missing.push(`sections.${section.sectionId}.duplicate`);
    }
    seenSectionIds.add(section.sectionId);
    if (blueprint.clockMode === "section_independent") {
      if (section.timeLimitMinutes == null || !Number.isFinite(section.timeLimitMinutes) || section.timeLimitMinutes <= 0) {
        missing.push(`sections.${section.sectionId}.timeLimitMinutes`);
      }
    }
    const secRangeValid = isValidScoreRange(section.scoreRange);
    if (!secRangeValid) missing.push(`sections.${section.sectionId}.scoreRange`);
    if (
      !Number.isFinite(section.scoreStep) ||
      section.scoreStep <= 0 ||
      (secRangeValid && !isAlignedScoreGrid(section.scoreRange, section.scoreStep))
    ) {
      missing.push(`sections.${section.sectionId}.scoreStep`);
    }
    if (!Number.isFinite(section.weight) || section.weight < 0) missing.push(`sections.${section.sectionId}.weight`);
    if (section.parts.length === 0) missing.push(`sections.${section.sectionId}.parts`);
    if (section.scoringKind === "item_raw_table") {
      if (!section.items || section.items.length === 0) {
        missing.push(`sections.${section.sectionId}.items`);
      } else {
        if (section.items.length > MAX_SECTION_ITEMS) {
          missing.push(`sections.${section.sectionId}.items.count`);
        }
        totalBlueprintItems += section.items.length;
        if (totalBlueprintItems > MAX_BLUEPRINT_ITEMS) {
          missing.push(`sections.${section.sectionId}.items.totalCount`);
        }
        let totalRawPoints = 0;
        for (const item of section.items) {
          if (item.skillIds.length === 0 || item.skillIds.some((id) => !skillSet.has(id))) {
            missing.push(`sections.${section.sectionId}.items.${item.itemId}.qMatrix`);
            break;
          }
          if (!(item.guess >= 0 && item.guess < 1 && item.lapse >= 0 && item.guess + item.lapse < 1)) {
            missing.push(`sections.${section.sectionId}.items.${item.itemId}.guessLapse`);
            break;
          }
          const pts = item.points ?? 1;
          if (!Number.isSafeInteger(pts) || pts < 1 || pts > MAX_ITEM_POINTS) {
            missing.push(`sections.${section.sectionId}.items.${item.itemId}.points`);
            break;
          }
          totalRawPoints += pts;
          if (!Number.isSafeInteger(totalRawPoints) || totalRawPoints > MAX_SECTION_TOTAL_POINTS) {
            missing.push(`sections.${section.sectionId}.items.totalPoints`);
            break;
          }
          if (!isValidTimeModel(item.timeModel)) {
            missing.push(`sections.${section.sectionId}.items.${item.itemId}.timeModel`);
            break;
          }
        }
      }
      if (!hasCompleteRawTable(section)) {
        missing.push(`sections.${section.sectionId}.rawToBandTable`);
      }
    } else {
      for (const part of section.parts) {
        if (!Number.isFinite(part.weight) || part.weight <= 0) {
          missing.push(`sections.${section.sectionId}.parts.${part.partId}.weight`);
          break;
        }
        if (part.skillIds.length === 0 || part.skillIds.some((id) => !skillSet.has(id))) {
          missing.push(`sections.${section.sectionId}.parts.${part.partId}.skillIds`);
          break;
        }
        if (blueprint.clockMode === "shared_full_paper" && part.timeModel === undefined) {
          missing.push(`sections.${section.sectionId}.parts.${part.partId}.timeModel`);
          break;
        }
        if (part.timeModel !== undefined && !isValidTimeModel(part.timeModel)) {
          missing.push(`sections.${section.sectionId}.parts.${part.partId}.timeModel`);
          break;
        }
      }
    }
  }
  return [...new Set(missing)];
}

/** Factory for shared full-paper 180-min / 150-pt blueprints (e.g. Math or CS 408). */
export function createSharedFullPaperBlueprint(input: {
  readonly blueprintId: string;
  readonly title: string;
  readonly totalTimeLimitMinutes: number;
  readonly totalPoints: number;
  readonly skillIds: readonly string[];
  readonly sections: readonly ExamSectionBlueprint[];
  readonly thetaCovariance?: readonly (readonly number[])[];
}): ExamBlueprintV1 {
  const n = input.skillIds.length;
  const cov =
    input.thetaCovariance ??
    Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 1 : 0.3)));
  return {
    schemaVersion: 1,
    blueprintId: input.blueprintId,
    title: input.title,
    clockMode: "shared_full_paper",
    totalTimeLimitMinutes: input.totalTimeLimitMinutes,
    aggregationMode: "weighted_sum",
    scoreRange: [0, input.totalPoints],
    scoreStep: 1,
    skillIds: input.skillIds,
    thetaCovariance: cov,
    sections: input.sections,
  };
}
