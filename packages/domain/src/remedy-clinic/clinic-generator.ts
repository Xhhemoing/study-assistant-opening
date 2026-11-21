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
  isNonBlankText,
  isValidLocalDate,
  isValidPrivacyEpoch,
  meetsClinicThreshold,
  selectSpreadRepresentativeCases,
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

export interface VerifiedClinicTransferProbe {
  readonly probeId: string;
  readonly requirementKey: string;
  readonly prompt: string;
  readonly competingModelIds: readonly string[];
  readonly report: ProbeDistinguishabilityReport;
}

export interface RejectedClinicProbe {
  readonly probeId: string;
  readonly reason: "duplicate_probe_id" | "duplicate_probe_prompt" | "not_distinguishable";
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
  readonly prompt: string;
  readonly checklist: readonly string[];
}

export interface DistinguishableTransferProbesStep {
  readonly stepNumber: 3;
  readonly kind: "distinguishable_transfer_probes";
  readonly durationMinutes: 7;
  readonly probes: readonly [VerifiedClinicTransferProbe, VerifiedClinicTransferProbe];
}

export type ClinicRevocationReason =
  | "none"
  | "partial_source_revoked_still_active"
  | "insufficient_surviving_evidence"
  | "invalid_privacy_epoch"
  | "already_revoked";

