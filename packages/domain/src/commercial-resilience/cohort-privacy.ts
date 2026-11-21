/**
 * Zero-solo-pollution bilateral-privacy cohort heatmap & pure LTI 1.3
 * deep-linking claims validator.
 *
 * Privacy invariants:
 *   1. Solo learners (`mode: "solo"`) receive zero cohort queries/widgets
 *      (`cohortSurfaceVisible: false`).
 *   2. Cohort heatmap aggregation is locked strictly to immutable ISO-8601
 *      calendar week boundaries `[Monday 00:00:00.000 UTC, next Monday 00:00:00.000 UTC)`.
 *      Sliding or arbitrary time windows are deterministically rejected to
 *      block single-student differencing attacks.
 *   3. Every skill/concept cell is suppressed unless ALL THREE hold:
 *        N >= 10 && E >= 5 && (N - E) >= 5
 *      Suppressed cells emit a uniform non-leaking reason and null counts/rates.
 *   4. LTI 1.3 deep-linking validation strictly enforces iss, aud/azp,
 *      deployment_id, nonce, exp/iat, version 1.3.0, target cartridge/course
 *      resource link, IMS LIS role mapping, and hard denial of solo learner
 *      private notes and raw attempt transcripts.
 */

import {
  assertNonNegativeSafeInteger,
  assertSafeTimestampMs,
  CommercialResilienceError,
  DAY_MS,
  normalizeIdentifier,
  WEEK_MS,
} from "./types";

export const MIN_COHORT_ACTIVE_SIZE = 10;
export const MIN_BILATERAL_CLASS_COUNT = 5;

/** 1970-01-05T00:00:00.000Z — the first Monday after the Unix epoch (1970-01-01 was Thursday). */
const FIRST_UTC_MONDAY_MS = 4 * DAY_MS;

/* ============================================================================
 * 1. Zero-Solo-Pollution Surface Policy
 * ========================================================================== */

export type WorkspaceLearningMode = "solo" | "cohort";
export type CohortViewerRole = "learner" | "instructor" | "admin";

export interface CohortSurfacePolicyInput {
  readonly mode: WorkspaceLearningMode;
  readonly role: CohortViewerRole;
}

export interface CohortSurfacePolicy {
  readonly mode: WorkspaceLearningMode;
  readonly role: CohortViewerRole;
  readonly cohortSurfaceVisible: boolean;
  readonly allowCohortQueries: boolean;
  readonly widgets: ReadonlyArray<"cohort_iso_week_heatmap">;
  readonly allowPrivateSoloNotesAccess: false;
  readonly allowRawAttemptTranscriptAccess: false;
  readonly reason:
    | "solo_mode_isolated"
    | "cohort_learner_isolated"
    | "cohort_instructor_aggregated_only";
}

export function resolveCohortSurfacePolicy(
  input: CohortSurfacePolicyInput,
): CohortSurfacePolicy {
  if (input.mode === "solo") {
    return {
      mode: "solo",
      role: input.role,
      cohortSurfaceVisible: false,
      allowCohortQueries: false,
      widgets: [],
      allowPrivateSoloNotesAccess: false,
      allowRawAttemptTranscriptAccess: false,
      reason: "solo_mode_isolated",
    };
  }

  if (input.role === "instructor" || input.role === "admin") {
    return {
      mode: "cohort",
      role: input.role,
      cohortSurfaceVisible: true,
      allowCohortQueries: true,
      widgets: ["cohort_iso_week_heatmap"],
      allowPrivateSoloNotesAccess: false,
      allowRawAttemptTranscriptAccess: false,
      reason: "cohort_instructor_aggregated_only",
    };
  }

  return {
    mode: "cohort",
    role: input.role,
    cohortSurfaceVisible: false,
    allowCohortQueries: false,
    widgets: [],
    allowPrivateSoloNotesAccess: false,
    allowRawAttemptTranscriptAccess: false,
    reason: "cohort_learner_isolated",
  };
}

/* ============================================================================
 * 2. Immutable ISO Calendar Week Windows & Bilateral-Privacy Cohort Heatmap
 * ========================================================================== */

export interface IsoWeekWindow {
  readonly isoWeekKey: string;
  readonly isoYear: number;
  readonly isoWeek: number;
  readonly weekStartUtcMs: number;
  readonly weekEndUtcMs: number;
}

export function isIsoWeekBoundaryUtcMs(utcMs: number): boolean {
  if (typeof utcMs !== "number" || !Number.isSafeInteger(utcMs) || utcMs < 0) {
    return false;
  }
  const offset = (((utcMs - FIRST_UTC_MONDAY_MS) % WEEK_MS) + WEEK_MS) % WEEK_MS;
  return offset === 0;
}

/**
 * Computes the ISO-8601 week key (`YYYY-Www`) and exact `[Monday 00:00 UTC,
 * next Monday 00:00 UTC)` bounds containing `utcMs`.
 */
