import type { LearningObservation } from "@aistudy/contracts";
import { evaluateEvidenceEligibility, resolveEvidenceAssistance, type EvidenceEligibility } from "./evidence-eligibility";
import { evaluateTransferEligibility, type TransferEligibility, type TransferSpecification } from "./evidence-transfer-eligibility";
import { summarizeObservations, type CourseEvidence, type RetestEvidenceIdentity } from "./learning-summary";

export type LearnerEvidenceDisplayState = "independent" | "hinted" | "retest" | "insufficient";
export const learnerEvidenceDisplayLabels: Record<LearnerEvidenceDisplayState, string> = {
  independent: "独立完成", hinted: "依赖提示", retest: "待复测", insufficient: "证据不足",
};

/** Presentation of qualified evidence only; never changes the original assessment. */
export function learnerEvidenceDisplayState(
  observation: Pick<LearningObservation, "assistance" | "eligibility"> | null | undefined,
  current: { dueRetest?: boolean; solutionDelivered?: boolean } = {},
): LearnerEvidenceDisplayState {
  const eligibility = observation?.eligibility;
  if (!observation || !eligibility || eligibility.usableForCurrentVersion !== "yes") return "insufficient";
  if (current.dueRetest || current.solutionDelivered || observation.assistance === "revealed"
    || eligibility.reasonCodes.includes("prior_answer_exposure") || eligibility.verifiedCorrect === "no") return "retest";
  if (eligibility.verifiedCorrect !== "yes") return "insufficient";
  if (eligibility.independentAttempt === "yes" && observation.assistance === "independent") return "independent";
  if (eligibility.independentAttempt === "no" && observation.assistance === "hinted") return "hinted";
  return "insufficient";
}

export type LearnerStateDisplay = {
  scope: "recorded_requirements";
  counts: Record<LearnerEvidenceDisplayState, number>;
  total: number;
  /** Unknown requirement identity cannot be merged by display label. */
  unscopedObservations: number;
  requirements: Array<{ courseId: string; requirementKey: string; skillLabel: string; state: LearnerEvidenceDisplayState; observationIds: string[]; dueRetest: boolean }>;
};

function projectLearnerDisplay(evidence: CourseEvidence, features: LearnerStateFeature[], dueRetests: readonly RetestEvidenceIdentity[]): LearnerStateDisplay {
  const groups = new Map<string, LearnerStateFeature[]>();
  for (const feature of features) {
    if (!feature.requirementKey) continue;
    const key = JSON.stringify([feature.courseId, feature.requirementKey]);
    const members = groups.get(key);
    if (members) members.push(feature);
    else groups.set(key, [feature]);
  }
  const observations = new Map(evidence.observations.map(row => [row.id, row]));
  const requirements = [...groups.values()].map(members => {
    const latestTime = members.reduce((latest, row) => Math.max(latest, Date.parse(row.attemptedAt)), -Infinity);
    const latest = members.filter(row => Date.parse(row.attemptedAt) === latestTime);
    const head = latest[latest.length - 1]!;
    const dueRetest = dueRetests.some(row => row.courseId === head.courseId && row.requirementKey === head.requirementKey);
    const states = latest.map(feature => {
      const row = observations.get(feature.observationId)!;
      const facts = evidence.evidenceContexts[feature.observationId];
      // A delivered solution changes the next learning step, not the qualification
      // of an original answer submitted before that delivery.
      const solutionDelivered = Boolean(feature.attemptId && facts?.context.helpHistory?.exposures.some(exposure =>
        exposure.attemptId === feature.attemptId && exposure.kind === "solution" && exposure.level === "revealed"
        && (exposure.supportDomain !== "language" || facts.observation.assessmentDomain === "language") && exposure.delivered === true));
      return learnerEvidenceDisplayState({ eligibility: feature.eligibility,
        assistance: facts ? resolveEvidenceAssistance(facts.observation, facts.context) : row.assistance }, { dueRetest, solutionDelivered });
    });
    // Equal timestamps do not establish an ordering between conflicting attempts.
    const state = states.every(value => value === states[0]) ? states[0]! : "insufficient";
    return { courseId: head.courseId, requirementKey: head.requirementKey!, skillLabel: head.skillLabel, state,
      observationIds: latest.map(row => row.observationId), dueRetest };
  });
  const counts: LearnerStateDisplay["counts"] = { independent: 0, hinted: 0, retest: 0, insufficient: 0 };
  for (const row of requirements) counts[row.state] += 1;
  return { scope: "recorded_requirements", counts, total: requirements.length,
    unscopedObservations: features.filter(row => !row.requirementKey).length, requirements };
}