export interface RemedyClinicSessionV1 {
  readonly schemaVersion: 1;
  readonly clinicId: string;
  readonly status: "active" | "stale_source_revoked";
  readonly learnerId: string;
  readonly courseId: string;
  readonly ruleId: string;
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
  readonly currentPrivacyEpoch: number;
  readonly activeSourcesMap: ActiveSourcesMap;
  readonly attempts: readonly DiagnosedRootAttempt[];
  readonly embeddingRecallCandidates?: readonly EmbeddingRecallCandidate[];
  readonly verifyRuleViolation: (attempt: DiagnosedRootAttempt) => boolean;
  readonly candidateProbes: readonly DistinguishableProbeSpec<TInput, TObservable>[];
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

function buildRestatementStep(ruleId: string, ruleTitle?: string): InvariantRuleRestatementStep {
  const label = isNonBlankText(ruleTitle) ? `${ruleTitle.trim()} (${ruleId})` : ruleId;
  return {
    stepNumber: 2,
    kind: "invariant_rule_restatement",
    durationMinutes: STEP2_INVARIANT_RESTATEMENT_MINUTES,
    ruleId,
    prompt:
      `Compare the 3 side-by-side cases above and restate the core invariant for ${label} in your own words. ` +
      "Explain what structural condition triggers the rule, why the recurring error fails that condition, " +
      "and what single check you will apply before committing to a step.",
    checklist: [
      "State the exact condition required by the invariant rule.",
      "Identify the shared failure mechanism across the 3 different cases.",
      "Write a concise pre-check you can apply to unseen transfer problems.",
    ],
  };
}

export function generateRemedyClinic<TInput = unknown, TObservable = unknown>(
  input: GenerateRemedyClinicInput<TInput, TObservable>,
): GenerateRemedyClinicResult {
  const zeroCoverage: EvidenceCoverage = { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 };

  if (
    !isNonBlankText(input.learnerId) ||
    !isNonBlankText(input.courseId) ||
    !isNonBlankText(input.ruleId) ||
    !isValidPrivacyEpoch(input.currentPrivacyEpoch) ||
    typeof input.verifyRuleViolation !== "function"
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

  const taggedCandidates: Array<{ attempt: DiagnosedRootAttempt; fromEmbeddingRecall: boolean }> = [
    ...input.attempts.map((attempt) => ({ attempt, fromEmbeddingRecall: false })),
    ...(input.embeddingRecallCandidates ?? []).map((candidate) => ({
      attempt: candidate.attempt,
      fromEmbeddingRecall: true,
    })),
  ];

  const verifiedCandidates: DiagnosedRootAttempt[] = [];
  for (const { attempt, fromEmbeddingRecall } of taggedCandidates) {
    if (attempt.learnerId !== input.learnerId || attempt.courseId !== input.courseId) {
      counters.scopeMismatch++;
      continue;
    }
    if (attempt.assisted) {
      counters.assisted++;
      continue;
    }
    if (!isValidPrivacyEpoch(attempt.privacyEpoch) || attempt.privacyEpoch !== input.currentPrivacyEpoch) {
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
    if (!areSourceRefsActive(attempt.sourceRefs, input.activeSourcesMap)) {
      counters.revokedSource++;
      continue;
    }
    // Strict exact ruleId clustering: never merge via A≈B, B≈C embedding transitive closure.
    if (attempt.ruleId !== input.ruleId) {
      counters.ruleIdMismatch++;
      if (fromEmbeddingRecall) counters.transitiveClosureBlocked++;
      continue;
    }
    if (!safeVerifyRuleViolation(input.verifyRuleViolation, attempt)) {
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

  for (const probe of input.candidateProbes) {
    const report = verifyProbeDistinguishability(probe);
    const probeId = report.probeId || (typeof probe?.probeId === "string" ? probe.probeId : "");
    if (!report.distinguishable) {
      rejectedProbes.push({ probeId, reason: "not_distinguishable", report });
      continue;
    }
    if (acceptedProbeIds.has(probeId)) {
      rejectedProbes.push({ probeId, reason: "duplicate_probe_id", report });
      continue;
    }
    const normalizedPrompt = probe.prompt.trim().replace(/\s+/g, " ").toLowerCase();
    if (acceptedProbePrompts.has(normalizedPrompt)) {
      rejectedProbes.push({ probeId, reason: "duplicate_probe_prompt", report });
      continue;
    }
    acceptedProbeIds.add(probeId);
    acceptedProbePrompts.add(normalizedPrompt);
    verifiedProbes.push({
      probeId,
      requirementKey: probe.requirementKey,
      prompt: probe.prompt,
      competingModelIds: report.predictions.map((entry) => entry.modelId),
      report,
    });
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
  const clinicId = isNonBlankText(input.clinicId)
    ? input.clinicId.trim()
    : `clinic:${input.courseId}:${input.ruleId}:e${input.currentPrivacyEpoch}`;

  const clinic: RemedyClinicSessionV1 = {
    schemaVersion: 1,
    clinicId,
    status: "active",
    learnerId: input.learnerId,
    courseId: input.courseId,
    ruleId: input.ruleId,
    totalMinutes: REMEDY_CLINIC_TOTAL_MINUTES,
    createdPrivacyEpoch: input.currentPrivacyEpoch,
    validatedPrivacyEpoch: input.currentPrivacyEpoch,
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
      buildRestatementStep(input.ruleId, input.ruleTitle),
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
      step2,
      step3,
    ],
    revocationSummary: {
      strippedCaseCount,
      reason,
    },
  };
}

/**
 * Read-time privacy_epoch and source-version guard.
 * Strips any case referencing missing/revoked/version-mismatched sources (completely scrubbing
 * its excerpt) and degrades to "stale_source_revoked" with empty excerpts if surviving cases
 * no longer satisfy >= 3 roots x >= 2 chapters x >= 2 local calendar days.
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
    const safeEpoch =
      isValidPrivacyEpoch(clinic.validatedPrivacyEpoch) && isValidPrivacyEpoch(clinic.createdPrivacyEpoch)
        ? Math.max(clinic.createdPrivacyEpoch, clinic.validatedPrivacyEpoch)
        : isValidPrivacyEpoch(clinic.createdPrivacyEpoch)
          ? clinic.createdPrivacyEpoch
          : 0;
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

  const seenRoots = new Set<string>();
  const survivingCases: ClinicEvidenceCase[] = [];
  for (const item of clinic.evidenceCases) {
    if (seenRoots.has(item.rootAttemptId)) continue;
    if (item.ruleId !== clinic.ruleId) continue;
    if (!isValidPrivacyEpoch(item.privacyEpoch) || item.privacyEpoch > currentPrivacyEpoch) continue;
    if (!isValidLocalDate(item.localDate)) continue;
    if (!areSourceRefsActive(item.sourceRefs, activeSourcesMap)) continue;
    seenRoots.add(item.rootAttemptId);
    survivingCases.push(cloneEvidenceCase(item));
  }

  const strippedCaseCount = clinic.evidenceCases.length - survivingCases.length;
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

  const selectedCases = selectSpreadRepresentativeCases(survivingCases);
  const [step1, step2, step3] = clinic.steps;
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
      step3,
    ],
    revocationSummary: {
      strippedCaseCount,
      reason: strippedCaseCount > 0 ? "partial_source_revoked_still_active" : "none",
    },
  };
}
