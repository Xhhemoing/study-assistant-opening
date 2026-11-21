/**
 * Pure deterministic source-revocation and privacy-epoch guard for RemedyClinicSessionV1.
 * Safe in browser and worker runtimes.
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

const MAX_ACTIVE_SOURCES_ENTRIES = 10_000;
const MAP_SIZE_GET = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!;
const MAP_FOR_EACH = Map.prototype.forEach;
const SET_SIZE_GET = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!;
const IS_ERROR = (Error as { isError?: (value: unknown) => boolean }).isError;

export interface ClinicDataShape {
  readonly allowFunction?: true;
  readonly allowMap?: true;
  readonly fields?: Readonly<Record<string, ClinicDataShape>>;
  readonly item?: ClinicDataShape;
  readonly maxDepth?: number;
}

export const ACTIVE_SOURCES_SHAPE: ClinicDataShape = { allowMap: true, maxDepth: 32 };

type DataCallback = (...args: never[]) => unknown;
type ClinicDataSnapshot =
  | { readonly ok: true; readonly value: unknown; readonly firstCallback?: DataCallback; readonly hasMap?: boolean }
  | { readonly ok: false };

interface ClinicDataNode {
  readonly kind: "record" | "array" | "map";
  readonly proto: object | null;
  readonly entries: ReadonlyArray<readonly [string, unknown]>;
}

function hasCollectionSlot(value: object, sizeGetter: () => unknown): boolean {
  try {
    Reflect.apply(sizeGetter, value, []);
    return true;
  } catch {
    return false;
  }
}

function captureMapEntries(map: object): ClinicDataNode["entries"] | null {
  const initialSize = Reflect.apply(MAP_SIZE_GET, map, []) as number;
  if (initialSize > MAX_ACTIVE_SOURCES_ENTRIES || Reflect.ownKeys(map).length !== 0) return null;

  const rawEntries: Array<readonly [unknown, unknown]> = [];
  Reflect.apply(MAP_FOR_EACH, map, [
    (value: unknown, key: unknown) => {
      if (rawEntries.length === initialSize) throw new RangeError("Map size changed during capture");
      rawEntries.push([key, value]);
    },
  ]);
  if (rawEntries.length !== initialSize || rawEntries.some(([key]) => typeof key !== "string")) return null;
  return rawEntries as ClinicDataNode["entries"];
}

function readClinicDataNode(value: object, allowMap = false): ClinicDataNode | null {
  const proto = Object.getPrototypeOf(value) as object | null;
  if (allowMap && proto === Map.prototype) {
    const entries = captureMapEntries(value);
    return entries && { kind: "map", proto, entries };
  }

  const array = Array.isArray(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const length: unknown = descriptors["length"]?.value;
  if (array && (typeof length !== "number" || !Number.isSafeInteger(length) || keys.length !== length + 1)) return null;

  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || key === "__proto__" || (array && key !== String(entries.length))) return null;
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null;
    entries.push([key, descriptor.value]);
  }
  return { kind: array ? "array" : "record", proto, entries };
}

function cloneErrorMessage(value: unknown): string | undefined {
  try {
    structuredClone(value);
  } catch (error) {
    if (error instanceof Error && error.name === "DataCloneError") return error.message;
  }
  return undefined;
}

const NON_DATA_CLONE_ERRORS = new Set([
  cloneErrorMessage(new Proxy({}, {})),
  cloneErrorMessage(new Proxy([], {})),
  cloneErrorMessage(new Proxy(Object.create(null) as object, {})),
  cloneErrorMessage(Object.setPrototypeOf((async function* () {})(), Object.prototype)),
  cloneErrorMessage(Object.setPrototypeOf((function* () {})(), Object.prototype)),
  cloneErrorMessage(Promise.resolve()),
]);
const PROXY_CALLBACK_SOURCE = Function.prototype.toString.call(new Proxy(() => undefined, {}));

function passesNativeClone(raw: object, container: ClinicDataNode, firstCallback?: DataCallback): boolean {
  if (firstCallback) {
    // An allowed callback can make a plain container unclonable. Accept its diagnostic
    // only when the engine distinguishes it from a root Proxy or exotic.
    const expected = cloneErrorMessage(firstCallback);
    return expected !== undefined && !NON_DATA_CLONE_ERRORS.has(expected) && cloneErrorMessage(raw) === expected;
  }
  const clone = structuredClone(raw);
  const expectedProto = container.kind === "record" ? Object.prototype : container.proto;
  return Object.getPrototypeOf(clone) === expectedProto;
}

/** Verify a descriptor graph in DFS post-order, then expose only the detached snapshot. */
export function snapshotClinicData(value: unknown, shape?: ClinicDataShape): ClinicDataSnapshot {
  type CompleteNode = {
    readonly raw: object;
    readonly shape: ClinicDataShape | undefined;
    readonly data: ClinicDataNode;
    readonly snapshot: Extract<ClinicDataSnapshot, { ok: true }>;
  };
  const inStack = new WeakSet<object>();
  const done = new WeakMap<object, CompleteNode>();
  const postOrder: CompleteNode[] = [];

  function visit(raw: unknown, policy: ClinicDataShape | undefined, remainingDepth: number): ClinicDataSnapshot {
    if (typeof raw === "symbol") return { ok: false };
    if (typeof raw === "function") {
      // Callable Proxies and bound functions can share the same opaque source.
      if (!policy?.allowFunction || Function.prototype.toString.call(raw) === PROXY_CALLBACK_SOURCE) {
        return { ok: false };
      }
      return { ok: true, value: raw, firstCallback: raw as DataCallback };
    }
    if (raw === null || typeof raw !== "object") return { ok: true, value: raw };
    const depth = Math.min(remainingDepth, policy?.maxDepth ?? Infinity);
    if (depth < 0 || inStack.has(raw)) return { ok: false };
    const prior = done.get(raw);
    if (prior) {
      // Data-only aliases can occur in several slots. Special values are allowed
      // only along the paths that explicitly opted into them.
      return prior.shape === policy || (!prior.snapshot.firstCallback && !prior.snapshot.hasMap)
        ? prior.snapshot
        : { ok: false };
    }

    inStack.add(raw);
    if (IS_ERROR?.(raw)) return { ok: false };
    const data = readClinicDataNode(raw, policy?.allowMap);
    if (!data) return { ok: false };
    // Reassigned collection prototypes can hide entries outside the descriptor graph.
    if (data.kind !== "map" && (hasCollectionSlot(raw, MAP_SIZE_GET) || hasCollectionSlot(raw, SET_SIZE_GET))) {
      return { ok: false };
    }
    const copy: object = data.kind === "map"
      ? new Map<string, unknown>()
      : data.kind === "array"
        ? []
        : Object.create(data.proto) as object;
    let firstCallback: DataCallback | undefined;
    let hasMap = data.kind === "map";
    for (const [key, child] of data.entries) {
      const fields = policy?.fields;
      const childPolicy = data.kind === "array"
        ? policy?.item
        : fields && Object.hasOwn(fields, key) ? fields[key] : undefined;
      const childSnapshot = visit(child, childPolicy, depth - 1);
      if (!childSnapshot.ok) return childSnapshot;
      if (copy instanceof Map) {
        copy.set(key, childSnapshot.value);
      } else {
        Object.defineProperty(copy, key, { value: childSnapshot.value, enumerable: true });
      }
      firstCallback ??= childSnapshot.firstCallback;
      hasMap ||= childSnapshot.hasMap === true;
    }
    const snapshot = { ok: true as const, value: Object.freeze(copy), firstCallback, hasMap };
    const complete = { raw, shape: policy, data, snapshot };
    inStack.delete(raw);
    done.set(raw, complete);
    postOrder.push(complete);
    return snapshot;
  }

  const verified = new WeakSet<object>();
  const verifiedList: CompleteNode[] = [];
  function isVerifiedChild(child: unknown): boolean {
    return child === null || typeof child !== "object" || verified.has(child);
  }

  function remainsClosed(container: CompleteNode): boolean {
    const { raw, data } = container;
    if (Object.getPrototypeOf(raw) !== data.proto) return false;
    if (data.kind === "map") {
      // Capture a fixed readback of Map keys and values before comparing entries.
      const entries = captureMapEntries(raw);
      return entries !== null && entries.length === data.entries.length &&
        entries.every(([key, child], i) => {
          const [previousKey, previousChild] = data.entries[i]!;
          return key === previousKey && Object.is(child, previousChild) && isVerifiedChild(child);
        });
    }

    const array = data.kind === "array";
    if (Reflect.ownKeys(raw).length !== data.entries.length + (array ? 1 : 0)) return false;
    if (array && Object.getOwnPropertyDescriptor(raw, "length")?.value !== data.entries.length) return false;
    for (const [key, child] of data.entries) {
      const desc = Object.getOwnPropertyDescriptor(raw, key);
      if (!desc?.enumerable || !Object.hasOwn(desc, "value") || !Object.is(desc.value, child) || !isVerifiedChild(child)) {
        return false;
      }
    }
    return true;
  }

  try {
    const snapshot = visit(value, shape, Infinity);
    if (!snapshot.ok) return snapshot;
    for (const node of postOrder) {
      if (!remainsClosed(node)) return { ok: false };
      // The current node may have run descriptor traps. Only previously checked,
      // genuine containers are reread here, so the closure stays intact until cloning.
      if (!verifiedList.every(remainsClosed)) return { ok: false };
      if (!passesNativeClone(node.raw, node.data, node.snapshot.firstCallback)) return { ok: false };
      verified.add(node.raw);
      verifiedList.push(node);
    }
    return snapshot;
  } catch {
    return { ok: false };
  }
}

