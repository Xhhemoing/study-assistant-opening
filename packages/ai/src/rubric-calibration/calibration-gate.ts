import type { AnchorCalibratedRubricV1Result } from "./anchor-calibrated-rubric";
import { snapHalfBand } from "./anchor-calibrated-rubric";

/**
 * Four-Fold + 3-Way Anti-Padding Calibration Gate for AnchorCalibratedRubricV1.
 * Rejects mean-compressed scorers even when QWK and overall SMD appear healthy.
 */

export type RubricCalibrationPoint = Pick<
  AnchorCalibratedRubricV1Result,
  "status" | "band" | "rawBand" | "countsTowardMastery"
> & {
  readonly submissionId?: string;
};

export interface GoldRubricBenchmarkItem {
  readonly itemId: string;
  readonly trueBand: number;
  readonly evaluation: RubricCalibrationPoint;
}

export interface EvaluatedCounterfactualTriplet {
  readonly tripletId: string;
  readonly substantiveConcise: RubricCalibrationPoint;
  readonly templatePaddedExpansion: RubricCalibrationPoint;
  readonly equalLengthSubstantive: RubricCalibrationPoint;
}

export interface RubricCalibrationGateThresholds {
  readonly minQwk?: number;
  readonly maxAbsSmd?: number;
  readonly maxAbsBiasLow?: number;
  readonly maxAbsBiasHigh?: number;
  readonly minSdRatio?: number;
  readonly minAdmissibleCoverage?: number;
  readonly lowTailMaxBand?: number;
  readonly highTailMinBand?: number;
  readonly maxPaddingGain?: number;
}

export type RubricCalibrationGateFailure =
  | "invalid_threshold_configuration"
  | "empty_benchmark"
  | "duplicate_or_invalid_benchmark_item_id"
  | "benchmark_cohort_mismatch"
  | "admissible_coverage_below_threshold"
  | "missing_low_tail_samples"
  | "missing_high_tail_samples"
  | "qwk_below_threshold"
  | "smd_exceeds_threshold"
  | "low_tail_bias_exceeds_threshold"
  | "high_tail_bias_exceeds_threshold"
  | "sd_ratio_compression_detected"
  | "missing_counterfactual_triplets"
  | "duplicate_or_invalid_triplet_id"
  | "triplet_cohort_mismatch"
  | "counterfactual_missing_point_score"
  | "counterfactual_padding_gain_exceeds_limit"
  | "counterfactual_padded_not_below_equal_length_substantive"
  | "counterfactual_padded_counts_toward_mastery";

export interface CounterfactualTripletAudit {
  readonly tripletId: string;
  readonly passed: boolean;
  readonly conciseScore: number | null;
  readonly paddedScore: number | null;
  readonly equalLengthScore: number | null;
  readonly paddingGain: number | null;
  readonly failures: readonly RubricCalibrationGateFailure[];
}

export interface RubricCalibrationGateReport {
  readonly passed: boolean;
  readonly metrics: {
    readonly totalCount: number;
    readonly admissibleCount: number;
    readonly admissibleCoverage: number;
    readonly lowTailCount: number;
    readonly highTailCount: number;
    readonly qwk: number | null;
    readonly smd: number | null;
    readonly biasLow: number | null;
    readonly biasHigh: number | null;
    readonly sdTrue: number | null;
    readonly sdPred: number | null;
    readonly sdRatio: number | null;
  };
  readonly counterfactualAudits: readonly CounterfactualTripletAudit[];
  readonly failures: readonly RubricCalibrationGateFailure[];
}

export const DEFAULT_CALIBRATION_THRESHOLDS = {
  minQwk: 0.70,
  maxAbsSmd: 0.15,
  maxAbsBiasLow: 0.25,
  maxAbsBiasHigh: 0.25,
  minSdRatio: 0.75,
  minAdmissibleCoverage: 0.85,
  lowTailMaxBand: 5.0,
  highTailMinBand: 7.5,
  maxPaddingGain: 0.25,
} as const;

const HALF_BAND_LEVELS = 19; // [0.0, 0.5, ..., 9.0]
const MAX_LEVEL_INDEX = HALF_BAND_LEVELS - 1;
const FLOAT_EPSILON = 1e-9;

function bandToHalfBandIndex(band: number): number {
  const snapped = snapHalfBand(band);
  return Math.min(MAX_LEVEL_INDEX, Math.max(0, Math.round(snapped * 2)));
}

