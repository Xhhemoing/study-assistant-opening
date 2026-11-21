import type {
  DistinguishableProbeSpec,
  ProbeDistinguishabilityIssue,
  ProbeDistinguishabilityReport,
  ProbeModelPrediction,
} from "../opening/cartridges/probe-protocol";
import {
  ACTIVE_SOURCES_SHAPE,
  areFrozenSourceRefsActive,
  buildSelfDiffEntries,
  compareUtf16,
  computeEvidenceCoverage,
  isNonBlankText,
  isValidLocalDate,
  isValidPrivacyEpoch,
  meetsClinicThreshold,
  parseActiveSourcesSnapshot,
  readOwnDataIndex,
  selectSpreadRepresentativeCases,
  snapshotActiveSourcesMap,
  snapshotClinicData,
  type ClinicDataShape,
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

const CALLBACK_SHAPE: ClinicDataShape = { allowFunction: true };
const MODEL_SHAPE: ClinicDataShape = { fields: { predict: CALLBACK_SHAPE } };
const PROBE_SHAPE: ClinicDataShape = {
  fields: {
    correctModel: MODEL_SHAPE,
    hypotheses: { item: MODEL_SHAPE },
    observableKey: CALLBACK_SHAPE,
    parseResponse: CALLBACK_SHAPE,
  },
};
const INPUT_SHAPE: ClinicDataShape = {
  fields: {
    activeSourcesMap: ACTIVE_SOURCES_SHAPE,
    verifyRuleViolation: CALLBACK_SHAPE,
    candidateProbes: { item: PROBE_SHAPE },
  },
};

function isSnapshotRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOwnDataProp(obj: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function readPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!isSnapshotRecord(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.hasOwn(value, "constructor")) {
    return null;
  }
  return Object.assign(Object.create(null) as Record<string, unknown>, value);
}

type SourceRefsSnapshotResult =
  | { readonly kind: "ok"; readonly refs: readonly RemedySourceRef[] }
  | { readonly kind: "empty_or_null_ref" }
  | { readonly kind: "invalid_descriptor" };

/** Parse source refs from a detached input or session snapshot. */
function snapshotSourceRefsWithKind(sourceRefs: unknown): SourceRefsSnapshotResult {
  if (!Array.isArray(sourceRefs)) return { kind: "invalid_descriptor" };

  let hasNullRef = false;
  const frozen: RemedySourceRef[] = [];
  for (const el of sourceRefs as readonly unknown[]) {
    if (el === null) {
      hasNullRef = true;
      continue;
    }
    if (!isSnapshotRecord(el)) return { kind: "invalid_descriptor" };
    if (Object.values(el).some((val: unknown) =>
      val !== null && (typeof val === "object" || typeof val === "function"))) {
      return { kind: "invalid_descriptor" };
    }
    const sourceId = readOwnDataProp(el, "sourceId");
    const sourceVersion = readOwnDataProp(el, "sourceVersion");
    if (typeof sourceId !== "string" || (typeof sourceVersion !== "string" && typeof sourceVersion !== "number")) {
      return { kind: "invalid_descriptor" };
    }
    frozen.push(Object.freeze({ sourceId, sourceVersion }));
  }

  if (sourceRefs.length === 0 || hasNullRef) return { kind: "empty_or_null_ref" };
  return { kind: "ok", refs: Object.freeze(frozen) };
}

function freezeSourceRefs(sourceRefs: unknown): readonly RemedySourceRef[] | null {
  const snap = snapshotSourceRefsWithKind(sourceRefs);
  return snap.kind === "ok" ? snap.refs : null;
}

function isolateProbeModel<TInput, TObservable>(
  rawModel: unknown,
  role: "correct" | "misconception",
): Record<string, unknown> | null {
  const model = readPlainRecord(rawModel);
  const rawPredict = model?.["predict"];
  if (!model || typeof rawPredict !== "function") return null;

  const { predict: _predict, ...receiver } = model;
  Object.freeze(receiver);
  const predictFn = rawPredict as (this: unknown, probeInput: TInput) => TObservable;
  const isolatedPredict = (probeInput: TInput): TObservable =>
    Reflect.apply(predictFn, receiver, [probeInput]);

  return Object.freeze({
    id: model["id"],
    label: model["label"],
    role: model["role"],
    predict: isolatedPredict,
    ...(role === "misconception" ? { description: model["description"] } : {}),
  });
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
      const clonedObservable = snapshotClinicData(rawObservable);
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

/** Runtime-agnostic verifier for H_i != H_j and H_i != M*. */
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
  if (!isSnapshotRecord(rawAttempt)) return null;
  const snap = rawAttempt;
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
  const items = Array.isArray(raw) ? raw as readonly unknown[] : null;
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
}

function prepareCandidateProbe<TInput, TObservable>(
  probe: unknown,
  activeSources: ReadonlyMap<string, ActiveSourceEntry>,
): { readonly prepared: PreparedCandidateProbe<TInput, TObservable> | null; readonly rejected: RejectedClinicProbe | null } {
  const probeSnap = readPlainRecord(probe);
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

  const frozenInput = rawInput as TInput;
  const hypothesesSnap = Array.isArray(rawHypotheses) ? rawHypotheses as readonly unknown[] : null;
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
  for (const hypothesis of hypothesesSnap) {
    const isolated = isolateProbeModel<TInput, TObservable>(hypothesis, "misconception");
    if (!isolated) {
      return {
        prepared: null,
        rejected: { probeId: frozenProbeId, reason: "invalid_probe_descriptor", report: null },
      };
    }
    isolatedHypothesesList.push(isolated);
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
    if (!areFrozenSourceRefsActive(refsSnap.refs, activeSources)) {
      return {
        prepared: null,
        rejected: { probeId: frozenProbeId, reason: "revoked_probe_source", report: null },
      };
    }
    frozenSourceRefs = refsSnap.refs;
  }

  if (!isNonBlankText(frozenPrompt)) {
    return {
      prepared: null,
      rejected: { probeId: frozenProbeId, reason: "invalid_probe_prompt", report: null },
    };
  }

  const frozenCorrectModel = isolatedCorrectModelRes as unknown as DistinguishableProbeSpec<
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
  const invalidResult = (): GenerateRemedyClinicResult => ({
    status: "invalid_input",
    clinic: null,
    coverage: zeroCoverage,
    rejectedCounts: emptyRejections(),
    verifiedProbeCount: 0,
    rejectedProbes: [],
  });

  const snapshot = snapshotClinicData(input, INPUT_SHAPE);
  const inputSnap = snapshot.ok ? readPlainRecord(snapshot.value) : null;
  if (!inputSnap) return invalidResult();

  const verifyRuleFn = inputSnap["verifyRuleViolation"];
  const verifyProbeFn = verifyClinicProbeDistinguishability;
  const activeSourcesCheck = parseActiveSourcesSnapshot(inputSnap["activeSourcesMap"]);
  if (!activeSourcesCheck.containerValid) return invalidResult();
  const activeSourcesSnapshot = activeSourcesCheck.sources;
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
    const calObj = inputSnap["rubricCalibration"];
    if (!isSnapshotRecord(calObj)) {
      rubricGuardStatus = "invalid";
    } else {
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

  const attemptsSnap = inputSnap["attempts"];
  const embeddingSnap = inputSnap["embeddingRecallCandidates"];
  const candidateProbesSnap = inputSnap["candidateProbes"];

  if (
    rubricGuardStatus === "invalid" ||
    !isNonBlankText(frozenLearnerId) ||
    !isNonBlankText(frozenCourseId) ||
    !isNonBlankText(frozenRuleId) ||
    !isValidPrivacyEpoch(frozenEpoch) ||
    typeof verifyRuleFn !== "function" ||
    !Array.isArray(attemptsSnap) ||
    (embeddingSnap !== undefined && !Array.isArray(embeddingSnap)) ||
    !Array.isArray(candidateProbesSnap) ||
    (hasExplicitRuleSourceRefs && (!frozenRuleSourceRefs || !areFrozenSourceRefsActive(frozenRuleSourceRefs, activeSourcesSnapshot)))
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
  for (const candidate of candidateProbesSnap as readonly unknown[]) {
    const { prepared, rejected } = prepareCandidateProbe<TInput, TObservable>(candidate, activeSourcesSnapshot);
    if (prepared) {
      preEvaluatedProbes.push({ kind: "prepared", entry: prepared });
    } else if (rejected) {
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

  // The input snapshot has already verified and detached attempts and recalled rows.
  const taggedCandidates: Array<{ attempt: DiagnosedRootAttempt | null; fromEmbeddingRecall: boolean }> = [];
  for (const row of attemptsSnap as readonly unknown[]) {
    taggedCandidates.push({ attempt: snapshotAttemptCandidate(row), fromEmbeddingRecall: false });
  }
  if (Array.isArray(embeddingSnap)) {
    for (const row of embeddingSnap as readonly unknown[]) {
      const rawAttempt = isSnapshotRecord(row) ? readOwnDataProp(row, "attempt") : undefined;
      taggedCandidates.push({ attempt: snapshotAttemptCandidate(rawAttempt), fromEmbeddingRecall: true });
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
    if (!areFrozenSourceRefsActive(attempt.sourceRefs, activeSourcesSnapshot)) {
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
  if (!isSnapshotRecord(rawCase)) return null;
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
  if (!isSnapshotRecord(report)) return false;
  if (readOwnDataProp(report, "probeId") !== expectedProbeId) return false;
  if (readOwnDataProp(report, "distinguishable") !== true) return false;

  const issues = readOwnDataProp(report, "issues");
  const ambiguousPairs = readOwnDataProp(report, "ambiguousPairs");
  const degenerate = readOwnDataProp(report, "degenerateAgainstCorrectModel");
  const predictions = readOwnDataProp(report, "predictions");

  if (
    !Array.isArray(issues) ||
    issues.length !== 0 ||
    !Array.isArray(ambiguousPairs) ||
    ambiguousPairs.length !== 0 ||
    !Array.isArray(degenerate) ||
    degenerate.length !== 0 ||
    !Array.isArray(predictions) ||
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
    if (!slot.ok || !isSnapshotRecord(slot.value)) return false;
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
  if (!isSnapshotRecord(rawDelayedRecheck)) return false;
  const recheckRuleId = readOwnDataProp(rawDelayedRecheck, "ruleId");
  return (
    readOwnDataProp(rawDelayedRecheck, "required") === true &&
    readOwnDataProp(rawDelayedRecheck, "scheduledOutsideSessionMinutes") === true &&
    readOwnDataProp(rawDelayedRecheck, "minDelayHours") === CLINIC_DELAYED_RECHECK_MIN_HOURS &&
    typeof recheckRuleId === "string" &&
    recheckRuleId.trim() === expectedRuleId &&
    readOwnDataProp(rawDelayedRecheck, "countsTowardMasteryUntilPassed") === false
  );
}

function snapshotProbeForRevalidation(
  rawProbe: unknown,
  activeSources: ReadonlyMap<string, ActiveSourceEntry>,
  expectedRuleId: string,
): VerifiedClinicTransferProbe | null {
  if (!isSnapshotRecord(rawProbe)) return null;
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
    !isSnapshotRecord(report)
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
    if (!frozenRefs || !areFrozenSourceRefsActive(frozenRefs, activeSources)) return null;
    validatedSourceRefs = frozenRefs;
  }

  if (!isValidDistinguishableReport(report, probeId, frozenCompetingModelIds, normalizedRuleId)) {
    return null;
  }

  return Object.freeze({
    probeId,
    requirementKey,
    prompt,
    targetMisconceptionId: normalizedRuleId,
    ...(validatedSourceRefs !== undefined ? { sourceRefs: validatedSourceRefs } : {}),
    competingModelIds: frozenCompetingModelIds,
    report,
  });
}

/**
 * Snapshot the session before applying privacy epoch and source-version checks.
 * Invalid session graphs revoke the clinic and scrub all three steps.
 */
export function revalidateRemedyClinic(
  clinic: RemedyClinicSessionV1,
  activeSourcesMap: ActiveSourcesMap,
  currentPrivacyEpoch: number,
): RemedyClinicSessionV1 {
  const zeroCoverage: EvidenceCoverage = { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 };
  const activeSourcesSnapshot = snapshotActiveSourcesMap(activeSourcesMap);

  const clonedClinic = snapshotClinicData(clinic);
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
    ruleId: typeof rawRuleId === "string" ? rawRuleId.trim() : "",
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
    if (!header.ruleSourceRefs || !areFrozenSourceRefsActive(header.ruleSourceRefs, activeSourcesSnapshot)) {
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
    !isSnapshotRecord(step0) ||
    !isSnapshotRecord(step1) ||
    !isSnapshotRecord(step2)
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
      if (!areFrozenSourceRefsActive(snap.sourceRefs, activeSourcesSnapshot)) continue;
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
