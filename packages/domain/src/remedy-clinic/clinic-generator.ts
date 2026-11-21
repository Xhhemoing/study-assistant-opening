import {
  verifyProbeDistinguishability,
  type DistinguishableProbeSpec,
  type ProbeDistinguishabilityReport,
} from "../opening/cartridges/probe-protocol";
import {
  areSourceRefsActive,
  buildSelfDiffEntries,
  cloneEvidenceCase,
  cloneSourceRefs,
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

function buildRestatementStep(ruleId: string, ruleTitle?: string): InvariantRuleRestatementStep {
  const trimmedTitle = isNonBlankText(ruleTitle) ? ruleTitle.trim() : "";
  const subject = trimmedTitle ? `"${trimmedTitle}"` : "this recurring rule";
  return {
    stepNumber: 2,
    kind: "invariant_rule_restatement",
    durationMinutes: STEP2_INVARIANT_RESTATEMENT_MINUTES,
    ruleId,
    ruleTitle: trimmedTitle,
    prompt:
      `Compare the 3 side-by-side cases above and restate the core invariant for ${subject} in your own words. ` +
      "Explain what structural condition triggers the rule, why the recurring error fails that condition, " +
      "and what single check you will apply before committing to a step.",
    checklist: [
      "State the exact condition required by the invariant rule.",
      "Identify the shared failure mechanism across the 3 different cases.",
      "Write a concise pre-check you can apply to unseen transfer problems.",
    ],
  };
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
  return true;
}

function isPlainDataDescriptorSafe(value: unknown, visited: Set<object> = new Set()): boolean {
  if (value === null || value === undefined) return true;
  const kind = typeof value;
  if (kind === "boolean" || kind === "number" || kind === "string" || kind === "bigint") return true;
  if (kind === "symbol" || kind === "function") return false;
  if (kind !== "object") return false;

  const obj = value as object;
  if (visited.has(obj)) return true;
  const proto = Object.getPrototypeOf(obj) as object | null;

  if (Array.isArray(obj)) {
    if (proto !== Array.prototype) return false;
    const lenDesc = Object.getOwnPropertyDescriptor(obj, "length");
    if (!lenDesc || typeof lenDesc.value !== "number" || !Number.isInteger(lenDesc.value)) return false;
    const len = lenDesc.value;
    const keys = Reflect.ownKeys(obj);
    if (keys.length !== len + 1) return false;
    visited.add(obj);
    for (let i = 0; i < len; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(obj, String(i));
      if (
        !desc ||
        !desc.enumerable ||
        !Object.hasOwn(desc, "value") ||
        desc.get !== undefined ||
        desc.set !== undefined ||
        !isPlainDataDescriptorSafe(desc.value, visited)
      ) {
        return false;
      }
    }
    return true;
  }

  if (proto !== Object.prototype && proto !== null) return false;
  visited.add(obj);
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== "string") return false;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (
      !desc ||
      !desc.enumerable ||
      !Object.hasOwn(desc, "value") ||
      desc.get !== undefined ||
      desc.set !== undefined ||
      !isPlainDataDescriptorSafe(desc.value, visited)
    ) {
      return false;
    }
  }
  return true;
}

function readOwnDataProp(obj: object, key: string): unknown {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc || !Object.hasOwn(desc, "value") || desc.get !== undefined || desc.set !== undefined) {
    return undefined;
  }
  return desc.value;
}

function deepFreezePlainData<T>(value: T, seen: Set<object> = new Set()): T {
  if (value === null || typeof value !== "object") return value;
  const obj = value as object;
  if (seen.has(obj)) return value;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i += 1) {
      deepFreezePlainData(obj[i], seen);
    }
  } else {
    for (const key of Object.keys(obj)) {
      deepFreezePlainData((obj as Record<string, unknown>)[key], seen);
    }
  }
  return Object.freeze(value);
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

