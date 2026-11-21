/**
 * Pure deterministic source-revocation and privacy-epoch guard for RemedyClinicSessionV1.
 * Zero node:* or persistence imports; safe in browser and worker runtimes.
 */

export interface RemedySourceRef {
  readonly sourceId: string;
  readonly sourceVersion: string | number;
}

export type ActiveSourceEntry =
  | string
  | number
  | {
      readonly version: string | number;
      readonly active?: boolean;
      readonly revoked?: boolean;
    };

export type ActiveSourcesMap =
  | ReadonlyMap<string, ActiveSourceEntry>
  | Readonly<Record<string, ActiveSourceEntry>>;

export interface ClinicEvidenceCase {
  readonly attemptId: string;
  readonly rootAttemptId: string;
  readonly chapterId: string;
  readonly localDate: string;
  readonly ruleId: string;
  readonly excerpt: string;
  readonly invariantSummary: string;
  readonly sourceRefs: readonly RemedySourceRef[];
  readonly privacyEpoch: number;
}

export interface SelfDiffEntry {
  readonly rootAttemptId: string;
  readonly chapterId: string;
  readonly localDate: string;
  readonly violatedRuleId: string;
  readonly excerpt: string;
  readonly invariantSummary: string;
  readonly sourceRefs: readonly RemedySourceRef[];
}

export interface EvidenceCoverage {
  readonly rootAttemptCount: number;
  readonly chapterCount: number;
  readonly localDateCount: number;
}

export const MIN_CLINIC_ROOT_ATTEMPTS = 3;
export const MIN_CLINIC_CHAPTERS = 2;
export const MIN_CLINIC_LOCAL_DAYS = 2;
export const SELECTED_DIFF_CASE_COUNT = 3;

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isNonBlankText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isValidPrivacyEpoch(epoch: unknown): epoch is number {
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0;
}

export function isValidLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function localDateToEpochDay(localDate: string): number {
  const match = LOCAL_DATE_PATTERN.exec(localDate);
  if (!match) return 0;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}

function isValidSourceVersion(version: unknown): version is string | number {
  if (typeof version === "string") return version.trim().length > 0;
  return typeof version === "number" && Number.isFinite(version);
}

const GUARD_REGEXP_SOURCE_GET = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
const GUARD_ARRAY_BUFFER_LEN_GET = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const GUARD_DATA_VIEW_LEN_GET = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get;
const GUARD_SHARED_BUFFER_LEN_GET =
  typeof SharedArrayBuffer !== "undefined"
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get
    : undefined;
const GUARD_WEAK_REF_DEREF = typeof WeakRef !== "undefined" ? WeakRef.prototype.deref : undefined;
const GUARD_FINALIZATION_UNREGISTER =
  typeof FinalizationRegistry !== "undefined" ? FinalizationRegistry.prototype.unregister : undefined;
const GUARD_GENERATOR_RETURN = (
  Object.getPrototypeOf(Object.getPrototypeOf((function* () {})())) as { return?: (value?: unknown) => unknown } | null
)?.return;
const GUARD_ERROR_IS_ERROR = (Error as { isError?: (v: unknown) => boolean }).isError;
const GUARD_WEAK_KEY = Object.freeze({});
const VERIFIED_ACTIVE_SOURCE_SNAPSHOTS = new WeakSet<ReadonlyMap<string, ActiveSourceEntry>>();