/** Exact discrete 19x19 Quadratic Weighted Kappa over IELTS [0, 9] half-band grid. */
export function computeQuadraticWeightedKappa(
  trueBands: readonly number[],
  predBands: readonly number[],
): number {
  const n = trueBands.length;
  if (n === 0 || n !== predBands.length) return Number.NaN;

  const observed: number[][] = Array.from({ length: HALF_BAND_LEVELS }, () =>
    new Array<number>(HALF_BAND_LEVELS).fill(0),
  );
  const trueHist = new Array<number>(HALF_BAND_LEVELS).fill(0);
  const predHist = new Array<number>(HALF_BAND_LEVELS).fill(0);

  for (let k = 0; k < n; k++) {
    const tVal = trueBands[k];
    const pVal = predBands[k];
    if (tVal === undefined || pVal === undefined) continue;
    const ti = bandToHalfBandIndex(tVal);
    const pi = bandToHalfBandIndex(pVal);
    const row = observed[ti];
    if (row) row[pi] = (row[pi] ?? 0) + 1;
    trueHist[ti] = (trueHist[ti] ?? 0) + 1;
    predHist[pi] = (predHist[pi] ?? 0) + 1;
  }

  let observedWeighted = 0;
  let expectedWeighted = 0;
  for (let i = 0; i < HALF_BAND_LEVELS; i++) {
    const row = observed[i];
    const hi = trueHist[i] ?? 0;
    for (let j = 0; j < HALF_BAND_LEVELS; j++) {
      const weight = ((i - j) / MAX_LEVEL_INDEX) ** 2;
      const oij = (row?.[j] ?? 0) / n;
      const eij = (hi / n) * ((predHist[j] ?? 0) / n);
      observedWeighted += weight * oij;
      expectedWeighted += weight * eij;
    }
  }

  if (expectedWeighted === 0) {
    return observedWeighted === 0 ? 1 : 0;
  }
  return 1 - observedWeighted / expectedWeighted;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  const sumSq = values.reduce((sum, v) => sum + (v - mu) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

const GATE_REGEXP_SOURCE_GET = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
const GATE_ARRAY_BUFFER_LEN_GET = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const GATE_DATA_VIEW_LEN_GET = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get;
const GATE_ERROR_IS_ERROR = (Error as { isError?: (v: unknown) => boolean }).isError;
const GATE_WEAK_KEY = Object.freeze({});

function matchesGateBrand(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

function hasGateExoticSlot(obj: object): boolean {
  try {
    if (ArrayBuffer.isView(obj)) return true;
    if (typeof GATE_ERROR_IS_ERROR === "function" && GATE_ERROR_IS_ERROR(obj)) return true;
    if (matchesGateBrand(() => Reflect.apply(Map.prototype.has, obj, [undefined]))) return true;
    if (matchesGateBrand(() => Reflect.apply(Set.prototype.has, obj, [undefined]))) return true;
    if (matchesGateBrand(() => Reflect.apply(WeakMap.prototype.has, obj, [GATE_WEAK_KEY]))) return true;
    if (matchesGateBrand(() => Reflect.apply(WeakSet.prototype.has, obj, [GATE_WEAK_KEY]))) return true;
    if (matchesGateBrand(() => Reflect.apply(Date.prototype.getTime, obj, []))) return true;
    if (GATE_REGEXP_SOURCE_GET && obj !== RegExp.prototype && matchesGateBrand(() => Reflect.apply(GATE_REGEXP_SOURCE_GET, obj, []))) return true;
    if (GATE_ARRAY_BUFFER_LEN_GET && matchesGateBrand(() => Reflect.apply(GATE_ARRAY_BUFFER_LEN_GET, obj, []))) return true;
    if (GATE_DATA_VIEW_LEN_GET && matchesGateBrand(() => Reflect.apply(GATE_DATA_VIEW_LEN_GET, obj, []))) return true;
    if (matchesGateBrand(() => Reflect.apply(Number.prototype.valueOf, obj, []))) return true;
    if (matchesGateBrand(() => Reflect.apply(String.prototype.valueOf, obj, []))) return true;
    if (matchesGateBrand(() => Reflect.apply(Boolean.prototype.valueOf, obj, []))) return true;
    return false;
  } catch {
    return true;
  }
}

function snapshotPlainGateDataInner(
  value: unknown,
  memo: Map<object, unknown>,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (value === null || value === undefined) return { ok: true, value };
  const kind = typeof value;
  if (kind === "boolean" || kind === "number" || kind === "string" || kind === "bigint") {
    return { ok: true, value };
  }
  if (kind !== "object") return { ok: false };
  const obj = value as object;
  if (memo.has(obj)) return { ok: true, value: memo.get(obj) };
  try {
    const proto = Object.getPrototypeOf(obj) as object | null;
    if (Array.isArray(obj)) {
      if (proto !== Array.prototype) return { ok: false };
      const lenDesc = Object.getOwnPropertyDescriptor(obj, "length");
      if (!lenDesc || !Object.hasOwn(lenDesc, "value") || typeof lenDesc.value !== "number" || !Number.isInteger(lenDesc.value) || lenDesc.value < 0) {
        return { ok: false };
      }
      const len = lenDesc.value;
      if (Reflect.ownKeys(obj).length !== len + 1) return { ok: false };
      if (hasGateExoticSlot(obj)) return { ok: false };
      const out: unknown[] = new Array(len);
      memo.set(obj, out);
      for (let i = 0; i < len; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(obj, String(i));
        if (!desc || !desc.enumerable || !Object.hasOwn(desc, "value") || desc.get !== undefined || desc.set !== undefined) {
          return { ok: false };
        }
        const child = snapshotPlainGateDataInner(desc.value, memo);
        if (!child.ok) return { ok: false };
        out[i] = child.value;
      }
      return { ok: true, value: Object.freeze(out) };
    }
    if (proto !== Object.prototype && proto !== null) return { ok: false };
    const keys = Reflect.ownKeys(obj);
    const entries: Array<{ readonly key: string; readonly value: unknown }> = [];
    for (const key of keys) {
      if (typeof key !== "string" || key === "__proto__") return { ok: false };
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc || !desc.enumerable || !Object.hasOwn(desc, "value") || desc.get !== undefined || desc.set !== undefined) {
        return { ok: false };
      }
      entries.push({ key, value: desc.value });
    }
    if (hasGateExoticSlot(obj)) return { ok: false };
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    memo.set(obj, out);
    for (const entry of entries) {
      const child = snapshotPlainGateDataInner(entry.value, memo);
      if (!child.ok) return { ok: false };
      Object.defineProperty(out, entry.key, {
        value: child.value,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    return { ok: true, value: Object.freeze(out) };
  } catch {
    return { ok: false };
  }
}

function snapshotPlainGateData(value: unknown): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const res = snapshotPlainGateDataInner(value, new Map());
  if (!res.ok) return { ok: false };
  if (value !== null && typeof value === "object") {
    try {
      structuredClone(value);
    } catch {
      return { ok: false };
    }
  }
  return res;
}

function snapshotShallowGateRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  try {
    if (Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(value);
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string" || key === "__proto__") return null;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !desc.enumerable || !Object.hasOwn(desc, "value") || desc.get !== undefined || desc.set !== undefined) {
        return null;
      }
      Object.defineProperty(out, key, {
        value: desc.value,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    if (hasGateExoticSlot(value)) return null;
    return Object.freeze(out);
  } catch {
    return null;
  }
}

function readOwnDataField(obj: unknown, key: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (obj === null || typeof obj !== "object" || key === "__proto__") return { ok: false };
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || !Object.hasOwn(desc, "value") || desc.get !== undefined || desc.set !== undefined) {
      return { ok: false };
    }
    return { ok: true, value: desc.value };
  } catch {
    return { ok: false };
  }
}

function isPlainRecordObject(value: unknown): value is Record<string, unknown> {
  return snapshotShallowGateRecord(value) !== null;
}

function snapshotDensePlainArray(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const lenDesc = Object.getOwnPropertyDescriptor(value, "length");
    if (!lenDesc || !Object.hasOwn(lenDesc, "value") || typeof lenDesc.value !== "number" || !Number.isInteger(lenDesc.value) || lenDesc.value < 0) return null;
    const len = lenDesc.value;
    if (Reflect.ownKeys(value).length !== len + 1) return null;
    if (hasGateExoticSlot(value)) return null;
    const out: unknown[] = new Array(len);
    for (let i = 0; i < len; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(value, String(i));
      if (
        !desc ||
        !desc.enumerable ||
        !Object.hasOwn(desc, "value") ||
        desc.get !== undefined ||
        desc.set !== undefined
      ) {
        return null;
      }
      out[i] = desc.value;
    }
    return out;
  } catch {
    return null;
  }
}

function parseUniqueNonBlankIdSet(rawIds: unknown): ReadonlySet<string> | null {
  const cloned = snapshotPlainGateData(rawIds);
  if (!cloned.ok || !Array.isArray(cloned.value) || cloned.value.length === 0) return null;
  const set = new Set<string>();
  for (const entry of cloned.value) {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || set.has(trimmed)) return null;
    set.add(trimmed);
  }
  return set;
}

function extractPointScore(point: unknown): number | null {
  if (!isPlainRecordObject(point)) return null;
  const statusField = readOwnDataField(point, "status");
  if (!statusField.ok || statusField.value !== "calibrated") return null;
  const bandField = readOwnDataField(point, "band");
  const rawBandField = readOwnDataField(point, "rawBand");
  const bandVal = bandField.ok ? bandField.value : null;
  const rawBandVal = rawBandField.ok ? rawBandField.value : null;
  const score = bandVal ?? rawBandVal;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 9) return null;
  return score;
}