export function getIsoWeekWindowForTimestamp(utcMs: number): IsoWeekWindow {
  const safeUtcMs = assertSafeTimestampMs(utcMs, "utcMs");
  const shifted = safeUtcMs - FIRST_UTC_MONDAY_MS;
  const weekIndex = Math.floor(shifted / WEEK_MS);
  const weekStartUtcMs = FIRST_UTC_MONDAY_MS + weekIndex * WEEK_MS;
  const weekEndUtcMs = weekStartUtcMs + WEEK_MS;

  // ISO-8601 rule: a week belongs to the calendar year containing its Thursday.
  const thursdayMs = weekStartUtcMs + 3 * DAY_MS;
  const thursdayDate = new Date(thursdayMs);
  const isoYear = thursdayDate.getUTCFullYear();
  const jan4Ms = Date.UTC(isoYear, 0, 4);
  const jan4WeekIndex = Math.floor((jan4Ms - FIRST_UTC_MONDAY_MS) / WEEK_MS);
  const isoWeek = weekIndex - jan4WeekIndex + 1;
  const isoWeekKey = `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;

  return {
    isoWeekKey,
    isoYear,
    isoWeek,
    weekStartUtcMs,
    weekEndUtcMs,
  };
}

/**
 * Parses an ISO-8601 week key (`YYYY-Www`) into its exact immutable UTC bounds.
 * Rejects nonexistent week numbers (e.g. `W53` in a 52-week ISO year).
 */
export function parseIsoWeekKey(isoWeekKey: string): IsoWeekWindow {
  const trimmed = normalizeIdentifier(isoWeekKey, "isoWeekKey");
  const match = /^(\d{4})-W(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new CommercialResilienceError(
      "SLIDING_OR_INVALID_WEEK_WINDOW",
      `Invalid ISO week key "${isoWeekKey}"; expected YYYY-Www`,
    );
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (year < 1971 || week < 1 || week > 53) {
    throw new CommercialResilienceError(
      "SLIDING_OR_INVALID_WEEK_WINDOW",
      `Out-of-range ISO week key "${isoWeekKey}"`,
    );
  }

  const jan4Ms = Date.UTC(year, 0, 4);
  const week1Index = Math.floor((jan4Ms - FIRST_UTC_MONDAY_MS) / WEEK_MS);
  const weekStartUtcMs =
    FIRST_UTC_MONDAY_MS + (week1Index + week - 1) * WEEK_MS;
  const window = getIsoWeekWindowForTimestamp(weekStartUtcMs);

  if (window.isoYear !== year || window.isoWeek !== week) {
    throw new CommercialResilienceError(
      "SLIDING_OR_INVALID_WEEK_WINDOW",
      `ISO year ${year} does not contain week W${String(week).padStart(2, "0")}`,
    );
  }
  return window;
}

/**
 * Validates that `[weekStartUtcMs, weekEndUtcMs)` is an exact single immutable
 * ISO calendar week boundary (`Monday 00:00:00.000 UTC` to next Monday).
 * Rejects sliding, shifted, partial, or multi-week windows.
 */
export function validateFixedIsoWeekWindow(window: {
  readonly weekStartUtcMs: number;
  readonly weekEndUtcMs: number;
}): IsoWeekWindow {
  const start = assertSafeTimestampMs(window.weekStartUtcMs, "weekStartUtcMs");
  const end = assertSafeTimestampMs(window.weekEndUtcMs, "weekEndUtcMs");

  if (!isIsoWeekBoundaryUtcMs(start)) {
    throw new CommercialResilienceError(
      "SLIDING_OR_INVALID_WEEK_WINDOW",
      "weekStartUtcMs must align exactly to Monday 00:00:00.000 UTC (sliding windows are forbidden)",
    );
  }
  if (end - start !== WEEK_MS) {
    throw new CommercialResilienceError(
      "SLIDING_OR_INVALID_WEEK_WINDOW",
      "Aggregation window must span exactly one immutable ISO calendar week (604,800,000 ms)",
    );
  }

  return getIsoWeekWindowForTimestamp(start);
}

export interface BilateralCohortCellInput {
  readonly skillId: string;
  readonly enrolledActiveCount: number;
  readonly eventLearnerCount: number;
}

export type BilateralCohortCell =
  | {
      readonly skillId: string;
      readonly suppressed: false;
      readonly enrolledActiveCount: number;
      readonly eventLearnerCount: number;
      readonly complementLearnerCount: number;
      readonly eventRate: number;
      readonly eventRateBps: number;
      readonly suppressionReason: null;
    }
  | {
      readonly skillId: string;
      readonly suppressed: true;
      readonly enrolledActiveCount: null;
      readonly eventLearnerCount: null;
      readonly complementLearnerCount: null;
      readonly eventRate: null;
      readonly eventRateBps: null;
      /** Uniform reason — never leaks whether E < 5 or N - E < 5. */
      readonly suppressionReason: "bilateral_privacy_threshold";
    };

/**
 * Applies the bilateral differential-privacy threshold gate:
 *   disclosed iff N >= 10 && E >= 5 && (N - E) >= 5.
 */
export function evaluateBilateralPrivacyCell(
  input: BilateralCohortCellInput,
): BilateralCohortCell {
  const skillId = normalizeIdentifier(input.skillId, "skillId");
  const n = assertNonNegativeSafeInteger(
    input.enrolledActiveCount,
    "enrolledActiveCount",
  );
  const e = assertNonNegativeSafeInteger(
    input.eventLearnerCount,
    "eventLearnerCount",
  );

  if (e > n) {
    throw new CommercialResilienceError(
      "INVALID_COHORT_COUNTS",
      `eventLearnerCount (${e}) cannot exceed enrolledActiveCount (${n}) for skill "${skillId}"`,
    );
  }

  const complement = n - e;
  const disclosed =
    n >= MIN_COHORT_ACTIVE_SIZE &&
    e >= MIN_BILATERAL_CLASS_COUNT &&
    complement >= MIN_BILATERAL_CLASS_COUNT;

  if (!disclosed) {
    return {
      skillId,
      suppressed: true,
      enrolledActiveCount: null,
      eventLearnerCount: null,
      complementLearnerCount: null,
      eventRate: null,
      eventRateBps: null,
      suppressionReason: "bilateral_privacy_threshold",
    };
  }

  return {
    skillId,
    suppressed: false,
    enrolledActiveCount: n,
    eventLearnerCount: e,
    complementLearnerCount: complement,
    eventRate: e / n,
    eventRateBps: Math.round((e * 10_000) / n),
    suppressionReason: null,
  };
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256HexPure(message: string): string {
  const input = new TextEncoder().encode(message);
  const bitLen = BigInt(input.length) * 8n;
  const paddedLen = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Number((bitLen >> 32n) & 0xffffffffn), false);
  view.setUint32(paddedLen - 4, Number(bitLen & 0xffffffffn), false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 =
        ((w15 >>> 7) | (w15 << 25)) ^
        ((w15 >>> 18) | (w15 << 14)) ^
        (w15 >>> 3);
      const s1 =
        ((w2 >>> 17) | (w2 << 15)) ^
        ((w2 >>> 19) | (w2 << 13)) ^
        (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

/**
 * Computes a deterministic, locale-independent SHA-256 digest binding a
 * closed ISO calendar week to its frozen enrolled learner roster.
 */
export function computeFrozenRosterDigest(
  window: IsoWeekWindow,
  learnerIds: ReadonlyArray<string>,
): string {
  const uniqueSorted = [...new Set(learnerIds)].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const canonicalBody = uniqueSorted
    .map((id) => `${id.length}:${id}`)
    .join("|");
  const payload = `cohort-roster-v1|${window.isoWeekKey}|${window.weekEndUtcMs}|${uniqueSorted.length}|${canonicalBody}`;
  return `sha256:${sha256HexPure(payload)}`;
}

export interface CohortSnapshotPublicationLedger {
  readonly ledgerKind: "cohort_snapshot_publication";
  readonly snapshotsByKey: ReadonlyMap<string, CohortHeatmapResult>;
  readonly snapshotDigestsByKey: ReadonlyMap<string, string>;
}

export function createCohortSnapshotPublicationLedger(): CohortSnapshotPublicationLedger {
  return Object.freeze({
    ledgerKind: "cohort_snapshot_publication" as const,
    snapshotsByKey: new Map<string, CohortHeatmapResult>(),
    snapshotDigestsByKey: new Map<string, string>(),
  });
}

function cloneAndFreezeWindow(window: IsoWeekWindow): IsoWeekWindow {
  return Object.freeze({
    isoWeekKey: window.isoWeekKey,
    isoYear: window.isoYear,
    isoWeek: window.isoWeek,
    weekStartUtcMs: window.weekStartUtcMs,
    weekEndUtcMs: window.weekEndUtcMs,
  });
}

function cloneAndFreezeCell(cell: BilateralCohortCell): BilateralCohortCell {
  if (cell.suppressed) {
    return Object.freeze({
      skillId: cell.skillId,
      suppressed: true as const,
      enrolledActiveCount: null,
      eventLearnerCount: null,
      complementLearnerCount: null,
      eventRate: null,
      eventRateBps: null,
      suppressionReason: "bilateral_privacy_threshold" as const,
    });
  }
  return Object.freeze({
    skillId: cell.skillId,
    suppressed: false as const,
    enrolledActiveCount: cell.enrolledActiveCount,
    eventLearnerCount: cell.eventLearnerCount,
    complementLearnerCount: cell.complementLearnerCount,
    eventRate: cell.eventRate,
    eventRateBps: cell.eventRateBps,
    suppressionReason: null,
  });
}

function cloneAndFreezeCohortSnapshot(
  snapshot: CohortHeatmapResult,
  overrides?: {
    readonly publicationKey?: string | null;
    readonly sealed?: boolean;
    readonly idempotentReplay?: boolean;
  },
): CohortHeatmapResult {
  const frozenWindow = snapshot.window
    ? cloneAndFreezeWindow(snapshot.window)
    : null;
  const frozenCells = Object.freeze(
    snapshot.cells.map((cell) => cloneAndFreezeCell(cell)),
  );
  return Object.freeze({
    cohortSurfaceVisible: snapshot.cohortSurfaceVisible,
    cohortId: snapshot.cohortId,
    publicationKey:
      overrides && "publicationKey" in overrides
        ? (overrides.publicationKey ?? null)
        : snapshot.publicationKey,
    window: frozenWindow,
    finalizedAtMs: snapshot.finalizedAtMs,
    frozenRosterDigest: snapshot.frozenRosterDigest,
    sealed: overrides?.sealed ?? snapshot.sealed,
    idempotentReplay: overrides?.idempotentReplay ?? snapshot.idempotentReplay,
    cells: frozenCells,
    disclosedCellCount: snapshot.disclosedCellCount,
    suppressedCellCount: snapshot.suppressedCellCount,
  });
}

function computeCohortSnapshotStructuralDigest(
  snapshot: CohortHeatmapResult,
  finalizedAtMsOverride?: number | null,
): string {
  const effectiveFinalizedAtMs =
    finalizedAtMsOverride !== undefined
      ? finalizedAtMsOverride
      : snapshot.finalizedAtMs;
  const cellPayload = snapshot.cells
    .map((cell) =>
      [
        `${cell.skillId.length}:${cell.skillId}`,
        cell.suppressed ? "1" : "0",
        String(cell.enrolledActiveCount ?? "null"),
        String(cell.eventLearnerCount ?? "null"),
        String(cell.complementLearnerCount ?? "null"),
        String(cell.eventRate ?? "null"),
        String(cell.eventRateBps ?? "null"),
        String(cell.suppressionReason ?? "null"),
      ].join(","),
    )
    .join(";");
  const canonical = [
    "cohort-snapshot-v1",
    snapshot.cohortSurfaceVisible ? "1" : "0",
    snapshot.cohortId ?? "null",
    snapshot.window?.isoWeekKey ?? "null",
    String(snapshot.window?.weekStartUtcMs ?? "null"),
    String(snapshot.window?.weekEndUtcMs ?? "null"),
    String(effectiveFinalizedAtMs ?? "null"),
    snapshot.frozenRosterDigest ?? "null",
    String(snapshot.disclosedCellCount),
    String(snapshot.suppressedCellCount),
    String(snapshot.cells.length),
    cellPayload,
  ].join("|");
  return `sha256:${sha256HexPure(canonical)}`;
}

export function cohortSnapshotPublicationKey(
  cohortId: string,
  isoWeekKey: string,
): string {
  return `${normalizeIdentifier(cohortId, "cohortId")}::${normalizeIdentifier(isoWeekKey, "isoWeekKey")}`;
}

function cohortCellsEqual(
  a: ReadonlyArray<BilateralCohortCell>,
  b: ReadonlyArray<BilateralCohortCell>,
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const ca = a[i];
    const cb = b[i];
    if (
      !ca ||
      !cb ||
      ca.skillId !== cb.skillId ||
      ca.suppressed !== cb.suppressed ||
      ca.enrolledActiveCount !== cb.enrolledActiveCount ||
      ca.eventLearnerCount !== cb.eventLearnerCount ||
      ca.complementLearnerCount !== cb.complementLearnerCount ||
      ca.eventRate !== cb.eventRate ||
      ca.eventRateBps !== cb.eventRateBps ||
      ca.suppressionReason !== cb.suppressionReason
    ) {
      return false;
    }
  }
  return true;
}

function cohortSnapshotsEquivalent(
  a: CohortHeatmapResult,
  b: CohortHeatmapResult,
): boolean {
  return (
    a.cohortSurfaceVisible === b.cohortSurfaceVisible &&
    a.cohortId === b.cohortId &&
    a.publicationKey === b.publicationKey &&
    a.frozenRosterDigest === b.frozenRosterDigest &&
    a.disclosedCellCount === b.disclosedCellCount &&
    a.suppressedCellCount === b.suppressedCellCount &&
    a.window?.isoWeekKey === b.window?.isoWeekKey &&
    a.window?.weekStartUtcMs === b.window?.weekStartUtcMs &&
    a.window?.weekEndUtcMs === b.window?.weekEndUtcMs &&
    cohortCellsEqual(a.cells, b.cells)
  );
}

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const SNAPSHOT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "cohortSurfaceVisible",
  "cohortId",
  "publicationKey",
  "window",
  "finalizedAtMs",
  "frozenRosterDigest",
  "sealed",
  "idempotentReplay",
  "cells",
  "disclosedCellCount",
  "suppressedCellCount",
]);

const WINDOW_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "isoWeekKey",
  "isoYear",
  "isoWeek",
  "weekStartUtcMs",
  "weekEndUtcMs",
]);

const CELL_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "skillId",
  "suppressed",
  "enrolledActiveCount",
  "eventLearnerCount",
  "complementLearnerCount",
  "eventRate",
  "eventRateBps",
  "suppressionReason",
]);

function isValidSha256Digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_DIGEST_PATTERN.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertStrictAllowedProperties(
  obj: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
  fail: (
    sealCode: "COHORT_WEEK_NOT_FINALIZED" | "COHORT_PRIVACY_VIOLATION",
    message: string,
  ) => never,
): void {
  if (Object.getOwnPropertySymbols(obj).length > 0) {
    fail(
      "COHORT_PRIVACY_VIOLATION",
      `${label} must not contain symbol properties`,
    );
  }
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (!allowedKeys.has(key)) {
      fail(
        "COHORT_PRIVACY_VIOLATION",
        `${label} contains disallowed extra property "${key}"`,
      );
    }
  }
}

function assertStrictPlainArray(
  arr: unknown[],
  label: string,
  fail: (
    sealCode: "COHORT_WEEK_NOT_FINALIZED" | "COHORT_PRIVACY_VIOLATION",
    message: string,
  ) => never,
): void {
  if (Object.getPrototypeOf(arr) !== Array.prototype) {
    fail(
      "COHORT_PRIVACY_VIOLATION",
      `${label} must have standard Array.prototype`,
    );
  }
  if (Object.getOwnPropertySymbols(arr).length > 0) {
    fail(
      "COHORT_PRIVACY_VIOLATION",
      `${label} must not contain symbol properties`,
    );
  }
  for (const prop of Object.getOwnPropertyNames(arr)) {
    if (prop === "length") {
      continue;
    }
    const idx = Number(prop);
    if (
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= arr.length ||
      String(idx) !== prop
    ) {
      fail(
        "COHORT_PRIVACY_VIOLATION",
        `${label} contains disallowed extra array property "${prop}"`,
      );
    }
  }
}

function validatePublishedSnapshotInvariants(
  rawSnapshot: unknown,
  mode: "seal" | "ledger_read",
): {
  readonly snapshot: CohortHeatmapResult;
  readonly validatedWindow: IsoWeekWindow;
  readonly cohortId: string;
} {
  function fail(
    sealCode: "COHORT_WEEK_NOT_FINALIZED" | "COHORT_PRIVACY_VIOLATION",
    message: string,
  ): never {
    throw new CommercialResilienceError(
      mode === "ledger_read" ? "COHORT_PUBLICATION_LEDGER_CORRUPTED" : sealCode,
      message,
    );
  }

  if (!isPlainRecord(rawSnapshot)) {
    fail("COHORT_PRIVACY_VIOLATION", "Cohort snapshot must be a plain object");
  }
  assertStrictAllowedProperties(
    rawSnapshot,
    SNAPSHOT_ALLOWED_KEYS,
    "Cohort snapshot",
    fail,
  );

  const cohortSurfaceVisible = rawSnapshot["cohortSurfaceVisible"];
  const rawCohortId = rawSnapshot["cohortId"];
  const rawPublicationKey = rawSnapshot["publicationKey"];
  const rawWindow = rawSnapshot["window"];
  const rawFinalizedAtMs = rawSnapshot["finalizedAtMs"];
  const rawFrozenRosterDigest = rawSnapshot["frozenRosterDigest"];
  const rawSealed = rawSnapshot["sealed"];
  const rawIdempotentReplay = rawSnapshot["idempotentReplay"];
  const rawCells = rawSnapshot["cells"];
  const rawDisclosedCellCount = rawSnapshot["disclosedCellCount"];
  const rawSuppressedCellCount = rawSnapshot["suppressedCellCount"];

  if (
    cohortSurfaceVisible !== true ||
    rawCohortId === null ||
    rawWindow === null ||
    rawFrozenRosterDigest === null ||
    rawFinalizedAtMs === null
  ) {
    fail(
      "COHORT_WEEK_NOT_FINALIZED",
      "Only a visible, finalized cohort weekly snapshot can be sealed for publication",
    );
  }

  if (
    typeof rawCohortId !== "string" ||
    rawCohortId.trim().length === 0 ||
    rawCohortId.trim() !== rawCohortId
  ) {
    fail(
      "COHORT_PRIVACY_VIOLATION",
      "Cohort snapshot cohortId must be a canonical non-empty identifier",
    );
  }
  const cohortId: string = rawCohortId;

  if (rawPublicationKey !== null && typeof rawPublicationKey !== "string") {
    fail(
      "COHORT_PRIVACY_VIOLATION",
      "Cohort snapshot publicationKey must be a string or null",
    );
  }
  if (typeof rawSealed !== "boolean" || typeof rawIdempotentReplay !== "boolean") {
    fail(
      "COHORT_PRIVACY_VIOLATION",
      "Cohort snapshot sealed/idempotentReplay flags must be booleans",
    );
  }

  if (!isPlainRecord(rawWindow)) {
    fail("COHORT_PRIVACY_VIOLATION", "Cohort snapshot window must be a plain object");
  }
  assertStrictAllowedProperties(
    rawWindow,
    WINDOW_ALLOWED_KEYS,
    "Cohort snapshot window",
    fail,
  );

  let validatedWindow: IsoWeekWindow;
  try {
    validatedWindow = validateFixedIsoWeekWindow({
      weekStartUtcMs: rawWindow["weekStartUtcMs"] as number,
      weekEndUtcMs: rawWindow["weekEndUtcMs"] as number,
    });
  } catch (err) {
    if (mode === "ledger_read") {
      throw new CommercialResilienceError(
        "COHORT_PUBLICATION_LEDGER_CORRUPTED",
        `Stored cohort snapshot has invalid ISO week window: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }
  if (
    rawWindow["isoWeekKey"] !== validatedWindow.isoWeekKey ||
    rawWindow["isoYear"] !== validatedWindow.isoYear ||
    rawWindow["isoWeek"] !== validatedWindow.isoWeek
  ) {
    fail(
      "COHORT_PRIVACY_VIOLATION",
      "Cohort snapshot window metadata does not match its UTC boundaries",
    );
  }

  if (
    typeof rawFinalizedAtMs !== "number" ||
    !Number.isSafeInteger(rawFinalizedAtMs) ||
    rawFinalizedAtMs < 0
  ) {
    fail(
      "COHORT_WEEK_NOT_FINALIZED",
      "Cohort snapshot finalizedAtMs must be a non-negative safe integer",
    );
  }
  if (rawFinalizedAtMs < validatedWindow.weekEndUtcMs) {
    fail(
      "COHORT_WEEK_NOT_FINALIZED",
      `Cohort snapshot for ${validatedWindow.isoWeekKey} cannot be sealed before week close (${validatedWindow.weekEndUtcMs})`,
    );
  }

  if (!isValidSha256Digest(rawFrozenRosterDigest)) {
    fail(
      "COHORT_PRIVACY_VIOLATION",
      "Cohort snapshot frozenRosterDigest must be a valid sha256 digest",
    );
  }

  if (!Array.isArray(rawCells)) {
    fail("COHORT_PRIVACY_VIOLATION", "Cohort snapshot cells must be an array");
  }
  assertStrictPlainArray(rawCells, "Cohort snapshot cells", fail);

  const seenSkillIds = new Set<string>();
  const validatedCells: BilateralCohortCell[] = [];
  let expectedEnrolledCount: number | null = null;
  let disclosedCount = 0;
  let suppressedCount = 0;

  for (let i = 0; i < rawCells.length; i += 1) {
    const rawCell: unknown = rawCells[i];
    if (!isPlainRecord(rawCell)) {
      fail(
        "COHORT_PRIVACY_VIOLATION",
        `Cohort snapshot cell[${i}] must be a plain object`,
      );
    }
    assertStrictAllowedProperties(
      rawCell,
      CELL_ALLOWED_KEYS,
      `Cohort snapshot cell[${i}]`,
      fail,
    );

    const rawSkillId = rawCell["skillId"];
    if (
      typeof rawSkillId !== "string" ||
      rawSkillId.trim().length === 0 ||
      rawSkillId.trim() !== rawSkillId
    ) {
      fail(
        "COHORT_PRIVACY_VIOLATION",
        `Cohort snapshot cell[${i}] has invalid skillId`,
      );
    }
    const skillId: string = rawSkillId;
    if (seenSkillIds.has(skillId)) {
      fail(
        "COHORT_PRIVACY_VIOLATION",
        `Cohort snapshot contains duplicate skillId "${skillId}"`,
      );
    }
    seenSkillIds.add(skillId);

    const suppressed = rawCell["suppressed"];
    if (suppressed === true) {
      if (
        rawCell["enrolledActiveCount"] !== null ||
        rawCell["eventLearnerCount"] !== null ||
        rawCell["complementLearnerCount"] !== null ||
        rawCell["eventRate"] !== null ||
        rawCell["eventRateBps"] !== null ||
        rawCell["suppressionReason"] !== "bilateral_privacy_threshold"
      ) {
        fail(
          "COHORT_PRIVACY_VIOLATION",
          `Suppressed cell "${skillId}" must redact all counts/rates to null with uniform suppressionReason`,
        );
      }
      validatedCells.push(
        Object.freeze({
          skillId,
          suppressed: true as const,
          enrolledActiveCount: null,
          eventLearnerCount: null,
          complementLearnerCount: null,
          eventRate: null,
          eventRateBps: null,
          suppressionReason: "bilateral_privacy_threshold" as const,
        }),
      );
      suppressedCount += 1;
    } else if (suppressed === false) {
      const n = rawCell["enrolledActiveCount"];
      const e = rawCell["eventLearnerCount"];
      const c = rawCell["complementLearnerCount"];
      if (
        typeof n !== "number" ||
        !Number.isSafeInteger(n) ||
        typeof e !== "number" ||
        !Number.isSafeInteger(e) ||
        typeof c !== "number" ||
        !Number.isSafeInteger(c) ||
        n < MIN_COHORT_ACTIVE_SIZE ||
        e < MIN_BILATERAL_CLASS_COUNT ||
        c < MIN_BILATERAL_CLASS_COUNT ||
        e + c !== n
      ) {
        fail(
          "COHORT_PRIVACY_VIOLATION",
          `Disclosed cell "${skillId}" violates bilateral privacy threshold (N >= 10 && E >= 5 && N - E >= 5)`,
        );
      }
      const eventRate = rawCell["eventRate"];
      const eventRateBps = rawCell["eventRateBps"];
      if (
        typeof eventRate !== "number" ||
        !Number.isFinite(eventRate) ||
        eventRate !== e / n ||
        eventRateBps !== Math.round((e * 10_000) / n) ||
        rawCell["suppressionReason"] !== null
      ) {
        fail(
          "COHORT_PRIVACY_VIOLATION",
          `Disclosed cell "${skillId}" has inconsistent rate or suppression metadata`,
        );
      }
      if (expectedEnrolledCount === null) {
        expectedEnrolledCount = n;
      } else if (expectedEnrolledCount !== n) {
        fail(
          "COHORT_PRIVACY_VIOLATION",
          `Disclosed cell "${skillId}" enrolledActiveCount (${n}) disagrees with frozen cohort size (${expectedEnrolledCount})`,
        );
      }
      validatedCells.push(
        Object.freeze({
          skillId,
          suppressed: false as const,
          enrolledActiveCount: n,
          eventLearnerCount: e,
          complementLearnerCount: c,
          eventRate,
          eventRateBps,
          suppressionReason: null,
        }),
      );
      disclosedCount += 1;
    } else {
      fail(
        "COHORT_PRIVACY_VIOLATION",
        `Cohort snapshot cell "${skillId}" has non-boolean suppressed flag`,
      );
    }
  }

  if (
    rawDisclosedCellCount !== disclosedCount ||
    rawSuppressedCellCount !== suppressedCount
  ) {
    fail(
      "COHORT_PRIVACY_VIOLATION",
      "Cohort snapshot disclosedCellCount/suppressedCellCount do not match evaluated cells",
    );
  }

  const canonicalSnapshot: CohortHeatmapResult = Object.freeze({
    cohortSurfaceVisible: true,
    cohortId,
    publicationKey: rawPublicationKey,
    window: cloneAndFreezeWindow(validatedWindow),
    finalizedAtMs: rawFinalizedAtMs,
    frozenRosterDigest: rawFrozenRosterDigest,
    sealed: rawSealed,
    idempotentReplay: rawIdempotentReplay,
    cells: Object.freeze(validatedCells),
    disclosedCellCount: disclosedCount,
    suppressedCellCount: suppressedCount,
  });

  return {
    snapshot: canonicalSnapshot,
    validatedWindow,
    cohortId,
  };
}

