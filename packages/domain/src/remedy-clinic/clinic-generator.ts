import type {
  DistinguishableProbeSpec,
  ProbeDistinguishabilityIssue,
  ProbeDistinguishabilityReport,
  ProbeModelPrediction,
} from "../opening/cartridges/probe-protocol";
import {
  areSourceRefsActive,
  buildSelfDiffEntries,
  compareUtf16,
  computeEvidenceCoverage,
  isNonBlankText,
  isValidLocalDate,
  isValidPrivacyEpoch,
  meetsClinicThreshold,
  readOwnDataIndex,
  selectSpreadRepresentativeCases,
  snapshotActiveSourcesMap,
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
export const CLINIC_RUBRIC_MIN_QWK = 0.7 as const;
export const CLINIC_DELAYED_RECHECK_MIN_HOURS = 24 as const;

export interface ClinicRubricCalibrationGuard {
  readonly calibrated: boolean;
  readonly agreementPassed?: boolean;
  readonly qwk?: number | null;
}

export interface ClinicDelayedRecheckContract {
  readonly required: true;
  readonly scheduledOutsideSessionMinutes: true;
  readonly minDelayHours: 24;
  readonly ruleId: string;
  readonly countsTowardMasteryUntilPassed: false;
}

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
  readonly swapConsistent?: boolean;
  readonly templatePadded?: boolean;
  readonly calibrationVerified?: boolean;
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
    | "target_misconception_mismatch"
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
  readonly delayedRecheck: ClinicDelayedRecheckContract;
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
  readonly rubricGuardRejected: number;
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
  readonly rubricCalibration?: ClinicRubricCalibrationGuard;
}

export interface GenerateRemedyClinicResult {
  readonly status:
    | "active"
    | "threshold_not_met"
    | "insufficient_distinguishable_probes"
    | "uncalibrated_rubric"
    | "low_rubric_agreement"
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
    rubricGuardRejected: 0,
    verifierRejected: 0,
    duplicateRoot: 0,
    transitiveClosureBlocked: 0,
  };
}

function buildDelayedRecheck(ruleId: string): ClinicDelayedRecheckContract {
  return Object.freeze({
    required: true as const,
    scheduledOutsideSessionMinutes: true as const,
    minDelayHours: CLINIC_DELAYED_RECHECK_MIN_HOURS,
    ruleId,
    countsTowardMasteryUntilPassed: false as const,
  });
}

