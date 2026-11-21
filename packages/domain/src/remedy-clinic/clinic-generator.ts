import {
  verifyProbeDistinguishability,
  type DistinguishableProbeSpec,
  type ProbeDistinguishabilityReport,
} from "../opening/cartridges/probe-protocol";
import {
  areSourceRefsActive,
  buildSelfDiffEntries,
  computeEvidenceCoverage,
  isDenseArray,
  isNonBlankText,
  isValidLocalDate,
  isValidPrivacyEpoch,
  meetsClinicThreshold,
  readOwnDataIndex,
  selectSpreadRepresentativeCases,
  type ActiveSourceEntry,
  type ActiveSourcesMap,
  type ClinicEvidenceCase,
  type EvidenceCoverage,
  type RemedySourceRef,
  type SelfDiffEntry,
} from "./privacy-guard";

/**
 * 14-minute cross-chapter RemedyClinicGenerator with exact ruleId clustering,
 * anti-transitive-closure verification, #469 distinguishable transfer probes,
 * and privacy_epoch + source-version read-time revocation guard.
 */

export const REMEDY_CLINIC_TOTAL_MINUTES = 14 as const;
export const STEP1_SELF_DIFF_MINUTES = 4 as const;
export const STEP2_INVARIANT_RESTATEMENT_MINUTES = 3 as const;
export const STEP3_TRANSFER_PROBES_MINUTES = 7 as const;
export const REQUIRED_TRANSFER_PROBE_COUNT = 2 as const;

export interface DiagnosedRootAttempt {
  readonly attemptId: string;
  readonly rootAttemptId: string;
  readonly learnerId: string;
  readonly courseId: string;
  readonly chapterId: string;
  readonly localDate: string;
  readonly ruleId: string;
  readonly excerpt: string;
  readonly invariantSummary: string;
  readonly sourceRefs: readonly RemedySourceRef[];
  readonly privacyEpoch: number;
  readonly assisted: boolean;
  readonly occurredAtMs?: number;
}

export interface EmbeddingRecallCandidate {
  readonly attempt: DiagnosedRootAttempt;
  readonly cosineSimilarity: number;
  readonly anchorAttemptId?: string;
}

export type ClinicCandidateProbe<TInput = unknown, TObservable = unknown> =
  DistinguishableProbeSpec<TInput, TObservable> & {
    readonly targetMisconceptionId?: string;
    readonly sourceRefs?: readonly RemedySourceRef[];
  };

export interface VerifiedClinicTransferProbe {
  readonly probeId: string;
  readonly requirementKey: string;
  readonly prompt: string;
  readonly targetMisconceptionId?: string;
  readonly sourceRefs?: readonly RemedySourceRef[];
  readonly competingModelIds: readonly string[];
  readonly report: ProbeDistinguishabilityReport;
}

export interface RejectedClinicProbe {
  readonly probeId: string;
  readonly reason:
    | "duplicate_probe_id"
    | "duplicate_probe_prompt"
    | "not_distinguishable"
    | "revoked_probe_source"
    | "invalid_probe_prompt"
    | "invalid_probe_descriptor";
  readonly report: ProbeDistinguishabilityReport | null;
}

export interface SideBySideSelfDiffStep {
  readonly stepNumber: 1;
  readonly kind: "side_by_side_self_diff";
  readonly durationMinutes: 4;
  readonly selectedCases: readonly ClinicEvidenceCase[];
  readonly diffs: readonly SelfDiffEntry[];
}

export interface InvariantRuleRestatementStep {
  readonly stepNumber: 2;
  readonly kind: "invariant_rule_restatement";
  readonly durationMinutes: 3;
  readonly ruleId: string;
  readonly ruleTitle: string;
  readonly prompt: string;
  readonly checklist: readonly string[];
}

export interface DistinguishableTransferProbesStep {
  readonly stepNumber: 3;
  readonly kind: "distinguishable_transfer_probes";
  readonly durationMinutes: 7;
  readonly probes: readonly VerifiedClinicTransferProbe[];
}

export type ClinicRevocationReason =
  | "none"
  | "partial_source_revoked_still_active"
  | "insufficient_surviving_evidence"
  | "insufficient_surviving_probes"
  | "rule_source_revoked"
  | "invalid_privacy_epoch"
  | "already_revoked";

export interface RemedyClinicSessionV1 {
  readonly schemaVersion: 1;
  readonly clinicId: string;
  readonly status: "active" | "stale_source_revoked";
  readonly learnerId: string;
  readonly courseId: string;
  readonly ruleId: string;
  readonly ruleSourceRefs?: readonly RemedySourceRef[];
  readonly totalMinutes: 14;
  readonly createdPrivacyEpoch: number;
  readonly validatedPrivacyEpoch: number;
  readonly coverage: EvidenceCoverage;
  readonly evidenceCases: readonly ClinicEvidenceCase[];
  readonly steps: readonly [
    SideBySideSelfDiffStep,
    InvariantRuleRestatementStep,
    DistinguishableTransferProbesStep,
  ];
  readonly revocationSummary: {
    readonly strippedCaseCount: number;
    readonly strippedProbeCount?: number;
    readonly reason: ClinicRevocationReason;
  };
}

export interface ClinicCandidateRejectionCounts {
  readonly scopeMismatch: number;
  readonly assisted: number;
  readonly invalidPrivacyEpoch: number;
  readonly malformedAttempt: number;
  readonly revokedSource: number;
  readonly ruleIdMismatch: number;
  readonly verifierRejected: number;
  readonly duplicateRoot: number;
  readonly transitiveClosureBlocked: number;
}

export interface GenerateRemedyClinicInput<TInput = unknown, TObservable = unknown> {
  readonly clinicId?: string;
  readonly learnerId: string;
  readonly courseId: string;
  readonly ruleId: string;
  readonly ruleTitle?: string;
  readonly ruleSourceRefs?: readonly RemedySourceRef[];
  readonly currentPrivacyEpoch: number;
  readonly activeSourcesMap: ActiveSourcesMap;
  readonly attempts: readonly DiagnosedRootAttempt[];
  readonly embeddingRecallCandidates?: readonly EmbeddingRecallCandidate[];
  readonly verifyRuleViolation: (attempt: DiagnosedRootAttempt) => boolean;
  readonly candidateProbes: readonly ClinicCandidateProbe<TInput, TObservable>[];
}

export interface GenerateRemedyClinicResult {
  readonly status:
    | "active"
    | "threshold_not_met"
    | "insufficient_distinguishable_probes"
    | "invalid_input";
  readonly clinic: RemedyClinicSessionV1 | null;
  readonly coverage: EvidenceCoverage;
  readonly rejectedCounts: ClinicCandidateRejectionCounts;
  readonly verifiedProbeCount: number;
  readonly rejectedProbes: readonly RejectedClinicProbe[];
}

function emptyRejections(): ClinicCandidateRejectionCounts {
  return {
    scopeMismatch: 0,
    assisted: 0,
    invalidPrivacyEpoch: 0,
    malformedAttempt: 0,
    revokedSource: 0,
    ruleIdMismatch: 0,
    verifierRejected: 0,
    duplicateRoot: 0,
    transitiveClosureBlocked: 0,
  };
}

function safeVerifyRuleViolation(
  verifier: (attempt: DiagnosedRootAttempt) => boolean,
  attempt: DiagnosedRootAttempt,
): boolean {
  try {
    return verifier(attempt) === true;
  } catch {
    return false;
  }
}

const REVOKED_CLINIC_STEP2_PLACEHOLDER =
  "This remedy clinic is no longer available because an underlying source was updated or removed.";
const MACHINE_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[_:-][a-z0-9]+)+$/i;

function resolveLearnerRuleLabel(ruleId: string, ruleTitle?: string): string {
  const trimmedTitle = isNonBlankText(ruleTitle) ? ruleTitle.trim() : "";
  const trimmedId = ruleId.trim();
  if (
    !trimmedTitle ||
    trimmedTitle.toLowerCase() === trimmedId.toLowerCase() ||
    MACHINE_IDENTIFIER_PATTERN.test(trimmedTitle)
  ) {
    return "当前薄弱规则";
  }
  return trimmedTitle;
}