function readVerifiedPublicationLedgerEntry(
  ledger: CohortSnapshotPublicationLedger,
  publicationKey: string,
): {
  readonly snapshot: CohortHeatmapResult;
  readonly expectedDigest: string;
} | undefined {
  const hasSnapshot = ledger.snapshotsByKey.has(publicationKey);
  const hasDigest = ledger.snapshotDigestsByKey.has(publicationKey);

  if (hasSnapshot !== hasDigest) {
    throw new CommercialResilienceError(
      "COHORT_PUBLICATION_LEDGER_CORRUPTED",
      `Cohort publication ledger has incomplete (snapshot, digest) pair for "${publicationKey}"`,
    );
  }
  if (!hasSnapshot) {
    return undefined;
  }

  const rawSnapshot: unknown = ledger.snapshotsByKey.get(publicationKey);
  const storedDigest = ledger.snapshotDigestsByKey.get(publicationKey);
  if (!isValidSha256Digest(storedDigest)) {
    throw new CommercialResilienceError(
      "COHORT_PUBLICATION_LEDGER_CORRUPTED",
      `Cohort publication ledger has missing or malformed digest for "${publicationKey}"`,
    );
  }
  const { snapshot, validatedWindow, cohortId } =
    validatePublishedSnapshotInvariants(rawSnapshot, "ledger_read");
  if (
    cohortSnapshotPublicationKey(cohortId, validatedWindow.isoWeekKey) !==
    publicationKey
  ) {
    throw new CommercialResilienceError(
      "COHORT_PUBLICATION_LEDGER_CORRUPTED",
      `Cohort publication ledger key "${publicationKey}" does not match stored snapshot metadata`,
    );
  }

  const actualDigest = computeCohortSnapshotStructuralDigest(snapshot);
  if (actualDigest !== storedDigest) {
    throw new CommercialResilienceError(
      "COHORT_PUBLICATION_LEDGER_CORRUPTED",
      `Cohort publication ledger structural digest mismatch for "${publicationKey}"`,
    );
  }

  return {
    snapshot,
    expectedDigest: storedDigest,
  };
}