function matchesGuardBrand(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

function hasGuardExoticBrand(obj: object, proto: object | null, hasOwnConstructor: boolean): boolean {
  try {
    if (ArrayBuffer.isView(obj)) return true;
    if (typeof GUARD_ERROR_IS_ERROR === "function") {
      if (GUARD_ERROR_IS_ERROR(obj)) return true;
    } else if (
      (proto === Object.prototype || proto === null || proto === Array.prototype) &&
      Object.getOwnPropertyDescriptor(obj, Symbol.toStringTag) === undefined &&
      Object.prototype.toString.call(obj) === "[object Error]"
    ) {
      return true;
    }
    if (matchesGuardBrand(() => Reflect.apply(Map.prototype.has, obj, [undefined]))) return true;
    if (matchesGuardBrand(() => Reflect.apply(Set.prototype.has, obj, [undefined]))) return true;
    if (matchesGuardBrand(() => Reflect.apply(WeakMap.prototype.has, obj, [GUARD_WEAK_KEY]))) return true;
    if (matchesGuardBrand(() => Reflect.apply(WeakSet.prototype.has, obj, [GUARD_WEAK_KEY]))) return true;
    if (GUARD_WEAK_REF_DEREF && matchesGuardBrand(() => Reflect.apply(GUARD_WEAK_REF_DEREF, obj, []))) return true;
    if (
      GUARD_FINALIZATION_UNREGISTER &&
      matchesGuardBrand(() => Reflect.apply(GUARD_FINALIZATION_UNREGISTER, obj, [GUARD_WEAK_KEY]))
    ) {
      return true;
    }
    if (matchesGuardBrand(() => Reflect.apply(Date.prototype.getTime, obj, []))) return true;
    if (
      GUARD_REGEXP_SOURCE_GET &&
      obj !== RegExp.prototype &&
      matchesGuardBrand(() => Reflect.apply(GUARD_REGEXP_SOURCE_GET, obj, []))
    ) {
      return true;
    }
    if (GUARD_ARRAY_BUFFER_LEN_GET && matchesGuardBrand(() => Reflect.apply(GUARD_ARRAY_BUFFER_LEN_GET, obj, []))) {
      return true;
    }
    if (GUARD_DATA_VIEW_LEN_GET && matchesGuardBrand(() => Reflect.apply(GUARD_DATA_VIEW_LEN_GET, obj, []))) {
      return true;
    }
    if (GUARD_SHARED_BUFFER_LEN_GET && matchesGuardBrand(() => Reflect.apply(GUARD_SHARED_BUFFER_LEN_GET, obj, []))) {
      return true;
    }
    if (GUARD_GENERATOR_RETURN && matchesGuardBrand(() => Reflect.apply(GUARD_GENERATOR_RETURN, obj, [undefined]))) {
      return true;
    }
    if (proto === Object.prototype && !hasOwnConstructor) {
      try {
        if (Reflect.apply(Promise.resolve, Object, [obj]) === obj) return true;
      } catch {
        // Not a Promise.
      }
    }
    if (matchesGuardBrand(() => Reflect.apply(Number.prototype.valueOf, obj, []))) return true;
    if (matchesGuardBrand(() => Reflect.apply(String.prototype.valueOf, obj, []))) return true;
    if (matchesGuardBrand(() => Reflect.apply(Boolean.prototype.valueOf, obj, []))) return true;
    if (matchesGuardBrand(() => Reflect.apply(Symbol.prototype.valueOf, obj, []))) return true;
    if (matchesGuardBrand(() => Reflect.apply(BigInt.prototype.valueOf, obj, []))) return true;
    return false;
  } catch {
    return true;
  }
}

function isPrimitiveValue(val: unknown): boolean {
  return val === null || (typeof val !== "object" && typeof val !== "function");
}

function snapshotOwnGuardRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  try {
    if (Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(value);
    const snap: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let hasOwnConstructor = false;
    for (const key of keys) {
      if (typeof key !== "string" || key === "__proto__") return null;
      if (key === "constructor") hasOwnConstructor = true;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (
        !desc ||
        !desc.enumerable ||
        !Object.hasOwn(desc, "value") ||
        desc.get !== undefined ||
        desc.set !== undefined
      ) {
        return null;
      }
      Object.defineProperty(snap, key, {
        value: desc.value,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    if (hasGuardExoticBrand(value, proto, hasOwnConstructor)) return null;
    return Object.freeze(snap);
  } catch {
    return null;
  }
}

function snapshotPlainPrimitiveRecord(value: unknown): Record<string, unknown> | null {
  const snap = snapshotOwnGuardRecord(value);
  if (!snap) return null;
  for (const key of Object.keys(snap)) {
    if (!isPrimitiveValue(snap[key])) return null;
  }
  try {
    structuredClone(value);
  } catch {
    return null;
  }
  return snap;
}

function isGenuinePlainMap(value: unknown): value is ReadonlyMap<unknown, unknown> {
  if (value === null || typeof value !== "object") return false;
  try {
    if (Object.getPrototypeOf(value) !== Map.prototype) return false;
    if (Reflect.ownKeys(value).length !== 0) return false;
    Reflect.apply(Map.prototype.has, value, [undefined]);
    return true;
  } catch {
    return false;
  }
}

function snapshotDenseArray(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const lenDesc = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lenDesc ||
      !Object.hasOwn(lenDesc, "value") ||
      typeof lenDesc.value !== "number" ||
      !Number.isInteger(lenDesc.value) ||
      lenDesc.value < 0
    ) {
      return null;
    }
    const len = lenDesc.value;
    if (Reflect.ownKeys(value).length !== len + 1) return null;
    if (hasGuardExoticBrand(value, Array.prototype, false)) return null;
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
    return Object.freeze(out);
  } catch {
    return null;
  }
}

function parseEntrySnap(entry: unknown): { readonly ok: true; readonly entry: ActiveSourceEntry | undefined } | { readonly ok: false } {
  if (entry === null || entry === undefined) return { ok: true, entry: undefined };
  if (typeof entry === "string" || typeof entry === "number") {
    return { ok: true, entry: isValidSourceVersion(entry) ? entry : undefined };
  }
  const snap = snapshotPlainPrimitiveRecord(entry);
  if (!snap) return { ok: false };
  const version = snap["version"];
  if (!isValidSourceVersion(version)) return { ok: true, entry: undefined };
  const hasActive = Object.prototype.hasOwnProperty.call(snap, "active");
  const hasRevoked = Object.prototype.hasOwnProperty.call(snap, "revoked");
  const active = hasActive ? snap["active"] : undefined;
  const revoked = hasRevoked ? snap["revoked"] : undefined;
  if ((hasActive && typeof active !== "boolean") || (hasRevoked && typeof revoked !== "boolean")) {
    return { ok: true, entry: undefined };
  }
  return {
    ok: true,
    entry: Object.freeze({
      version,
      ...(typeof active === "boolean" ? { active } : {}),
      ...(typeof revoked === "boolean" ? { revoked } : {}),
    }),
  };
}

/**
 * Single-pass, Proxy/Promise/Generator/forged-Map-rejecting snapshot of ActiveSourcesMap.
 * Never executes getters and returns an empty Map on any malformed/exotic entry or throw.
 */
export function snapshotActiveSourcesMap(activeSourcesMap: ActiveSourcesMap): ReadonlyMap<string, ActiveSourceEntry> {
  if (!activeSourcesMap || typeof activeSourcesMap !== "object") {
    const empty = new Map<string, ActiveSourceEntry>();
    VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.add(empty);
    return empty;
  }
  if (VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.has(activeSourcesMap as ReadonlyMap<string, ActiveSourceEntry>)) {
    return activeSourcesMap as ReadonlyMap<string, ActiveSourceEntry>;
  }

  if (isGenuinePlainMap(activeSourcesMap)) {
    const mapSnap = new Map<string, ActiveSourceEntry>();
    let invalidOrExotic = false;
    try {
      Reflect.apply(Map.prototype.forEach, activeSourcesMap, [
        (rawEntry: unknown, rawKey: unknown) => {
          if (invalidOrExotic) return;
          if (typeof rawKey !== "string") {
            invalidOrExotic = true;
            return;
          }
          const parsed = parseEntrySnap(rawEntry);
          if (!parsed.ok) {
            invalidOrExotic = true;
            return;
          }
          if (parsed.entry !== undefined) {
            mapSnap.set(rawKey, parsed.entry);
          }
        },
      ]);
      if (invalidOrExotic) {
        const empty = new Map<string, ActiveSourceEntry>();
        VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.add(empty);
        return empty;
      }
      structuredClone(activeSourcesMap);
      VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.add(mapSnap);
      return mapSnap;
    } catch {
      const empty = new Map<string, ActiveSourceEntry>();
      VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.add(empty);
      return empty;
    }
  }

  const recordSnap = snapshotOwnGuardRecord(activeSourcesMap);
  if (!recordSnap) {
    const empty = new Map<string, ActiveSourceEntry>();
    VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.add(empty);
    return empty;
  }

  const snapshot = new Map<string, ActiveSourceEntry>();
  for (const key of Object.keys(recordSnap)) {
    const parsed = parseEntrySnap(recordSnap[key]);
    if (!parsed.ok) {
      const empty = new Map<string, ActiveSourceEntry>();
      VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.add(empty);
      return empty;
    }
    if (parsed.entry !== undefined) {
      snapshot.set(key, parsed.entry);
    }
  }
  try {
    structuredClone(activeSourcesMap);
  } catch {
    const empty = new Map<string, ActiveSourceEntry>();
    VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.add(empty);
    return empty;
  }
  VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.add(snapshot);
  return snapshot;
}

function isSourceRefActiveAgainstVerified(
  ref: RemedySourceRef,
  verifiedSources: ReadonlyMap<string, ActiveSourceEntry>,
): boolean {
  const refSnap = snapshotPlainPrimitiveRecord(ref);
  if (!refSnap) return false;
  const sourceId = refSnap["sourceId"];
  const sourceVersion = refSnap["sourceVersion"];
  if (!isNonBlankText(sourceId) || !isValidSourceVersion(sourceVersion)) return false;
  const entry = verifiedSources.get(sourceId);
  if (entry === undefined) return false;
  if (typeof entry === "string" || typeof entry === "number") {
    return entry === sourceVersion;
  }
  if (entry.revoked === true || entry.active === false) {
    return false;
  }
  return entry.version === sourceVersion;
}

export function isSourceRefActive(
  ref: RemedySourceRef,
  activeSourcesMap: ActiveSourcesMap,
): boolean {
  const verifiedSources = snapshotActiveSourcesMap(activeSourcesMap);
  return isSourceRefActiveAgainstVerified(ref, verifiedSources);
}

export function readOwnDataIndex<T>(
  arr: readonly T[],
  index: number,
): { readonly ok: true; readonly value: T } | { readonly ok: false } {
  try {
    const desc = Object.getOwnPropertyDescriptor(arr, String(index));
    if (!desc || !Object.hasOwn(desc, "value") || desc.get !== undefined || desc.set !== undefined) {
      return { ok: false };
    }
    return { ok: true, value: desc.value as T };
  } catch {
    return { ok: false };
  }
}

export function isDenseArray<T>(value: unknown): value is readonly T[] {
  return snapshotDenseArray(value) !== null;
}

export function areSourceRefsActive(
  sourceRefs: readonly RemedySourceRef[],
  activeSourcesMap: ActiveSourcesMap,
): boolean {
  const items = snapshotDenseArray(sourceRefs);
  if (!items || items.length === 0) return false;
  const verifiedSources = snapshotActiveSourcesMap(activeSourcesMap);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || !isSourceRefActiveAgainstVerified(item as RemedySourceRef, verifiedSources)) return false;
  }
  try {
    structuredClone(sourceRefs);
  } catch {
    return false;
  }
  return true;
}