function buildRestatementStep(ruleId: string, ruleTitle?: string): InvariantRuleRestatementStep {
  const trimmedTitle = isNonBlankText(ruleTitle) ? ruleTitle.trim() : "";
  const subject = resolveLearnerRuleLabel(ruleId, trimmedTitle);
  return Object.freeze({
    stepNumber: 2,
    kind: "invariant_rule_restatement",
    durationMinutes: STEP2_INVARIANT_RESTATEMENT_MINUTES,
    ruleId,
    ruleTitle: trimmedTitle,
    prompt:
      `Compare the 3 side-by-side cases above and restate the core invariant for "${subject}" in your own words. ` +
      "Explain what structural condition triggers the rule, why the recurring error fails that condition, " +
      "and what single check you will apply before committing to a step.",
    checklist: Object.freeze([
      "State the exact condition required by the invariant rule.",
      "Identify the shared failure mechanism across the 3 different cases.",
      "Write a concise pre-check you can apply to unseen transfer problems.",
    ]),
  });
}

const NOOP_CALLBACK = (): void => {};
const REGEXP_SOURCE_GET = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GET = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const DATA_VIEW_BYTE_LENGTH_GET = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get;
const SHARED_ARRAY_BUFFER_BYTE_LENGTH_GET =
  typeof SharedArrayBuffer !== "undefined"
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get
    : undefined;
const ERROR_IS_ERROR = (Error as { isError?: (v: unknown) => boolean }).isError;
const WEAK_PROBE_KEY = Object.freeze({});
const SPECIES_NON_OBJECT_ERROR_MESSAGE = (() => {
  try {
    Reflect.apply(Promise.prototype.finally, { constructor: null }, [NOOP_CALLBACK]);
  } catch (err) {
    return err instanceof TypeError ? err.message : "";
  }
  return "";
})();

function matchesBrand(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

/**
 * Zero-getter, zero-mutation Promise internal-slot brand check.
 * Precondition: obj already verified to have proto === Object.prototype | null | Array.prototype
 * and no own symbol keys or accessor getters.
 */
function hasPromiseInternalSlot(obj: object): boolean {
  if (Array.isArray(obj)) return false;
  const proto = Object.getPrototypeOf(obj) as object | null;
  if (proto !== Object.prototype && proto !== null) return true;

  const ctorDesc = Object.getOwnPropertyDescriptor(obj, "constructor");
  if (ctorDesc && (ctorDesc.get !== undefined || ctorDesc.set !== undefined || !Object.hasOwn(ctorDesc, "value"))) {
    return true;
  }
  const hasOwnCtor = ctorDesc !== undefined;
  const ctorVal = ctorDesc?.value;

  // Case A: No own constructor, or own constructor is undefined / Object (no user [Symbol.species]).
  if (!hasOwnCtor || ctorVal === undefined || ctorVal === Object) {
    return matchesBrand(() => Reflect.apply(Promise.prototype.then, obj, [NOOP_CALLBACK, NOOP_CALLBACK]));
  }

  // Case B: Non-callable object constructor. Per ECMA-262 PromiseResolve(C, x), if IsPromise(obj)
  // and obj.constructor === C, returns obj at Step 2b BEFORE touching [Symbol.species] or NewPromiseCapability;
  // if !IsPromise(obj), NewPromiseCapability throws TypeError immediately on non-callable C.
  if (typeof ctorVal === "object" && ctorVal !== null) {
    try {
      return Reflect.apply(Promise.resolve, ctorVal, [obj]) === obj;
    } catch {
      return false;
    }
  }

  // Case C: Untrusted function constructor !== Object — fail closed without invoking it.
  if (typeof ctorVal === "function") {
    return true;
  }

  // Case D: null or primitive constructor — distinguish IsPromise Step 2 failure from SpeciesConstructor Step 3 failure.
  let expectedSpeciesErrMsg = SPECIES_NON_OBJECT_ERROR_MESSAGE;
  if (ctorVal !== null) {
    try {
      Reflect.apply(Promise.prototype.finally, { constructor: ctorVal }, [NOOP_CALLBACK]);
    } catch (sampleErr) {
      if (sampleErr instanceof TypeError) expectedSpeciesErrMsg = sampleErr.message;
    }
  }
  try {
    Reflect.apply(Promise.prototype.then, obj, [NOOP_CALLBACK, NOOP_CALLBACK]);
    return true;
  } catch (err) {
    return (
      err instanceof TypeError &&
      expectedSpeciesErrMsg !== "" &&
      err.message === expectedSpeciesErrMsg
    );
  }
}

/**
 * Detect exotic built-in internal slots (Map, Set, Date, RegExp, ArrayBuffer, TypedArray,
 * DataView, WeakMap, WeakSet, Promise, Error, boxed primitives, SharedArrayBuffer) even when
 * the object's prototype has been reassigned via Object.setPrototypeOf(..., Object.prototype | null).
 * Call ONLY after verifying prototype and own keys (no symbol keys / no accessors).
 */
function hasExoticInternalSlots(obj: object): boolean {
  if (ArrayBuffer.isView(obj)) return true;
  if (typeof ERROR_IS_ERROR === "function") {
    if (ERROR_IS_ERROR(obj)) return true;
  } else {
    const proto = Object.getPrototypeOf(obj) as object | null;
    if (
      (proto === Object.prototype || proto === null || proto === Array.prototype) &&
      Object.getOwnPropertyDescriptor(obj, Symbol.toStringTag) === undefined &&
      Object.prototype.toString.call(obj) === "[object Error]"
    ) {
      return true;
    }
  }
  if (matchesBrand(() => Reflect.apply(Map.prototype.has, obj, [undefined]))) return true;
  if (matchesBrand(() => Reflect.apply(Set.prototype.has, obj, [undefined]))) return true;
  if (matchesBrand(() => Reflect.apply(WeakMap.prototype.has, obj, [WEAK_PROBE_KEY]))) return true;
  if (matchesBrand(() => Reflect.apply(WeakSet.prototype.has, obj, [WEAK_PROBE_KEY]))) return true;
  if (matchesBrand(() => Reflect.apply(Date.prototype.getTime, obj, []))) return true;
  if (
    REGEXP_SOURCE_GET &&
    obj !== RegExp.prototype &&
    matchesBrand(() => Reflect.apply(REGEXP_SOURCE_GET, obj, []))
  ) {
    return true;
  }
  if (ARRAY_BUFFER_BYTE_LENGTH_GET && matchesBrand(() => Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GET, obj, []))) {
    return true;
  }
  if (DATA_VIEW_BYTE_LENGTH_GET && matchesBrand(() => Reflect.apply(DATA_VIEW_BYTE_LENGTH_GET, obj, []))) {
    return true;
  }
  if (
    SHARED_ARRAY_BUFFER_BYTE_LENGTH_GET &&
    matchesBrand(() => Reflect.apply(SHARED_ARRAY_BUFFER_BYTE_LENGTH_GET, obj, []))
  ) {
    return true;
  }
  if (hasPromiseInternalSlot(obj)) return true;
  if (matchesBrand(() => Reflect.apply(Number.prototype.valueOf, obj, []))) return true;
  if (matchesBrand(() => Reflect.apply(String.prototype.valueOf, obj, []))) return true;
  if (matchesBrand(() => Reflect.apply(Boolean.prototype.valueOf, obj, []))) return true;
  if (matchesBrand(() => Reflect.apply(Symbol.prototype.valueOf, obj, []))) return true;
  if (matchesBrand(() => Reflect.apply(BigInt.prototype.valueOf, obj, []))) return true;
  return false;
}

function isPlainRecordOwnDataOnly(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !Object.hasOwn(desc, "value") || desc.get !== undefined || desc.set !== undefined) {
      return false;
    }
  }
  if (hasExoticInternalSlots(value)) return false;
  return true;
}