export type LearnerEvidenceView = "independent" | "retention" | "transfer" | "help";
/** Count current graded answers once, using the full effective-head sequence. */
export function countValidLearnerObservations(observations: readonly {
  observationId: string;
  eligibility: Pick<EvidenceEligibility, "verifiedCorrect" | "usableForCurrentVersion">;
}[]): number {
  return new Set(observations.filter(row => row.eligibility.verifiedCorrect !== "unknown"
    && row.eligibility.usableForCurrentVersion === "yes").map(row => row.observationId)).size;
}

export type LearnerStateEvidence = {
  observationId: string; attemptId: string | null; courseId: string; requirementKey: string | null;
  itemVersionId: string | null; skillLabel: string; attemptedAt: string; recordedAt: string | null;
  sourceIds: string[];
  sourceVersions: Record<string, number>; eligibility: EvidenceEligibility;
  availability: "available" | "stale" | "unavailable" | "unknown";
  views: LearnerEvidenceView[];
  transfer: TransferEligibility;
  retention: { protocolId: string | null; earliestAt: string | null; recordedIntervalSupportCount: number | null; intervalExposureComplete: boolean | null };
  /** Missing protocol/exposure metadata remains a gap, never a negative performance claim. */
  gaps: string[];
};
export type LearnerStateFeature = LearnerStateEvidence & { outcome: LearningObservation["outcome"]; ordinal: number };
export const LEARNER_SKILL_PROFILE_VERSION = "rule-profile:1";
export type LearnerSkillProfileItem = {
  courseId: string; requirementKey: string; skillLabel: string; state: LearnerEvidenceDisplayState;
  observationRefs: Array<{ observationId: string; attemptId: string | null; itemVersionId: string | null; sourceIds: string[] }>;
};
export type LearnerSkillProfile = {
  profileVersion: typeof LEARNER_SKILL_PROFILE_VERSION;
  stateVersion: string; dataAsOf: string; qualificationVersion: string;
  scope: { workspaceId: string; ownerUserId: string; courseId: string | null };
  items: LearnerSkillProfileItem[];
  ungroupedObservationIds: string[];
};
export type LearnerMeasurementFeature = { attemptId: string; trialId: string; courseId: string; ordinal: number;
  itemId: string; itemVersion: string; skillId: string; familyId: string; phase: string;
  protocolVersion: string; bankVersion: string; presentedAt: string; answeredAt: string | null;
  outcome: "correct" | "incorrect" | "skipped" | null; firstAttempt: boolean; helpEvents: unknown[];
  retractedAt: string | null };
export type LearnerState = {
  stateVersion: string; dataAsOf: string; policyVersion: string;
 scope: { workspaceId: string; ownerUserId: string; courseId: string | null };
  sourceVersions: Record<string, number[]>;
  currentSourceVersions: Record<string, number>;
  summary: Array<{ courseId: string; requirementKey: string | null; skillLabel: string;
    status: "unobserved" | "observed_independent" | "needs_check" | "needs_review"; sampleCount: number;
    views: Record<LearnerEvidenceView, number>; gaps: string[] }>;
  /** Mutually exclusive evidence states for recorded requirements, not curriculum coverage. */
  display: LearnerStateDisplay;
  skillProfile: LearnerSkillProfile;
  evidence: LearnerStateEvidence[];
  /** Full chronological sequence, independent of the UI display limit. */
  features: LearnerStateFeature[];
  /** Formal measurement facts, kept separate from estimated probabilities and observation qualification. */
  measurementFeatures: LearnerMeasurementFeature[];
  projection: { mode: "live_read"; persistedRows: number; eligibleHeads: number; repairTriggered: false };
  completeness: { status: "complete" | "truncated" | "unavailable"; total: number; returned: number;
    gaps: string[]; stale: boolean };
};