function snapshotSourceRefsStrict(
  sourceRefs: unknown,
): { readonly ok: true; readonly refs: readonly RemedySourceRef[] } | { readonly ok: false } {
  const items = snapshotDenseArray(sourceRefs);
  if (!items) return { ok: false };
  const cloned: RemedySourceRef[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === null || item === undefined) continue;
    const itemSnap = snapshotPlainPrimitiveRecord(item);
    if (!itemSnap) return { ok: false };
    const sourceId = itemSnap["sourceId"];
    const sourceVersion = itemSnap["sourceVersion"];
    if (
      typeof sourceId !== "string" ||
      (typeof sourceVersion !== "string" && typeof sourceVersion !== "number")
    ) {
      continue;
    }
    cloned.push(Object.freeze({ sourceId, sourceVersion }));
  }
  try {
    structuredClone(sourceRefs);
  } catch {
    return { ok: false };
  }
  return { ok: true, refs: Object.freeze(cloned) };
}

export function cloneSourceRefs(sourceRefs: readonly RemedySourceRef[]): readonly RemedySourceRef[] {
  const result = snapshotSourceRefsStrict(sourceRefs);
  return result.ok ? result.refs : Object.freeze([]);
}

const EMPTY_INVALID_CASE: ClinicEvidenceCase = Object.freeze({
  attemptId: "",
  rootAttemptId: "",
  chapterId: "",
  localDate: "",
  ruleId: "",
  excerpt: "",
  invariantSummary: "",
  sourceRefs: Object.freeze([]),
  privacyEpoch: -1,
});