function lookupPublishedSnapshot(
  source:
    | ReadonlyMap<string, CohortHeatmapResult>
    | CohortSnapshotPublicationLedger
    | undefined,
  publicationKey: string,
): {
  readonly snapshot: CohortHeatmapResult;
  readonly expectedDigest: string | null;
} | undefined {
  if (!source) {
    return undefined;
  }
  if ("ledgerKind" in source) {
    return readVerifiedPublicationLedgerEntry(source, publicationKey);
  }
  const rawSnapshot: unknown = source.get(publicationKey);
  if (rawSnapshot === undefined) {
    return undefined;
  }
  const { snapshot } = validatePublishedSnapshotInvariants(
    rawSnapshot,
    "ledger_read",
  );
  return { snapshot, expectedDigest: null };
}

/**
 * Seals at most ONE deeply-frozen immutable finalized snapshot per `(cohortId, isoWeekKey)`.
 * Re-verifies full bilateral privacy and roster consistency invariants before sealing.
 * Replaying an identical snapshot returns a deeply frozen copy of the original sealed snapshot;
 * attempting to publish any altered count/cell/digest for an already-published
 * `(cohortId, isoWeekKey)` throws `COHORT_WEEK_ALREADY_PUBLISHED`.
 * Incomplete or tampered `(snapshot, digest)` ledger pairs fail closed with
 * `COHORT_PUBLICATION_LEDGER_CORRUPTED`.
 */