/** No inferred transfer tags or no-review retention claims; those require canonical protocol facts. */
export function assembleLearnerState(input: { evidence: CourseEvidence; dataAsOf: string; stateVersion: string;
  scope?: { workspaceId: string; ownerUserId: string; courseId?: string };
  persistedRows?: number; limit?: number; measurementFeatures?: LearnerMeasurementFeature[]; currentSourceVersions?: Record<string, number>;
  transferSpecifications?: Record<string, TransferSpecification>; observationFamilies?: Record<string, string>;
  dueRetests?: readonly RetestEvidenceIdentity[] }): LearnerState {
  const ordered = [...input.evidence.observations].sort((a, b) => {
    const time = (row: LearningObservation) => input.evidence.evidenceContexts[row.id]?.observation.submittedAt
      ?? Date.parse(row.submittedAt ?? row.occurredAt);
    return time(a) - time(b) || a.id.localeCompare(b.id);
  });
  const features = ordered.map((row, ordinal): LearnerStateFeature => {
    const facts = input.evidence.evidenceContexts[row.id];
    const eligibility = evaluateEvidenceEligibility(facts?.observation ?? { courseId: row.courseId, problemId: row.problemId, assistance: row.assistance, outcome: row.outcome, verdictSource: row.verdictSource }, facts?.context ?? {});
    const specification = input.transferSpecifications?.[row.id];
    const baselineFamilyObservedBefore = Boolean(specification && ordered.some(prior => {
      if (prior.id === row.id || prior.courseId !== row.courseId || input.observationFamilies?.[prior.id] !== specification.fromFamilyId) return false;
      const baseline = input.evidence.evidenceContexts[prior.id];
      if (!baseline || (baseline.observation.submittedAt ?? Date.parse(prior.submittedAt ?? prior.occurredAt)) >= (facts?.observation.submittedAt ?? Date.parse(row.submittedAt ?? row.occurredAt))) return false;
      const qualified = evaluateEvidenceEligibility(baseline.observation, baseline.context);
      return qualified.independentAttempt === "yes" && qualified.verifiedCorrect === "yes" && qualified.usableForCurrentVersion === "yes";
    }));
    const transfer = evaluateTransferEligibility({ specification, eligibility, baselineFamilyObservedBefore, evaluation: facts?.context.serverEvaluation });
    const views: LearnerEvidenceView[] = [];
    if (transfer.usable === "yes") views.push("transfer");
    if (eligibility.independentAttempt === "yes") views.push("independent");
    if (eligibility.usableForDelayedCheck === "yes") views.push("retention");
    if (facts?.context.helpHistory?.exposures.some(exposure => exposure.delivered === true)) views.push("help");
    const applicability = facts?.context.version?.applicability;
    const availability = applicability === "exact" || applicability === "equivalent_confirmed" ? "available"
      : applicability === "changed_needs_check" ? "stale" : applicability === "unavailable" || applicability === "privacy_excluded" ? "unavailable" : "unknown";
    const delayed = facts?.context.delayedCheck;
    const retention = { protocolId: delayed?.protocolId ?? null,
      earliestAt: delayed?.earliestAt == null ? null : new Date(delayed.earliestAt).toISOString(),
      recordedIntervalSupportCount: delayed?.intervalExposure?.recordedCount ?? null,
      intervalExposureComplete: delayed?.intervalExposure?.complete ?? null };
    const gaps = [...transfer.reasonCodes.filter(code => code !== "predeclared_transfer_verified_for_named_kcs"),
      ...(delayed?.intervalExposure?.complete === true ? [] : ["retention_intervening_exposure_not_established"]),
      ...(delayed?.protocolId ? [] : ["retention_protocol_not_recorded"])];
    if (eligibility.verifiedCorrect === "unknown") gaps.push("correctness_unverified");
    if (eligibility.independentAttempt === "unknown") gaps.push("independence_unknown");
    if (eligibility.usableForCurrentVersion !== "yes") gaps.push("current_version_not_established");
    return { observationId: row.id, attemptId: row.attemptId ?? null, courseId: row.courseId,
      requirementKey: facts?.observation.requirementKey ?? null, itemVersionId: row.itemVersionId ?? null,
      sourceIds: [...row.sourceIds],
      skillLabel: row.skillLabel, attemptedAt: new Date(facts?.observation.submittedAt ?? Date.parse(row.submittedAt ?? row.occurredAt)).toISOString(),
      recordedAt: row.recordedAt ?? null, sourceVersions: row.sourceVersions ?? {}, eligibility, availability, views, transfer, retention, gaps,
      outcome: row.outcome, ordinal };
  });
  const summaries = summarizeObservations(ordered, input.dataAsOf, { evidenceContexts: input.evidence.evidenceContexts });
  const summary = summaries.map(row => {
    const members = features.filter(feature => row.evidenceIds.includes(feature.observationId));
    return { courseId: row.courseId, requirementKey: row.requirementKey, skillLabel: row.skillLabel, status: row.status,
      sampleCount: row.sampleCount, views: Object.fromEntries((["independent", "retention", "transfer", "help"] as const)
        .map(view => [view, members.filter(member => member.views.includes(view)).length])) as Record<LearnerEvidenceView, number>,
      gaps: [...new Set(members.flatMap(member => member.gaps))] };
  });
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const evidence = features.slice(-limit).map(({ outcome: _outcome, ordinal: _ordinal, ...row }) => row);
  const sourceVersions: Record<string, number[]> = {};
  for (const feature of features) for (const [id, version] of Object.entries(feature.sourceVersions)) {
    sourceVersions[id] = [...new Set([...(sourceVersions[id] ?? []), version])].sort((a, b) => a - b);
  }
  for (const [id, version] of Object.entries(input.currentSourceVersions ?? {})) {
    sourceVersions[id] = [...new Set([...(sourceVersions[id] ?? []), version])].sort((a, b) => a - b);
  }
  const display = projectLearnerDisplay(input.evidence, features, input.dueRetests ?? []);
  const scope = { workspaceId: input.scope?.workspaceId ?? "", ownerUserId: input.scope?.ownerUserId ?? "", courseId: input.scope?.courseId ?? null };
  const featureById = new Map(features.map(feature => [feature.observationId, feature]));
  const skillProfile: LearnerSkillProfile = { profileVersion: LEARNER_SKILL_PROFILE_VERSION, stateVersion: input.stateVersion,
    dataAsOf: input.dataAsOf, qualificationVersion: features[0]?.eligibility.policyVersion ?? evaluateEvidenceEligibility({}, {}).policyVersion,
    scope, items: display.requirements.map(requirement => ({ ...requirement,
      observationRefs: requirement.observationIds.map(observationId => { const feature = featureById.get(observationId)!;
        return { observationId, attemptId: feature.attemptId, itemVersionId: feature.itemVersionId, sourceIds: feature.sourceIds }; }) })),
    ungroupedObservationIds: features.filter(feature => !feature.requirementKey).map(feature => feature.observationId) };
  return { stateVersion: input.stateVersion, dataAsOf: input.dataAsOf,
    policyVersion: features[0]?.eligibility.policyVersion ?? evaluateEvidenceEligibility({}, {}).policyVersion,
    scope, sourceVersions, currentSourceVersions: input.currentSourceVersions ?? {}, summary, display,
    skillProfile,
    evidence, features, measurementFeatures: input.measurementFeatures ?? [],
    projection: { mode: "live_read", persistedRows: input.persistedRows ?? 0, eligibleHeads: features.length, repairTriggered: false },
    completeness: { status: features.length > evidence.length ? "truncated" : "complete", total: features.length,
      returned: evidence.length, gaps: [...(features.length ? [] : ["no_observation_evidence"]),
        ...(features.some(row => row.availability === "unavailable") ? ["source_unavailable"] : [])], stale: features.some(row => row.availability === "stale") } };
}