export function cloneEvidenceCase(item: ClinicEvidenceCase): ClinicEvidenceCase {
  const snap = snapshotOwnGuardRecord(item);
  if (!snap) return EMPTY_INVALID_CASE;

  let frozenRefs: readonly RemedySourceRef[] = Object.freeze([]);
  for (const key of Object.keys(snap)) {
    if (key === "sourceRefs") {
      const refsRes = snapshotSourceRefsStrict(snap[key]);
      if (!refsRes.ok) return EMPTY_INVALID_CASE;
      frozenRefs = refsRes.refs;
      continue;
    }
    if (!isPrimitiveValue(snap[key])) {
      return EMPTY_INVALID_CASE;
    }
  }
  try {
    structuredClone(item);
  } catch {
    return EMPTY_INVALID_CASE;
  }

  const readStr = (key: string): string => (typeof snap[key] === "string" ? (snap[key] as string) : "");
  const epoch = snap["privacyEpoch"];
  return Object.freeze({
    attemptId: readStr("attemptId"),
    rootAttemptId: readStr("rootAttemptId"),
    chapterId: readStr("chapterId"),
    localDate: readStr("localDate"),
    ruleId: readStr("ruleId"),
    excerpt: readStr("excerpt"),
    invariantSummary: readStr("invariantSummary"),
    sourceRefs: frozenRefs,
    privacyEpoch: typeof epoch === "number" ? epoch : -1,
  });
}

