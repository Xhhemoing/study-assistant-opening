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

function lookupActiveSource(
  activeSourcesMap: ActiveSourcesMap,
  sourceId: string,
): ActiveSourceEntry | undefined {
  if (!activeSourcesMap || typeof activeSourcesMap !== "object") return undefined;
  if (activeSourcesMap instanceof Map) {
    return activeSourcesMap.get(sourceId);
  }
  const record = activeSourcesMap as Readonly<Record<string, ActiveSourceEntry>>;
  return Object.hasOwn(record, sourceId) ? record[sourceId] : undefined;
}

export function isSourceRefActive(
  ref: RemedySourceRef,
  activeSourcesMap: ActiveSourcesMap,
): boolean {
  if (!ref || typeof ref !== "object") return false;
  if (!activeSourcesMap || typeof activeSourcesMap !== "object") return false;
  if (!isNonBlankText(ref.sourceId) || !isValidSourceVersion(ref.sourceVersion)) return false;
  const entry = lookupActiveSource(activeSourcesMap, ref.sourceId);
  if (entry === undefined) return false;
  if (typeof entry === "string" || typeof entry === "number") {
    return entry === ref.sourceVersion;
  }
  if (!entry || typeof entry !== "object") return false;
  if (entry.revoked === true || entry.active === false) return false;
  return entry.version === ref.sourceVersion;
}

export function areSourceRefsActive(
  sourceRefs: readonly RemedySourceRef[],
  activeSourcesMap: ActiveSourcesMap,
): boolean {
  if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) return false;
  return sourceRefs.every((ref) => isSourceRefActive(ref, activeSourcesMap));
}

export function cloneSourceRefs(sourceRefs: readonly RemedySourceRef[]): readonly RemedySourceRef[] {
  return sourceRefs.map((ref) => ({ sourceId: ref.sourceId, sourceVersion: ref.sourceVersion }));
}

export function cloneEvidenceCase(item: ClinicEvidenceCase): ClinicEvidenceCase {
  return {
    attemptId: item.attemptId,
    rootAttemptId: item.rootAttemptId,
    chapterId: item.chapterId,
    localDate: item.localDate,
    ruleId: item.ruleId,
    excerpt: item.excerpt,
    invariantSummary: item.invariantSummary,
    sourceRefs: cloneSourceRefs(item.sourceRefs),
    privacyEpoch: item.privacyEpoch,
  };
}

export function computeEvidenceCoverage(cases: readonly ClinicEvidenceCase[]): EvidenceCoverage {
  const roots = new Set<string>();
  const chapters = new Set<string>();
  const dates = new Set<string>();
  for (const item of cases) {
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
  return cases.map((item) => ({
    rootAttemptId: item.rootAttemptId,
    chapterId: item.chapterId,
    localDate: item.localDate,
    violatedRuleId: item.ruleId,
    excerpt: item.excerpt,
    invariantSummary: item.invariantSummary,
    sourceRefs: cloneSourceRefs(item.sourceRefs),
  }));
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
  return candidate.tieKey.localeCompare(best.tieKey) < 0;
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
  if (cases.length <= SELECTED_DIFF_CASE_COUNT) {
    return cases.map(cloneEvidenceCase);
  }

  const ordered = [...cases].sort(
    (x, y) => x.localDate.localeCompare(y.localDate) || x.chapterId.localeCompare(y.chapterId) || x.rootAttemptId.localeCompare(y.rootAttemptId),
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
    if (fallback) return fallback.map(cloneEvidenceCase);
  }

  return bestTuple ? bestTuple.map(cloneEvidenceCase) : ordered.slice(0, SELECTED_DIFF_CASE_COUNT).map(cloneEvidenceCase);
}