function isPrimitiveValue(value: unknown): boolean {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

/**
 * Plain-data schema parser for a single already-verified ActiveSourcesMap entry.
 * Called after the source container has been verified and detached; malformed plain-data entries (e.g. null, arrays, non-finite numbers,
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
 * Verify the entire source container before parsing entries. Malformed plain-data values
 * are omitted while invalid JavaScript graphs invalidate the source container.
 */
export function inspectActiveSourcesMap(activeSourcesMap: ActiveSourcesMap): ActiveSourcesInspection {
  const snapshot = snapshotClinicData(activeSourcesMap, ACTIVE_SOURCES_SHAPE);
  return snapshot.ok
    ? parseActiveSourcesSnapshot(snapshot.value)
    : { containerValid: false, sources: new Map() };
}

/** Parse a detached source container from snapshotClinicData. */
export function parseActiveSourcesSnapshot(value: unknown): ActiveSourcesInspection {
  const sources = new Map<string, ActiveSourceEntry>();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { containerValid: false, sources };
  }
  const entries = value instanceof Map
    ? (value as ReadonlyMap<string, unknown>).entries()
    : Object.entries(value);
  for (const [key, entryValue] of entries) {
    const entry = parsePlainActiveSourceEntry(entryValue);
    if (entry !== undefined) sources.set(key, entry);
  }
  return { containerValid: true, sources };
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

export function isSourceRefActive(
  ref: RemedySourceRef,
  activeSourcesMap: ActiveSourcesMap,
): boolean {
  return areSourceRefsActive([ref], activeSourcesMap);
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
  const snapshot = snapshotClinicData(value);
  return snapshot.ok && Array.isArray(snapshot.value);
}

export function areSourceRefsActive(
  sourceRefs: readonly RemedySourceRef[],
  activeSourcesMap: ActiveSourcesMap,
): boolean {
  const snapshot = snapshotClinicData(sourceRefs);
  if (!snapshot.ok) return false;
  const refs = parseSourceRefs(snapshot.value);
  return refs !== null && areFrozenSourceRefsActive(refs, snapshotActiveSourcesMap(activeSourcesMap));
}

/** Check detached source refs against a parsed, private source snapshot. */
export function areFrozenSourceRefsActive(
  refs: readonly RemedySourceRef[],
  verifiedSources: ReadonlyMap<string, ActiveSourceEntry>,
): boolean {
  return refs.length > 0 && refs.every((ref) => isFrozenSourceRefActive(ref, verifiedSources));
}

function parseSourceRefs(items: unknown): readonly RemedySourceRef[] | null {
  if (!Array.isArray(items)) return null;
  const cloned: RemedySourceRef[] = [];
  for (const item of items as readonly unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    if (!Object.values(item).every(isPrimitiveValue)) return null;
    const sourceId: unknown = Object.getOwnPropertyDescriptor(item, "sourceId")?.value;
    const sourceVersion: unknown = Object.getOwnPropertyDescriptor(item, "sourceVersion")?.value;
    if (!isNonBlankText(sourceId) || !isValidSourceVersion(sourceVersion)) return null;
    cloned.push(Object.freeze({ sourceId, sourceVersion }));
  }
  return Object.freeze(cloned);
}

export function cloneSourceRefs(sourceRefs: readonly RemedySourceRef[]): readonly RemedySourceRef[] {
  const snapshot = snapshotClinicData(sourceRefs);
  return (snapshot.ok && parseSourceRefs(snapshot.value)) || Object.freeze([]);
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
  const snapshot = snapshotClinicData(item);
  return snapshot.ok ? parseEvidenceCase(snapshot.value) : EMPTY_INVALID_CASE;
}

function parseEvidenceCase(item: unknown): ClinicEvidenceCase {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return EMPTY_INVALID_CASE;
  const snap = Object.assign(Object.create(null) as Record<string, unknown>, item);
  let frozenRefs: readonly RemedySourceRef[] = Object.freeze([]);
  for (const key of Object.keys(snap)) {
    if (key === "sourceRefs") {
      const refs = parseSourceRefs(snap[key]);
      if (!refs) return EMPTY_INVALID_CASE;
      frozenRefs = refs;
    } else if (!isPrimitiveValue(snap[key])) {
      return EMPTY_INVALID_CASE;
    }
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
  const snapshot = snapshotClinicData(cases);
  if (!snapshot.ok || !Array.isArray(snapshot.value)) {
    return { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 };
  }
  for (const rawItem of snapshot.value as readonly unknown[]) {
    const item = parseEvidenceCase(rawItem);
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

  // Phase 1: Guarantee chapter diversity across the full ordered list before capping it.
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
  const snapshot = snapshotClinicData(cases);
  if (!snapshot.ok || !Array.isArray(snapshot.value)) return Object.freeze([]);
  const safeCases = (snapshot.value as readonly unknown[]).map(parseEvidenceCase);
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