export function computeEvidenceCoverage(cases: readonly ClinicEvidenceCase[]): EvidenceCoverage {
  const roots = new Set<string>();
  const chapters = new Set<string>();
  const dates = new Set<string>();
  for (const item of cases) {
    if (isNonBlankText(item.rootAttemptId)) roots.add(item.rootAttemptId.trim());
    if (isNonBlankText(item.chapterId)) chapters.add(item.chapterId.trim());
    if (isValidLocalDate(item.localDate)) dates.add(item.localDate);
  }
  return {
    rootAttemptCount: roots.size,
    chapterCount: chapters.size,
    localDateCount: dates.size,
  };
}

export function meetsClinicThreshold(coverage: EvidenceCoverage): boolean {
  return (
    coverage.rootAttemptCount >= MIN_CLINIC_ROOT_ATTEMPTS &&
    coverage.chapterCount >= MIN_CLINIC_CHAPTERS &&
    coverage.localDateCount >= MIN_CLINIC_LOCAL_DAYS
  );
}

export function buildSelfDiffEntries(cases: readonly ClinicEvidenceCase[]): readonly SelfDiffEntry[] {
  return Object.freeze(
    cases.map((item) =>
      Object.freeze({
        rootAttemptId: item.rootAttemptId,
        chapterId: item.chapterId,
        localDate: item.localDate,
        violatedRuleId: item.ruleId,
        excerpt: item.excerpt,
        invariantSummary: item.invariantSummary,
        sourceRefs: cloneSourceRefs(item.sourceRefs),
      }),
    ),
  );
}