function isPlainDenseArrayHeader(obj: unknown): obj is unknown[] {
  if (!Array.isArray(obj)) return false;
  if (Object.getPrototypeOf(obj) !== Array.prototype) return false;
  const lenDesc = Object.getOwnPropertyDescriptor(obj, "length");
  if (!lenDesc || typeof lenDesc.value !== "number" || !Number.isInteger(lenDesc.value)) return false;
  const len = lenDesc.value;
  const keys = Reflect.ownKeys(obj);
  if (keys.length !== len + 1) return false;
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
  }
  return !hasExoticInternalSlots(obj);
}

/**
 * Single-pass, exotic-brand-rejecting, descriptor-materializing plain-data clone & deep-freeze.
 * Replaces structuredClone completely: zero getter execution, O(V + E) on shared DAGs, cyclic
 * plain-object safe, and safe for own "__proto__" data properties via Object.defineProperty.
 */
function cloneAndFreezePlainData(
  value: unknown,
  memo: Map<object, unknown> = new Map(),
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (value === null || value === undefined) return { ok: true, value };
  const kind = typeof value;
  if (kind === "boolean" || kind === "number" || kind === "string" || kind === "bigint") {
    return { ok: true, value };
  }
  if (kind === "symbol" || kind === "function" || kind !== "object") {
    return { ok: false };
  }

  const obj = value as object;
  if (memo.has(obj)) return { ok: true, value: memo.get(obj) };

  const proto = Object.getPrototypeOf(obj) as object | null;
  if (Array.isArray(obj)) {
    if (!isPlainDenseArrayHeader(obj)) return { ok: false };
    const len = obj.length;
    const out: unknown[] = new Array(len);
    memo.set(obj, out);
    for (let i = 0; i < len; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(obj, String(i));
      if (!desc || !Object.hasOwn(desc, "value")) return { ok: false };
      const child = cloneAndFreezePlainData(desc.value, memo);
      if (!child.ok) return { ok: false };
      Object.defineProperty(out, String(i), {
        value: child.value,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    Object.freeze(out);
    return { ok: true, value: out };
  }

  if (proto !== Object.prototype && proto !== null) return { ok: false };
  const ownKeys = Reflect.ownKeys(obj);
  const validatedEntries: Array<{ readonly key: string; readonly value: unknown; readonly enumerable: boolean }> = [];
  for (const key of ownKeys) {
    if (typeof key !== "string") return { ok: false };
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (
      !desc ||
      !desc.enumerable ||
      !Object.hasOwn(desc, "value") ||
      desc.get !== undefined ||
      desc.set !== undefined
    ) {
      return { ok: false };
    }
    validatedEntries.push({ key, value: desc.value, enumerable: desc.enumerable });
  }
  if (hasExoticInternalSlots(obj)) return { ok: false };

  const out: Record<string, unknown> =
    proto === null ? (Object.create(null) as Record<string, unknown>) : {};
  memo.set(obj, out);
  for (const entry of validatedEntries) {
    const child = cloneAndFreezePlainData(entry.value, memo);
    if (!child.ok) return { ok: false };
    Object.defineProperty(out, entry.key, {
      value: child.value,
      writable: false,
      enumerable: entry.enumerable,
      configurable: false,
    });
  }
  Object.freeze(out);
  return { ok: true, value: out };
}

function readOwnDataProp(obj: object, key: string): unknown {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc || !Object.hasOwn(desc, "value") || desc.get !== undefined || desc.set !== undefined) {
    return undefined;
  }
  return desc.value;
}

function snapshotActiveSourcesMap(activeSourcesMap: ActiveSourcesMap): ReadonlyMap<string, ActiveSourceEntry> {
  const snapshot = new Map<string, ActiveSourceEntry>();
  if (!activeSourcesMap || typeof activeSourcesMap !== "object") return snapshot;
  const copyEntry = (entry: ActiveSourceEntry): ActiveSourceEntry | undefined => {
    if (typeof entry === "string" || typeof entry === "number") return entry;
    if (!isPlainRecordOwnDataOnly(entry)) return undefined;
    const version = readOwnDataProp(entry, "version");
    const active = readOwnDataProp(entry, "active");
    const revoked = readOwnDataProp(entry, "revoked");
    if (typeof version !== "string" && typeof version !== "number") return undefined;
    return Object.freeze({
      version,
      ...(typeof active === "boolean" ? { active } : {}),
      ...(typeof revoked === "boolean" ? { revoked } : {}),
    });
  };
  if (activeSourcesMap instanceof Map) {
    for (const [k, v] of activeSourcesMap.entries()) {
      if (typeof k !== "string") continue;
      const cloned = copyEntry(v);
      if (cloned !== undefined) snapshot.set(k, cloned);
    }
    return snapshot;
  }
  if (!isPlainRecordOwnDataOnly(activeSourcesMap)) return snapshot;
  for (const key of Object.keys(activeSourcesMap)) {
    const raw = readOwnDataProp(activeSourcesMap, key) as ActiveSourceEntry;
    const cloned = copyEntry(raw);
    if (cloned !== undefined) snapshot.set(key, cloned);
  }
  return snapshot;
}

function freezeSourceRefs(sourceRefs: unknown): readonly RemedySourceRef[] | null {
  if (!isPlainDenseArrayHeader(sourceRefs) || sourceRefs.length === 0) return null;
  const frozen: RemedySourceRef[] = [];
  for (let i = 0; i < sourceRefs.length; i += 1) {
    const slot = readOwnDataIndex(sourceRefs, i);
    if (!slot.ok) return null;
    const ref = slot.value;
    if (!isPlainRecordOwnDataOnly(ref)) return null;
    const sourceId = readOwnDataProp(ref, "sourceId");
    const sourceVersion = readOwnDataProp(ref, "sourceVersion");
    if (typeof sourceId !== "string" || (typeof sourceVersion !== "string" && typeof sourceVersion !== "number")) {
      return null;
    }
    frozen.push(Object.freeze({ sourceId, sourceVersion }));
  }
  return Object.freeze(frozen);
}

function isolateProbeModel<TInput, TObservable>(
  rawModel: Record<string, unknown>,
  role: "correct" | "misconception",
): Record<string, unknown> | null {
  if (!isPlainRecordOwnDataOnly(rawModel)) return null;
  const rawPredict = readOwnDataProp(rawModel, "predict");
  if (typeof rawPredict !== "function") return null;

  const modelProto = Object.getPrototypeOf(rawModel) as object | null;
  const frozenReceiver: Record<string, unknown> =
    modelProto === null ? (Object.create(null) as Record<string, unknown>) : {};
  const memo = new Map<object, unknown>();
  memo.set(rawModel, frozenReceiver);

  for (const key of Reflect.ownKeys(rawModel)) {
    if (typeof key !== "string") return null;
    if (key === "predict") continue;
    const desc = Object.getOwnPropertyDescriptor(rawModel, key);
    if (!desc || !Object.hasOwn(desc, "value") || desc.get !== undefined || desc.set !== undefined) {
      return null;
    }
    const cloned = cloneAndFreezePlainData(desc.value, memo);
    if (!cloned.ok) return null;
    Object.defineProperty(frozenReceiver, key, {
      value: cloned.value,
      writable: false,
      enumerable: desc.enumerable,
      configurable: false,
    });
  }
  Object.freeze(frozenReceiver);

  const predictFn = rawPredict as (this: unknown, probeInput: TInput) => TObservable;
  const isolatedPredict = (probeInput: TInput): TObservable =>
    Reflect.apply(predictFn, frozenReceiver, [probeInput]);

  const id = readOwnDataProp(frozenReceiver, "id");
  const label = readOwnDataProp(frozenReceiver, "label");
  const modelRole = readOwnDataProp(frozenReceiver, "role");
  const base: Record<string, unknown> = {
    id,
    label,
    role: modelRole,
    predict: isolatedPredict,
  };
  if (role === "misconception") {
    base.description = readOwnDataProp(frozenReceiver, "description");
  }
  return Object.freeze(base);
}

function snapshotAttemptCandidate(rawAttempt: unknown): DiagnosedRootAttempt | null {
  if (!isPlainRecordOwnDataOnly(rawAttempt)) return null;
  const attemptId = readOwnDataProp(rawAttempt, "attemptId");
  const rootAttemptId = readOwnDataProp(rawAttempt, "rootAttemptId");
  const learnerId = readOwnDataProp(rawAttempt, "learnerId");
  const courseId = readOwnDataProp(rawAttempt, "courseId");
  const chapterId = readOwnDataProp(rawAttempt, "chapterId");
  const localDate = readOwnDataProp(rawAttempt, "localDate");
  const ruleId = readOwnDataProp(rawAttempt, "ruleId");
  const excerpt = readOwnDataProp(rawAttempt, "excerpt");
  const invariantSummary = readOwnDataProp(rawAttempt, "invariantSummary");
  const rawSourceRefs = readOwnDataProp(rawAttempt, "sourceRefs");
  const privacyEpoch = readOwnDataProp(rawAttempt, "privacyEpoch");
  const assisted = readOwnDataProp(rawAttempt, "assisted");
  const occurredAtMs = readOwnDataProp(rawAttempt, "occurredAtMs");

  if (
    typeof attemptId !== "string" ||
    typeof rootAttemptId !== "string" ||
    typeof learnerId !== "string" ||
    typeof courseId !== "string" ||
    typeof chapterId !== "string" ||
    typeof localDate !== "string" ||
    typeof ruleId !== "string" ||
    typeof excerpt !== "string" ||
    typeof invariantSummary !== "string" ||
    typeof privacyEpoch !== "number" ||
    typeof assisted !== "boolean"
  ) {
    return null;
  }

  const frozenSourceRefs = freezeSourceRefs(rawSourceRefs);

  return Object.freeze({
    attemptId,
    rootAttemptId,
    learnerId,
    courseId,
    chapterId,
    localDate,
    ruleId,
    excerpt,
    invariantSummary,
    sourceRefs: frozenSourceRefs ?? Object.freeze([]),
    privacyEpoch,
    assisted,
    ...(typeof occurredAtMs === "number" && Number.isFinite(occurredAtMs) ? { occurredAtMs } : {}),
  });
}

function snapshotStringArray(raw: unknown): readonly string[] | null {
  if (!isPlainDenseArrayHeader(raw)) return null;
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const slot = readOwnDataIndex(raw, i);
    if (!slot.ok || typeof slot.value !== "string") return null;
    out.push(slot.value);
  }
  return Object.freeze(out);
}

interface PreparedCandidateProbe<TInput, TObservable> {
  readonly frozenProbeId: string;
  readonly frozenRequirementKey: string;
  readonly frozenPrompt: string;
  readonly frozenTargetMisconceptionId: string | undefined;
  readonly frozenSourceRefs: readonly RemedySourceRef[] | undefined;
  readonly frozenSpec: DistinguishableProbeSpec<TInput, TObservable>;
}

function prepareCandidateProbe<TInput, TObservable>(
  probe: ClinicCandidateProbe<TInput, TObservable>,
  activeSources: ReadonlyMap<string, ActiveSourceEntry>,
): { readonly prepared: PreparedCandidateProbe<TInput, TObservable> | null; readonly rejected: RejectedClinicProbe | null } {
  if (!isPlainRecordOwnDataOnly(probe)) {
    return {
      prepared: null,
      rejected: { probeId: "", reason: "invalid_probe_descriptor", report: null },
    };
  }

  const rawProbeId = readOwnDataProp(probe, "probeId");
  const rawRequirementKey = readOwnDataProp(probe, "requirementKey");
  const rawPrompt = readOwnDataProp(probe, "prompt");
  const rawTargetMisconceptionId = readOwnDataProp(probe, "targetMisconceptionId");
  const hasExplicitSourceRefs = Object.hasOwn(probe, "sourceRefs") && readOwnDataProp(probe, "sourceRefs") !== undefined;
  const rawSourceRefs = hasExplicitSourceRefs ? readOwnDataProp(probe, "sourceRefs") : undefined;
  const rawInput = readOwnDataProp(probe, "input");
  const rawCorrectModel = readOwnDataProp(probe, "correctModel");
  const rawHypotheses = readOwnDataProp(probe, "hypotheses");
  const rawObservableKey = readOwnDataProp(probe, "observableKey");
  const rawParseResponse = readOwnDataProp(probe, "parseResponse");

  const frozenProbeId = typeof rawProbeId === "string" ? rawProbeId : "";
  const frozenRequirementKey = typeof rawRequirementKey === "string" ? rawRequirementKey : "";
  const frozenPrompt = typeof rawPrompt === "string" ? rawPrompt : "";
  const frozenTargetMisconceptionId =
    typeof rawTargetMisconceptionId === "string" ? rawTargetMisconceptionId : undefined;

  const clonedInput = cloneAndFreezePlainData(rawInput);
  if (!clonedInput.ok) {
    return {
      prepared: null,
      rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
    };
  }
  const frozenInput = clonedInput.value as TInput;

  if (!isPlainRecordOwnDataOnly(rawCorrectModel) || !isDenseArray(rawHypotheses)) {
    return {
      prepared: null,
      rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
    };
  }
  const isolatedCorrectModel = isolateProbeModel<TInput, TObservable>(rawCorrectModel, "correct");
  if (!isolatedCorrectModel) {
    return {
      prepared: null,
      rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
    };
  }

  const isolatedHypothesesList: Record<string, unknown>[] = [];
  for (let h = 0; h < rawHypotheses.length; h += 1) {
    const slot = readOwnDataIndex(rawHypotheses, h);
    if (!slot.ok || !isPlainRecordOwnDataOnly(slot.value)) {
      return {
        prepared: null,
        rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
      };
    }
    const isolatedHyp = isolateProbeModel<TInput, TObservable>(slot.value, "misconception");
    if (!isolatedHyp) {
      return {
        prepared: null,
        rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
      };
    }
    isolatedHypothesesList.push(isolatedHyp);
  }

  let frozenSourceRefs: readonly RemedySourceRef[] | undefined;
  if (hasExplicitSourceRefs) {
    const frozen = freezeSourceRefs(rawSourceRefs);
    if (!frozen) {
      return {
        prepared: null,
        rejected: {
          probeId: frozenProbeId,
          reason:
            Array.isArray(rawSourceRefs) && rawSourceRefs.length === 0
              ? "revoked_probe_source"
              : !Array.isArray(rawSourceRefs)
                ? "invalid_probe_descriptor"
                : "revoked_probe_source",
          report: null,
        },
      };
    }
    if (!areSourceRefsActive(frozen, activeSources)) {
      return {
        prepared: null,
        rejected: { probeId: frozenProbeId, reason: "revoked_probe_source", report: null },
      };
    }
    frozenSourceRefs = frozen;
  }

  if (!isNonBlankText(frozenPrompt)) {
    return {
      prepared: null,
      rejected: { probeId: frozenProbeId, reason: "invalid_probe_prompt", report: null },
    };
  }

  const frozenCorrectModel = isolatedCorrectModel as unknown as DistinguishableProbeSpec<
    TInput,
    TObservable
  >["correctModel"];
  const frozenHypotheses = Object.freeze(isolatedHypothesesList) as unknown as DistinguishableProbeSpec<
    TInput,
    TObservable
  >["hypotheses"];

  const canonicalSpec: {
    probeId: string;
    requirementKey: string;
    prompt: string;
    input: TInput;
    correctModel: DistinguishableProbeSpec<TInput, TObservable>["correctModel"];
    hypotheses: DistinguishableProbeSpec<TInput, TObservable>["hypotheses"];
    observableKey: DistinguishableProbeSpec<TInput, TObservable>["observableKey"];
    parseResponse: DistinguishableProbeSpec<TInput, TObservable>["parseResponse"];
  } = {
    probeId: frozenProbeId,
    requirementKey: frozenRequirementKey,
    prompt: frozenPrompt,
    input: frozenInput,
    correctModel: frozenCorrectModel,
    hypotheses: frozenHypotheses,
    observableKey: (typeof rawObservableKey === "function"
      ? (obs: TObservable): string =>
          Reflect.apply(rawObservableKey as (this: unknown, obs: TObservable) => string, canonicalSpec, [obs])
      : rawObservableKey) as DistinguishableProbeSpec<TInput, TObservable>["observableKey"],
    parseResponse: (typeof rawParseResponse === "function"
      ? (resp: unknown): TObservable | null =>
          Reflect.apply(rawParseResponse as (this: unknown, resp: unknown) => TObservable | null, canonicalSpec, [resp])
      : rawParseResponse) as DistinguishableProbeSpec<TInput, TObservable>["parseResponse"],
  };
  const frozenSpec: DistinguishableProbeSpec<TInput, TObservable> = Object.freeze(canonicalSpec);

  return {
    prepared: {
      frozenProbeId,
      frozenRequirementKey,
      frozenPrompt,
      frozenTargetMisconceptionId,
      frozenSourceRefs,
      frozenSpec,
    },
    rejected: null,
  };
}

export function generateRemedyClinic<TInput = unknown, TObservable = unknown>(
  input: GenerateRemedyClinicInput<TInput, TObservable>,
): GenerateRemedyClinicResult {
  const zeroCoverage: EvidenceCoverage = { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 };

  // Snapshot and freeze all top-level rule inputs, active sources, and callbacks BEFORE running any callback.
  const verifyRuleFn = input.verifyRuleViolation;
  const verifyProbeFn = verifyProbeDistinguishability;
  const activeSourcesSnapshot = snapshotActiveSourcesMap(input.activeSourcesMap);
  const frozenLearnerId = typeof input.learnerId === "string" ? input.learnerId : "";
  const frozenCourseId = typeof input.courseId === "string" ? input.courseId : "";
  const frozenRuleId = typeof input.ruleId === "string" ? input.ruleId : "";
  const frozenRuleTitle = typeof input.ruleTitle === "string" ? input.ruleTitle : undefined;
  const frozenClinicIdInput = typeof input.clinicId === "string" ? input.clinicId : undefined;
  const frozenEpoch = input.currentPrivacyEpoch;
  const hasExplicitRuleSourceRefs = input.ruleSourceRefs !== undefined;
  const frozenRuleSourceRefs = hasExplicitRuleSourceRefs ? freezeSourceRefs(input.ruleSourceRefs) : undefined;

  if (
    !isNonBlankText(frozenLearnerId) ||
    !isNonBlankText(frozenCourseId) ||
    !isNonBlankText(frozenRuleId) ||
    !isValidPrivacyEpoch(frozenEpoch) ||
    typeof verifyRuleFn !== "function" ||
    !isDenseArray(input.attempts) ||
    (input.embeddingRecallCandidates !== undefined && !isDenseArray(input.embeddingRecallCandidates)) ||
    !isDenseArray(input.candidateProbes) ||
    (hasExplicitRuleSourceRefs && (!frozenRuleSourceRefs || !areSourceRefsActive(frozenRuleSourceRefs, activeSourcesSnapshot)))
  ) {
    return {
      status: "invalid_input",
      clinic: null,
      coverage: zeroCoverage,
      rejectedCounts: emptyRejections(),
      verifiedProbeCount: 0,
      rejectedProbes: [],
    };
  }

  const frozenRestatementStep = Object.freeze({
    ...buildRestatementStep(frozenRuleId, frozenRuleTitle),
  });
  const frozenClinicId = isNonBlankText(frozenClinicIdInput)
    ? frozenClinicIdInput.trim()
    : `clinic:${frozenCourseId}:${frozenRuleId}:e${frozenEpoch}`;

  // Snapshot and freeze ALL candidate probes up front before invoking ANY predict/verifier callback.
  const preEvaluatedProbes: Array<
    | { readonly kind: "prepared"; readonly entry: PreparedCandidateProbe<TInput, TObservable> }
    | { readonly kind: "rejected"; readonly rejected: RejectedClinicProbe }
  > = [];
  for (let i = 0; i < input.candidateProbes.length; i += 1) {
    const slot = readOwnDataIndex(input.candidateProbes, i);
    if (!slot.ok) {
      preEvaluatedProbes.push({
        kind: "rejected",
        rejected: { probeId: "", reason: "invalid_probe_descriptor", report: null },
      });
      continue;
    }
    const { prepared, rejected } = prepareCandidateProbe(slot.value, activeSourcesSnapshot);
    if (prepared) preEvaluatedProbes.push({ kind: "prepared", entry: prepared });
    else if (rejected) preEvaluatedProbes.push({ kind: "rejected", rejected });
  }

  const counters = {
    scopeMismatch: 0,
    assisted: 0,
    invalidPrivacyEpoch: 0,
    malformedAttempt: 0,
    revokedSource: 0,
    ruleIdMismatch: 0,
    verifierRejected: 0,
    duplicateRoot: 0,
    transitiveClosureBlocked: 0,
  };

  // Snapshot and deep-freeze ALL attempts (including sourceRefs) up front before invoking verifyRuleViolation.
  const taggedCandidates: Array<{ attempt: DiagnosedRootAttempt | null; fromEmbeddingRecall: boolean }> = [];
  for (let i = 0; i < input.attempts.length; i += 1) {
    const slot = readOwnDataIndex(input.attempts, i);
    taggedCandidates.push({
      attempt: slot.ok ? snapshotAttemptCandidate(slot.value) : null,
      fromEmbeddingRecall: false,
    });
  }
  if (input.embeddingRecallCandidates) {
    for (let i = 0; i < input.embeddingRecallCandidates.length; i += 1) {
      const slot = readOwnDataIndex(input.embeddingRecallCandidates, i);
      const rawCandidate = slot.ok && isPlainRecordOwnDataOnly(slot.value) ? readOwnDataProp(slot.value, "attempt") : null;
      taggedCandidates.push({
        attempt: snapshotAttemptCandidate(rawCandidate),
        fromEmbeddingRecall: true,
      });
    }
  }

  const verifiedCandidates: DiagnosedRootAttempt[] = [];
  for (const { attempt, fromEmbeddingRecall } of taggedCandidates) {
    if (!attempt) {
      counters.malformedAttempt++;
      continue;
    }
    if (attempt.learnerId !== frozenLearnerId || attempt.courseId !== frozenCourseId) {
      counters.scopeMismatch++;
      continue;
    }
    if (attempt.assisted) {
      counters.assisted++;
      continue;
    }
    if (!isValidPrivacyEpoch(attempt.privacyEpoch) || attempt.privacyEpoch !== frozenEpoch) {
      counters.invalidPrivacyEpoch++;
      continue;
    }
    if (
      !isNonBlankText(attempt.attemptId) ||
      !isNonBlankText(attempt.rootAttemptId) ||
      !isNonBlankText(attempt.chapterId) ||
      !isNonBlankText(attempt.ruleId) ||
      !isNonBlankText(attempt.excerpt) ||
      !isNonBlankText(attempt.invariantSummary) ||
      !isValidLocalDate(attempt.localDate)
    ) {
      counters.malformedAttempt++;
      continue;
    }
    if (!areSourceRefsActive(attempt.sourceRefs, activeSourcesSnapshot)) {
      counters.revokedSource++;
      continue;
    }
    // Strict exact ruleId clustering: never merge via A≈B, B≈C embedding transitive closure.
    if (attempt.ruleId !== frozenRuleId) {
      counters.ruleIdMismatch++;
      if (fromEmbeddingRecall) counters.transitiveClosureBlocked++;
      continue;
    }
    if (!safeVerifyRuleViolation(verifyRuleFn, attempt)) {
      counters.verifierRejected++;
      if (fromEmbeddingRecall) counters.transitiveClosureBlocked++;
      continue;
    }
    verifiedCandidates.push(attempt);
  }

  // Deterministic earliest-attempt selection per rootAttemptId so retries count at most once.
  verifiedCandidates.sort((a, b) => {
    const dateOrder = a.localDate.localeCompare(b.localDate);
    if (dateOrder !== 0) return dateOrder;
    const timeA = typeof a.occurredAtMs === "number" && Number.isFinite(a.occurredAtMs)
      ? a.occurredAtMs
      : Number.POSITIVE_INFINITY;
    const timeB = typeof b.occurredAtMs === "number" && Number.isFinite(b.occurredAtMs)
      ? b.occurredAtMs
      : Number.POSITIVE_INFINITY;
    if (timeA !== timeB) return timeA - timeB;
    return a.attemptId.localeCompare(b.attemptId);
  });

  const seenRoots = new Set<string>();
  const evidenceCases: ClinicEvidenceCase[] = [];
  for (const attempt of verifiedCandidates) {
    if (seenRoots.has(attempt.rootAttemptId)) {
      counters.duplicateRoot++;
      continue;
    }
    seenRoots.add(attempt.rootAttemptId);
    evidenceCases.push(
      Object.freeze({
        attemptId: attempt.attemptId,
        rootAttemptId: attempt.rootAttemptId,
        chapterId: attempt.chapterId,
        localDate: attempt.localDate,
        ruleId: attempt.ruleId,
        excerpt: attempt.excerpt,
        invariantSummary: attempt.invariantSummary,
        sourceRefs: attempt.sourceRefs,
        privacyEpoch: attempt.privacyEpoch,
      }),
    );
  }
  const frozenEvidenceCases = Object.freeze(evidenceCases);

  const coverage = Object.freeze(computeEvidenceCoverage(frozenEvidenceCases));
  if (!meetsClinicThreshold(coverage)) {
    return {
      status: "threshold_not_met",
      clinic: null,
      coverage,
      rejectedCounts: counters,
      verifiedProbeCount: 0,
      rejectedProbes: [],
    };
  }

  const verifiedProbes: VerifiedClinicTransferProbe[] = [];
  const rejectedProbes: RejectedClinicProbe[] = [];
  const acceptedProbeIds = new Set<string>();
  const acceptedProbePrompts = new Set<string>();

  for (const item of preEvaluatedProbes) {
    if (item.kind === "rejected") {
      rejectedProbes.push(item.rejected);
      continue;
    }
    const {
      frozenProbeId,
      frozenRequirementKey,
      frozenPrompt,
      frozenTargetMisconceptionId,
      frozenSourceRefs,
      frozenSpec,
    } = item.entry;

    const report = verifyProbeFn(frozenSpec);
    const probeId = report.probeId || frozenProbeId;
    if (!report.distinguishable) {
      rejectedProbes.push({ probeId, reason: "not_distinguishable", report });
      continue;
    }
    if (acceptedProbeIds.has(probeId)) {
      rejectedProbes.push({ probeId, reason: "duplicate_probe_id", report });
      continue;
    }
    const normalizedPrompt = frozenPrompt.trim().replace(/\s+/g, " ").toLowerCase();
    if (acceptedProbePrompts.has(normalizedPrompt)) {
      rejectedProbes.push({ probeId, reason: "duplicate_probe_prompt", report });
      continue;
    }
    acceptedProbeIds.add(probeId);
    acceptedProbePrompts.add(normalizedPrompt);
    verifiedProbes.push(
      Object.freeze({
        probeId,
        requirementKey: frozenRequirementKey,
        prompt: frozenPrompt,
        ...(frozenTargetMisconceptionId !== undefined
          ? { targetMisconceptionId: frozenTargetMisconceptionId }
          : {}),
        ...(frozenSourceRefs !== undefined ? { sourceRefs: frozenSourceRefs } : {}),
        competingModelIds: Object.freeze(report.predictions.map((entry) => entry.modelId)),
        report,
      }),
    );
  }

  const probe1 = verifiedProbes[0];
  const probe2 = verifiedProbes[1];
  if (!probe1 || !probe2) {
    return {
      status: "insufficient_distinguishable_probes",
      clinic: null,
      coverage,
      rejectedCounts: counters,
      verifiedProbeCount: verifiedProbes.length,
      rejectedProbes,
    };
  }

  const selectedCases = Object.freeze(selectSpreadRepresentativeCases(frozenEvidenceCases));
  const clinic: RemedyClinicSessionV1 = Object.freeze({
    schemaVersion: 1,
    clinicId: frozenClinicId,
    status: "active",
    learnerId: frozenLearnerId,
    courseId: frozenCourseId,
    ruleId: frozenRuleId,
    ...(frozenRuleSourceRefs !== undefined && frozenRuleSourceRefs !== null
      ? { ruleSourceRefs: frozenRuleSourceRefs }
      : {}),
    totalMinutes: REMEDY_CLINIC_TOTAL_MINUTES,
    createdPrivacyEpoch: frozenEpoch,
    validatedPrivacyEpoch: frozenEpoch,
    coverage,
    evidenceCases: frozenEvidenceCases,
    steps: Object.freeze([
      Object.freeze({
        stepNumber: 1 as const,
        kind: "side_by_side_self_diff" as const,
        durationMinutes: STEP1_SELF_DIFF_MINUTES,
        selectedCases,
        diffs: buildSelfDiffEntries(selectedCases),
      }),
      frozenRestatementStep,
      Object.freeze({
        stepNumber: 3 as const,
        kind: "distinguishable_transfer_probes" as const,
        durationMinutes: STEP3_TRANSFER_PROBES_MINUTES,
        probes: Object.freeze([probe1, probe2]),
      }),
    ] as const),
    revocationSummary: Object.freeze({
      strippedCaseCount: 0,
      reason: "none" as const,
    }),
  });

  return {
    status: "active",
    clinic,
    coverage,
    rejectedCounts: counters,
    verifiedProbeCount: REQUIRED_TRANSFER_PROBE_COUNT,
    rejectedProbes,
  };
}

interface ClinicSnapshotHeader {
  readonly clinicId: string;
  readonly status: "active" | "stale_source_revoked";
  readonly learnerId: string;
  readonly courseId: string;
  readonly ruleId: string;
  readonly hasRuleSourceRefs: boolean;
  readonly ruleSourceRefs: readonly RemedySourceRef[] | null;
  readonly createdPrivacyEpoch: number;
  readonly validatedPrivacyEpoch: number;
  readonly priorStrippedCaseCount: number;
}

function buildRevokedClinicFromHeader(
  header: ClinicSnapshotHeader,
  validatedPrivacyEpoch: number,
  coverage: EvidenceCoverage,
  strippedCaseCount: number,
  reason: ClinicRevocationReason,
): RemedyClinicSessionV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    clinicId: header.clinicId,
    status: "stale_source_revoked" as const,
    learnerId: header.learnerId,
    courseId: header.courseId,
    ruleId: header.ruleId,
    ...(header.hasRuleSourceRefs ? { ruleSourceRefs: Object.freeze([]) } : {}),
    totalMinutes: REMEDY_CLINIC_TOTAL_MINUTES,
    createdPrivacyEpoch: header.createdPrivacyEpoch,
    validatedPrivacyEpoch,
    coverage: Object.freeze({ ...coverage }),
    evidenceCases: Object.freeze([]),
    steps: Object.freeze([
      Object.freeze({
        stepNumber: 1 as const,
        kind: "side_by_side_self_diff" as const,
        durationMinutes: STEP1_SELF_DIFF_MINUTES,
        selectedCases: Object.freeze([]),
        diffs: Object.freeze([]),
      }),
      Object.freeze({
        stepNumber: 2 as const,
        kind: "invariant_rule_restatement" as const,
        durationMinutes: STEP2_INVARIANT_RESTATEMENT_MINUTES,
        ruleId: header.ruleId,
        ruleTitle: "",
        prompt: REVOKED_CLINIC_STEP2_PLACEHOLDER,
        checklist: Object.freeze([]),
      }),
      Object.freeze({
        stepNumber: 3 as const,
        kind: "distinguishable_transfer_probes" as const,
        durationMinutes: STEP3_TRANSFER_PROBES_MINUTES,
        probes: Object.freeze([]),
      }),
    ] as const),
    revocationSummary: Object.freeze({
      strippedCaseCount,
      reason,
    }),
  });
}

