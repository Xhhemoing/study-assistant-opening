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
const ERROR_IS_ERROR = (Error as { isError?: (v: unknown) => boolean }).isError;
const WEAK_PROBE_KEY = Object.freeze({});

function matchesBrand(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

function safeHasOwn(obj: object, key: PropertyKey): boolean {
  try {
    return Object.hasOwn(obj, key);
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

function allOwnValuesArePrimitives(obj: object, keys: readonly PropertyKey[]): boolean {
  for (const key of keys) {
    const descRes = safeGetOwnPropertyDescriptor(obj, key);
    if (!descRes.ok || !descRes.desc || !Object.hasOwn(descRes.desc, "value")) return false;
    const val = descRes.desc.value;
    if (val !== null && (typeof val === "object" || typeof val === "function")) {
      return false;
    }
  }
  return true;
}

/**
 * Detect exotic built-in internal slots (Map, Set, Date, RegExp, ArrayBuffer, TypedArray,
 * DataView, WeakMap, WeakSet, WeakRef, FinalizationRegistry, Promise, Generator, AsyncGenerator,
 * Error, boxed primitives, SharedArrayBuffer, Proxy) even when prototype is reassigned.
 * Never attaches Promise reactions or invokes getters.
 * Call ONLY after verifying prototype and own keys (no symbol keys / no accessors / no "__proto__").
 */
function hasExoticInternalSlots(obj: object, verifiedOwnKeys?: readonly PropertyKey[]): boolean {
  try {
    if (ArrayBuffer.isView(obj)) return true;
    if (typeof ERROR_IS_ERROR === "function") {
      if (ERROR_IS_ERROR(obj)) return true;
    } else {
      const protoRes = safeGetPrototypeOf(obj);
      if (!protoRes.ok) return true;
      const tagDescRes = safeGetOwnPropertyDescriptor(obj, Symbol.toStringTag);
      if (!tagDescRes.ok) return true;
      if (
        (protoRes.proto === Object.prototype || protoRes.proto === null || protoRes.proto === Array.prototype) &&
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
    if (matchesBrand(() => Reflect.apply(Number.prototype.valueOf, obj, []))) return true;
    if (matchesBrand(() => Reflect.apply(String.prototype.valueOf, obj, []))) return true;
    if (matchesBrand(() => Reflect.apply(Boolean.prototype.valueOf, obj, []))) return true;
    if (matchesBrand(() => Reflect.apply(Symbol.prototype.valueOf, obj, []))) return true;
    if (matchesBrand(() => Reflect.apply(BigInt.prototype.valueOf, obj, []))) return true;

    // When all own property values are primitives, structuredClone visits zero child objects
    // while rejecting Proxy (zero traps), Promise (zero [[PromiseIsHandled]] mutation),
    // Generator, and AsyncGenerator in native runtime checks.
    const keys = verifiedOwnKeys ?? safeOwnKeys(obj);
    if (!keys) return true;
    if (allOwnValuesArePrimitives(obj, keys)) {
      try {
        structuredClone(obj);
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function isPlainRecordOwnDataOnly(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || safeIsArray(value)) return false;
  const protoRes = safeGetPrototypeOf(value);
  if (!protoRes.ok || (protoRes.proto !== Object.prototype && protoRes.proto !== null)) return false;
  const keys = safeOwnKeys(value);
  if (!keys) return false;
  for (const key of keys) {
    if (typeof key !== "string" || key === "__proto__") return false;
    const descRes = safeGetOwnPropertyDescriptor(value, key);
    if (
      !descRes.ok ||
      !descRes.desc ||
      !Object.hasOwn(descRes.desc, "value") ||
      descRes.desc.get !== undefined ||
      descRes.desc.set !== undefined
    ) {
      return false;
    }
  }
  if (hasExoticInternalSlots(value, keys)) return false;
  return true;
}

function isPlainDenseArrayHeader(obj: unknown): obj is unknown[] {
  if (!safeIsArray(obj)) return false;
  const protoRes = safeGetPrototypeOf(obj);
  if (!protoRes.ok || protoRes.proto !== Array.prototype) return false;
  const lenDescRes = safeGetOwnPropertyDescriptor(obj, "length");
  if (!lenDescRes.ok || !lenDescRes.desc || typeof lenDescRes.desc.value !== "number" || !Number.isInteger(lenDescRes.desc.value)) {
    return false;
  }
  const len = lenDescRes.desc.value;
  const keys = safeOwnKeys(obj);
  if (!keys || keys.length !== len + 1) return false;
  for (let i = 0; i < len; i += 1) {
    const descRes = safeGetOwnPropertyDescriptor(obj, String(i));
    if (
      !descRes.ok ||
      !descRes.desc ||
      !descRes.desc.enumerable ||
      !Object.hasOwn(descRes.desc, "value") ||
      descRes.desc.get !== undefined ||
      descRes.desc.set !== undefined
    ) {
      return false;
    }
  }
  return !hasExoticInternalSlots(obj, keys);
}

/**
 * Single-pass, exotic-brand-rejecting, descriptor-materializing plain-data clone & deep-freeze.
 * Guarded against throwing Proxy traps, rejects own "__proto__" keys, and verifies the root
 * via structuredClone AFTER confirming every reachable node is getter-free so Proxy, Promise
 * (without mutating [[PromiseIsHandled]]), Generator, and AsyncGenerator are rejected cleanly.
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
    if (!isPlainDenseArrayHeader(obj)) return { ok: false };
    const lenDescRes = safeGetOwnPropertyDescriptor(obj, "length");
    if (!lenDescRes.ok || !lenDescRes.desc || typeof lenDescRes.desc.value !== "number") return { ok: false };
    const len = lenDescRes.desc.value;
    const out: unknown[] = new Array(len);
    memo.set(obj, out);
    for (let i = 0; i < len; i += 1) {
      const descRes = safeGetOwnPropertyDescriptor(obj, String(i));
      if (!descRes.ok || !descRes.desc || !Object.hasOwn(descRes.desc, "value")) return { ok: false };
      const child = cloneAndFreezePlainDataInner(descRes.desc.value, memo);
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
  const validatedEntries: Array<{ readonly key: string; readonly value: unknown; readonly enumerable: boolean }> = [];
  for (const key of ownKeys) {
    if (typeof key !== "string" || key === "__proto__") return { ok: false };
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
  if (hasExoticInternalSlots(obj, ownKeys)) return { ok: false };

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
  try {
    if (activeSourcesMap instanceof Map) {
      for (const [k, v] of activeSourcesMap.entries()) {
        if (typeof k !== "string") continue;
        const cloned = copyEntry(v);
        if (cloned !== undefined) snapshot.set(k, cloned);
      }
      return snapshot;
    }
  } catch {
    return snapshot;
  }
  if (!isPlainRecordOwnDataOnly(activeSourcesMap)) return snapshot;
  const keys = safeOwnKeys(activeSourcesMap);
  if (!keys) return snapshot;
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const descRes = safeGetOwnPropertyDescriptor(activeSourcesMap, key);
    if (!descRes.ok || !descRes.desc || !descRes.desc.enumerable || !Object.hasOwn(descRes.desc, "value")) {
      continue;
    }
    const cloned = copyEntry(descRes.desc.value as ActiveSourceEntry);
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

  const modelProtoRes = safeGetPrototypeOf(rawModel);
  if (!modelProtoRes.ok) return null;
  const frozenReceiver: Record<string, unknown> =
    modelProtoRes.proto === null ? (Object.create(null) as Record<string, unknown>) : {};
  const memo = new Map<object, unknown>();
  memo.set(rawModel, frozenReceiver);

  const ownKeys = safeOwnKeys(rawModel);
  if (!ownKeys) return null;
  const valuesToCloneCheck: unknown[] = [];

  for (const key of ownKeys) {
    if (typeof key !== "string" || key === "__proto__") return null;
    if (key === "predict") continue;
    const descRes = safeGetOwnPropertyDescriptor(rawModel, key);
    if (
      !descRes.ok ||
      !descRes.desc ||
      !Object.hasOwn(descRes.desc, "value") ||
      descRes.desc.get !== undefined ||
      descRes.desc.set !== undefined
    ) {
      return null;
    }
    const cloned = cloneAndFreezePlainDataInner(descRes.desc.value, memo);
    if (!cloned.ok) return null;
    if (descRes.desc.value !== null && typeof descRes.desc.value === "object") {
      valuesToCloneCheck.push(descRes.desc.value);
    }
    Object.defineProperty(frozenReceiver, key, {
      value: cloned.value,
      writable: false,
      enumerable: descRes.desc.enumerable,
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
  const swapConsistent = readOwnDataProp(rawAttempt, "swapConsistent");
  const templatePadded = readOwnDataProp(rawAttempt, "templatePadded");
  const calibrationVerified = readOwnDataProp(rawAttempt, "calibrationVerified");

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
    ...(typeof swapConsistent === "boolean" ? { swapConsistent } : {}),
    ...(typeof templatePadded === "boolean" ? { templatePadded } : {}),
    ...(typeof calibrationVerified === "boolean" ? { calibrationVerified } : {}),
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
  const hasExplicitSourceRefs = safeHasOwn(probe, "sourceRefs") && readOwnDataProp(probe, "sourceRefs") !== undefined;
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
  const verifyProbeFn = verifyClinicProbeDistinguishability;
  const activeSourcesSnapshot = snapshotActiveSourcesMap(input.activeSourcesMap);
  const frozenLearnerId = typeof input.learnerId === "string" ? input.learnerId : "";
  const frozenCourseId = typeof input.courseId === "string" ? input.courseId : "";
  const frozenRuleId = typeof input.ruleId === "string" ? input.ruleId : "";
  const frozenRuleTitle = typeof input.ruleTitle === "string" ? input.ruleTitle : undefined;
  const frozenClinicIdInput = typeof input.clinicId === "string" ? input.clinicId : undefined;
  const frozenEpoch = input.currentPrivacyEpoch;
  const hasExplicitRuleSourceRefs = input.ruleSourceRefs !== undefined;
  const frozenRuleSourceRefs = hasExplicitRuleSourceRefs ? freezeSourceRefs(input.ruleSourceRefs) : undefined;
  const hasRubricCalibration = input.rubricCalibration !== undefined;
  let rubricGuardStatus: "ok" | "invalid" | "uncalibrated_rubric" | "low_rubric_agreement" = "ok";
  if (hasRubricCalibration) {
    const rawCalibration = input.rubricCalibration;
    if (!isPlainRecordOwnDataOnly(rawCalibration)) {
      rubricGuardStatus = "invalid";
    } else {
      const calibratedVal = readOwnDataProp(rawCalibration, "calibrated");
      const agreementVal = readOwnDataProp(rawCalibration, "agreementPassed");
      const qwkVal = readOwnDataProp(rawCalibration, "qwk");
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

  if (
    rubricGuardStatus === "invalid" ||
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
    rubricGuardRejected: 0,
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
    if (!safeVerifyRuleViolation(verifyRuleFn, attempt)) {
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

function isValidDistinguishableReport(
  report: unknown,
  expectedProbeId: string,
  expectedCompetingModelIds: readonly string[],
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
  const seenModelIds = new Set<string>();
  const seenObservableKeys = new Set<string>();

  for (let i = 0; i < predictions.length; i += 1) {
    const slot = readOwnDataIndex(predictions, i);
    if (!slot.ok || !isPlainRecordOwnDataOnly(slot.value)) return false;
    const modelId = readOwnDataProp(slot.value, "modelId");
    const role = readOwnDataProp(slot.value, "role");
    const observableKey = readOwnDataProp(slot.value, "observableKey");

    if (!isNonBlankText(modelId) || modelId !== expectedCompetingModelIds[i] || seenModelIds.has(modelId)) {
      return false;
    }
    if (role === "correct") {
      correctCount += 1;
    } else if (role === "misconception") {
      misconceptionCount += 1;
    } else {
      return false;
    }
    if (!isNonBlankText(observableKey) || seenObservableKeys.has(observableKey)) {
      return false;
    }
    seenModelIds.add(modelId);
    seenObservableKeys.add(observableKey);
  }

  return correctCount === 1 && misconceptionCount >= 1;
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
): VerifiedClinicTransferProbe | null {
  if (!isPlainRecordOwnDataOnly(rawProbe)) return null;
  const probeId = readOwnDataProp(rawProbe, "probeId");
  const requirementKey = readOwnDataProp(rawProbe, "requirementKey");
  const prompt = readOwnDataProp(rawProbe, "prompt");
  const targetMisconceptionId = readOwnDataProp(rawProbe, "targetMisconceptionId");
  const hasExplicitSourceRefs =
    safeHasOwn(rawProbe, "sourceRefs") && readOwnDataProp(rawProbe, "sourceRefs") !== undefined;
  const rawSourceRefs = hasExplicitSourceRefs ? readOwnDataProp(rawProbe, "sourceRefs") : undefined;
  const rawCompetingModelIds = readOwnDataProp(rawProbe, "competingModelIds");
  const report = readOwnDataProp(rawProbe, "report");

  if (
    !isNonBlankText(probeId) ||
    !isNonBlankText(requirementKey) ||
    !isNonBlankText(prompt) ||
    (targetMisconceptionId !== undefined && typeof targetMisconceptionId !== "string") ||
    !isPlainRecordOwnDataOnly(report)
  ) {
    return null;
  }

  const frozenCompetingModelIds = snapshotStringArray(rawCompetingModelIds);
  if (!frozenCompetingModelIds || frozenCompetingModelIds.length < 2) return null;
  for (const modelId of frozenCompetingModelIds) {
    if (!isNonBlankText(modelId)) return null;
  }

  let validatedSourceRefs: readonly RemedySourceRef[] | undefined;
  if (hasExplicitSourceRefs) {
    const frozenRefs = freezeSourceRefs(rawSourceRefs);
    if (!frozenRefs || !areSourceRefsActive(frozenRefs, activeSources)) return null;
    validatedSourceRefs = frozenRefs;
  }

  const clonedReport = cloneAndFreezePlainData(report);
  if (!clonedReport.ok || !isValidDistinguishableReport(clonedReport.value, probeId, frozenCompetingModelIds)) {
    return null;
  }

  return Object.freeze({
    probeId,
    requirementKey,
    prompt,
    ...(targetMisconceptionId !== undefined ? { targetMisconceptionId } : {}),
    ...(validatedSourceRefs !== undefined ? { sourceRefs: validatedSourceRefs } : {}),
    competingModelIds: frozenCompetingModelIds,
    report: clonedReport.value,
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
    clinicIsPlain && safeHasOwn(clinic, "ruleSourceRefs") && readOwnDataProp(clinic, "ruleSourceRefs") !== undefined;
  const rawRuleSourceRefs = hasRuleSourceRefs ? readOwnDataProp(clinic, "ruleSourceRefs") : undefined;
  const rawEvidenceCases = clinicIsPlain ? readOwnDataProp(clinic, "evidenceCases") : undefined;
  const rawSteps = clinicIsPlain ? readOwnDataProp(clinic, "steps") : undefined;
  const rawDelayedRecheck = clinicIsPlain ? readOwnDataProp(clinic, "delayedRecheck") : undefined;
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

  const totalEvidenceCases = safeIsArray(rawEvidenceCases) ? rawEvidenceCases.length : 0;

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

  if (!isValidDelayedRecheck(rawDelayedRecheck, header.ruleId)) {
    return buildRevokedClinicFromHeader(
      header,
      currentPrivacyEpoch,
      zeroCoverage,
      totalEvidenceCases,
      "insufficient_surviving_evidence",
    );
  }

  // Snapshot clinic.steps strictly via own data indices 0, 1, 2 (zero iterator/getter invocation).
  if (!safeIsArray(rawSteps) || rawSteps.length !== 3) {
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
  if (safeIsArray(rawEvidenceCases)) {
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

  // Single-pass snapshot + validation of Step 3 probes (unique probeId/prompt, valid report, active sourceRefs).
  const rawStep3Probes = readOwnDataProp(step2Slot.value, "probes");
  const totalProbes = safeIsArray(rawStep3Probes) ? rawStep3Probes.length : 0;
  const survivingProbes: VerifiedClinicTransferProbe[] = [];
  const seenProbeIds = new Set<string>();
  const seenProbePrompts = new Set<string>();
  if (safeIsArray(rawStep3Probes)) {
    for (let i = 0; i < rawStep3Probes.length; i += 1) {
      const slot = readOwnDataIndex(rawStep3Probes, i);
      if (!slot.ok) continue;
      const snapProbe = snapshotProbeForRevalidation(slot.value, activeSourcesSnapshot);
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