interface TripleScore {
  readonly meetsSpread: number;
  readonly combinedSpread: number;
  readonly chapterCount: number;
  readonly dateCount: number;
  readonly dateSpanDays: number;
  readonly tieKey: string;
}

function scoreTriple(a: ClinicEvidenceCase, b: ClinicEvidenceCase, c: ClinicEvidenceCase): TripleScore {
  const chapterCount = new Set([a.chapterId, b.chapterId, c.chapterId]).size;
  const dateCount = new Set([a.localDate, b.localDate, c.localDate]).size;
  const days = [a.localDate, b.localDate, c.localDate].map(localDateToEpochDay);
  const dateSpanDays = Math.max(...days) - Math.min(...days);
  return {
    meetsSpread: chapterCount >= MIN_CLINIC_CHAPTERS && dateCount >= MIN_CLINIC_LOCAL_DAYS ? 1 : 0,
    combinedSpread: chapterCount + dateCount,
    chapterCount,
    dateCount,
    dateSpanDays,
    tieKey: `${a.rootAttemptId}|${b.rootAttemptId}|${c.rootAttemptId}`,
  };
}

function isBetterTriple(candidate: TripleScore, best: TripleScore): boolean {
  if (candidate.meetsSpread !== best.meetsSpread) return candidate.meetsSpread > best.meetsSpread;
  if (candidate.combinedSpread !== best.combinedSpread) return candidate.combinedSpread > best.combinedSpread;
  if (candidate.chapterCount !== best.chapterCount) return candidate.chapterCount > best.chapterCount;
  if (candidate.dateCount !== best.dateCount) return candidate.dateCount > best.dateCount;
  if (candidate.dateSpanDays !== best.dateSpanDays) return candidate.dateSpanDays > best.dateSpanDays;
  return compareUtf16(candidate.tieKey, best.tieKey) < 0;
}

const SPREAD_POOL_CAP = 36;
const MAX_GUARANTEED_CHAPTERS = 14;
const MAX_GUARANTEED_DATES = 14;

function buildSpreadCandidatePool(ordered: readonly ClinicEvidenceCase[]): readonly ClinicEvidenceCase[] {
  const pool: ClinicEvidenceCase[] = [];
  const includedRoots = new Set<string>();
  const add = (item: ClinicEvidenceCase | undefined): void => {
    if (!item || includedRoots.has(item.rootAttemptId)) return;
    includedRoots.add(item.rootAttemptId);
    pool.push(item);
  };

  // Phase 1: Guarantee chapter diversity across the full ordered list before any cap.
  const seenChapters = new Set<string>();
  for (const item of ordered) {
    if (seenChapters.has(item.chapterId)) continue;
    seenChapters.add(item.chapterId);
    add(item);
    if (seenChapters.size >= MAX_GUARANTEED_CHAPTERS) break;
  }

  // Phase 2: Guarantee calendar-day diversity (including earliest and latest dates first).
  const firstItem = ordered[0];
  const lastItem = ordered[ordered.length - 1];
  add(firstItem);
  add(lastItem);

  const seenDates = new Set<string>();
  if (firstItem) seenDates.add(firstItem.localDate);
  if (lastItem) seenDates.add(lastItem.localDate);
  for (const item of ordered) {
    if (seenDates.has(item.localDate)) continue;
    seenDates.add(item.localDate);
    add(item);
    if (seenDates.size >= MAX_GUARANTEED_DATES) break;
  }

  // Phase 2b: Also capture the latest case for the earliest guaranteed chapters to maximize span.
  const latestChapters = new Set<string>();
  for (let i = ordered.length - 1; i >= 0 && pool.length < SPREAD_POOL_CAP; i--) {
    const item = ordered[i];
    if (!item || latestChapters.has(item.chapterId)) continue;
    latestChapters.add(item.chapterId);
    add(item);
    if (latestChapters.size >= 4) break;
  }

  // Phase 3: Fill remaining pool slots with up to 2 cases per (chapterId, localDate) bucket.
  const bucketCounts = new Map<string, number>();
  for (const item of pool) {
    const key = `${item.chapterId}::${item.localDate}`;
    bucketCounts.set(key, (bucketCounts.get(key) ?? 0) + 1);
  }
  for (const item of ordered) {
    if (pool.length >= SPREAD_POOL_CAP) break;
    if (includedRoots.has(item.rootAttemptId)) continue;
    const key = `${item.chapterId}::${item.localDate}`;
    const count = bucketCounts.get(key) ?? 0;
    if (count < 2) {
      bucketCounts.set(key, count + 1);
      add(item);
    }
  }

  return pool;
}