function snapshotEvidenceCaseForRevalidation(rawCase: unknown): ClinicEvidenceCase | null {
  if (!isPlainRecordOwnDataOnly(rawCase)) return null;
  const attemptId = readOwnDataProp(rawCase, "attemptId");
  const rootAttemptId = readOwnDataProp(rawCase, "rootAttemptId");
  const chapterId = readOwnDataProp(rawCase, "chapterId");
  const localDate = readOwnDataProp(rawCase, "localDate");
  const ruleId = readOwnDataProp(rawCase, "ruleId");
  const excerpt = readOwnDataProp(rawCase, "excerpt");
  const invariantSummary = readOwnDataProp(rawCase, "invariantSummary");
  const privacyEpoch = readOwnDataProp(rawCase, "privacyEpoch");
  const rawSourceRefs = readOwnDataProp(rawCase, "sourceRefs");

  if (
    typeof attemptId !== "string" ||
    typeof rootAttemptId !== "string" ||
    typeof chapterId !== "string" ||
    typeof localDate !== "string" ||
    typeof ruleId !== "string" ||
    typeof excerpt !== "string" ||
    typeof invariantSummary !== "string" ||
    typeof privacyEpoch !== "number"
  ) {
    return null;
  }

  const frozenSourceRefs = freezeSourceRefs(rawSourceRefs);
  if (!frozenSourceRefs) return null;

  return Object.freeze({
    attemptId,
    rootAttemptId,
    chapterId,
    localDate,
    ruleId,
    excerpt,
    invariantSummary,
    sourceRefs: frozenSourceRefs,
    privacyEpoch,
  });
}

