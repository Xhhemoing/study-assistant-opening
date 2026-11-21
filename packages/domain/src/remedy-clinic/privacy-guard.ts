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

const MAX_ACTIVE_SOURCES_DEPTH = 32;

function walkActiveSourcesPlainValue(
  value: unknown,
  seen: Set<object>,
  preOrder: object[],
  depth: number,
): boolean {
  if (value === null || value === undefined) return true;
  const kind = typeof value;
  if (kind === "boolean" || kind === "number" || kind === "string" || kind === "bigint") return true;
  if (kind !== "object") return false;
  const obj = value as object;
  if (seen.has(obj)) return true;
  if (depth > MAX_ACTIVE_SOURCES_DEPTH) return false;
  seen.add(obj);
  preOrder.push(obj);
  try {
    const proto = Object.getPrototypeOf(obj) as object | null;
    if (Array.isArray(obj)) {
      if (proto !== Array.prototype) return false;
      const lenDesc = Object.getOwnPropertyDescriptor(obj, "length");
      if (
        !lenDesc ||
        !Object.hasOwn(lenDesc, "value") ||
        typeof lenDesc.value !== "number" ||
        !Number.isInteger(lenDesc.value) ||
        lenDesc.value < 0
      ) {
        return false;
      }
      const len = lenDesc.value;
      if (Reflect.ownKeys(obj).length !== len + 1) return false;
      if (hasGuardExoticBrand(obj, Array.prototype, false)) return false;
      const children: unknown[] = new Array(len);
      for (let i = 0; i < len; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(obj, String(i));
        if (
          !desc ||
          !desc.enumerable ||
          !Object.hasOwn(desc, "value") ||
          desc.get !== undefined ||
          desc.set !== undefined
        ) {
          return false;
        }
        children[i] = desc.value;
      }
      for (let i = 0; i < len; i += 1) {
        if (!walkActiveSourcesPlainValue(children[i], seen, preOrder, depth + 1)) return false;
      }
      return true;
    }
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Reflect.ownKeys(obj);
    let hasOwnCtor = false;
    const children: unknown[] = [];
    for (const key of keys) {
      if (typeof key !== "string" || key === "__proto__") return false;
      if (key === "constructor") hasOwnCtor = true;
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (
        !desc ||
        !desc.enumerable ||
        !Object.hasOwn(desc, "value") ||
        desc.get !== undefined ||
        desc.set !== undefined
      ) {
        return false;
      }
      children.push(desc.value);
    }
    if (hasGuardExoticBrand(obj, proto, hasOwnCtor)) return false;
    for (let i = 0; i < children.length; i += 1) {
      if (!walkActiveSourcesPlainValue(children[i], seen, preOrder, depth + 1)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Plain-data schema parser for a single already-verified ActiveSourcesMap entry.
 * Called ONLY after the entire container graph has passed descriptor-walk and reverse-pre-order
 * structuredClone verification; malformed plain-data entries (e.g. null, arrays, non-finite numbers,
 * blank version, or non-boolean active/revoked such as {}, [], "yes") degrade ONLY that entry to
 * undefined while preserving valid sibling sources.
 */
function parsePlainActiveSourceEntry(rawEntry: unknown): ActiveSourceEntry | undefined {
  if (typeof rawEntry === "string" || typeof rawEntry === "number") {
    return isValidSourceVersion(rawEntry) ? rawEntry : undefined;
  }
  if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return undefined;
  }
  const versionDesc = Object.getOwnPropertyDescriptor(rawEntry, "version");
  const version = versionDesc && Object.hasOwn(versionDesc, "value") ? versionDesc.value : undefined;
  if (!isValidSourceVersion(version)) {
    return undefined;
  }
  const activeDesc = Object.getOwnPropertyDescriptor(rawEntry, "active");
  const revokedDesc = Object.getOwnPropertyDescriptor(rawEntry, "revoked");
  const hasActive = activeDesc !== undefined;
  const hasRevoked = revokedDesc !== undefined;
  const active = hasActive && Object.hasOwn(activeDesc, "value") ? activeDesc.value : undefined;
  const revoked = hasRevoked && Object.hasOwn(revokedDesc, "value") ? revokedDesc.value : undefined;
  if ((hasActive && typeof active !== "boolean") || (hasRevoked && typeof revoked !== "boolean")) {
    return undefined;
  }
  return Object.freeze({
    version,
    ...(typeof active === "boolean" ? { active } : {}),
    ...(typeof revoked === "boolean" ? { revoked } : {}),
  });
}

export interface ActiveSourcesInspection {
  readonly containerValid: boolean;
  readonly sources: ReadonlyMap<string, ActiveSourceEntry>;
}

/**
 * Unified JS-security vs plain-data-schema inspection of ActiveSourcesMap:
 * - JS security boundary (getters/setters, Proxy, Promise, Generator, exotics, functions, symbols,
 *   forged Map, non-string Map key, own "__proto__", excessive depth): aborts BEFORE structuredClone
 *   (zero getter executions) or catches any Proxy via unconditional reverse-pre-order structuredClone,
 *   failing closed at container level (`containerValid: false`, empty sources).
 * - Plain-data schema boundary (valid plain Record or genuine Map whose entries contain malformed
 *   plain-data values like `{ version: "v1", active: {} }`, `{ version: "v1", revoked: [] }`,
 *   `{ version: "v1", active: "yes" }`, `{ version: "" }`, `null`, `[]`, `true`, `NaN`): degrades ONLY
 *   that entry to inactive while preserving all valid sibling sources (`containerValid: true`).
 */
export function inspectActiveSourcesMap(activeSourcesMap: ActiveSourcesMap): ActiveSourcesInspection {
  if (!activeSourcesMap || typeof activeSourcesMap !== "object") {
    return { containerValid: false, sources: new Map<string, ActiveSourceEntry>() };
  }
  if (VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.has(activeSourcesMap as ReadonlyMap<string, ActiveSourceEntry>)) {
    return {
      containerValid: true,
      sources: activeSourcesMap as ReadonlyMap<string, ActiveSourceEntry>,
    };
  }

  if (isGenuinePlainMap(activeSourcesMap)) {
    const rawEntries: Array<readonly [string, unknown]> = [];
    const seen = new Set<object>([activeSourcesMap]);
    const preOrder: object[] = [activeSourcesMap];
    let containerOk = true;
    try {
      Reflect.apply(Map.prototype.forEach, activeSourcesMap, [
        (rawEntry: unknown, rawKey: unknown) => {
          if (!containerOk) return;
          if (typeof rawKey !== "string") {
            containerOk = false;
            return;
          }
          if (!walkActiveSourcesPlainValue(rawEntry, seen, preOrder, 1)) {
            containerOk = false;
            return;
          }
          rawEntries.push([rawKey, rawEntry]);
        },
      ]);
      if (!containerOk) {
        return { containerValid: false, sources: new Map<string, ActiveSourceEntry>() };
      }
      for (let i = preOrder.length - 1; i >= 0; i -= 1) {
        structuredClone(preOrder[i]);
      }
      const mapSnap = new Map<string, ActiveSourceEntry>();
      for (let i = 0; i < rawEntries.length; i += 1) {
        const pair = rawEntries[i]!;
        const parsed = parsePlainActiveSourceEntry(pair[1]);
        if (parsed !== undefined) {
          mapSnap.set(pair[0], parsed);
        }
      }
      VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.add(mapSnap);
      return { containerValid: true, sources: mapSnap };
    } catch {
      return { containerValid: false, sources: new Map<string, ActiveSourceEntry>() };
    }
  }

  const recordSnap = snapshotOwnGuardRecord(activeSourcesMap);
  if (!recordSnap) {
    return { containerValid: false, sources: new Map<string, ActiveSourceEntry>() };
  }

  const seen = new Set<object>([activeSourcesMap as object]);
  const preOrder: object[] = [activeSourcesMap as object];
  const keys = Object.keys(recordSnap);
  for (let i = 0; i < keys.length; i += 1) {
    if (!walkActiveSourcesPlainValue(recordSnap[keys[i]!], seen, preOrder, 1)) {
      return { containerValid: false, sources: new Map<string, ActiveSourceEntry>() };
    }
  }
  for (let i = preOrder.length - 1; i >= 0; i -= 1) {
    try {
      structuredClone(preOrder[i]);
    } catch {
      return { containerValid: false, sources: new Map<string, ActiveSourceEntry>() };
    }
  }

  const snapshot = new Map<string, ActiveSourceEntry>();
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    const parsed = parsePlainActiveSourceEntry(recordSnap[key]);
    if (parsed !== undefined) {
      snapshot.set(key, parsed);
    }
  }
  VERIFIED_ACTIVE_SOURCE_SNAPSHOTS.add(snapshot);
  return { containerValid: true, sources: snapshot };
}

export function snapshotActiveSourcesMap(activeSourcesMap: ActiveSourcesMap): ReadonlyMap<string, ActiveSourceEntry> {
  return inspectActiveSourcesMap(activeSourcesMap).sources;
}

function isFrozenSourceRefActive(
  ref: RemedySourceRef,
  verifiedSources: ReadonlyMap<string, ActiveSourceEntry>,
): boolean {
  const entry = verifiedSources.get(ref.sourceId);
  if (entry === undefined) return false;
  if (typeof entry === "string" || typeof entry === "number") {
    return entry === ref.sourceVersion;
  }
  if (entry.revoked === true || entry.active === false) {
    return false;
  }
  return entry.version === ref.sourceVersion;
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
  return isFrozenSourceRefActive({ sourceId, sourceVersion }, verifiedSources);
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
  const refsRes = snapshotSourceRefsStrict(sourceRefs);
  if (!refsRes.ok || refsRes.refs.length === 0) return false;
  const verifiedSources = snapshotActiveSourcesMap(activeSourcesMap);
  for (let i = 0; i < refsRes.refs.length; i += 1) {
    if (!isFrozenSourceRefActive(refsRes.refs[i]!, verifiedSources)) return false;
  }
  return true;
}

function snapshotSourceRefsStrict(
  sourceRefs: unknown,
): { readonly ok: true; readonly refs: readonly RemedySourceRef[] } | { readonly ok: false } {
  const items = snapshotDenseArray(sourceRefs);
  if (!items) return { ok: false };
  const preOrder: object[] = [sourceRefs as object];
  const cloned: RemedySourceRef[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === null || typeof item !== "object") return { ok: false };
    preOrder.push(item as object);
    const itemSnap = snapshotOwnGuardRecord(item);
    if (!itemSnap) return { ok: false };
    for (const key of Object.keys(itemSnap)) {
      if (!isPrimitiveValue(itemSnap[key])) return { ok: false };
    }
    const sourceId = itemSnap["sourceId"];
    const sourceVersion = itemSnap["sourceVersion"];
    if (!isNonBlankText(sourceId) || !isValidSourceVersion(sourceVersion)) {
      return { ok: false };
    }
    cloned.push(Object.freeze({ sourceId, sourceVersion }));
  }
  // Reverse-pre-order per-node structuredClone: catches self-detaching element Proxies
  // before testing the outer array or earlier elements.
  for (let i = preOrder.length - 1; i >= 0; i -= 1) {
    try {
      structuredClone(preOrder[i]);
    } catch {
      return { ok: false };
    }
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
  const readTrimmed = (key: string): string => (typeof snap[key] === "string" ? (snap[key] as string).trim() : "");
  const epoch = snap["privacyEpoch"];
  return Object.freeze({
    attemptId: readTrimmed("attemptId"),
    rootAttemptId: readTrimmed("rootAttemptId"),
    chapterId: readTrimmed("chapterId"),
    localDate: readStr("localDate"),
    ruleId: readTrimmed("ruleId"),
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
  const items = snapshotDenseArray(cases);
  if (!items) {
    return { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 };
  }
  let allCloneSafe = true;
  for (const rawItem of items) {
    const item = cloneEvidenceCase(rawItem as ClinicEvidenceCase);
    if (item === EMPTY_INVALID_CASE) {
      allCloneSafe = false;
      continue;
    }
    if (
      !isNonBlankText(item.attemptId) ||
      !isNonBlankText(item.rootAttemptId) ||
      !isNonBlankText(item.chapterId) ||
      !isValidLocalDate(item.localDate) ||
      !isNonBlankText(item.ruleId) ||
      !isNonBlankText(item.excerpt) ||
      !isNonBlankText(item.invariantSummary) ||
      !isValidPrivacyEpoch(item.privacyEpoch) ||
      item.sourceRefs.length === 0 ||
      !item.sourceRefs.every(
        (ref) => isNonBlankText(ref.sourceId) && isValidSourceVersion(ref.sourceVersion),
      )
    ) {
      continue;
    }
    roots.add(item.rootAttemptId);
    chapters.add(item.chapterId);
    dates.add(item.localDate);
  }
  if (allCloneSafe) {
    try {
      structuredClone(cases);
    } catch {
      return { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 };
    }
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