function constructFallbackSpreadTriple(
  ordered: readonly ClinicEvidenceCase[],
): readonly [ClinicEvidenceCase, ClinicEvidenceCase, ClinicEvidenceCase] | null {
  const first = ordered[0];
  if (!first) return null;
  const second = ordered.find((item) => item.chapterId !== first.chapterId);
  if (!second) return null;
  const third =
    first.localDate === second.localDate
      ? ordered.find(
          (item) =>
            item.rootAttemptId !== first.rootAttemptId &&
            item.rootAttemptId !== second.rootAttemptId &&
            item.localDate !== first.localDate,
        )
      : ordered.find(
          (item) =>
            item.rootAttemptId !== first.rootAttemptId &&
            item.rootAttemptId !== second.rootAttemptId,
        );
  return third ? [first, second, third] : null;
}

/** Deterministically select 3 representative cases maximizing chapter and calendar-day spread. */
export function selectSpreadRepresentativeCases(
  cases: readonly ClinicEvidenceCase[],
): readonly ClinicEvidenceCase[] {
  const items = snapshotDenseArray(cases);
  if (!items) return Object.freeze([]);
  const safeCases = items.map((item) => cloneEvidenceCase(item as ClinicEvidenceCase));
  if (safeCases.length <= SELECTED_DIFF_CASE_COUNT) {
    return Object.freeze(safeCases);
  }

  const ordered = [...safeCases].sort(
    (x, y) =>
      compareUtf16(x.localDate, y.localDate) ||
      compareUtf16(x.chapterId, y.chapterId) ||
      compareUtf16(x.rootAttemptId, y.rootAttemptId),
  );
  const pool = buildSpreadCandidatePool(ordered);

  let bestTuple: readonly [ClinicEvidenceCase, ClinicEvidenceCase, ClinicEvidenceCase] | null = null;
  let bestScore: TripleScore | null = null;

  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (!a) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j];
      if (!b) continue;
      for (let k = j + 1; k < pool.length; k++) {
        const c = pool[k];
        if (!c) continue;
        const score = scoreTriple(a, b, c);
        if (!bestScore || isBetterTriple(score, bestScore)) {
          bestScore = score;
          bestTuple = [a, b, c];
        }
      }
    }
  }

  const inputCoverage = computeEvidenceCoverage(ordered);
  const requiresSpread =
    inputCoverage.chapterCount >= MIN_CLINIC_CHAPTERS &&
    inputCoverage.localDateCount >= MIN_CLINIC_LOCAL_DAYS;

  if (requiresSpread && (!bestTuple || bestScore?.meetsSpread !== 1)) {
    const fallback = constructFallbackSpreadTriple(ordered);
    if (fallback) return Object.freeze([...fallback]);
  }

  return Object.freeze(bestTuple ? [...bestTuple] : ordered.slice(0, SELECTED_DIFF_CASE_COUNT));
}