export function sealCohortWeeklySnapshot(
  ledger: CohortSnapshotPublicationLedger,
  snapshot: CohortHeatmapResult,
): {
  readonly ledger: CohortSnapshotPublicationLedger;
  readonly snapshot: CohortHeatmapResult;
  readonly idempotentReplay: boolean;
} {
  const {
    snapshot: validatedSnapshot,
    validatedWindow,
    cohortId,
  } = validatePublishedSnapshotInvariants(snapshot, "seal");

  const key = cohortSnapshotPublicationKey(
    cohortId,
    validatedWindow.isoWeekKey,
  );
  const candidateFrozen = cloneAndFreezeCohortSnapshot(validatedSnapshot, {
    publicationKey: key,
    sealed: true,
    idempotentReplay: false,
  });
  const candidateDigest = computeCohortSnapshotStructuralDigest(candidateFrozen);

  const existingRecord = readVerifiedPublicationLedgerEntry(ledger, key);
  if (existingRecord) {
    const replayDigestAligned = computeCohortSnapshotStructuralDigest(
      candidateFrozen,
      existingRecord.snapshot.finalizedAtMs,
    );
    if (
      replayDigestAligned === existingRecord.expectedDigest &&
      cohortSnapshotsEquivalent(existingRecord.snapshot, candidateFrozen)
    ) {
      return {
        ledger,
        snapshot: cloneAndFreezeCohortSnapshot(existingRecord.snapshot, {
          sealed: true,
          idempotentReplay: true,
        }),
        idempotentReplay: true,
      };
    }
    throw new CommercialResilienceError(
      "COHORT_WEEK_ALREADY_PUBLISHED",
      `Cohort snapshot for (${cohortId}, ${validatedWindow.isoWeekKey}) was already published and cannot be mutated`,
    );
  }

  const nextMap = new Map(ledger.snapshotsByKey);
  nextMap.set(key, candidateFrozen);
  const nextDigests = new Map(ledger.snapshotDigestsByKey);
  nextDigests.set(key, candidateDigest);

  return {
    ledger: Object.freeze({
      ledgerKind: "cohort_snapshot_publication" as const,
      snapshotsByKey: nextMap,
      snapshotDigestsByKey: nextDigests,
    }),
    snapshot: cloneAndFreezeCohortSnapshot(candidateFrozen),
    idempotentReplay: false,
  };
}

export interface CohortHeatmapInput {
  readonly cohortId: string;
  readonly mode: WorkspaceLearningMode;
  readonly role: CohortViewerRole;
  readonly window: {
    readonly weekStartUtcMs: number;
    readonly weekEndUtcMs: number;
  };
  /** Evaluation/publication UTC ms; MUST be >= window.weekEndUtcMs (closed week only). */
  readonly evaluatedAtMs: number;
  /** Digest binding this finalized week snapshot to its frozen enrolled roster. */
  readonly frozenRosterDigest: string;
  readonly cells: ReadonlyArray<BilateralCohortCellInput>;
  /** Previously sealed weekly snapshots; enforces at most one immutable snapshot per (cohortId, isoWeekKey). */
  readonly publishedSnapshots?:
    | ReadonlyMap<string, CohortHeatmapResult>
    | CohortSnapshotPublicationLedger;
}

export interface CohortHeatmapResult {
  readonly cohortSurfaceVisible: boolean;
  readonly cohortId: string | null;
  readonly publicationKey: string | null;
  readonly window: IsoWeekWindow | null;
  readonly finalizedAtMs: number | null;
  readonly frozenRosterDigest: string | null;
  readonly sealed: boolean;
  readonly idempotentReplay: boolean;
  readonly cells: ReadonlyArray<BilateralCohortCell>;
  readonly disclosedCellCount: number;
  readonly suppressedCellCount: number;
}

/**
 * Produces a bilateral-privacy-gated cohort heatmap locked strictly to a
 * finalized (closed) immutable ISO calendar week (`evaluatedAtMs >= weekEndUtcMs`)
 * and sealed at most once per `(cohortId, isoWeekKey)`.
 * Solo learners (and cohort learners) receive zero cohort UI or query results.
 */
export function buildCohortHeatmap(
  input: CohortHeatmapInput,
): CohortHeatmapResult {
  const policy = resolveCohortSurfacePolicy({
    mode: input.mode,
    role: input.role,
  });

  if (!policy.cohortSurfaceVisible || !policy.allowCohortQueries) {
    return {
      cohortSurfaceVisible: false,
      cohortId: null,
      publicationKey: null,
      window: null,
      finalizedAtMs: null,
      frozenRosterDigest: null,
      sealed: false,
      idempotentReplay: false,
      cells: [],
      disclosedCellCount: 0,
      suppressedCellCount: 0,
    };
  }

  const cohortId = normalizeIdentifier(input.cohortId, "cohortId");
  const validatedWindow = validateFixedIsoWeekWindow(input.window);
  const evaluatedAtMs = assertSafeTimestampMs(
    input.evaluatedAtMs,
    "evaluatedAtMs",
  );
  if (evaluatedAtMs < validatedWindow.weekEndUtcMs) {
    throw new CommercialResilienceError(
      "COHORT_WEEK_NOT_FINALIZED",
      `Cohort heatmap for ${validatedWindow.isoWeekKey} cannot be published before week close (${validatedWindow.weekEndUtcMs})`,
    );
  }
  const frozenRosterDigest = normalizeIdentifier(
    input.frozenRosterDigest,
    "frozenRosterDigest",
  );

  const evaluatedCells = input.cells.map((cell) =>
    evaluateBilateralPrivacyCell(cell),
  );

  let disclosedCellCount = 0;
  let suppressedCellCount = 0;
  for (const cell of evaluatedCells) {
    if (cell.suppressed) {
      suppressedCellCount += 1;
    } else {
      disclosedCellCount += 1;
    }
  }

  const publicationKey = cohortSnapshotPublicationKey(
    cohortId,
    validatedWindow.isoWeekKey,
  );
  const candidate: CohortHeatmapResult = {
    cohortSurfaceVisible: true,
    cohortId,
    publicationKey,
    window: validatedWindow,
    finalizedAtMs: evaluatedAtMs,
    frozenRosterDigest,
    sealed: false,
    idempotentReplay: false,
    cells: evaluatedCells,
    disclosedCellCount,
    suppressedCellCount,
  };

  const existingRecord = lookupPublishedSnapshot(
    input.publishedSnapshots,
    publicationKey,
  );
  if (existingRecord) {
    const existingDigest = computeCohortSnapshotStructuralDigest(
      existingRecord.snapshot,
    );
    const replayDigestAligned = computeCohortSnapshotStructuralDigest(
      candidate,
      existingRecord.snapshot.finalizedAtMs,
    );
    const digestIntact =
      existingRecord.expectedDigest === null ||
      existingDigest === existingRecord.expectedDigest;
    if (
      digestIntact &&
      existingDigest === replayDigestAligned &&
      cohortSnapshotsEquivalent(existingRecord.snapshot, candidate)
    ) {
      return cloneAndFreezeCohortSnapshot(existingRecord.snapshot, {
        sealed: true,
        idempotentReplay: true,
      });
    }
    throw new CommercialResilienceError(
      "COHORT_WEEK_ALREADY_PUBLISHED",
      `Cohort snapshot for (${cohortId}, ${validatedWindow.isoWeekKey}) was already published and cannot be mutated`,
    );
  }

  return cloneAndFreezeCohortSnapshot(candidate);
}

export interface CohortRosterMember {
  readonly learnerId: string;
  /** UTC ms timestamp when the learner enrolled; only <= window.weekEndUtcMs are frozen into the week snapshot. */
  readonly enrolledAtMs: number;
}

export interface CohortSkillEventRecord {
  readonly learnerId: string;
  readonly skillId: string;
  readonly occurredAtMs: number;
  /** Required server ingestion UTC ms timestamp; late-ingested events with recordedAtMs > weekEndUtcMs are excluded from closed weeks. */
  readonly recordedAtMs: number;
}

export interface AggregateCohortEventsInput {
  readonly cohortId: string;
  readonly mode: WorkspaceLearningMode;
  readonly role: CohortViewerRole;
  readonly window: {
    readonly weekStartUtcMs: number;
    readonly weekEndUtcMs: number;
  };
  /** Evaluation/publication UTC ms; MUST be >= window.weekEndUtcMs (closed week only). */
  readonly evaluatedAtMs: number;
  readonly enrolledRoster: ReadonlyArray<CohortRosterMember>;
  readonly skillIds: ReadonlyArray<string>;
  readonly events: ReadonlyArray<CohortSkillEventRecord>;
  /** Previously sealed weekly snapshots; enforces at most one immutable snapshot per (cohortId, isoWeekKey). */
  readonly publishedSnapshots?:
    | ReadonlyMap<string, CohortHeatmapResult>
    | CohortSnapshotPublicationLedger;
}

/**
 * Publishes a finalized weekly cohort heatmap strictly after `window.weekEndUtcMs`,
 * freezing the enrolled roster to learners with `enrolledAtMs <= window.weekEndUtcMs`,
 * excluding late-ingested events (`recordedAtMs > window.weekEndUtcMs`), and
 * enforcing once-per-`(cohortId, isoWeekKey)` immutability when sealed snapshots exist.
 */