function extractCounterfactualScore(point: unknown): number | null {
  if (!isPlainRecordObject(point)) return null;
  const statusField = readOwnDataField(point, "status");
  if (!statusField.ok || statusField.value !== "calibrated") return null;
  const rawBandField = readOwnDataField(point, "rawBand");
  const bandField = readOwnDataField(point, "band");
  const rawBandVal = rawBandField.ok ? rawBandField.value : null;
  const bandVal = bandField.ok ? bandField.value : null;
  const score = rawBandVal ?? bandVal;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 9) return null;
  return score;
}

interface ResolvedCalibrationThresholds {
  readonly minQwk: number;
  readonly maxAbsSmd: number;
  readonly maxAbsBiasLow: number;
  readonly maxAbsBiasHigh: number;
  readonly minSdRatio: number;
  readonly minAdmissibleCoverage: number;
  readonly lowTailMaxBand: number;
  readonly highTailMinBand: number;
  readonly customLowTailMaxBand: number | null;
  readonly customHighTailMinBand: number | null;
  readonly maxPaddingGain: number;
}

function resolveTighteningThresholds(
  rawOverrides: unknown,
): { readonly thresholds: ResolvedCalibrationThresholds; readonly valid: boolean } {
  if (rawOverrides === undefined) {
    return {
      thresholds: {
        ...DEFAULT_CALIBRATION_THRESHOLDS,
        customLowTailMaxBand: null,
        customHighTailMinBand: null,
      },
      valid: true,
    };
  }

  const clonedOverrides = snapshotPlainGateData(rawOverrides);
  if (!clonedOverrides.ok || clonedOverrides.value === null || typeof clonedOverrides.value !== "object" || Array.isArray(clonedOverrides.value)) {
    return {
      thresholds: {
        ...DEFAULT_CALIBRATION_THRESHOLDS,
        customLowTailMaxBand: null,
        customHighTailMinBand: null,
      },
      valid: false,
    };
  }
  const overrides = clonedOverrides.value as Record<string, unknown>;

  let valid = true;
  const checkFinite = (
    value: unknown,
    fallback: number,
    minAllowed: number,
    maxAllowed: number,
  ): number => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < minAllowed || value > maxAllowed) {
      valid = false;
      return fallback;
    }
    return value;
  };

  const minQwk = Math.max(
    DEFAULT_CALIBRATION_THRESHOLDS.minQwk,
    checkFinite(overrides["minQwk"], DEFAULT_CALIBRATION_THRESHOLDS.minQwk, -1, 1),
  );
  const maxAbsSmd = Math.min(
    DEFAULT_CALIBRATION_THRESHOLDS.maxAbsSmd,
    checkFinite(overrides["maxAbsSmd"], DEFAULT_CALIBRATION_THRESHOLDS.maxAbsSmd, 0, Number.MAX_SAFE_INTEGER),
  );
  const maxAbsBiasLow = Math.min(
    DEFAULT_CALIBRATION_THRESHOLDS.maxAbsBiasLow,
    checkFinite(overrides["maxAbsBiasLow"], DEFAULT_CALIBRATION_THRESHOLDS.maxAbsBiasLow, 0, 9),
  );
  const maxAbsBiasHigh = Math.min(
    DEFAULT_CALIBRATION_THRESHOLDS.maxAbsBiasHigh,
    checkFinite(overrides["maxAbsBiasHigh"], DEFAULT_CALIBRATION_THRESHOLDS.maxAbsBiasHigh, 0, 9),
  );
  const minSdRatio = Math.max(
    DEFAULT_CALIBRATION_THRESHOLDS.minSdRatio,
    checkFinite(overrides["minSdRatio"], DEFAULT_CALIBRATION_THRESHOLDS.minSdRatio, 0, Number.MAX_SAFE_INTEGER),
  );
  const minAdmissibleCoverage = Math.max(
    DEFAULT_CALIBRATION_THRESHOLDS.minAdmissibleCoverage,
    checkFinite(overrides["minAdmissibleCoverage"], DEFAULT_CALIBRATION_THRESHOLDS.minAdmissibleCoverage, 0, 1),
  );

  const rawCustomLow = overrides["lowTailMaxBand"];
  const rawCustomHigh = overrides["highTailMinBand"];
  // Default tail cutoffs are always mandatory; custom cutoffs are validated and enforced additionally.
  const customLowTailMaxBand =
    rawCustomLow === undefined
      ? null
      : checkFinite(rawCustomLow, DEFAULT_CALIBRATION_THRESHOLDS.lowTailMaxBand, 0, 9);
  const customHighTailMinBand =
    rawCustomHigh === undefined
      ? null
      : checkFinite(rawCustomHigh, DEFAULT_CALIBRATION_THRESHOLDS.highTailMinBand, 0, 9);
  const maxPaddingGain = Math.min(
    DEFAULT_CALIBRATION_THRESHOLDS.maxPaddingGain,
    checkFinite(overrides["maxPaddingGain"], DEFAULT_CALIBRATION_THRESHOLDS.maxPaddingGain, 0, 9),
  );

  const effectiveCustomLow = customLowTailMaxBand ?? DEFAULT_CALIBRATION_THRESHOLDS.lowTailMaxBand;
  const effectiveCustomHigh = customHighTailMinBand ?? DEFAULT_CALIBRATION_THRESHOLDS.highTailMinBand;
  if (effectiveCustomLow >= effectiveCustomHigh) {
    valid = false;
  }

  return {
    valid,
    thresholds: {
      minQwk,
      maxAbsSmd,
      maxAbsBiasLow,
      maxAbsBiasHigh,
      minSdRatio,
      minAdmissibleCoverage,
      lowTailMaxBand: DEFAULT_CALIBRATION_THRESHOLDS.lowTailMaxBand,
      highTailMinBand: DEFAULT_CALIBRATION_THRESHOLDS.highTailMinBand,
      customLowTailMaxBand,
      customHighTailMinBand,
      maxPaddingGain,
    },
  };
}