function snapshotProbeForRevalidation(
  rawProbe: unknown,
  activeSources: ReadonlyMap<string, ActiveSourceEntry>,
): VerifiedClinicTransferProbe | null {
  if (!isPlainRecordOwnDataOnly(rawProbe)) return null;
  const probeId = readOwnDataProp(rawProbe, "probeId");
  const requirementKey = readOwnDataProp(rawProbe, "requirementKey");
  const prompt = readOwnDataProp(rawProbe, "prompt");
  const targetMisconceptionId = readOwnDataProp(rawProbe, "targetMisconceptionId");
  const hasExplicitSourceRefs =
    Object.hasOwn(rawProbe, "sourceRefs") && readOwnDataProp(rawProbe, "sourceRefs") !== undefined;
  const rawSourceRefs = hasExplicitSourceRefs ? readOwnDataProp(rawProbe, "sourceRefs") : undefined;
  const rawCompetingModelIds = readOwnDataProp(rawProbe, "competingModelIds");
  const report = readOwnDataProp(rawProbe, "report");

  if (
    typeof probeId !== "string" ||
    typeof requirementKey !== "string" ||
    typeof prompt !== "string" ||
    (targetMisconceptionId !== undefined && typeof targetMisconceptionId !== "string") ||
    !isPlainRecordOwnDataOnly(report)
  ) {
    return null;
  }

  const frozenCompetingModelIds = snapshotStringArray(rawCompetingModelIds);
  if (!frozenCompetingModelIds) return null;

  let validatedSourceRefs: readonly RemedySourceRef[] | undefined;
  if (hasExplicitSourceRefs) {
    const frozenRefs = freezeSourceRefs(rawSourceRefs);
    if (!frozenRefs || !areSourceRefsActive(frozenRefs, activeSources)) return null;
    validatedSourceRefs = frozenRefs;
  }

  const clonedReport = cloneAndFreezePlainData(report);
  if (!clonedReport.ok) return null;

  return Object.freeze({
    probeId,
    requirementKey,
    prompt,
    ...(targetMisconceptionId !== undefined ? { targetMisconceptionId } : {}),
    ...(validatedSourceRefs !== undefined ? { sourceRefs: validatedSourceRefs } : {}),
    competingModelIds: frozenCompetingModelIds,
    report: clonedReport.value as ProbeDistinguishabilityReport,
  });
}