export function aggregateCohortEventsToHeatmap(
  input: AggregateCohortEventsInput,
): CohortHeatmapResult {
  const policy = resolveCohortSurfacePolicy({
    mode: input.mode,
    role: input.role,
  });

  if (!policy.cohortSurfaceVisible || !policy.allowCohortQueries) {
    return {
      cohortSurfaceVisible: false,
      cohortId: null,
      publicationKey: null,
      window: null,
      finalizedAtMs: null,
      frozenRosterDigest: null,
      sealed: false,
      idempotentReplay: false,
      cells: [],
      disclosedCellCount: 0,
      suppressedCellCount: 0,
    };
  }

  const cohortId = normalizeIdentifier(input.cohortId, "cohortId");
  const validatedWindow = validateFixedIsoWeekWindow(input.window);
  const evaluatedAtMs = assertSafeTimestampMs(
    input.evaluatedAtMs,
    "evaluatedAtMs",
  );
  if (evaluatedAtMs < validatedWindow.weekEndUtcMs) {
    throw new CommercialResilienceError(
      "COHORT_WEEK_NOT_FINALIZED",
      `Cohort heatmap for ${validatedWindow.isoWeekKey} cannot be published before week close (${validatedWindow.weekEndUtcMs})`,
    );
  }

  // Freeze roster strictly to learners enrolled at or before week close.
  const enrolledSet = new Set<string>();
  for (const [idx, member] of input.enrolledRoster.entries()) {
    const learnerId = normalizeIdentifier(
      member.learnerId,
      `enrolledRoster[${idx}].learnerId`,
    );
    const enrolledAtMs = assertSafeTimestampMs(
      member.enrolledAtMs,
      `enrolledRoster[${idx}].enrolledAtMs`,
    );
    if (enrolledAtMs <= validatedWindow.weekEndUtcMs) {
      enrolledSet.add(learnerId);
    }
  }
  const frozenRosterDigest = computeFrozenRosterDigest(validatedWindow, [
    ...enrolledSet,
  ]);

  const distinctSkillIds: string[] = [];
  const seenSkills = new Set<string>();
  for (const [i, rawSkillId] of input.skillIds.entries()) {
    const skillId = normalizeIdentifier(rawSkillId, `skillIds[${i}]`);
    if (!seenSkills.has(skillId)) {
      seenSkills.add(skillId);
      distinctSkillIds.push(skillId);
    }
  }

  const learnersBySkill = new Map<string, Set<string>>();
  for (const skillId of distinctSkillIds) {
    learnersBySkill.set(skillId, new Set<string>());
  }

  for (const [i, ev] of input.events.entries()) {
    const learnerId = normalizeIdentifier(
      ev.learnerId,
      `events[${i}].learnerId`,
    );
    const skillId = normalizeIdentifier(ev.skillId, `events[${i}].skillId`);
    const occurredAtMs = assertSafeTimestampMs(
      ev.occurredAtMs,
      `events[${i}].occurredAtMs`,
    );
    const recordedAtMs = assertSafeTimestampMs(
      ev.recordedAtMs,
      `events[${i}].recordedAtMs`,
    );
    // Post-close late-ingested events cannot retroactively mutate a closed week.
    if (recordedAtMs > validatedWindow.weekEndUtcMs) {
      continue;
    }

    if (
      occurredAtMs < validatedWindow.weekStartUtcMs ||
      occurredAtMs >= validatedWindow.weekEndUtcMs
    ) {
      continue;
    }
    if (!enrolledSet.has(learnerId)) {
      continue;
    }
    const bucket = learnersBySkill.get(skillId);
    if (bucket) {
      bucket.add(learnerId);
    }
  }

  const n = enrolledSet.size;
  const cells: BilateralCohortCellInput[] = distinctSkillIds.map((skillId) => ({
    skillId,
    enrolledActiveCount: n,
    eventLearnerCount: learnersBySkill.get(skillId)?.size ?? 0,
  }));

  return buildCohortHeatmap({
    cohortId,
    mode: input.mode,
    role: input.role,
    window: {
      weekStartUtcMs: validatedWindow.weekStartUtcMs,
      weekEndUtcMs: validatedWindow.weekEndUtcMs,
    },
    evaluatedAtMs,
    frozenRosterDigest,
    cells,
    publishedSnapshots: input.publishedSnapshots,
  });
}

/* ============================================================================
 * 3. Pure LTI 1.3 Deep-Linking Payload & Claims Validator
 * ========================================================================== */

export const LTI_13_VERSION = "1.3.0";
export const LTI_CLAIM_MESSAGE_TYPE =
  "https://purl.imsglobal.org/spec/lti/claim/message_type";
export const LTI_CLAIM_VERSION =
  "https://purl.imsglobal.org/spec/lti/claim/version";
export const LTI_CLAIM_DEPLOYMENT_ID =
  "https://purl.imsglobal.org/spec/lti/claim/deployment_id";
export const LTI_CLAIM_ROLES =
  "https://purl.imsglobal.org/spec/lti/claim/roles";
export const LTI_CLAIM_CONTEXT =
  "https://purl.imsglobal.org/spec/lti/claim/context";
export const LTI_CLAIM_RESOURCE_LINK =
  "https://purl.imsglobal.org/spec/lti/claim/resource_link";
export const LTI_CLAIM_DEEP_LINKING_SETTINGS =
  "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings";
export const LTI_CLAIM_CUSTOM =
  "https://purl.imsglobal.org/spec/lti/claim/custom";

export type Lti13MessageType =
  | "LtiDeepLinkingRequest"
  | "LtiResourceLinkRequest";

export interface Lti13DeepLinkingSettingsClaim {
  readonly deep_link_return_url?: string;
  readonly accept_types?: ReadonlyArray<string>;
  readonly accept_presentation_document_targets?: ReadonlyArray<string>;
  readonly accept_multiple?: boolean;
  readonly data?: string;
}

export interface Lti13ResourceLinkClaim {
  readonly id?: string;
  readonly title?: string;
  readonly target_link_uri?: string;
}

export interface Lti13ContextClaim {
  readonly id?: string;
  readonly label?: string;
  readonly title?: string;
}

export interface Lti13DeepLinkingClaimsPayload {
  readonly iss?: string;
  readonly sub?: string;
  readonly aud?: string | ReadonlyArray<string>;
  readonly azp?: string;
  readonly nonce?: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly [LTI_CLAIM_VERSION]?: string;
  readonly [LTI_CLAIM_MESSAGE_TYPE]?: string;
  readonly [LTI_CLAIM_DEPLOYMENT_ID]?: string;
  readonly [LTI_CLAIM_ROLES]?: ReadonlyArray<string>;
  readonly [LTI_CLAIM_CONTEXT]?: Lti13ContextClaim;
  readonly [LTI_CLAIM_RESOURCE_LINK]?: Lti13ResourceLinkClaim;
  readonly [LTI_CLAIM_DEEP_LINKING_SETTINGS]?: Lti13DeepLinkingSettingsClaim;
  readonly [LTI_CLAIM_CUSTOM]?: Readonly<Record<string, unknown>>;
}

export interface Lti13ValidationPolicy {
  readonly expectedIssuer: string;
  readonly expectedClientId: string;
  readonly allowedDeploymentIds: ReadonlyArray<string>;
  /** Exact single-launch nonce initiated for this OIDC/LTI request (OIDC Core §3.1.3.7). */
  readonly expectedNonce: string;
  /** Optional active-session launch nonce registry; when supplied, claims.nonce MUST match BOTH expectedNonce AND this registry. */
  readonly issuedLaunchNonces?: ReadonlySet<string> | ReadonlyArray<string>;
  readonly nowMs: number;
  readonly maxClockSkewSeconds?: number;
  readonly usedNonces?: ReadonlySet<string>;
  readonly allowedMessageTypes?: ReadonlyArray<Lti13MessageType>;
  readonly allowedReturnOrigins?: ReadonlyArray<string>;
  readonly allowedCartridgeIds?: ReadonlyArray<string>;
  readonly allowedCourseIds?: ReadonlyArray<string>;
}

export type Lti13ValidationErrorCode =
  | "INVALID_ISSUER"
  | "INVALID_CLIENT_ID"
  | "INVALID_SUBJECT"
  | "INVALID_DEPLOYMENT_ID"
  | "INVALID_NONCE"
  | "UNRECOGNIZED_NONCE"
  | "NONCE_REPLAYED"
  | "TOKEN_EXPIRED"
  | "INVALID_TIMESTAMPS"
  | "INVALID_VERSION"
  | "INVALID_MESSAGE_TYPE"
  | "INVALID_DEEP_LINKING_SETTINGS"
  | "INVALID_TARGET_RESOURCE_LINK"
  | "NO_VALID_LTI_ROLE"
  | "FORBIDDEN_PRIVACY_SCOPE";

export interface Lti13ValidationIssue {
  readonly code: Lti13ValidationErrorCode;
  readonly message: string;
}

export interface Lti13PrivacyBoundary {
  readonly canViewAggregatedCohortHeatmap: boolean;
  readonly canAccessSoloLearnerPrivateNotes: false;
  readonly canAccessRawAttemptTranscripts: false;
  readonly canQuerySlidingTimeWindows: false;
}

export interface ValidatedLti13DeepLinkingContext {
  readonly issuer: string;
  readonly clientId: string;
  readonly deploymentId: string;
  readonly subject: string;
  readonly nonce: string;
  readonly messageType: Lti13MessageType;
  readonly expiresAtMs: number;
  readonly issuedAtMs: number;
  readonly contextId: string | null;
  readonly targetResourceLink: {
    readonly resourceLinkId: string;
    readonly cartridgeId: string | null;
    readonly courseId: string | null;
    readonly targetLinkUri: string | null;
  };
  readonly deepLinkReturnUrl: string | null;
  readonly mappedRole: CohortViewerRole;
  readonly matchedRoleUris: ReadonlyArray<string>;
  readonly privacyBoundary: Lti13PrivacyBoundary;
}