function resolveRevokedStep2Placeholder(reason: ClinicRevocationReason): string {
  switch (reason) {
    case "invalid_privacy_epoch":
      return "This remedy clinic is unavailable because the privacy verification state is invalid or out of date.";
    case "insufficient_surviving_probes":
      return "This remedy clinic is unavailable because its transfer probes are no longer available or valid.";
    default:
      return "This remedy clinic is no longer available because an underlying source was updated or removed.";
  }
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

const REGEXP_SOURCE_GET = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GET = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const DATA_VIEW_BYTE_LENGTH_GET = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get;
const SHARED_ARRAY_BUFFER_BYTE_LENGTH_GET =
  typeof SharedArrayBuffer !== "undefined"
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get
    : undefined;
const WEAK_REF_DEREF = typeof WeakRef !== "undefined" ? WeakRef.prototype.deref : undefined;
const FINALIZATION_REGISTRY_UNREGISTER =
  typeof FinalizationRegistry !== "undefined" ? FinalizationRegistry.prototype.unregister : undefined;
const GENERATOR_RETURN = (
  Object.getPrototypeOf(Object.getPrototypeOf((function* () {})())) as { return?: (value?: unknown) => unknown } | null
)?.return;
const ERROR_IS_ERROR = (Error as { isError?: (v: unknown) => boolean }).isError;
const WEAK_PROBE_KEY = Object.freeze({});

function getStructuredCloneErrorSignature(value: unknown): string | null {
  try {
    structuredClone(value);
    return null;
  } catch (err) {
    if (err instanceof Error) return `${err.name}:${err.message}`;
    return String(err);
  }
}

const EXOTIC_CONTAINER_CLONE_ERRORS: ReadonlySet<string> = (() => {
  const signatures = new Set<string>();
  const agObjProto = Object.setPrototypeOf((async function* () {})(), Object.prototype);
  const agNullProto = Object.setPrototypeOf((async function* () {})(), null);
  const proxyObj = new Proxy({}, {});
  for (const sample of [agObjProto, agNullProto, proxyObj]) {
    const sig = getStructuredCloneErrorSignature(sample);
    if (sig !== null) signatures.add(sig);
  }
  return signatures;
})();

/**
 * Synchronous, zero-Promise-allocation, reaction-free check for function-bearing containers
 * (input, candidateProbe, correctModel, hypothesis) AFTER all non-function properties have been
 * proven getter-free plain data. Rejects AsyncGenerator, Generator, Promise, and Proxy at the root
 * (where structuredClone fails before traversing properties) while accepting genuine plain objects
 * whose only uncloneable values are the validated function fields.
 */
function isPlainContainerWithOnlyKnownFunctions(
  root: object,
  knownFunctions: readonly ((...args: never[]) => unknown)[],
): boolean {
  const actualSig = getStructuredCloneErrorSignature(root);
  if (actualSig === null) return true;
  if (knownFunctions.length === 0) return false;
  const allowedFnSigs = new Set<string>();
  for (const fn of knownFunctions) {
    const fnSig = getStructuredCloneErrorSignature({ f: fn });
    if (fnSig !== null) allowedFnSigs.add(fnSig);
  }
  if (!allowedFnSigs.has(actualSig)) return false;
  if (EXOTIC_CONTAINER_CLONE_ERRORS.has(actualSig)) {
    // Only disambiguate when the host engine distinguishes root exotic object errors from function errors.
    for (const fnSig of allowedFnSigs) {
      if (!EXOTIC_CONTAINER_CLONE_ERRORS.has(fnSig)) return false;
    }
  }
  return true;
}

function matchesBrand(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

function safeIsArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function safeGetPrototypeOf(obj: object): { readonly ok: true; readonly proto: object | null } | { readonly ok: false } {
  try {
    return { ok: true, proto: Object.getPrototypeOf(obj) as object | null };
  } catch {
    return { ok: false };
  }
}

function safeOwnKeys(obj: object): readonly PropertyKey[] | null {
  try {
    return Reflect.ownKeys(obj);
  } catch {
    return null;
  }
}

function safeGetOwnPropertyDescriptor(
  obj: object,
  key: PropertyKey,
): { readonly ok: true; readonly desc: PropertyDescriptor | undefined } | { readonly ok: false } {
  try {
    return { ok: true, desc: Object.getOwnPropertyDescriptor(obj, key) };
  } catch {
    return { ok: false };
  }
}

/**
 * Detect exotic built-in internal slots (Map, Set, Date, RegExp, ArrayBuffer, TypedArray,
 * DataView, WeakMap, WeakSet, WeakRef, FinalizationRegistry, Generator, Promise, Error,
 * boxed primitives, SharedArrayBuffer) even when prototype is reassigned.
 * Uses reaction-free ECMA-262 PromiseResolve(Object, obj) (never attaches .then reactions
 * or mutates [[PromiseIsHandled]]) and Generator.prototype.return (never executes suspended-start body).
 * Call ONLY after verifying prototype and own keys (no symbol keys / no accessors / no "__proto__").
 */
function hasExoticInternalSlots(
  obj: object,
  verifiedProto: object | null,
  hasOwnConstructor: boolean,
): boolean {
  try {
    if (ArrayBuffer.isView(obj)) return true;
    if (typeof ERROR_IS_ERROR === "function") {
      if (ERROR_IS_ERROR(obj)) return true;
    } else {
      const tagDescRes = safeGetOwnPropertyDescriptor(obj, Symbol.toStringTag);
      if (!tagDescRes.ok) return true;
      if (
        (verifiedProto === Object.prototype || verifiedProto === null || verifiedProto === Array.prototype) &&
        tagDescRes.desc === undefined &&
        Object.prototype.toString.call(obj) === "[object Error]"
      ) {
        return true;
      }
    }
    if (matchesBrand(() => Reflect.apply(Map.prototype.has, obj, [undefined]))) return true;
    if (matchesBrand(() => Reflect.apply(Set.prototype.has, obj, [undefined]))) return true;
    if (matchesBrand(() => Reflect.apply(WeakMap.prototype.has, obj, [WEAK_PROBE_KEY]))) return true;
    if (matchesBrand(() => Reflect.apply(WeakSet.prototype.has, obj, [WEAK_PROBE_KEY]))) return true;
    if (WEAK_REF_DEREF && matchesBrand(() => Reflect.apply(WEAK_REF_DEREF, obj, []))) return true;
    if (
      FINALIZATION_REGISTRY_UNREGISTER &&
      matchesBrand(() => Reflect.apply(FINALIZATION_REGISTRY_UNREGISTER, obj, [WEAK_PROBE_KEY]))
    ) {
      return true;
    }
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
    if (GENERATOR_RETURN && matchesBrand(() => Reflect.apply(GENERATOR_RETURN, obj, [undefined]))) return true;
    // Reaction-free Promise check: when proto === Object.prototype and no own constructor,
    // ECMA-262 PromiseResolve(Object, obj) returns obj at Step 2b if IsPromise(obj) without
    // touching [[PromiseIsHandled]] or attaching reactions, and throws TypeError otherwise.
    if (verifiedProto === Object.prototype && !hasOwnConstructor) {
      try {
        if (Reflect.apply(Promise.resolve, Object, [obj]) === obj) return true;
      } catch {
        // Not a Promise.
      }
    }
    if (matchesBrand(() => Reflect.apply(Number.prototype.valueOf, obj, []))) return true;
    if (matchesBrand(() => Reflect.apply(String.prototype.valueOf, obj, []))) return true;
    if (matchesBrand(() => Reflect.apply(Boolean.prototype.valueOf, obj, []))) return true;
    if (matchesBrand(() => Reflect.apply(Symbol.prototype.valueOf, obj, []))) return true;
    if (matchesBrand(() => Reflect.apply(BigInt.prototype.valueOf, obj, []))) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Single-pass array snapshot: reads length descriptor and every index 0..len-1 strictly ONCE
 * inside try/catch, returning a fresh native frozen array. Callers never touch raw value again.
 */
function snapshotDenseOwnArray(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
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
    const keys = Reflect.ownKeys(value);
    if (keys.length !== len + 1) return null;
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
    if (hasExoticInternalSlots(value, Array.prototype, false)) return null;
    return Object.freeze(out);
  } catch {
    return null;
  }
}

/**
 * Single-pass own-data record snapshot: reads Reflect.ownKeys and every descriptor strictly ONCE
 * into a frozen null-prototype record, eliminating multi-read stateful Proxy TOCTOU.
 */
function snapshotOwnRecord(
  value: unknown,
  options?: {
    readonly requireObjectProto?: boolean;
    readonly forbidOwnConstructor?: boolean;
  },
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  try {
    if (Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value) as object | null;
    if (options?.requireObjectProto) {
      if (proto !== Object.prototype) return null;
    } else if (proto !== Object.prototype && proto !== null) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    const snap: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let hasOwnConstructor = false;
    for (const key of keys) {
      if (typeof key !== "string" || key === "__proto__") return null;
      if (key === "constructor") {
        if (options?.forbidOwnConstructor) return null;
        hasOwnConstructor = true;
      }
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
    if (hasExoticInternalSlots(value, proto, hasOwnConstructor)) return null;
    return Object.freeze(snap);
  } catch {
    return null;
  }
}

function isPlainRecordOwnDataOnly(value: unknown): value is Record<string, unknown> {
  return snapshotOwnRecord(value) !== null;
}

function isPlainDenseArrayHeader(obj: unknown): obj is unknown[] {
  return snapshotDenseOwnArray(obj) !== null;
}

/**
 * Single-pass, exotic-brand-rejecting, descriptor-materializing plain-data clone & deep-freeze.
 * Guarded against throwing Proxy traps, rejects own "__proto__" keys, and unconditionally verifies
 * every non-primitive root via structuredClone AFTER confirming every reachable node is getter-free
 * so Proxy, Promise (without mutating [[PromiseIsHandled]]), Generator, and AsyncGenerator are
 * always rejected regardless of nesting or non-primitive child values.
 */
function cloneAndFreezePlainDataInner(
  value: unknown,
  memo: Map<object, unknown>,
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

  const protoRes = safeGetPrototypeOf(obj);
  if (!protoRes.ok) return { ok: false };
  const proto = protoRes.proto;

  if (safeIsArray(obj)) {
    const items = snapshotDenseOwnArray(obj);
    if (!items) return { ok: false };
    const len = items.length;
    const out: unknown[] = new Array(len);
    memo.set(obj, out);
    for (let i = 0; i < len; i += 1) {
      const child = cloneAndFreezePlainDataInner(items[i], memo);
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
  const ownKeys = safeOwnKeys(obj);
  if (!ownKeys) return { ok: false };
  let hasOwnConstructor = false;
  const validatedEntries: Array<{ readonly key: string; readonly value: unknown; readonly enumerable: boolean }> = [];
  for (const key of ownKeys) {
    if (typeof key !== "string" || key === "__proto__") return { ok: false };
    if (key === "constructor") hasOwnConstructor = true;
    const descRes = safeGetOwnPropertyDescriptor(obj, key);
    if (
      !descRes.ok ||
      !descRes.desc ||
      !descRes.desc.enumerable ||
      !Object.hasOwn(descRes.desc, "value") ||
      descRes.desc.get !== undefined ||
      descRes.desc.set !== undefined
    ) {
      return { ok: false };
    }
    validatedEntries.push({ key, value: descRes.desc.value, enumerable: descRes.desc.enumerable });
  }
  if (hasExoticInternalSlots(obj, proto, hasOwnConstructor)) return { ok: false };

  const out: Record<string, unknown> =
    proto === null ? (Object.create(null) as Record<string, unknown>) : {};
  memo.set(obj, out);
  for (const entry of validatedEntries) {
    const child = cloneAndFreezePlainDataInner(entry.value, memo);
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

function cloneAndFreezePlainData(
  value: unknown,
  memo: Map<object, unknown> = new Map(),
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const cloned = cloneAndFreezePlainDataInner(value, memo);
  if (!cloned.ok) return { ok: false };
  if (value !== null && typeof value === "object") {
    try {
      structuredClone(value);
    } catch {
      return { ok: false };
    }
  }
  return cloned;
}

function readOwnDataProp(obj: object, key: string): unknown {
  const descRes = safeGetOwnPropertyDescriptor(obj, key);
  if (
    !descRes.ok ||
    !descRes.desc ||
    !Object.hasOwn(descRes.desc, "value") ||
    descRes.desc.get !== undefined ||
    descRes.desc.set !== undefined
  ) {
    return undefined;
  }
  return descRes.desc.value;
}

type SourceRefsSnapshotResult =
  | { readonly kind: "ok"; readonly refs: readonly RemedySourceRef[] }
  | { readonly kind: "empty_or_null_ref" }
  | { readonly kind: "invalid_descriptor" };

/**
 * Single-pass sourceRefs validator: verifies dense plain array and plain primitive element records
 * BEFORE running structuredClone (zero getter execution, zero second reads).
 */
function snapshotSourceRefsWithKind(sourceRefs: unknown): SourceRefsSnapshotResult {
  const items = snapshotDenseOwnArray(sourceRefs);
  if (!items) return { kind: "invalid_descriptor" };

  let hasNullRef = false;
  const frozen: RemedySourceRef[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const el = items[i];
    if (el === null) {
      hasNullRef = true;
      continue;
    }
    const rec = snapshotOwnRecord(el);
    if (!rec) return { kind: "invalid_descriptor" };
    for (const key of Object.keys(rec)) {
      const val = rec[key];
      if (val !== null && (typeof val === "object" || typeof val === "function")) {
        return { kind: "invalid_descriptor" };
      }
    }
    const sourceId = rec["sourceId"];
    const sourceVersion = rec["sourceVersion"];
    if (typeof sourceId !== "string" || (typeof sourceVersion !== "string" && typeof sourceVersion !== "number")) {
      return { kind: "invalid_descriptor" };
    }
    frozen.push(Object.freeze({ sourceId, sourceVersion }));
  }

  // Every reachable element is verified getter-free plain data; structuredClone rejects Proxy/Promise/Generator.
  try {
    structuredClone(sourceRefs);
  } catch {
    return { kind: "invalid_descriptor" };
  }

  if (items.length === 0 || hasNullRef) {
    return { kind: "empty_or_null_ref" };
  }
  return { kind: "ok", refs: Object.freeze(frozen) };
}

function freezeSourceRefs(sourceRefs: unknown): readonly RemedySourceRef[] | null {
  const snap = snapshotSourceRefsWithKind(sourceRefs);
  return snap.kind === "ok" ? snap.refs : null;
}

interface IsolatedProbeModelResult {
  readonly model: Record<string, unknown>;
  readonly rawPredict: (...args: never[]) => unknown;
}

function isolateProbeModel<TInput, TObservable>(
  rawModel: unknown,
  role: "correct" | "misconception",
): IsolatedProbeModelResult | null {
  const modelSnap = snapshotOwnRecord(rawModel, {
    requireObjectProto: true,
    forbidOwnConstructor: true,
  });
  if (!modelSnap) return null;
  const rawPredict = modelSnap["predict"];
  if (typeof rawPredict !== "function") return null;

  const frozenReceiver: Record<string, unknown> = {};
  const memo = new Map<object, unknown>();
  memo.set(rawModel as object, frozenReceiver);
  const valuesToCloneCheck: unknown[] = [];

  for (const key of Object.keys(modelSnap)) {
    if (key === "predict") continue;
    const rawVal = modelSnap[key];
    const cloned = cloneAndFreezePlainDataInner(rawVal, memo);
    if (!cloned.ok) return null;
    if (rawVal !== null && typeof rawVal === "object") {
      valuesToCloneCheck.push(rawVal);
    }
    Object.defineProperty(frozenReceiver, key, {
      value: cloned.value,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
  if (valuesToCloneCheck.length > 0) {
    try {
      structuredClone(valuesToCloneCheck);
    } catch {
      return null;
    }
  }
  // All non-predict properties are verified getter-free plain data; verify rawModel itself is not
  // an AsyncGenerator, Generator, Promise, or Proxy.
  if (!isPlainContainerWithOnlyKnownFunctions(rawModel as object, [rawPredict as (...args: never[]) => unknown])) {
    return null;
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
  return {
    model: Object.freeze(base),
    rawPredict: rawPredict as (...args: never[]) => unknown,
  };
}

function normalizePromptKey(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

function predictClinicObservableKey<TInput, TObservable>(
  input: TInput,
  encodeObservable: (observable: TObservable) => string,
  predict: (value: TInput) => TObservable,
  issues: Set<ProbeDistinguishabilityIssue>,
): string | null {
  try {
    const predictAndEncode = (): unknown => {
      const inputCopy = structuredClone(input);
      const rawObservable = predict(inputCopy);
      const clonedObservable = cloneAndFreezePlainData(rawObservable);
      if (!clonedObservable.ok) {
        throw new TypeError("Non-plain observable output");
      }
      return encodeObservable(clonedObservable.value as TObservable);
    };
    const first = predictAndEncode();
    const second = predictAndEncode();
    if (!isNonBlankText(first) || !isNonBlankText(second)) {
      issues.add("invalid_observable_key");
      return null;
    }
    if (first !== second) {
      issues.add("nondeterministic_prediction");
      return null;
    }
    return first;
  } catch {
    issues.add("prediction_failed");
    return null;
  }
}

function buildInvalidProbeReport(
  probeId: string,
  issue: ProbeDistinguishabilityIssue,
): ProbeDistinguishabilityReport {
  return Object.freeze({
    probeId,
    distinguishable: false,
    predictions: Object.freeze([]),
    ambiguousPairs: Object.freeze([]),
    degenerateAgainstCorrectModel: Object.freeze([]),
    issues: Object.freeze([issue]),
  });
}

/**
 * Runtime-agnostic closed-core H_i != H_j / H_i != M* probe distinguishability verifier.
 * Works identically in browser, worker, default, and node runtimes with zero node:* imports.
 */
function verifyClinicProbeDistinguishability<TInput, TObservable>(
  spec: DistinguishableProbeSpec<TInput, TObservable>,
): ProbeDistinguishabilityReport {
  const probeId = typeof spec.probeId === "string" ? spec.probeId : "";
  if (
    !isNonBlankText(spec.probeId) ||
    !isNonBlankText(spec.requirementKey) ||
    !isNonBlankText(spec.prompt) ||
    typeof spec.observableKey !== "function" ||
    typeof spec.parseResponse !== "function"
  ) {
    return buildInvalidProbeReport(probeId, "probe_identity_incomplete");
  }

  const { correctModel, hypotheses } = spec;
  if (
    !correctModel ||
    correctModel.role !== "correct" ||
    !isNonBlankText(correctModel.id) ||
    !isNonBlankText(correctModel.label) ||
    typeof correctModel.predict !== "function"
  ) {
    return buildInvalidProbeReport(probeId, "probe_identity_incomplete");
  }

  if (!Array.isArray(hypotheses) || hypotheses.length === 0) {
    return buildInvalidProbeReport(probeId, "no_competing_hypotheses");
  }
  for (const hyp of hypotheses) {
    if (
      !hyp ||
      hyp.role !== "misconception" ||
      !isNonBlankText(hyp.id) ||
      !isNonBlankText(hyp.label) ||
      !isNonBlankText(hyp.description) ||
      typeof hyp.predict !== "function"
    ) {
      return buildInvalidProbeReport(probeId, "probe_identity_incomplete");
    }
  }

  const issues = new Set<ProbeDistinguishabilityIssue>();
  const modelIds = [correctModel.id, ...hypotheses.map((h) => h.id)];
  if (new Set(modelIds).size !== modelIds.length) {
    issues.add("duplicate_model_id");
  }

  const encodeObservable = (observable: TObservable): string => spec.observableKey(observable);
  const correctKey = predictClinicObservableKey(
    spec.input,
    encodeObservable,
    (value) => correctModel.predict(value),
    issues,
  );

  const predictions: ProbeModelPrediction[] = [
    Object.freeze({ modelId: correctModel.id, role: correctModel.role, observableKey: correctKey }),
    ...hypotheses.map((hypothesis) =>
      Object.freeze({
        modelId: hypothesis.id,
        role: hypothesis.role,
        observableKey: predictClinicObservableKey(
          spec.input,
          encodeObservable,
          (value) => hypothesis.predict(value),
          issues,
        ),
      }),
    ),
  ];

  const ambiguousPairs: Array<ProbeDistinguishabilityReport["ambiguousPairs"][number]> = [];
  const degenerateAgainstCorrectModel: Array<
    ProbeDistinguishabilityReport["degenerateAgainstCorrectModel"][number]
  > = [];
  const hypothesesByKey = new Map<string, string[]>();

  for (let i = 1; i < predictions.length; i += 1) {
    const entry = predictions[i]!;
    if (entry.observableKey === null) continue;
    if (entry.observableKey === correctKey) {
      degenerateAgainstCorrectModel.push(
        Object.freeze({ hypothesisId: entry.modelId, observableKey: entry.observableKey }),
      );
    }
    const previous = hypothesesByKey.get(entry.observableKey);
    if (!previous) {
      hypothesesByKey.set(entry.observableKey, [entry.modelId]);
      continue;
    }
    for (const other of previous) {
      const [a, b] = compareUtf16(other, entry.modelId) < 0 ? [other, entry.modelId] : [entry.modelId, other];
      ambiguousPairs.push(Object.freeze({ a, b, observableKey: entry.observableKey }));
    }
    previous.push(entry.modelId);
  }

  if (ambiguousPairs.length > 0) issues.add("ambiguous_hypothesis_pair");
  if (degenerateAgainstCorrectModel.length > 0) issues.add("degenerate_against_correct_model");

  const sortedAmbiguous = [...ambiguousPairs].sort(
    (x, y) => compareUtf16(x.a, y.a) || compareUtf16(x.b, y.b),
  );
  const sortedDegenerate = [...degenerateAgainstCorrectModel].sort((x, y) =>
    compareUtf16(x.hypothesisId, y.hypothesisId),
  );
  const sortedIssues = [...issues].sort(compareUtf16);

  return Object.freeze({
    probeId,
    distinguishable: sortedIssues.length === 0,
    predictions: Object.freeze(predictions),
    ambiguousPairs: Object.freeze(sortedAmbiguous),
    degenerateAgainstCorrectModel: Object.freeze(sortedDegenerate),
    issues: Object.freeze(sortedIssues),
  });
}

function snapshotAttemptCandidate(rawAttempt: unknown): DiagnosedRootAttempt | null {
  const cloned = cloneAndFreezePlainData(rawAttempt);
  if (!cloned.ok || cloned.value === null || typeof cloned.value !== "object" || Array.isArray(cloned.value)) {
    return null;
  }
  const snap = cloned.value as Record<string, unknown>;
  const attemptId = readOwnDataProp(snap, "attemptId");
  const rootAttemptId = readOwnDataProp(snap, "rootAttemptId");
  const learnerId = readOwnDataProp(snap, "learnerId");
  const courseId = readOwnDataProp(snap, "courseId");
  const chapterId = readOwnDataProp(snap, "chapterId");
  const localDate = readOwnDataProp(snap, "localDate");
  const ruleId = readOwnDataProp(snap, "ruleId");
  const excerpt = readOwnDataProp(snap, "excerpt");
  const invariantSummary = readOwnDataProp(snap, "invariantSummary");
  const rawSourceRefs = readOwnDataProp(snap, "sourceRefs");
  const privacyEpoch = readOwnDataProp(snap, "privacyEpoch");
  const assisted = readOwnDataProp(snap, "assisted");
  const occurredAtMs = readOwnDataProp(snap, "occurredAtMs");
  const swapConsistent = readOwnDataProp(snap, "swapConsistent");
  const templatePadded = readOwnDataProp(snap, "templatePadded");
  const calibrationVerified = readOwnDataProp(snap, "calibrationVerified");

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
    typeof assisted !== "boolean" ||
    (swapConsistent !== undefined && typeof swapConsistent !== "boolean") ||
    (templatePadded !== undefined && typeof templatePadded !== "boolean") ||
    (calibrationVerified !== undefined && typeof calibrationVerified !== "boolean")
  ) {
    return null;
  }

  const frozenSourceRefs = freezeSourceRefs(rawSourceRefs);

  return Object.freeze({
    attemptId: attemptId.trim(),
    rootAttemptId: rootAttemptId.trim(),
    learnerId,
    courseId,
    chapterId: chapterId.trim(),
    localDate,
    ruleId: ruleId.trim(),
    excerpt,
    invariantSummary,
    sourceRefs: frozenSourceRefs ?? Object.freeze([]),
    privacyEpoch,
    assisted,
    ...(typeof occurredAtMs === "number" && Number.isFinite(occurredAtMs) ? { occurredAtMs } : {}),
    ...(typeof swapConsistent === "boolean" ? { swapConsistent } : {}),
    ...(typeof templatePadded === "boolean" ? { templatePadded } : {}),
    ...(typeof calibrationVerified === "boolean" ? { calibrationVerified } : {}),
  });
}

function snapshotStringArray(raw: unknown): readonly string[] | null {
  const items = snapshotDenseOwnArray(raw);
  if (!items) return null;
  const out: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const val = items[i];
    if (typeof val !== "string") return null;
    out.push(val);
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
  readonly rawFunctions: readonly ((...args: never[]) => unknown)[];
}

const KNOWN_PROBE_KEYS: ReadonlySet<string> = new Set([
  "probeId",
  "requirementKey",
  "prompt",
  "targetMisconceptionId",
  "sourceRefs",
  "input",
  "correctModel",
  "hypotheses",
  "observableKey",
  "parseResponse",
]);

function prepareCandidateProbe<TInput, TObservable>(
  probe: unknown,
  activeSources: ReadonlyMap<string, ActiveSourceEntry>,
): { readonly prepared: PreparedCandidateProbe<TInput, TObservable> | null; readonly rejected: RejectedClinicProbe | null } {
  const probeSnap = snapshotOwnRecord(probe, {
    requireObjectProto: true,
    forbidOwnConstructor: true,
  });
  if (!probeSnap) {
    return {
      prepared: null,
      rejected: { probeId: "", reason: "invalid_probe_descriptor", report: null },
    };
  }

  const rawProbeId = probeSnap["probeId"];
  const rawRequirementKey = probeSnap["requirementKey"];
  const rawPrompt = probeSnap["prompt"];
  const rawTargetMisconceptionId = probeSnap["targetMisconceptionId"];
  const hasExplicitSourceRefs = Object.hasOwn(probeSnap, "sourceRefs") && probeSnap["sourceRefs"] !== undefined;
  const rawSourceRefs = hasExplicitSourceRefs ? probeSnap["sourceRefs"] : undefined;
  const rawInput = probeSnap["input"];
  const rawCorrectModel = probeSnap["correctModel"];
  const rawHypotheses = probeSnap["hypotheses"];
  const rawObservableKey = probeSnap["observableKey"];
  const rawParseResponse = probeSnap["parseResponse"];

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

  const hypothesesSnap = snapshotDenseOwnArray(rawHypotheses);
  if (!hypothesesSnap) {
    return {
      prepared: null,
      rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
    };
  }
  const isolatedCorrectModelRes = isolateProbeModel<TInput, TObservable>(rawCorrectModel, "correct");
  if (!isolatedCorrectModelRes) {
    return {
      prepared: null,
      rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
    };
  }

  const isolatedHypothesesList: Record<string, unknown>[] = [];
  const probeFunctions: ((...args: never[]) => unknown)[] = [isolatedCorrectModelRes.rawPredict];
  for (let h = 0; h < hypothesesSnap.length; h += 1) {
    const isolatedHypRes = isolateProbeModel<TInput, TObservable>(hypothesesSnap[h], "misconception");
    if (!isolatedHypRes) {
      return {
        prepared: null,
        rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
      };
    }
    isolatedHypothesesList.push(isolatedHypRes.model);
    probeFunctions.push(isolatedHypRes.rawPredict);
  }
  if (typeof rawObservableKey === "function") {
    probeFunctions.push(rawObservableKey as (...args: never[]) => unknown);
  }
  if (typeof rawParseResponse === "function") {
    probeFunctions.push(rawParseResponse as (...args: never[]) => unknown);
  }

  let frozenSourceRefs: readonly RemedySourceRef[] | undefined;
  if (hasExplicitSourceRefs) {
    const refsSnap = snapshotSourceRefsWithKind(rawSourceRefs);
    if (refsSnap.kind === "empty_or_null_ref") {
      return {
        prepared: null,
        rejected: { probeId: frozenProbeId, reason: "revoked_probe_source", report: null },
      };
    }
    if (refsSnap.kind === "invalid_descriptor") {
      return {
        prepared: null,
        rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
      };
    }
    if (!areSourceRefsActive(refsSnap.refs, activeSources)) {
      return {
        prepared: null,
        rejected: { probeId: frozenProbeId, reason: "revoked_probe_source", report: null },
      };
    }
    frozenSourceRefs = refsSnap.refs;
  }

  // Verify any extra own properties on probeSnap are getter-free plain data before checking probe root.
  for (const key of Object.keys(probeSnap)) {
    if (KNOWN_PROBE_KEYS.has(key)) continue;
    if (!cloneAndFreezePlainData(probeSnap[key]).ok) {
      return {
        prepared: null,
        rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
      };
    }
  }
  // Verify rawHypotheses and probe itself are not AsyncGenerator, Generator, Promise, or Proxy.
  if (
    !isPlainContainerWithOnlyKnownFunctions(rawHypotheses as object, probeFunctions) ||
    !isPlainContainerWithOnlyKnownFunctions(probe as object, probeFunctions)
  ) {
    return {
      prepared: null,
      rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
    };
  }

  if (!isNonBlankText(frozenPrompt)) {
    return {
      prepared: null,
      rejected: { probeId: frozenProbeId, reason: "invalid_probe_prompt", report: null },
    };
  }

  const frozenCorrectModel = isolatedCorrectModelRes.model as unknown as DistinguishableProbeSpec<
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
    targetMisconceptionId?: string;
    sourceRefs?: readonly RemedySourceRef[];
    input: TInput;
    correctModel: DistinguishableProbeSpec<TInput, TObservable>["correctModel"];
    hypotheses: DistinguishableProbeSpec<TInput, TObservable>["hypotheses"];
    observableKey: DistinguishableProbeSpec<TInput, TObservable>["observableKey"];
    parseResponse: DistinguishableProbeSpec<TInput, TObservable>["parseResponse"];
  } = {
    probeId: frozenProbeId,
    requirementKey: frozenRequirementKey,
    prompt: frozenPrompt,
    ...(frozenTargetMisconceptionId !== undefined
      ? { targetMisconceptionId: frozenTargetMisconceptionId }
      : {}),
    ...(frozenSourceRefs !== undefined ? { sourceRefs: frozenSourceRefs } : {}),
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
      rawFunctions: probeFunctions,
    },
    rejected: null,
  };
}

export function generateRemedyClinic<TInput = unknown, TObservable = unknown>(
  input: GenerateRemedyClinicInput<TInput, TObservable>,
): GenerateRemedyClinicResult {
  const zeroCoverage: EvidenceCoverage = { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 };
  const invalidResult = (): GenerateRemedyClinicResult => ({
    status: "invalid_input",
    clinic: null,
    coverage: zeroCoverage,
    rejectedCounts: emptyRejections(),
    verifiedProbeCount: 0,
    rejectedProbes: [],
  });

  // Single-pass top-level snapshot: never read any property from raw input twice.
  const inputSnap = snapshotOwnRecord(input, {
    requireObjectProto: true,
    forbidOwnConstructor: true,
  });
  if (!inputSnap) return invalidResult();

  const verifyRuleFn = inputSnap["verifyRuleViolation"];
  const verifyProbeFn = verifyClinicProbeDistinguishability;
  const activeSourcesSnapshot = snapshotActiveSourcesMap(inputSnap["activeSourcesMap"] as ActiveSourcesMap);
  const frozenLearnerId = typeof inputSnap["learnerId"] === "string" ? inputSnap["learnerId"] : "";
  const frozenCourseId = typeof inputSnap["courseId"] === "string" ? inputSnap["courseId"] : "";
  const frozenRuleId = typeof inputSnap["ruleId"] === "string" ? inputSnap["ruleId"].trim() : "";
  const frozenRuleTitle = typeof inputSnap["ruleTitle"] === "string" ? inputSnap["ruleTitle"] : undefined;
  const frozenClinicIdInput = typeof inputSnap["clinicId"] === "string" ? inputSnap["clinicId"] : undefined;
  const frozenEpoch = inputSnap["currentPrivacyEpoch"];
  const hasExplicitRuleSourceRefs = Object.hasOwn(inputSnap, "ruleSourceRefs") && inputSnap["ruleSourceRefs"] !== undefined;
  const frozenRuleSourceRefs = hasExplicitRuleSourceRefs ? freezeSourceRefs(inputSnap["ruleSourceRefs"]) : undefined;

  const hasRubricCalibration =
    Object.hasOwn(inputSnap, "rubricCalibration") && inputSnap["rubricCalibration"] !== undefined;
  let rubricGuardStatus: "ok" | "invalid" | "uncalibrated_rubric" | "low_rubric_agreement" = "ok";
  if (hasRubricCalibration) {
    const clonedCal = cloneAndFreezePlainData(inputSnap["rubricCalibration"]);
    if (
      !clonedCal.ok ||
      clonedCal.value === null ||
      typeof clonedCal.value !== "object" ||
      Array.isArray(clonedCal.value)
    ) {
      rubricGuardStatus = "invalid";
    } else {
      const calObj = clonedCal.value as Record<string, unknown>;
      const calibratedVal = readOwnDataProp(calObj, "calibrated");
      const agreementVal = readOwnDataProp(calObj, "agreementPassed");
      const qwkVal = readOwnDataProp(calObj, "qwk");
      if (
        typeof calibratedVal !== "boolean" ||
        (agreementVal !== undefined && typeof agreementVal !== "boolean")
      ) {
        rubricGuardStatus = "invalid";
      } else if (calibratedVal === false) {
        rubricGuardStatus = "uncalibrated_rubric";
      } else if (
        agreementVal === false ||
        (qwkVal !== undefined &&
          (typeof qwkVal !== "number" || !Number.isFinite(qwkVal) || qwkVal < CLINIC_RUBRIC_MIN_QWK))
      ) {
        rubricGuardStatus = "low_rubric_agreement";
      }
    }
  }

  const rawAttempts = inputSnap["attempts"];
  const attemptsSnap = snapshotDenseOwnArray(rawAttempts);
  const hasEmbeddingCandidates =
    Object.hasOwn(inputSnap, "embeddingRecallCandidates") && inputSnap["embeddingRecallCandidates"] !== undefined;
  const rawEmbeddingCandidates = hasEmbeddingCandidates ? inputSnap["embeddingRecallCandidates"] : undefined;
  const embeddingSnap = hasEmbeddingCandidates ? snapshotDenseOwnArray(rawEmbeddingCandidates) : null;
  const rawCandidateProbes = inputSnap["candidateProbes"];
  const candidateProbesSnap = snapshotDenseOwnArray(rawCandidateProbes);

  if (
    rubricGuardStatus === "invalid" ||
    !isNonBlankText(frozenLearnerId) ||
    !isNonBlankText(frozenCourseId) ||
    !isNonBlankText(frozenRuleId) ||
    !isValidPrivacyEpoch(frozenEpoch) ||
    typeof verifyRuleFn !== "function" ||
    !attemptsSnap ||
    (hasEmbeddingCandidates && !embeddingSnap) ||
    !candidateProbesSnap ||
    (hasExplicitRuleSourceRefs && (!frozenRuleSourceRefs || !areSourceRefsActive(frozenRuleSourceRefs, activeSourcesSnapshot)))
  ) {
    return invalidResult();
  }

  if (rubricGuardStatus === "uncalibrated_rubric" || rubricGuardStatus === "low_rubric_agreement") {
    return {
      status: rubricGuardStatus,
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
  let allProbesPrepared = true;
  const inputKnownFunctions: ((...args: never[]) => unknown)[] = [
    verifyRuleFn as (...args: never[]) => unknown,
  ];
  for (let i = 0; i < candidateProbesSnap.length; i += 1) {
    const { prepared, rejected } = prepareCandidateProbe<TInput, TObservable>(
      candidateProbesSnap[i],
      activeSourcesSnapshot,
    );
    if (prepared) {
      preEvaluatedProbes.push({ kind: "prepared", entry: prepared });
      for (const fn of prepared.rawFunctions) inputKnownFunctions.push(fn);
    } else if (rejected) {
      allProbesPrepared = false;
      preEvaluatedProbes.push({ kind: "rejected", rejected });
    }
  }

  const counters = {
    scopeMismatch: 0,
    assisted: 0,
    invalidPrivacyEpoch: 0,
    malformedAttempt: 0,
    revokedSource: 0,
    ruleIdMismatch: 0,
    rubricGuardRejected: 0,
    verifierRejected: 0,
    duplicateRoot: 0,
    transitiveClosureBlocked: 0,
  };

  // Snapshot and deep-freeze ALL attempts (including sourceRefs) up front before invoking verifyRuleViolation.
  const taggedCandidates: Array<{ attempt: DiagnosedRootAttempt | null; fromEmbeddingRecall: boolean }> = [];
  let allAttemptsPlain = true;
  for (let i = 0; i < attemptsSnap.length; i += 1) {
    const snapAttempt = snapshotAttemptCandidate(attemptsSnap[i]);
    if (!snapAttempt) allAttemptsPlain = false;
    taggedCandidates.push({
      attempt: snapAttempt,
      fromEmbeddingRecall: false,
    });
  }
  if (allAttemptsPlain) {
    // Reject Proxy-wrapped attempts array in C++ once all elements are proven getter-free.
    try {
      structuredClone(rawAttempts);
    } catch {
      return invalidResult();
    }
  }
  let allEmbeddingPlain = true;
  if (embeddingSnap) {
    for (let i = 0; i < embeddingSnap.length; i += 1) {
      const clonedItem = cloneAndFreezePlainData(embeddingSnap[i]);
      if (!clonedItem.ok || clonedItem.value === null || typeof clonedItem.value !== "object" || Array.isArray(clonedItem.value)) {
        allEmbeddingPlain = false;
        taggedCandidates.push({ attempt: null, fromEmbeddingRecall: true });
        continue;
      }
      const rawCandidate = readOwnDataProp(clonedItem.value as object, "attempt");
      const snapAttempt = snapshotAttemptCandidate(rawCandidate);
      if (!snapAttempt) allEmbeddingPlain = false;
      taggedCandidates.push({
        attempt: snapAttempt,
        fromEmbeddingRecall: true,
      });
    }
    if (allEmbeddingPlain) {
      try {
        structuredClone(rawEmbeddingCandidates);
      } catch {
        return invalidResult();
      }
    }
  }

  // Once all child containers are verified getter-free, verify top-level input itself is not
  // an AsyncGenerator, Generator, Promise, or Proxy.
  if (allProbesPrepared && allAttemptsPlain && allEmbeddingPlain && activeSourcesSnapshot.size > 0) {
    const KNOWN_INPUT_KEYS = new Set([
      "clinicId",
      "learnerId",
      "courseId",
      "ruleId",
      "ruleTitle",
      "ruleSourceRefs",
      "currentPrivacyEpoch",
      "activeSourcesMap",
      "attempts",
      "embeddingRecallCandidates",
      "verifyRuleViolation",
      "candidateProbes",
      "rubricCalibration",
    ]);
    let extraInputPlain = true;
    for (const key of Object.keys(inputSnap)) {
      if (KNOWN_INPUT_KEYS.has(key)) continue;
      if (!cloneAndFreezePlainData(inputSnap[key]).ok) {
        extraInputPlain = false;
        break;
      }
    }
    if (extraInputPlain) {
      if (
        !isPlainContainerWithOnlyKnownFunctions(rawCandidateProbes as object, inputKnownFunctions) ||
        !isPlainContainerWithOnlyKnownFunctions(input as object, inputKnownFunctions)
      ) {
        return invalidResult();
      }
    }
  }

  const verifyRuleCallback = verifyRuleFn as (attempt: DiagnosedRootAttempt) => boolean;

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
    if (
      attempt.swapConsistent === false ||
      attempt.templatePadded === true ||
      attempt.calibrationVerified === false
    ) {
      counters.rubricGuardRejected++;
      continue;
    }
    // Strict exact ruleId clustering: never merge via A≈B, B≈C embedding transitive closure.
    if (attempt.ruleId !== frozenRuleId) {
      counters.ruleIdMismatch++;
      if (fromEmbeddingRecall) counters.transitiveClosureBlocked++;
      continue;
    }
    if (!safeVerifyRuleViolation(verifyRuleCallback, attempt)) {
      counters.verifierRejected++;
      if (fromEmbeddingRecall) counters.transitiveClosureBlocked++;
      continue;
    }
    verifiedCandidates.push(attempt);
  }

  // Deterministic earliest-attempt selection per rootAttemptId so retries count at most once.
  verifiedCandidates.sort((a, b) => {
    const dateOrder = compareUtf16(a.localDate, b.localDate);
    if (dateOrder !== 0) return dateOrder;
    const timeA = typeof a.occurredAtMs === "number" && Number.isFinite(a.occurredAtMs)
      ? a.occurredAtMs
      : Number.POSITIVE_INFINITY;
    const timeB = typeof b.occurredAtMs === "number" && Number.isFinite(b.occurredAtMs)
      ? b.occurredAtMs
      : Number.POSITIVE_INFINITY;
    if (timeA !== timeB) return timeA - timeB;
    return compareUtf16(a.attemptId, b.attemptId);
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

    const normalizedRuleId = frozenRuleId.trim();
    const normalizedTargetId =
      typeof frozenTargetMisconceptionId === "string" ? frozenTargetMisconceptionId.trim() : "";
    const hasTargetHypothesis =
      normalizedTargetId.length > 0 &&
      normalizedTargetId === normalizedRuleId &&
      frozenSpec.hypotheses.some((hyp) => isNonBlankText(hyp.id) && hyp.id.trim() === normalizedTargetId);
    if (!hasTargetHypothesis) {
      rejectedProbes.push({
        probeId: frozenProbeId,
        reason: "target_misconception_mismatch",
        report: null,
      });
      continue;
    }

    const report = verifyProbeFn(frozenSpec);
    const probeId = report.probeId || frozenProbeId;
    if (!report.distinguishable) {
      rejectedProbes.push({ probeId, reason: "not_distinguishable", report });
      continue;
    }
    const correctPred = report.predictions.find((entry) => entry.role === "correct");
    const targetPred = report.predictions.find(
      (entry) => entry.role === "misconception" && entry.modelId.trim() === normalizedTargetId,
    );
    if (
      !correctPred ||
      !targetPred ||
      !isNonBlankText(correctPred.observableKey) ||
      !isNonBlankText(targetPred.observableKey) ||
      targetPred.observableKey === correctPred.observableKey
    ) {
      rejectedProbes.push({ probeId, reason: "target_misconception_mismatch", report });
      continue;
    }
    if (acceptedProbeIds.has(probeId)) {
      rejectedProbes.push({ probeId, reason: "duplicate_probe_id", report });
      continue;
    }
    const normalizedPrompt = normalizePromptKey(frozenPrompt);
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
        targetMisconceptionId: normalizedTargetId,
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
    delayedRecheck: buildDelayedRecheck(frozenRuleId),
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
  readonly priorReason: ClinicRevocationReason;
}

const PRESERVABLE_REVOCATION_REASONS: ReadonlySet<ClinicRevocationReason> = new Set([
  "invalid_privacy_epoch",
  "insufficient_surviving_probes",
  "rule_source_revoked",
  "insufficient_surviving_evidence",
  "already_revoked",
]);

function parsePriorRevocationReason(value: unknown): ClinicRevocationReason {
  if (typeof value === "string" && PRESERVABLE_REVOCATION_REASONS.has(value as ClinicRevocationReason)) {
    return value as ClinicRevocationReason;
  }
  return "already_revoked";
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
        prompt: resolveRevokedStep2Placeholder(reason),
        checklist: Object.freeze([]),
      }),
      Object.freeze({
        stepNumber: 3 as const,
        kind: "distinguishable_transfer_probes" as const,
        durationMinutes: STEP3_TRANSFER_PROBES_MINUTES,
        probes: Object.freeze([]),
      }),
    ] as const),
    delayedRecheck: buildDelayedRecheck(header.ruleId),
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
    !isNonBlankText(attemptId) ||
    !isNonBlankText(rootAttemptId) ||
    !isNonBlankText(chapterId) ||
    !isValidLocalDate(localDate) ||
    !isNonBlankText(ruleId) ||
    !isNonBlankText(excerpt) ||
    !isNonBlankText(invariantSummary) ||
    !isValidPrivacyEpoch(privacyEpoch)
  ) {
    return null;
  }

  const frozenSourceRefs = freezeSourceRefs(rawSourceRefs);
  if (!frozenSourceRefs) return null;

  return Object.freeze({
    attemptId: attemptId.trim(),
    rootAttemptId: rootAttemptId.trim(),
    chapterId: chapterId.trim(),
    localDate,
    ruleId: ruleId.trim(),
    excerpt,
    invariantSummary,
    sourceRefs: frozenSourceRefs,
    privacyEpoch,
  });
}

function isValidDistinguishableReport(
  report: unknown,
  expectedProbeId: string,
  expectedCompetingModelIds: readonly string[],
  expectedTargetRuleId: string,
): report is ProbeDistinguishabilityReport {
  if (!isPlainRecordOwnDataOnly(report)) return false;
  if (readOwnDataProp(report, "probeId") !== expectedProbeId) return false;
  if (readOwnDataProp(report, "distinguishable") !== true) return false;

  const issues = readOwnDataProp(report, "issues");
  const ambiguousPairs = readOwnDataProp(report, "ambiguousPairs");
  const degenerate = readOwnDataProp(report, "degenerateAgainstCorrectModel");
  const predictions = readOwnDataProp(report, "predictions");

  if (
    !isPlainDenseArrayHeader(issues) ||
    issues.length !== 0 ||
    !isPlainDenseArrayHeader(ambiguousPairs) ||
    ambiguousPairs.length !== 0 ||
    !isPlainDenseArrayHeader(degenerate) ||
    degenerate.length !== 0 ||
    !isPlainDenseArrayHeader(predictions) ||
    predictions.length < 2 ||
    predictions.length !== expectedCompetingModelIds.length
  ) {
    return false;
  }

  let correctCount = 0;
  let misconceptionCount = 0;
  let correctObservableKey: string | null = null;
  let targetMisconceptionObservableKey: string | null = null;
  const seenModelIds = new Set<string>();
  const seenObservableKeys = new Set<string>();
  const normalizedTargetRuleId = expectedTargetRuleId.trim();

  for (let i = 0; i < predictions.length; i += 1) {
    const slot = readOwnDataIndex(predictions, i);
    if (!slot.ok || !isPlainRecordOwnDataOnly(slot.value)) return false;
    const modelId = readOwnDataProp(slot.value, "modelId");
    const role = readOwnDataProp(slot.value, "role");
    const observableKey = readOwnDataProp(slot.value, "observableKey");

    if (!isNonBlankText(modelId) || modelId !== expectedCompetingModelIds[i] || seenModelIds.has(modelId)) {
      return false;
    }
    if (!isNonBlankText(observableKey) || seenObservableKeys.has(observableKey)) {
      return false;
    }
    if (role === "correct") {
      correctCount += 1;
      correctObservableKey = observableKey;
    } else if (role === "misconception") {
      misconceptionCount += 1;
      if (modelId.trim() === normalizedTargetRuleId) {
        targetMisconceptionObservableKey = observableKey;
      }
    } else {
      return false;
    }
    seenModelIds.add(modelId);
    seenObservableKeys.add(observableKey);
  }

  return (
    correctCount === 1 &&
    misconceptionCount >= 1 &&
    correctObservableKey !== null &&
    targetMisconceptionObservableKey !== null &&
    targetMisconceptionObservableKey !== correctObservableKey
  );
}

function isValidDelayedRecheck(rawDelayedRecheck: unknown, expectedRuleId: string): boolean {
  if (!isPlainRecordOwnDataOnly(rawDelayedRecheck)) return false;
  return (
    readOwnDataProp(rawDelayedRecheck, "required") === true &&
    readOwnDataProp(rawDelayedRecheck, "scheduledOutsideSessionMinutes") === true &&
    readOwnDataProp(rawDelayedRecheck, "minDelayHours") === CLINIC_DELAYED_RECHECK_MIN_HOURS &&
    readOwnDataProp(rawDelayedRecheck, "ruleId") === expectedRuleId &&
    readOwnDataProp(rawDelayedRecheck, "countsTowardMasteryUntilPassed") === false
  );
}

function snapshotProbeForRevalidation(
  rawProbe: unknown,
  activeSources: ReadonlyMap<string, ActiveSourceEntry>,
  expectedRuleId: string,
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
  const normalizedRuleId = expectedRuleId.trim();

  if (
    !isNonBlankText(probeId) ||
    !isNonBlankText(requirementKey) ||
    !isNonBlankText(prompt) ||
    !isNonBlankText(targetMisconceptionId) ||
    targetMisconceptionId.trim() !== normalizedRuleId ||
    !isPlainRecordOwnDataOnly(report)
  ) {
    return null;
  }

  const frozenCompetingModelIds = snapshotStringArray(rawCompetingModelIds);
  if (!frozenCompetingModelIds || frozenCompetingModelIds.length < 2) return null;
  let includesTargetModel = false;
  for (const modelId of frozenCompetingModelIds) {
    if (!isNonBlankText(modelId)) return null;
    if (modelId.trim() === normalizedRuleId) includesTargetModel = true;
  }
  if (!includesTargetModel) return null;

  let validatedSourceRefs: readonly RemedySourceRef[] | undefined;
  if (hasExplicitSourceRefs) {
    const frozenRefs = freezeSourceRefs(rawSourceRefs);
    if (!frozenRefs || !areSourceRefsActive(frozenRefs, activeSources)) return null;
    validatedSourceRefs = frozenRefs;
  }

  const clonedReport = cloneAndFreezePlainData(report);
  if (
    !clonedReport.ok ||
    !isValidDistinguishableReport(clonedReport.value, probeId, frozenCompetingModelIds, normalizedRuleId)
  ) {
    return null;
  }

  return Object.freeze({
    probeId,
    requirementKey,
    prompt,
    targetMisconceptionId: normalizedRuleId,
    ...(validatedSourceRefs !== undefined ? { sourceRefs: validatedSourceRefs } : {}),
    competingModelIds: frozenCompetingModelIds,
    report: clonedReport.value,
  });
}

/**
 * Read-time privacy_epoch and source-version guard.
 * Deep-clones and freezes the entire pure-data clinic tree in ONE pass up front (zero getter
 * execution, zero Proxy/Promise/Generator escapes, zero second reads), strips any case or probe
 * referencing missing/revoked/version-mismatched sources, and degrades fail-closed to
 * "stale_source_revoked" with all 3 steps scrubbed.
 */
export function revalidateRemedyClinic(
  clinic: RemedyClinicSessionV1,
  activeSourcesMap: ActiveSourcesMap,
  currentPrivacyEpoch: number,
): RemedyClinicSessionV1 {
  const zeroCoverage: EvidenceCoverage = { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 };
  const activeSourcesSnapshot = snapshotActiveSourcesMap(activeSourcesMap);

  const clonedClinic = cloneAndFreezePlainData(clinic);
  if (
    !clonedClinic.ok ||
    clonedClinic.value === null ||
    typeof clonedClinic.value !== "object" ||
    Array.isArray(clonedClinic.value)
  ) {
    const safeEpoch = isValidPrivacyEpoch(currentPrivacyEpoch) ? currentPrivacyEpoch : 0;
    const emptyHeader: ClinicSnapshotHeader = {
      clinicId: "",
      status: "stale_source_revoked",
      learnerId: "",
      courseId: "",
      ruleId: "",
      hasRuleSourceRefs: false,
      ruleSourceRefs: null,
      createdPrivacyEpoch: -1,
      validatedPrivacyEpoch: -1,
      priorStrippedCaseCount: 0,
      priorReason: "invalid_privacy_epoch",
    };
    return buildRevokedClinicFromHeader(emptyHeader, safeEpoch, zeroCoverage, 0, "invalid_privacy_epoch");
  }

  const clinicSnap = clonedClinic.value as Record<string, unknown>;
  const rawClinicId = readOwnDataProp(clinicSnap, "clinicId");
  const rawStatus = readOwnDataProp(clinicSnap, "status");
  const rawLearnerId = readOwnDataProp(clinicSnap, "learnerId");
  const rawCourseId = readOwnDataProp(clinicSnap, "courseId");
  const rawRuleId = readOwnDataProp(clinicSnap, "ruleId");
  const rawCreatedEpoch = readOwnDataProp(clinicSnap, "createdPrivacyEpoch");
  const rawValidatedEpoch = readOwnDataProp(clinicSnap, "validatedPrivacyEpoch");
  const hasRuleSourceRefs =
    Object.hasOwn(clinicSnap, "ruleSourceRefs") && readOwnDataProp(clinicSnap, "ruleSourceRefs") !== undefined;
  const rawRuleSourceRefs = hasRuleSourceRefs ? readOwnDataProp(clinicSnap, "ruleSourceRefs") : undefined;
  const rawEvidenceCases = readOwnDataProp(clinicSnap, "evidenceCases");
  const rawSteps = readOwnDataProp(clinicSnap, "steps");
  const rawDelayedRecheck = readOwnDataProp(clinicSnap, "delayedRecheck");
  const rawRevSummary = readOwnDataProp(clinicSnap, "revocationSummary");
  const revSummaryObj =
    rawRevSummary !== null && typeof rawRevSummary === "object" && !Array.isArray(rawRevSummary)
      ? (rawRevSummary as Record<string, unknown>)
      : null;
  const priorStrippedCaseCount =
    revSummaryObj && typeof readOwnDataProp(revSummaryObj, "strippedCaseCount") === "number"
      ? (readOwnDataProp(revSummaryObj, "strippedCaseCount") as number)
      : 0;
  const priorReason = revSummaryObj ? parsePriorRevocationReason(readOwnDataProp(revSummaryObj, "reason")) : "already_revoked";

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
    priorReason,
  };

  const evidenceCasesSnap = Array.isArray(rawEvidenceCases) ? rawEvidenceCases : null;
  const totalEvidenceCases = evidenceCasesSnap ? evidenceCasesSnap.length : 0;

  if (
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
      header.priorReason,
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

  if (!isNonBlankText(header.ruleId) || !isValidDelayedRecheck(rawDelayedRecheck, header.ruleId)) {
    return buildRevokedClinicFromHeader(
      header,
      currentPrivacyEpoch,
      zeroCoverage,
      totalEvidenceCases,
      "insufficient_surviving_evidence",
    );
  }

  if (!Array.isArray(rawSteps) || rawSteps.length !== 3) {
    return buildRevokedClinicFromHeader(
      header,
      currentPrivacyEpoch,
      zeroCoverage,
      totalEvidenceCases,
      "insufficient_surviving_evidence",
    );
  }
  const step0 = rawSteps[0];
  const step1 = rawSteps[1];
  const step2 = rawSteps[2];
  if (
    !isPlainRecordOwnDataOnly(step0) ||
    !isPlainRecordOwnDataOnly(step1) ||
    !isPlainRecordOwnDataOnly(step2)
  ) {
    return buildRevokedClinicFromHeader(
      header,
      currentPrivacyEpoch,
      zeroCoverage,
      totalEvidenceCases,
      "insufficient_surviving_evidence",
    );
  }

  const rawStep2RuleTitle = readOwnDataProp(step1, "ruleTitle");
  const rawStep2Prompt = readOwnDataProp(step1, "prompt");
  const rawStep2Checklist = snapshotStringArray(readOwnDataProp(step1, "checklist"));
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

  const normalizedHeaderRuleId = header.ruleId.trim();
  const seenRoots = new Set<string>();
  const survivingCases: ClinicEvidenceCase[] = [];
  if (evidenceCasesSnap) {
    for (let i = 0; i < evidenceCasesSnap.length; i += 1) {
      const snap = snapshotEvidenceCaseForRevalidation(evidenceCasesSnap[i]);
      if (!snap) continue;
      if (seenRoots.has(snap.rootAttemptId)) continue;
      if (snap.ruleId !== normalizedHeaderRuleId) continue;
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

  const rawStep3Probes = readOwnDataProp(step2, "probes");
  const step3ProbesSnap = Array.isArray(rawStep3Probes) ? rawStep3Probes : null;
  const totalProbes = step3ProbesSnap ? step3ProbesSnap.length : 0;
  const survivingProbes: VerifiedClinicTransferProbe[] = [];
  const seenProbeIds = new Set<string>();
  const seenProbePrompts = new Set<string>();
  if (step3ProbesSnap) {
    for (let i = 0; i < step3ProbesSnap.length; i += 1) {
      const snapProbe = snapshotProbeForRevalidation(
        step3ProbesSnap[i],
        activeSourcesSnapshot,
        normalizedHeaderRuleId,
      );
      if (!snapProbe) continue;
      const promptKey = normalizePromptKey(snapProbe.prompt);
      if (seenProbeIds.has(snapProbe.probeId) || seenProbePrompts.has(promptKey)) continue;
      seenProbeIds.add(snapProbe.probeId);
      seenProbePrompts.add(promptKey);
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
    delayedRecheck: buildDelayedRecheck(header.ruleId),
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