/**
 * Read-time privacy_epoch and source-version guard.
 * Performs single-pass own-data descriptor snapshotting up front (zero getter execution,
 * zero second reads), strips any case or probe referencing missing/revoked/version-mismatched
 * sources, and degrades fail-closed to "stale_source_revoked" with all 3 steps scrubbed.
 */
export function revalidateRemedyClinic(
  clinic: RemedyClinicSessionV1,
  activeSourcesMap: ActiveSourcesMap,
  currentPrivacyEpoch: number,
): RemedyClinicSessionV1 {
  const zeroCoverage: EvidenceCoverage = { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 };
  const activeSourcesSnapshot = snapshotActiveSourcesMap(activeSourcesMap);

  const clinicIsPlain = isPlainRecordOwnDataOnly(clinic);
  const rawClinicId = clinicIsPlain ? readOwnDataProp(clinic, "clinicId") : "";
  const rawStatus = clinicIsPlain ? readOwnDataProp(clinic, "status") : "stale_source_revoked";
  const rawLearnerId = clinicIsPlain ? readOwnDataProp(clinic, "learnerId") : "";
  const rawCourseId = clinicIsPlain ? readOwnDataProp(clinic, "courseId") : "";
  const rawRuleId = clinicIsPlain ? readOwnDataProp(clinic, "ruleId") : "";
  const rawCreatedEpoch = clinicIsPlain ? readOwnDataProp(clinic, "createdPrivacyEpoch") : -1;
  const rawValidatedEpoch = clinicIsPlain ? readOwnDataProp(clinic, "validatedPrivacyEpoch") : -1;
  const hasRuleSourceRefs =
    clinicIsPlain && Object.hasOwn(clinic, "ruleSourceRefs") && readOwnDataProp(clinic, "ruleSourceRefs") !== undefined;
  const rawRuleSourceRefs = hasRuleSourceRefs ? readOwnDataProp(clinic, "ruleSourceRefs") : undefined;
  const rawEvidenceCases = clinicIsPlain ? readOwnDataProp(clinic, "evidenceCases") : undefined;
  const rawSteps = clinicIsPlain ? readOwnDataProp(clinic, "steps") : undefined;
  const rawRevSummary = clinicIsPlain ? readOwnDataProp(clinic, "revocationSummary") : undefined;
  const priorStrippedCaseCount =
    isPlainRecordOwnDataOnly(rawRevSummary) && typeof readOwnDataProp(rawRevSummary, "strippedCaseCount") === "number"
      ? (readOwnDataProp(rawRevSummary, "strippedCaseCount") as number)
      : 0;

  const header: ClinicSnapshotHeader = {
    clinicId: typeof rawClinicId === "string" ? rawClinicId : "",
    status: rawStatus === "active" ? "active" : "stale_source_revoked",
    learnerId: typeof rawLearnerId === "string" ? rawLearnerId : "",
    courseId: typeof rawCourseId === "string" ? rawCourseId : "",
    ruleId: typeof rawRuleId === "string" ? rawRuleId : "",
    hasRuleSourceRefs,
    ruleSourceRefs: hasRuleSourceRefs ? freezeSourceRefs(rawRuleSourceRefs) : null,
    createdPrivacyEpoch: typeof rawCreatedEpoch === "number" ? rawCreatedEpoch : -1,
    validatedPrivacyEpoch: typeof rawValidatedEpoch === "number" ? rawValidatedEpoch : -1,
    priorStrippedCaseCount,
  };

  const totalEvidenceCases = Array.isArray(rawEvidenceCases) ? rawEvidenceCases.length : 0;

  if (
    !clinicIsPlain ||
    !isValidPrivacyEpoch(currentPrivacyEpoch) ||
    !isValidPrivacyEpoch(header.createdPrivacyEpoch) ||
    !isValidPrivacyEpoch(header.validatedPrivacyEpoch) ||
    header.validatedPrivacyEpoch < header.createdPrivacyEpoch ||
    currentPrivacyEpoch < header.createdPrivacyEpoch ||
    currentPrivacyEpoch < header.validatedPrivacyEpoch
  ) {
    const validEpochs = [
      header.createdPrivacyEpoch,
      header.validatedPrivacyEpoch,
      currentPrivacyEpoch,
    ].filter(isValidPrivacyEpoch);
    const safeEpoch = validEpochs.length > 0 ? Math.max(0, ...validEpochs) : 0;
    return buildRevokedClinicFromHeader(
      header,
      safeEpoch,
      zeroCoverage,
      totalEvidenceCases,
      "invalid_privacy_epoch",
    );
  }

  if (header.status === "stale_source_revoked") {
    return buildRevokedClinicFromHeader(
      header,
      currentPrivacyEpoch,
      zeroCoverage,
      header.priorStrippedCaseCount,
      "already_revoked",
    );
  }

  if (header.hasRuleSourceRefs) {
    if (!header.ruleSourceRefs || !areSourceRefsActive(header.ruleSourceRefs, activeSourcesSnapshot)) {
      return buildRevokedClinicFromHeader(
        header,
        currentPrivacyEpoch,
        zeroCoverage,
        totalEvidenceCases,
        "rule_source_revoked",
      );
    }
  }

  // Snapshot clinic.steps strictly via own data indices 0, 1, 2 (zero iterator/getter invocation).
  if (!Array.isArray(rawSteps) || rawSteps.length !== 3) {
    return buildRevokedClinicFromHeader(
      header,
      currentPrivacyEpoch,
      zeroCoverage,
      totalEvidenceCases,
      "insufficient_surviving_evidence",
    );
  }
  const step0Slot = readOwnDataIndex(rawSteps, 0);
  const step1Slot = readOwnDataIndex(rawSteps, 1);
  const step2Slot = readOwnDataIndex(rawSteps, 2);
  if (
    !step0Slot.ok ||
    !step1Slot.ok ||
    !step2Slot.ok ||
    !isPlainRecordOwnDataOnly(step0Slot.value) ||
    !isPlainRecordOwnDataOnly(step1Slot.value) ||
    !isPlainRecordOwnDataOnly(step2Slot.value)
  ) {
    return buildRevokedClinicFromHeader(
      header,
      currentPrivacyEpoch,
      zeroCoverage,
      totalEvidenceCases,
      "insufficient_surviving_evidence",
    );
  }

  const rawStep2RuleTitle = readOwnDataProp(step1Slot.value, "ruleTitle");
  const rawStep2Prompt = readOwnDataProp(step1Slot.value, "prompt");
  const rawStep2Checklist = snapshotStringArray(readOwnDataProp(step1Slot.value, "checklist"));
  if (typeof rawStep2RuleTitle !== "string" || typeof rawStep2Prompt !== "string" || !rawStep2Checklist) {
    return buildRevokedClinicFromHeader(
      header,
      currentPrivacyEpoch,
      zeroCoverage,
      totalEvidenceCases,
      "insufficient_surviving_evidence",
    );
  }
  const frozenStep2: InvariantRuleRestatementStep = Object.freeze({
    stepNumber: 2 as const,
    kind: "invariant_rule_restatement" as const,
    durationMinutes: STEP2_INVARIANT_RESTATEMENT_MINUTES,
    ruleId: header.ruleId,
    ruleTitle: rawStep2RuleTitle,
    prompt: rawStep2Prompt,
    checklist: rawStep2Checklist,
  });

  // Single-pass snapshot + validation of evidenceCases (never read any case or sourceRefs twice).
  const seenRoots = new Set<string>();
  const survivingCases: ClinicEvidenceCase[] = [];
  if (Array.isArray(rawEvidenceCases)) {
    for (let i = 0; i < rawEvidenceCases.length; i += 1) {
      const slot = readOwnDataIndex(rawEvidenceCases, i);
      if (!slot.ok) continue;
      const snap = snapshotEvidenceCaseForRevalidation(slot.value);
      if (!snap) continue;
      if (seenRoots.has(snap.rootAttemptId)) continue;
      if (snap.ruleId !== header.ruleId) continue;
      if (!isValidPrivacyEpoch(snap.privacyEpoch) || snap.privacyEpoch > currentPrivacyEpoch) continue;
      if (!isValidLocalDate(snap.localDate)) continue;
      if (!areSourceRefsActive(snap.sourceRefs, activeSourcesSnapshot)) continue;
      seenRoots.add(snap.rootAttemptId);
      survivingCases.push(snap);
    }
  }
  const frozenSurvivingCases = Object.freeze(survivingCases);
  const strippedCaseCount = totalEvidenceCases - frozenSurvivingCases.length;
  const coverage = Object.freeze(computeEvidenceCoverage(frozenSurvivingCases));

  if (!meetsClinicThreshold(coverage)) {
    return buildRevokedClinicFromHeader(
      header,
      currentPrivacyEpoch,
      coverage,
      strippedCaseCount,
      "insufficient_surviving_evidence",
    );
  }

  // Single-pass snapshot + validation of Step 3 probes (including competingModelIds and sourceRefs).
  const rawStep3Probes = readOwnDataProp(step2Slot.value, "probes");
  const totalProbes = Array.isArray(rawStep3Probes) ? rawStep3Probes.length : 0;
  const survivingProbes: VerifiedClinicTransferProbe[] = [];
  if (Array.isArray(rawStep3Probes)) {
    for (let i = 0; i < rawStep3Probes.length; i += 1) {
      const slot = readOwnDataIndex(rawStep3Probes, i);
      if (!slot.ok) continue;
      const snapProbe = snapshotProbeForRevalidation(slot.value, activeSourcesSnapshot);
      if (!snapProbe) continue;
      survivingProbes.push(snapProbe);
    }
  }
  const strippedProbeCount = totalProbes - survivingProbes.length;
  if (survivingProbes.length < REQUIRED_TRANSFER_PROBE_COUNT) {
    return buildRevokedClinicFromHeader(
      header,
      currentPrivacyEpoch,
      coverage,
      strippedCaseCount,
      "insufficient_surviving_probes",
    );
  }

  const selectedCases = Object.freeze(selectSpreadRepresentativeCases(frozenSurvivingCases));
  return Object.freeze({
    schemaVersion: 1 as const,
    clinicId: header.clinicId,
    status: "active" as const,
    learnerId: header.learnerId,
    courseId: header.courseId,
    ruleId: header.ruleId,
    ...(header.hasRuleSourceRefs && header.ruleSourceRefs ? { ruleSourceRefs: header.ruleSourceRefs } : {}),
    totalMinutes: REMEDY_CLINIC_TOTAL_MINUTES,
    createdPrivacyEpoch: header.createdPrivacyEpoch,
    validatedPrivacyEpoch: currentPrivacyEpoch,
    coverage,
    evidenceCases: frozenSurvivingCases,
    steps: Object.freeze([
      Object.freeze({
        stepNumber: 1 as const,
        kind: "side_by_side_self_diff" as const,
        durationMinutes: STEP1_SELF_DIFF_MINUTES,
        selectedCases,
        diffs: buildSelfDiffEntries(selectedCases),
      }),
      frozenStep2,
      Object.freeze({
        stepNumber: 3 as const,
        kind: "distinguishable_transfer_probes" as const,
        durationMinutes: STEP3_TRANSFER_PROBES_MINUTES,
        probes: Object.freeze(survivingProbes.slice(0, REQUIRED_TRANSFER_PROBE_COUNT)),
      }),
    ] as const),
    revocationSummary: Object.freeze({
      strippedCaseCount,
      ...(strippedProbeCount > 0 ? { strippedProbeCount } : {}),
      reason:
        strippedCaseCount > 0 || strippedProbeCount > 0
          ? ("partial_source_revoked_still_active" as const)
          : ("none" as const),
    }),
  });
}