function freezeSourceRefs(sourceRefs: readonly RemedySourceRef[]): readonly RemedySourceRef[] | null {
  if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) return null;
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

  const receiverData: Record<string, unknown> = {};
  for (const key of Object.keys(rawModel)) {
    if (key === "predict") continue;
    const val = readOwnDataProp(rawModel, key);
    if (!isPlainDataDescriptorSafe(val)) return null;
    receiverData[key] = val;
  }

  let frozenReceiver: Record<string, unknown>;
  try {
    frozenReceiver = deepFreezePlainData(structuredClone(receiverData));
  } catch {
    return null;
  }

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

  const frozenSourceRefs =
    isPlainDataDescriptorSafe(rawSourceRefs) && Array.isArray(rawSourceRefs)
      ? freezeSourceRefs(rawSourceRefs as readonly RemedySourceRef[])
      : null;

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

function cloneVerifiedProbe(
  probe: VerifiedClinicTransferProbe,
  validatedSourceRefs?: readonly RemedySourceRef[],
): VerifiedClinicTransferProbe {
  return Object.freeze({
    probeId: probe.probeId,
    requirementKey: probe.requirementKey,
    prompt: probe.prompt,
    ...(probe.targetMisconceptionId !== undefined
      ? { targetMisconceptionId: probe.targetMisconceptionId }
      : {}),
    ...(validatedSourceRefs !== undefined ? { sourceRefs: validatedSourceRefs } : {}),
    competingModelIds: Object.freeze([...probe.competingModelIds]),
    report: probe.report,
  });
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

  if (!isPlainDataDescriptorSafe(rawInput)) {
    return {
      prepared: null,
      rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
    };
  }
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
  if (hasExplicitSourceRefs && !isPlainDataDescriptorSafe(rawSourceRefs)) {
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

  let frozenSourceRefs: readonly RemedySourceRef[] | undefined;
  if (hasExplicitSourceRefs) {
    const frozen = freezeSourceRefs(rawSourceRefs as readonly RemedySourceRef[]);
    if (!frozen || !areSourceRefsActive(frozen, activeSources)) {
      return {
        prepared: null,
        rejected: { probeId: frozenProbeId, reason: "revoked_probe_source", report: null },
      };
    }
    frozenSourceRefs = frozen;
  }

  let frozenInput: TInput;
  try {
    frozenInput = deepFreezePlainData(structuredClone(rawInput as TInput));
  } catch {
    return {
      prepared: null,
      rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
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
  const observableKeyFn =
    typeof rawObservableKey === "function"
      ? (obs: TObservable): string =>
          Reflect.apply(rawObservableKey as (obs: TObservable) => string, undefined, [obs])
      : (rawObservableKey as DistinguishableProbeSpec<TInput, TObservable>["observableKey"]);
  const parseResponseFn =
    typeof rawParseResponse === "function"
      ? (resp: unknown): TObservable | null =>
          Reflect.apply(rawParseResponse as (resp: unknown) => TObservable | null, undefined, [resp])
      : (rawParseResponse as DistinguishableProbeSpec<TInput, TObservable>["parseResponse"]);

  const frozenSpec: DistinguishableProbeSpec<TInput, TObservable> = Object.freeze({
    probeId: frozenProbeId,
    requirementKey: frozenRequirementKey,
    prompt: frozenPrompt,
    input: frozenInput,
    correctModel: frozenCorrectModel,
    hypotheses: frozenHypotheses,
    observableKey: observableKeyFn,
    parseResponse: parseResponseFn,
  });

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
  const frozenRuleSourceRefs = hasExplicitRuleSourceRefs
    ? isPlainDataDescriptorSafe(input.ruleSourceRefs)
      ? freezeSourceRefs(input.ruleSourceRefs)
      : null
    : undefined;

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
    evidenceCases.push({
      attemptId: attempt.attemptId,
      rootAttemptId: attempt.rootAttemptId,
      chapterId: attempt.chapterId,
      localDate: attempt.localDate,
      ruleId: attempt.ruleId,
      excerpt: attempt.excerpt,
      invariantSummary: attempt.invariantSummary,
      sourceRefs: cloneSourceRefs(attempt.sourceRefs),
      privacyEpoch: attempt.privacyEpoch,
    });
  }

  const coverage = computeEvidenceCoverage(evidenceCases);
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

  const selectedCases = selectSpreadRepresentativeCases(evidenceCases);
  const clinic: RemedyClinicSessionV1 = {
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
    evidenceCases: evidenceCases.map(cloneEvidenceCase),
    steps: [
      {
        stepNumber: 1,
        kind: "side_by_side_self_diff",
        durationMinutes: STEP1_SELF_DIFF_MINUTES,
        selectedCases,
        diffs: buildSelfDiffEntries(selectedCases),
      },
      frozenRestatementStep,
      {
        stepNumber: 3,
        kind: "distinguishable_transfer_probes",
        durationMinutes: STEP3_TRANSFER_PROBES_MINUTES,
        probes: [probe1, probe2],
      },
    ],
    revocationSummary: {
      strippedCaseCount: 0,
      reason: "none",
    },
  };

  return {
    status: "active",
    clinic,
    coverage,
    rejectedCounts: counters,
    verifiedProbeCount: REQUIRED_TRANSFER_PROBE_COUNT,
    rejectedProbes,
  };
}

function degradeClinicToRevoked(
  clinic: RemedyClinicSessionV1,
  validatedPrivacyEpoch: number,
  coverage: EvidenceCoverage,
  strippedCaseCount: number,
  reason: ClinicRevocationReason,
): RemedyClinicSessionV1 {
  const [step1, step2, step3] = clinic.steps;
  return {
    ...clinic,
    ...(clinic.ruleSourceRefs !== undefined ? { ruleSourceRefs: [] } : {}),
    status: "stale_source_revoked",
    validatedPrivacyEpoch,
    coverage,
    evidenceCases: [],
    steps: [
      {
        ...step1,
        selectedCases: [],
        diffs: [],
      },
      {
        ...step2,
        ruleTitle: "",
        prompt: REVOKED_CLINIC_STEP2_PLACEHOLDER,
        checklist: [],
      },
      {
        ...step3,
        probes: [],
      },
    ],
    revocationSummary: {
      strippedCaseCount,
      reason,
    },
  };
}

/**
 * Read-time privacy_epoch and source-version guard.
 * Strips any case or probe referencing missing/revoked/version-mismatched sources (scrubbing
 * revoked text across all steps) and degrades to "stale_source_revoked" with empty excerpts,
 * cleared Step 2 title/prompt, and empty Step 3 probes when invariants fail.
 */
export function revalidateRemedyClinic(
  clinic: RemedyClinicSessionV1,
  activeSourcesMap: ActiveSourcesMap,
  currentPrivacyEpoch: number,
): RemedyClinicSessionV1 {
  if (
    !isValidPrivacyEpoch(currentPrivacyEpoch) ||
    !isValidPrivacyEpoch(clinic.createdPrivacyEpoch) ||
    !isValidPrivacyEpoch(clinic.validatedPrivacyEpoch) ||
    clinic.validatedPrivacyEpoch < clinic.createdPrivacyEpoch ||
    currentPrivacyEpoch < clinic.createdPrivacyEpoch ||
    currentPrivacyEpoch < clinic.validatedPrivacyEpoch
  ) {
    const validEpochs = [
      clinic.createdPrivacyEpoch,
      clinic.validatedPrivacyEpoch,
      currentPrivacyEpoch,
    ].filter(isValidPrivacyEpoch);
    const safeEpoch = validEpochs.length > 0 ? Math.max(0, ...validEpochs) : 0;
    return degradeClinicToRevoked(
      clinic,
      safeEpoch,
      { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 },
      clinic.evidenceCases.length,
      "invalid_privacy_epoch",
    );
  }

  if (clinic.status === "stale_source_revoked") {
    return degradeClinicToRevoked(
      clinic,
      currentPrivacyEpoch,
      { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 },
      clinic.revocationSummary.strippedCaseCount,
      "already_revoked",
    );
  }

  if (clinic.ruleSourceRefs !== undefined) {
    const frozenRuleRefs = isPlainDataDescriptorSafe(clinic.ruleSourceRefs)
      ? freezeSourceRefs(clinic.ruleSourceRefs)
      : null;
    if (!frozenRuleRefs || !areSourceRefsActive(frozenRuleRefs, activeSourcesMap)) {
      return degradeClinicToRevoked(
        clinic,
        currentPrivacyEpoch,
        { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 },
        Array.isArray(clinic.evidenceCases) ? clinic.evidenceCases.length : 0,
        "rule_source_revoked",
      );
    }
  }

  const seenRoots = new Set<string>();
  const survivingCases: ClinicEvidenceCase[] = [];
  const totalEvidenceCases = Array.isArray(clinic.evidenceCases) ? clinic.evidenceCases.length : 0;
  if (Array.isArray(clinic.evidenceCases)) {
    for (let i = 0; i < clinic.evidenceCases.length; i += 1) {
      const slot = readOwnDataIndex(clinic.evidenceCases, i);
      if (!slot.ok) continue;
      const item = slot.value;
      if (!item || typeof item !== "object") continue;
      if (seenRoots.has(item.rootAttemptId)) continue;
      if (item.ruleId !== clinic.ruleId) continue;
      if (!isValidPrivacyEpoch(item.privacyEpoch) || item.privacyEpoch > currentPrivacyEpoch) continue;
      if (!isValidLocalDate(item.localDate)) continue;
      if (!areSourceRefsActive(item.sourceRefs, activeSourcesMap)) continue;
      seenRoots.add(item.rootAttemptId);
      survivingCases.push(cloneEvidenceCase(item));
    }
  }

  const strippedCaseCount = totalEvidenceCases - survivingCases.length;
  const coverage = computeEvidenceCoverage(survivingCases);

  if (!meetsClinicThreshold(coverage)) {
    return degradeClinicToRevoked(
      clinic,
      currentPrivacyEpoch,
      coverage,
      strippedCaseCount,
      "insufficient_surviving_evidence",
    );
  }

  const [step1, step2, step3] = clinic.steps;
  const survivingProbes: VerifiedClinicTransferProbe[] = [];
  const totalProbes = Array.isArray(step3.probes) ? step3.probes.length : 0;
  if (Array.isArray(step3.probes)) {
    for (let i = 0; i < step3.probes.length; i += 1) {
      const slot = readOwnDataIndex(step3.probes, i);
      if (!slot.ok) continue;
      const probe = slot.value;
      if (!probe || typeof probe !== "object") continue;
      let validatedProbeRefs: readonly RemedySourceRef[] | undefined;
      if (probe.sourceRefs !== undefined) {
        const frozenProbeRefs = isPlainDataDescriptorSafe(probe.sourceRefs)
          ? freezeSourceRefs(probe.sourceRefs)
          : null;
        if (!frozenProbeRefs || !areSourceRefsActive(frozenProbeRefs, activeSourcesMap)) {
          continue;
        }
        validatedProbeRefs = frozenProbeRefs;
      }
      survivingProbes.push(cloneVerifiedProbe(probe, validatedProbeRefs));
    }
  }
  const strippedProbeCount = totalProbes - survivingProbes.length;
  if (survivingProbes.length < REQUIRED_TRANSFER_PROBE_COUNT) {
    return degradeClinicToRevoked(
      clinic,
      currentPrivacyEpoch,
      coverage,
      strippedCaseCount,
      "insufficient_surviving_probes",
    );
  }

  const selectedCases = selectSpreadRepresentativeCases(survivingCases);
  return {
    ...clinic,
    status: "active",
    validatedPrivacyEpoch: currentPrivacyEpoch,
    coverage,
    evidenceCases: survivingCases,
    steps: [
      {
        ...step1,
        selectedCases,
        diffs: buildSelfDiffEntries(selectedCases),
      },
      step2,
      {
        ...step3,
        probes: survivingProbes.slice(0, REQUIRED_TRANSFER_PROBE_COUNT),
      },
    ],
    revocationSummary: {
      strippedCaseCount,
      ...(strippedProbeCount > 0 ? { strippedProbeCount } : {}),
      reason:
        strippedCaseCount > 0 || strippedProbeCount > 0
          ? "partial_source_revoked_still_active"
          : "none",
    },
  };
}