export type Lti13ValidationResult =
  | {
      readonly valid: true;
      readonly context: ValidatedLti13DeepLinkingContext;
      readonly consumedNonce: string;
      /** Immutable updated used-nonce set including `consumedNonce` so replay fails closed. */
      readonly nextUsedNonces: ReadonlySet<string>;
      readonly errors: readonly [];
    }
  | {
      readonly valid: false;
      readonly context: null;
      readonly consumedNonce: null;
      readonly nextUsedNonces: null;
      readonly errors: ReadonlyArray<Lti13ValidationIssue>;
    };

const IMS_ADMIN_ROLE_URIS: ReadonlySet<string> = new Set([
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator",
  "http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator",
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator",
]);

const IMS_INSTRUCTOR_ROLE_URIS: ReadonlySet<string> = new Set([
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor",
  "http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper",
  "http://purl.imsglobal.org/vocab/lis/v2/membership/Instructor#TeachingAssistant",
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor",
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Faculty",
]);

const IMS_LEARNER_ROLE_URIS: ReadonlySet<string> = new Set([
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner",
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Learner",
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Student",
]);

const SAFE_RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const FORBIDDEN_PRIVACY_CUSTOM_KEYS: ReadonlySet<string> = new Set([
  "solo_private_notes",
  "private_notes",
  "include_solo_notes",
  "raw_attempt_transcripts",
  "attempt_transcripts",
  "include_raw_transcripts",
]);

function isForbiddenPrivacyClaimValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return !Number.isNaN(value) && value !== 0;
  }
  if (typeof value === "bigint") {
    return value !== 0n;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "false" && normalized !== "0";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function parseHttpsUrl(raw: string | undefined): URL | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function isSafeResourceIdentifier(value: string | undefined): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return (
    SAFE_RESOURCE_ID_PATTERN.test(trimmed) && !trimmed.includes("..")
  );
}

function mapImsLtiRoles(rawRoles: ReadonlyArray<string> | undefined): {
  readonly mappedRole: CohortViewerRole | null;
  readonly matchedRoleUris: ReadonlyArray<string>;
} {
  if (!Array.isArray(rawRoles)) {
    return { mappedRole: null, matchedRoleUris: [] };
  }

  let hasAdmin = false;
  let hasInstructor = false;
  let hasLearner = false;
  const matched: string[] = [];

  for (const role of rawRoles) {
    if (typeof role !== "string") {
      continue;
    }
    const normalized = role.trim();
    if (IMS_ADMIN_ROLE_URIS.has(normalized)) {
      hasAdmin = true;
      matched.push(normalized);
    } else if (IMS_INSTRUCTOR_ROLE_URIS.has(normalized)) {
      hasInstructor = true;
      matched.push(normalized);
    } else if (IMS_LEARNER_ROLE_URIS.has(normalized)) {
      hasLearner = true;
      matched.push(normalized);
    }
  }

  if (hasAdmin) {
    return { mappedRole: "admin", matchedRoleUris: matched };
  }
  if (hasInstructor) {
    return { mappedRole: "instructor", matchedRoleUris: matched };
  }
  if (hasLearner) {
    return { mappedRole: "learner", matchedRoleUris: matched };
  }
  return { mappedRole: null, matchedRoleUris: [] };
}

/**
 * Pure fail-closed LTI 1.3 deep-linking claims & resource-link validator.
 * Rejects invalid issuer, client_id/azp, deployment_id, nonce replay, expired
 * tokens, unsafe resource links, unrecognized roles, and any attempt to
 * request solo learner private notes or raw attempt transcripts.
 */