export function evaluateRubricCalibrationGate(input: {
  readonly benchmarkItems: readonly GoldRubricBenchmarkItem[];
  readonly counterfactualTriplets: readonly EvaluatedCounterfactualTriplet[];
  readonly thresholds?: RubricCalibrationGateThresholds;
  readonly expectedBenchmarkItemIds?: readonly string[];
  readonly expectedTripletIds?: readonly string[];
}): RubricCalibrationGateReport {
  const failures = new Set<RubricCalibrationGateFailure>();
  const clonedInput = snapshotPlainGateData(input);
  const inputSnap =
    clonedInput.ok && clonedInput.value !== null && typeof clonedInput.value === "object" && !Array.isArray(clonedInput.value)
      ? (clonedInput.value as Record<string, unknown>)
      : null;
  if (!inputSnap) {
    failures.add("invalid_threshold_configuration");
    failures.add("empty_benchmark");
    failures.add("duplicate_or_invalid_benchmark_item_id");
    failures.add("missing_counterfactual_triplets");
    return {
      passed: false,
      metrics: {
        totalCount: 0,
        admissibleCount: 0,
        admissibleCoverage: 0,
        lowTailCount: 0,
        highTailCount: 0,
        qwk: null,
        smd: null,
        biasLow: null,
        biasHigh: null,
        sdTrue: null,
        sdPred: null,
        sdRatio: null,
      },
      counterfactualAudits: [],
      failures: [...failures],
    };
  }

  const rawThresholds = inputSnap["thresholds"];
  const rawBenchmarkItems = inputSnap["benchmarkItems"];
  const rawCounterfactualTriplets = inputSnap["counterfactualTriplets"];
  const rawExpectedBenchmarkIds = inputSnap["expectedBenchmarkItemIds"];
  const rawExpectedTripletIds = inputSnap["expectedTripletIds"];

  const { thresholds: t, valid: thresholdsValid } = resolveTighteningThresholds(rawThresholds);
  if (!thresholdsValid) {
    failures.add("invalid_threshold_configuration");
  }

  const benchmarkArray = snapshotDensePlainArray(rawBenchmarkItems);
  const totalCount = benchmarkArray ? benchmarkArray.length : 0;
  if (!benchmarkArray) {
    failures.add("empty_benchmark");
    failures.add("duplicate_or_invalid_benchmark_item_id");
  } else if (totalCount === 0) {
    failures.add("empty_benchmark");
  }

  const hasExpectedBenchmarkIds = rawExpectedBenchmarkIds !== undefined;
  const expectedBenchmarkSet = hasExpectedBenchmarkIds
    ? parseUniqueNonBlankIdSet(rawExpectedBenchmarkIds)
    : null;
  if (hasExpectedBenchmarkIds && !expectedBenchmarkSet) {
    failures.add("benchmark_cohort_mismatch");
  }

  const benchmarkIdCounts = new Map<string, number>();
  const parsedBenchmarks: Array<{
    readonly itemId: string | null;
    readonly trueBand: number | null;
    readonly evaluation: unknown;
  }> = [];
  if (benchmarkArray) {
    for (const rawItem of benchmarkArray) {
      if (!isPlainRecordObject(rawItem)) {
        failures.add("duplicate_or_invalid_benchmark_item_id");
        parsedBenchmarks.push({ itemId: null, trueBand: null, evaluation: null });
        continue;
      }
      const idField = readOwnDataField(rawItem, "itemId");
      const rawId = idField.ok && typeof idField.value === "string" ? idField.value.trim() : "";
      if (rawId.length === 0) {
        failures.add("duplicate_or_invalid_benchmark_item_id");
        parsedBenchmarks.push({ itemId: null, trueBand: null, evaluation: null });
        continue;
      }
      benchmarkIdCounts.set(rawId, (benchmarkIdCounts.get(rawId) ?? 0) + 1);
      const trueBandField = readOwnDataField(rawItem, "trueBand");
      const trueBandVal =
        trueBandField.ok && typeof trueBandField.value === "number" ? trueBandField.value : Number.NaN;
      const evalField = readOwnDataField(rawItem, "evaluation");
      parsedBenchmarks.push({
        itemId: rawId,
        trueBand: trueBandVal,
        evaluation: evalField.ok ? evalField.value : null,
      });
    }
  }

  const seenValidBenchmarkIds = new Set<string>();
  const admissiblePairs: Array<{ trueBand: number; predBand: number }> = [];
  for (const item of parsedBenchmarks) {
    if (item.itemId === null) continue;
    if ((benchmarkIdCounts.get(item.itemId) ?? 0) > 1) {
      failures.add("duplicate_or_invalid_benchmark_item_id");
      continue;
    }
    seenValidBenchmarkIds.add(item.itemId);
    if (hasExpectedBenchmarkIds && isPlainRecordObject(item.evaluation)) {
      const subIdField = readOwnDataField(item.evaluation, "submissionId");
      if (subIdField.ok && typeof subIdField.value === "string" && subIdField.value.trim().length > 0) {
        if (subIdField.value.trim() !== item.itemId) {
          failures.add("benchmark_cohort_mismatch");
        }
      }
    }
    if (item.trueBand === null || !Number.isFinite(item.trueBand) || item.trueBand < 0 || item.trueBand > 9) {
      continue;
    }
    const predBand = extractPointScore(item.evaluation);
    if (predBand !== null) {
      admissiblePairs.push({ trueBand: item.trueBand, predBand });
    }
  }

  if (expectedBenchmarkSet) {
    let exactMatch =
      seenValidBenchmarkIds.size === expectedBenchmarkSet.size &&
      totalCount === expectedBenchmarkSet.size;
    if (exactMatch) {
      for (const expectedId of expectedBenchmarkSet) {
        if (!seenValidBenchmarkIds.has(expectedId)) {
          exactMatch = false;
          break;
        }
      }
    }
    if (!exactMatch) {
      failures.add("benchmark_cohort_mismatch");
    }
  }

  const admissibleCount = admissiblePairs.length;
  const admissibleCoverage = totalCount > 0 ? admissibleCount / totalCount : 0;
  if (totalCount > 0 && admissibleCoverage + FLOAT_EPSILON < t.minAdmissibleCoverage) {
    failures.add("admissible_coverage_below_threshold");
  }

  const lowTail = admissiblePairs.filter((pair) => pair.trueBand <= t.lowTailMaxBand + FLOAT_EPSILON);
  const highTail = admissiblePairs.filter((pair) => pair.trueBand >= t.highTailMinBand - FLOAT_EPSILON);
  if (lowTail.length === 0) failures.add("missing_low_tail_samples");
  if (highTail.length === 0) failures.add("missing_high_tail_samples");

  const customLowTail =
    t.customLowTailMaxBand !== null
      ? admissiblePairs.filter((pair) => pair.trueBand <= t.customLowTailMaxBand! + FLOAT_EPSILON)
      : null;
  const customHighTail =
    t.customHighTailMinBand !== null
      ? admissiblePairs.filter((pair) => pair.trueBand >= t.customHighTailMinBand! - FLOAT_EPSILON)
      : null;
  if (customLowTail !== null && customLowTail.length === 0) failures.add("missing_low_tail_samples");
  if (customHighTail !== null && customHighTail.length === 0) failures.add("missing_high_tail_samples");

  const trueBands = admissiblePairs.map((pair) => pair.trueBand);
  const predBands = admissiblePairs.map((pair) => pair.predBand);

  const qwk = admissibleCount > 0 ? computeQuadraticWeightedKappa(trueBands, predBands) : null;
  const sdTrue = admissibleCount > 0 ? standardDeviation(trueBands) : null;
  const sdPred = admissibleCount > 0 ? standardDeviation(predBands) : null;

  let smd: number | null = null;
  if (admissibleCount > 0 && sdTrue !== null && sdPred !== null) {
    const meanDiff = mean(predBands) - mean(trueBands);
    const pooledSd = Math.sqrt(0.5 * (sdTrue * sdTrue + sdPred * sdPred));
    if (pooledSd === 0) {
      smd = Math.abs(meanDiff) < FLOAT_EPSILON ? 0 : Math.sign(meanDiff) * Number.POSITIVE_INFINITY;
    } else {
      smd = meanDiff / pooledSd;
    }
  }

  const biasLow = lowTail.length > 0 ? mean(lowTail.map((p) => p.predBand - p.trueBand)) : null;
  const biasHigh = highTail.length > 0 ? mean(highTail.map((p) => p.predBand - p.trueBand)) : null;
  const customBiasLow =
    customLowTail !== null && customLowTail.length > 0
      ? mean(customLowTail.map((p) => p.predBand - p.trueBand))
      : null;
  const customBiasHigh =
    customHighTail !== null && customHighTail.length > 0
      ? mean(customHighTail.map((p) => p.predBand - p.trueBand))
      : null;
  const sdRatio = sdTrue !== null && sdPred !== null && sdTrue > 0 ? sdPred / sdTrue : null;

  if (qwk === null || !Number.isFinite(qwk) || qwk + FLOAT_EPSILON < t.minQwk) {
    failures.add("qwk_below_threshold");
  }
  if (smd === null || !Number.isFinite(smd) || Math.abs(smd) > t.maxAbsSmd + FLOAT_EPSILON) {
    failures.add("smd_exceeds_threshold");
  }
  if (
    (biasLow !== null && Math.abs(biasLow) > t.maxAbsBiasLow + FLOAT_EPSILON) ||
    (customBiasLow !== null && Math.abs(customBiasLow) > t.maxAbsBiasLow + FLOAT_EPSILON)
  ) {
    failures.add("low_tail_bias_exceeds_threshold");
  }
  if (
    (biasHigh !== null && Math.abs(biasHigh) > t.maxAbsBiasHigh + FLOAT_EPSILON) ||
    (customBiasHigh !== null && Math.abs(customBiasHigh) > t.maxAbsBiasHigh + FLOAT_EPSILON)
  ) {
    failures.add("high_tail_bias_exceeds_threshold");
  }
  if (sdRatio === null || !Number.isFinite(sdRatio) || sdRatio + FLOAT_EPSILON < t.minSdRatio) {
    failures.add("sd_ratio_compression_detected");
  }

  const counterfactualAudits: CounterfactualTripletAudit[] = [];
  const tripletsArray = snapshotDensePlainArray(rawCounterfactualTriplets);
  const hasExpectedTripletIds = rawExpectedTripletIds !== undefined;
  const expectedTripletSet = hasExpectedTripletIds
    ? parseUniqueNonBlankIdSet(rawExpectedTripletIds)
    : null;
  if (hasExpectedTripletIds && !expectedTripletSet) {
    failures.add("triplet_cohort_mismatch");
  }

  const seenValidTripletIds = new Set<string>();
  if (!tripletsArray) {
    failures.add("missing_counterfactual_triplets");
    failures.add("duplicate_or_invalid_triplet_id");
  } else if (tripletsArray.length === 0) {
    failures.add("missing_counterfactual_triplets");
  } else {
    const tripletIdCounts = new Map<string, number>();
    const parsedTriplets: Array<{
      readonly tripletId: string | null;
      readonly concise: unknown;
      readonly padded: unknown;
      readonly equalLength: unknown;
    }> = [];
    for (const rawTriplet of tripletsArray) {
      if (!isPlainRecordObject(rawTriplet)) {
        failures.add("duplicate_or_invalid_triplet_id");
        parsedTriplets.push({ tripletId: null, concise: null, padded: null, equalLength: null });
        continue;
      }
      const idField = readOwnDataField(rawTriplet, "tripletId");
      const rawId = idField.ok && typeof idField.value === "string" ? idField.value.trim() : "";
      if (rawId.length === 0) {
        failures.add("duplicate_or_invalid_triplet_id");
        parsedTriplets.push({ tripletId: null, concise: null, padded: null, equalLength: null });
        continue;
      }
      tripletIdCounts.set(rawId, (tripletIdCounts.get(rawId) ?? 0) + 1);
      const conciseField = readOwnDataField(rawTriplet, "substantiveConcise");
      const paddedField = readOwnDataField(rawTriplet, "templatePaddedExpansion");
      const equalField = readOwnDataField(rawTriplet, "equalLengthSubstantive");
      parsedTriplets.push({
        tripletId: rawId,
        concise: conciseField.ok ? conciseField.value : null,
        padded: paddedField.ok ? paddedField.value : null,
        equalLength: equalField.ok ? equalField.value : null,
      });
    }

    for (const triplet of parsedTriplets) {
      const tripletFailures: RubricCalibrationGateFailure[] = [];
      if (triplet.tripletId === null || (tripletIdCounts.get(triplet.tripletId) ?? 0) > 1) {
        tripletFailures.push("duplicate_or_invalid_triplet_id");
        failures.add("duplicate_or_invalid_triplet_id");
      } else {
        seenValidTripletIds.add(triplet.tripletId);
      }

      const paddedMasteryField = readOwnDataField(triplet.padded, "countsTowardMastery");
      if (!paddedMasteryField.ok || paddedMasteryField.value !== false) {
        tripletFailures.push("counterfactual_padded_counts_toward_mastery");
        failures.add("counterfactual_padded_counts_toward_mastery");
      }
      const conciseScore = extractCounterfactualScore(triplet.concise);
      const paddedScore = extractCounterfactualScore(triplet.padded);
      const equalLengthScore = extractCounterfactualScore(triplet.equalLength);

      if (conciseScore === null || paddedScore === null || equalLengthScore === null) {
        tripletFailures.push("counterfactual_missing_point_score");
        failures.add("counterfactual_missing_point_score");
        counterfactualAudits.push({
          tripletId: triplet.tripletId ?? "",
          passed: false,
          conciseScore,
          paddedScore,
          equalLengthScore,
          paddingGain: null,
          failures: tripletFailures,
        });
        continue;
      }

      const paddingGain = paddedScore - conciseScore;
      if (paddingGain > t.maxPaddingGain + FLOAT_EPSILON) {
        tripletFailures.push("counterfactual_padding_gain_exceeds_limit");
        failures.add("counterfactual_padding_gain_exceeds_limit");
      }
      if (!(paddedScore + FLOAT_EPSILON < equalLengthScore)) {
        tripletFailures.push("counterfactual_padded_not_below_equal_length_substantive");
        failures.add("counterfactual_padded_not_below_equal_length_substantive");
      }

      counterfactualAudits.push({
        tripletId: triplet.tripletId ?? "",
        passed: tripletFailures.length === 0,
        conciseScore,
        paddedScore,
        equalLengthScore,
        paddingGain,
        failures: tripletFailures,
      });
    }
  }

  if (expectedTripletSet) {
    let exactTripletMatch =
      tripletsArray !== null &&
      seenValidTripletIds.size === expectedTripletSet.size &&
      tripletsArray.length === expectedTripletSet.size;
    if (exactTripletMatch) {
      for (const expectedId of expectedTripletSet) {
        if (!seenValidTripletIds.has(expectedId)) {
          exactTripletMatch = false;
          break;
        }
      }
    }
    if (!exactTripletMatch) {
      failures.add("triplet_cohort_mismatch");
    }
  }

  const failureList = [...failures];
  return {
    passed: failureList.length === 0,
    metrics: {
      totalCount,
      admissibleCount,
      admissibleCoverage,
      lowTailCount: lowTail.length,
      highTailCount: highTail.length,
      qwk,
      smd,
      biasLow,
      biasHigh,
      sdTrue,
      sdPred,
      sdRatio,
    },
    counterfactualAudits,
    failures: failureList,
  };
}