export function validateLti13DeepLinkingClaims(
  claims: Lti13DeepLinkingClaimsPayload,
  policy: Lti13ValidationPolicy,
): Lti13ValidationResult {
  const nowMs = assertSafeTimestampMs(policy.nowMs, "policy.nowMs");
  const maxClockSkewSeconds = assertNonNegativeSafeInteger(
    policy.maxClockSkewSeconds ?? 60,
    "policy.maxClockSkewSeconds",
  );
  const expectedIssuer = normalizeIdentifier(
    policy.expectedIssuer,
    "policy.expectedIssuer",
  );
  const expectedClientId = normalizeIdentifier(
    policy.expectedClientId,
    "policy.expectedClientId",
  );
  const allowedDeploymentIds = new Set(
    policy.allowedDeploymentIds.map((id, idx) =>
      normalizeIdentifier(id, `policy.allowedDeploymentIds[${idx}]`),
    ),
  );
  if (
    typeof policy.expectedNonce !== "string" ||
    policy.expectedNonce.length === 0 ||
    /\s/.test(policy.expectedNonce)
  ) {
    throw new CommercialResilienceError(
      "INVALID_IDENTIFIER",
      "policy.expectedNonce must be a non-empty string with no whitespace",
    );
  }
  const expectedNonce = policy.expectedNonce;
  let activeLaunchRegistry: Set<string> | null = null;
  if (policy.issuedLaunchNonces !== undefined) {
    activeLaunchRegistry = new Set<string>();
    let idx = 0;
    for (const rawNonce of policy.issuedLaunchNonces) {
      if (
        typeof rawNonce !== "string" ||
        rawNonce.length === 0 ||
        /\s/.test(rawNonce)
      ) {
        throw new CommercialResilienceError(
          "INVALID_IDENTIFIER",
          `policy.issuedLaunchNonces[${idx}] must be a non-empty string with no whitespace`,
        );
      }
      activeLaunchRegistry.add(rawNonce);
      idx += 1;
    }
    if (activeLaunchRegistry.size === 0) {
      throw new CommercialResilienceError(
        "INVALID_IDENTIFIER",
        "policy.issuedLaunchNonces must be non-empty when provided",
      );
    }
  }
  const allowedMessageTypes = new Set<Lti13MessageType>(
    policy.allowedMessageTypes ?? ["LtiDeepLinkingRequest"],
  );
  const allowedReturnOrigins = policy.allowedReturnOrigins
    ? new Set(policy.allowedReturnOrigins.map((origin) => origin.trim()))
    : null;
  const allowedCartridgeIds = policy.allowedCartridgeIds
    ? new Set(
        policy.allowedCartridgeIds.map((id, idx) =>
          normalizeIdentifier(id, `policy.allowedCartridgeIds[${idx}]`),
        ),
      )
    : null;
  const allowedCourseIds = policy.allowedCourseIds
    ? new Set(
        policy.allowedCourseIds.map((id, idx) =>
          normalizeIdentifier(id, `policy.allowedCourseIds[${idx}]`),
        ),
      )
    : null;

  const errors: Lti13ValidationIssue[] = [];

  // 1. Issuer (`iss`)
  const issuerUrl = parseHttpsUrl(claims.iss);
  const trimmedIssuer = typeof claims.iss === "string" ? claims.iss.trim() : "";
  if (!issuerUrl || trimmedIssuer !== expectedIssuer) {
    errors.push({
      code: "INVALID_ISSUER",
      message: "LTI 1.3 iss claim must be an exact registered https:// issuer",
    });
  }

  // 2. Client ID (`aud` + OIDC Core §3.1.3.7 `azp` validation)
  const rawAud = claims.aud;
  const azpPresent = claims.azp !== undefined;
  const azpMatchesClient =
    typeof claims.azp === "string" && claims.azp.trim() === expectedClientId;
  let audValid = false;
  if (typeof rawAud === "string") {
    audValid =
      rawAud.trim() === expectedClientId && (!azpPresent || azpMatchesClient);
  } else if (
    Array.isArray(rawAud) &&
    rawAud.length > 0 &&
    rawAud.every((item): item is string => typeof item === "string")
  ) {
    const trimmedAud = rawAud.map((item) => item.trim());
    const containsClient = trimmedAud.includes(expectedClientId);
    if (trimmedAud.length === 1) {
      audValid = containsClient && (!azpPresent || azpMatchesClient);
    } else if (trimmedAud.length > 1) {
      audValid = containsClient && azpMatchesClient;
    }
  }
  if (!audValid) {
    errors.push({
      code: "INVALID_CLIENT_ID",
      message:
        "LTI 1.3 aud (and azp when present or for multi-audience tokens) must match registered client_id",
    });
  }

  // 3. Subject (`sub`)
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (subject.length === 0) {
    errors.push({
      code: "INVALID_SUBJECT",
      message: "LTI 1.3 sub claim must be a non-empty string",
    });
  }

  // 4. Deployment ID
  const deploymentId =
    typeof claims[LTI_CLAIM_DEPLOYMENT_ID] === "string"
      ? claims[LTI_CLAIM_DEPLOYMENT_ID].trim()
      : "";
  if (deploymentId.length === 0 || !allowedDeploymentIds.has(deploymentId)) {
    errors.push({
      code: "INVALID_DEPLOYMENT_ID",
      message: "LTI 1.3 deployment_id is missing or not registered",
    });
  }

  // 5. Exact byte-for-byte nonce validation bound to single-launch expectedNonce (+ optional active-session registry) + replay protection
  const rawNonce = claims.nonce;
  let validNonce: string | null = null;
  if (
    typeof rawNonce !== "string" ||
    rawNonce.length === 0 ||
    /\s/.test(rawNonce)
  ) {
    errors.push({
      code: "INVALID_NONCE",
      message:
        "LTI 1.3 nonce must be a non-empty string with no leading, trailing, or internal whitespace",
    });
  } else if (policy.usedNonces?.has(rawNonce)) {
    errors.push({
      code: "NONCE_REPLAYED",
      message: `LTI 1.3 nonce "${rawNonce}" has already been consumed`,
    });
  } else if (
    rawNonce !== expectedNonce ||
    (activeLaunchRegistry !== null && !activeLaunchRegistry.has(rawNonce))
  ) {
    errors.push({
      code: "UNRECOGNIZED_NONCE",
      message:
        "LTI 1.3 nonce must match this launch's exact expectedNonce byte-for-byte (and active session registry if provided)",
    });
  } else {
    validNonce = rawNonce;
  }

  // 6. Expiration (`exp`) & issued-at (`iat`)
  const exp = claims.exp;
  const iat = claims.iat;
  const nowSeconds = Math.floor(nowMs / 1000);
  let validExp: number | null = null;
  let validIat: number | null = null;
  if (
    typeof exp !== "number" ||
    !Number.isSafeInteger(exp) ||
    typeof iat !== "number" ||
    !Number.isSafeInteger(iat) ||
    exp <= iat ||
    iat > nowSeconds + maxClockSkewSeconds
  ) {
    errors.push({
      code: "INVALID_TIMESTAMPS",
      message: "LTI 1.3 iat/exp claims must be valid safe-integer Unix seconds with iat < exp",
    });
  } else if (nowSeconds >= exp + maxClockSkewSeconds) {
    errors.push({
      code: "TOKEN_EXPIRED",
      message: "LTI 1.3 token has expired",
    });
  } else {
    validExp = exp;
    validIat = iat;
  }

  // 7. LTI Version & Message Type
  if (claims[LTI_CLAIM_VERSION] !== LTI_13_VERSION) {
    errors.push({
      code: "INVALID_VERSION",
      message: `LTI version claim must equal "${LTI_13_VERSION}"`,
    });
  }

  const rawMessageType = claims[LTI_CLAIM_MESSAGE_TYPE];
  const validMessageType =
    (rawMessageType === "LtiDeepLinkingRequest" ||
      rawMessageType === "LtiResourceLinkRequest") &&
    allowedMessageTypes.has(rawMessageType)
      ? rawMessageType
      : null;
  if (!validMessageType) {
    errors.push({
      code: "INVALID_MESSAGE_TYPE",
      message: "LTI message_type is unsupported or not permitted by policy",
    });
  }

  // 8. Deep-Linking Settings (mandatory for LtiDeepLinkingRequest)
  let deepLinkReturnUrl: string | null = null;
  if (validMessageType === "LtiDeepLinkingRequest") {
    const settings = claims[LTI_CLAIM_DEEP_LINKING_SETTINGS];
    const parsedReturnUrl = parseHttpsUrl(settings?.deep_link_return_url);
    const acceptsResourceLink =
      Array.isArray(settings?.accept_types) &&
      settings.accept_types.includes("ltiResourceLink");
    const originAllowed =
      parsedReturnUrl !== null &&
      (allowedReturnOrigins === null ||
        allowedReturnOrigins.has(parsedReturnUrl.origin));

    if (!parsedReturnUrl || !acceptsResourceLink || !originAllowed) {
      errors.push({
        code: "INVALID_DEEP_LINKING_SETTINGS",
        message:
          "LtiDeepLinkingRequest requires an allowed https:// deep_link_return_url and accept_types including ltiResourceLink",
      });
    } else {
      deepLinkReturnUrl = parsedReturnUrl.toString();
    }
  }

  // 9. Target cartridge/course resource link validation
  const rawCustom = claims[LTI_CLAIM_CUSTOM];
  const custom: Readonly<Record<string, unknown>> =
    typeof rawCustom === "object" && rawCustom !== null && !Array.isArray(rawCustom)
      ? (rawCustom as Readonly<Record<string, unknown>>)
      : {};
  const resourceLink = claims[LTI_CLAIM_RESOURCE_LINK];

  const customResourceLinkId =
    typeof custom.resource_link_id === "string"
      ? custom.resource_link_id
      : undefined;
  const rawResourceLinkId = resourceLink?.id ?? customResourceLinkId;
  const rawCartridgeId = custom.cartridge_id;
  const rawCourseId = custom.course_id;
  const rawTargetUri =
    resourceLink?.target_link_uri ?? custom.target_link_uri;

  const resourceLinkId = isSafeResourceIdentifier(rawResourceLinkId)
    ? rawResourceLinkId.trim()
    : null;
  const cartridgeId =
    rawCartridgeId === undefined
      ? null
      : typeof rawCartridgeId === "string" &&
          isSafeResourceIdentifier(rawCartridgeId)
        ? rawCartridgeId.trim()
        : "INVALID";
  const courseId =
    rawCourseId === undefined
      ? null
      : typeof rawCourseId === "string" && isSafeResourceIdentifier(rawCourseId)
        ? rawCourseId.trim()
        : "INVALID";

  let targetLinkUri: string | null = null;
  let targetUriValid = true;
  if (rawTargetUri !== undefined) {
    const parsed =
      typeof rawTargetUri === "string" ? parseHttpsUrl(rawTargetUri) : null;
    if (!parsed) {
      targetUriValid = false;
    } else {
      targetLinkUri = parsed.toString();
    }
  }

  const cartridgeIdValid =
    cartridgeId !== "INVALID" &&
    (allowedCartridgeIds === null ||
      (cartridgeId === null
        ? allowedCourseIds !== null && courseId !== null
        : allowedCartridgeIds.has(cartridgeId)));
  const courseIdValid =
    courseId !== "INVALID" &&
    (allowedCourseIds === null ||
      (courseId === null
        ? allowedCartridgeIds !== null && cartridgeId !== null
        : allowedCourseIds.has(courseId)));
  const hasTargetAsset =
    (cartridgeId !== null && cartridgeId !== "INVALID") ||
    (courseId !== null && courseId !== "INVALID");

  if (
    !resourceLinkId ||
    !hasTargetAsset ||
    !targetUriValid ||
    !cartridgeIdValid ||
    !courseIdValid
  ) {
    errors.push({
      code: "INVALID_TARGET_RESOURCE_LINK",
      message:
        "Target cartridge/course resource link must specify a safe resource_link id, allowed cartridge_id or course_id, and https:// target_link_uri if present",
    });
  }

  // 10. Strict IMS LIS Role Mapping (fail-closed)
  const { mappedRole, matchedRoleUris } = mapImsLtiRoles(
    claims[LTI_CLAIM_ROLES],
  );
  if (!mappedRole) {
    errors.push({
      code: "NO_VALID_LTI_ROLE",
      message: "At least one recognized IMS LIS v2 role URI is required",
    });
  }

  // 11. Hard Privacy Boundary Guard against forbidden custom scopes/claims
  for (const [key, value] of Object.entries(custom)) {
    const normalizedKey = key.trim().toLowerCase();
    if (
      FORBIDDEN_PRIVACY_CUSTOM_KEYS.has(normalizedKey) &&
      isForbiddenPrivacyClaimValue(value)
    ) {
      errors.push({
        code: "FORBIDDEN_PRIVACY_SCOPE",
        message: `LTI launch cannot request solo private notes or raw attempt transcripts (forbidden claim "${key}")`,
      });
    }
  }

  if (
    errors.length > 0 ||
    !validMessageType ||
    !mappedRole ||
    !resourceLinkId ||
    validExp === null ||
    validIat === null ||
    validNonce === null
  ) {
    return {
      valid: false,
      context: null,
      consumedNonce: null,
      nextUsedNonces: null,
      errors,
    };
  }

  const contextId =
    typeof claims[LTI_CLAIM_CONTEXT]?.id === "string" &&
    claims[LTI_CLAIM_CONTEXT].id.trim().length > 0
      ? claims[LTI_CLAIM_CONTEXT].id.trim()
      : null;

  const nextUsedNonces = new Set<string>(policy.usedNonces ?? []);
  nextUsedNonces.add(validNonce);

  return {
    valid: true,
    consumedNonce: validNonce,
    nextUsedNonces,
    errors: [],
    context: {
      issuer: trimmedIssuer,
      clientId: expectedClientId,
      deploymentId,
      subject,
      nonce: validNonce,
      messageType: validMessageType,
      expiresAtMs: validExp * 1000,
      issuedAtMs: validIat * 1000,
      contextId,
      targetResourceLink: {
        resourceLinkId,
        cartridgeId: cartridgeId === "INVALID" ? null : cartridgeId,
        courseId: courseId === "INVALID" ? null : courseId,
        targetLinkUri,
      },
      deepLinkReturnUrl,
      mappedRole,
      matchedRoleUris,
      privacyBoundary: {
        canViewAggregatedCohortHeatmap:
          mappedRole === "instructor" || mappedRole === "admin",
        canAccessSoloLearnerPrivateNotes: false,
        canAccessRawAttemptTranscripts: false,
        canQuerySlidingTimeWindows: false,
      },
    },
  };
}
