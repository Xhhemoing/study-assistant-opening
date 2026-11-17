import { nextLearningStep, type LearnerStateFeature } from "@aistudy/domain";
import { nextLearningStepWithExperimentalBkt } from "../../../../packages/domain/src/opening/adaptive/experimental-bkt-advice";
import { createExperimentalLearningAdvicePort } from "../features/opening/teaching/experimental-learning-advice-port";
import type { ExperimentalBktSnapshot } from "../../../../packages/database/src/repositories/opening-experimental-bkt-snapshot";
import type { ExperimentalBktTrustedHostContext, ExperimentalBktSnapshotServiceOptions,
  ExperimentalBktSnapshotReadOptions, ExperimentalBktSnapshotServiceRead, ExperimentalBktSnapshotPortRead,
  ExperimentalBktProviderQualification,
} from "./experimental-bkt-snapshot-service-types";

function strictTime(value: string | null): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`), parsed = Date.parse(value);
  return Number.isFinite(parsed) && Number.isFinite(day.getTime())
    && day.toISOString().slice(0, 10) === value.slice(0, 10) && Number(value.slice(11, 13)) < 24 ? parsed : NaN;
}

/** Consistency gate over ONE atomic repository result, never cross-run joins.
 * Repo owns qualification/family provenance; this is not a second predictor or
 * a claim of historical metadata reconstruction. Read identity is not a receipt.
 */
function snapshotProblem(snapshot: ExperimentalBktSnapshot, context: ExperimentalBktTrustedHostContext): string | null {
  const { scope, target } = context;
  if (snapshot.scope.workspaceId !== scope.workspaceId || snapshot.scope.ownerUserId !== scope.ownerUserId
    || snapshot.scope.courseId !== target.courseId || snapshot.cutoff !== target.cutoff) return "snapshot_scope_conflict";
  if (snapshot.status === "not_available") return `snapshot:${snapshot.reason}`;
  const asOf = strictTime(snapshot.dataAsOf), cutoff = strictTime(target.cutoff);
  if (!snapshot.stateVersion?.trim() || !Number.isFinite(asOf) || !Number.isFinite(cutoff) || cutoff > asOf) return "snapshot_identity_unavailable";
  const { features, observationHeads: heads, families } = snapshot;
  if (!features.length) return "no_qualified_heads";
  if (features.length !== heads.length || features.length !== families.length
    || new Set(features.map(row => row.observationId)).size !== features.length
    || new Set(heads.map(row => row.id)).size !== heads.length
    || new Set(heads.map(row => row.problemId)).size !== heads.length
    || new Set(families.map(row => row.observationId)).size !== families.length) return "snapshot_pair_conflict";
  const excluded = new Set(target.excludedProblemIds ?? []);
  for (const feature of features) {
    const head = heads.find(row => row.id === feature.observationId), family = families.find(row => row.observationId === feature.observationId);
    if (!head || !head.problemId || !head.itemVersionId || head.problemId === target.problemId
      || excluded.has(head.problemId) || excluded.has(head.id) || !family?.familyId.trim() || family.provenance !== "span_catalogue"
      || feature.courseId !== target.courseId || feature.requirementKey !== target.requirementKey
      || head.requirementKey !== target.requirementKey || head.itemVersionId !== feature.itemVersionId
      || head.skillLabel !== feature.skillLabel) return "snapshot_pair_conflict";
    const attempted = strictTime(feature.attemptedAt), recorded = strictTime(feature.recordedAt);
    if (!Number.isFinite(attempted) || !Number.isFinite(recorded) || attempted > recorded
      || attempted >= cutoff || recorded >= cutoff || strictTime(head.attemptedAt) !== attempted) return "strict_asof_unavailable";
    if (feature.availability !== "available" || !feature.views.includes("independent") || feature.views.includes("help")
      || feature.eligibility.independentAttempt !== "yes" || feature.eligibility.usableForCurrentVersion !== "yes"
      || !["yes", "no"].includes(feature.eligibility.verifiedCorrect)
      || feature.eligibility.reasonCodes.some(code => code.startsWith("ai_"))
      || feature.outcome !== (feature.eligibility.verifiedCorrect === "yes" ? "correct" : "incorrect")
      || head.assistance !== "independent" || head.independentAttempt !== "yes" || head.usableForCurrentVersion !== "yes"
      || head.verifiedCorrect !== feature.eligibility.verifiedCorrect) return "snapshot_qualification_conflict";
  }
  return null;
}

/** Only fields needed by the frozen provider; no answer/source/probability payload,
 * no arbitrary repository extensions, and no invented family/KC/retention facts.
 */
function providerQualification(snapshot: ExperimentalBktSnapshot, context: ExperimentalBktTrustedHostContext): ExperimentalBktProviderQualification {
  const features: LearnerStateFeature[] = snapshot.features.map(row => ({
    observationId: row.observationId, attemptId: row.attemptId, courseId: row.courseId,
    requirementKey: row.requirementKey, itemVersionId: row.itemVersionId, skillLabel: row.skillLabel,
    attemptedAt: row.attemptedAt, recordedAt: row.recordedAt, sourceIds: [], sourceVersions: {},
    eligibility: { policyVersion: row.eligibility.policyVersion, independentAttempt: row.eligibility.independentAttempt,
      verifiedCorrect: row.eligibility.verifiedCorrect, usableForCurrentVersion: row.eligibility.usableForCurrentVersion,
      usableForDelayedCheck: "unknown", reasonCodes: [...row.eligibility.reasonCodes] },
    availability: row.availability, views: ["independent"], outcome: row.outcome, ordinal: row.ordinal,
    transfer: { usable: "unknown", knowledgeComponents: [], reasonCodes: [] },
    retention: { protocolId: null, earliestAt: null, recordedIntervalSupportCount: null, intervalExposureComplete: null }, gaps: [],
  }));
  return {
    dataAsOf: snapshot.dataAsOf!, stateVersion: snapshot.stateVersion!, ruleDecision: context.ruleDecision,
    ruleInput: context.ruleInput && { ...context.ruleInput, observations: [...snapshot.observationHeads]
      .sort((a, b) => strictTime(b.attemptedAt) - strictTime(a.attemptedAt) || b.id.localeCompare(a.id)).map(row => ({
      id: row.id, problemId: row.problemId, itemVersionId: row.itemVersionId, requirementKey: row.requirementKey,
      skillLabel: row.skillLabel, attemptedAt: row.attemptedAt, assistance: row.assistance,
      independentAttempt: row.independentAttempt, verifiedCorrect: row.verifiedCorrect,
      usableForCurrentVersion: row.usableForCurrentVersion,
    })) },
    observationHeads: snapshot.observationHeads.map(row => ({ id: row.id, problemId: row.problemId,
      itemVersionId: row.itemVersionId, requirementKey: row.requirementKey, skillLabel: row.skillLabel,
      attemptedAt: row.attemptedAt, assistance: row.assistance, independentAttempt: row.independentAttempt,
      verifiedCorrect: row.verifiedCorrect, usableForCurrentVersion: row.usableForCurrentVersion })),
    // Preparation stays disabled; only readPort's separately authorized same-read
    // callback may enable the fixed R4 experiment. Approval alone grants nothing.
    experiment: { enabled: false, features, target: { courseId: context.target.courseId,
      requirementKey: context.target.requirementKey, problemId: context.target.problemId, itemVersionId: context.target.itemVersionId },
    cutoff: context.target.cutoff, excludedProblemIds: [...context.target.excludedProblemIds ?? []] },
  };
}

/** Read-only DI seam with fixed R4/port calls; no concrete auth host, cache or HTTP.
 * Errors propagate unchanged. Default off does not resolve auth or touch the repo.
 */
export function createExperimentalBktSnapshotService({ host, repository, ruleDecision }: ExperimentalBktSnapshotServiceOptions = {}) {
  let generation = 0;
  const unavailable = (reason: string): ExperimentalBktSnapshotServiceRead => ({ status: "unavailable", reason });
  async function readSnapshot({ enabled = false, signal }: ExperimentalBktSnapshotReadOptions = {},
    consume?: (qualification: ExperimentalBktProviderQualification) => void): Promise<ExperimentalBktSnapshotServiceRead> {
      const run = ++generation;
      if (!enabled) return { status: "disabled" };
      if (signal?.aborted) return unavailable("cancelled");
      if (!host) return unavailable("trusted_host_unavailable");
      const context = await host.resolveAuthenticatedContext(signal);
      if (signal?.aborted || run !== generation) return unavailable("cancelled");
      if (!context) return unavailable("authenticated_context_unavailable");
      // Capture host-owned values before awaiting IO. Never accept a client scope.
      const bound: ExperimentalBktTrustedHostContext = {
        scope: { workspaceId: context.scope.workspaceId, ownerUserId: context.scope.ownerUserId },
        target: { courseId: context.target.courseId, requirementKey: context.target.requirementKey,
          problemId: context.target.problemId, itemVersionId: context.target.itemVersionId,
          cutoff: context.target.cutoff, excludedProblemIds: [...context.target.excludedProblemIds ?? []] },
        ruleDecision: context.ruleDecision && { activityKind: context.ruleDecision.activityKind,
          reasonCode: context.ruleDecision.reasonCode, focusObservationId: context.ruleDecision.focusObservationId,
          phase: context.ruleDecision.phase, phaseSource: context.ruleDecision.phaseSource },
        ruleInput: context.ruleInput && { status: context.ruleInput.status, wantsFullExplanation: context.ruleInput.wantsFullExplanation,
          dueRetest: context.ruleInput.dueRetest, learningPhase: context.ruleInput.learningPhase,
          phaseSource: context.ruleInput.phaseSource, remediationCycles: context.ruleInput.remediationCycles && structuredClone(context.ruleInput.remediationCycles) },
      };
      if (!host.isCurrent(context)) return unavailable("host_authorization_revoked");
      if (host.canPrepare?.(context) !== true) return unavailable("host_prepare_not_authorized");
      if (consume && host.canCompare?.(context) !== true) return unavailable("host_comparison_not_authorized");
      if (consume && (!bound.ruleInput || !bound.ruleDecision)) return unavailable("host_rule_input_unavailable");
      if (!repository) return unavailable("snapshot_repository_unavailable");
      const snapshot = await repository.read(bound.scope, bound.target);
      if (signal?.aborted || run !== generation) return unavailable("cancelled");
      if (!host.isCurrent(context)) return unavailable("host_authorization_revoked");
      if (host.canPrepare?.(context) !== true) return unavailable("host_prepare_not_authorized");
      if (consume && host.canCompare?.(context) !== true) return unavailable("host_comparison_not_authorized");
      const problem = snapshotProblem(snapshot, bound);
      if (problem) return unavailable(problem);
      const qualification = providerQualification(snapshot, bound);
      if (consume && qualification.ruleInput && qualification.ruleDecision) {
        const subset = nextLearningStep(qualification.ruleInput), authoritative = qualification.ruleDecision;
        if (subset.activityKind !== authoritative.activityKind || subset.reasonCode !== authoritative.reasonCode
          || subset.focusObservationId !== authoritative.focusObservationId || subset.phase !== authoritative.phase
          || subset.phaseSource !== authoritative.phaseSource) return unavailable("host_rule_context_conflict");
      }
      // Sanitized owned projection; it is not a decision receipt or auth proof.
      const safe: ExperimentalBktSnapshot = { status: "available", reason: null,
        scope: { ...bound.scope, courseId: bound.target.courseId }, cutoff: bound.target.cutoff,
        dataAsOf: qualification.dataAsOf, stateVersion: qualification.stateVersion,
        features: structuredClone([...qualification.experiment.features]), observationHeads: structuredClone([...qualification.observationHeads]),
        families: snapshot.families.map(row => ({ observationId: row.observationId, familyId: row.familyId, provenance: row.provenance })), excluded: {} };
      if (consume) {
        if (signal?.aborted || run !== generation) return unavailable("cancelled");
        if (!host.isCurrent(context)) return unavailable("host_authorization_revoked");
        if (host.canPrepare?.(context) !== true) return unavailable("host_prepare_not_authorized");
        if (host.canCompare?.(context) !== true) return unavailable("host_comparison_not_authorized");
        consume(qualification);
      }
      if (signal?.aborted || run !== generation) return unavailable("cancelled");
      if (!host.isCurrent(context)) return unavailable("host_authorization_revoked");
      if (host.canPrepare?.(context) !== true) return unavailable("host_prepare_not_authorized");
      if (consume && host.canCompare?.(context) !== true) return unavailable("host_comparison_not_authorized");
      return { status: "unavailable", reason: "comparison_not_requested", comparisonReady: false,
        preparation: { snapshot: safe, qualification, mode: "read_only", authorization: "host_checked" } };
  }
  const service = {
    /** Invalidates all in-flight reads; retains no result that could be reused. */
    cancel() { generation++; },
    read(options: ExperimentalBktSnapshotReadOptions = {}) { return readSnapshot(options); },
    /** Explicit server-only preparation entry. `enabled` is only a local opt-in;
     * it cannot grant host permission. Output is disabled read-only data, not an
     * enabled experiment, ready comparison, reusable authorization or action.
     */
    async prepare(options: ExperimentalBktSnapshotReadOptions = {}): Promise<ExperimentalBktSnapshotServiceRead> {
      return service.read(options);
    },
    /** Fresh read, fixed real R4 wrapper and original display-only port. No caller
     * wrapper substitute or enabled cache. Errors propagate; post-call revocation
     * discards even a completed synchronous projection before returning it.
     */
    async readPort(options: ExperimentalBktSnapshotReadOptions = {}): Promise<ExperimentalBktSnapshotPortRead> {
      let projected: ExperimentalBktSnapshotPortRead | undefined;
      const result = await readSnapshot(options, qualification => {
        // Missing controls were rejected before IO; no cast or fabricated default.
        if (!qualification.ruleInput) return;
        const input = qualification.ruleInput;
        const rule = qualification.ruleDecision;
        if (!rule) return;
        const experiment = { ...qualification.experiment, enabled: true };
        const port = createExperimentalLearningAdvicePort({ ruleDecision: rule, experimentEnabled: true,
          provideExperimentalResult: () => nextLearningStepWithExperimentalBkt(input, experiment) });
        projected = { comparisonReady: port.status === "compared", reason: port.status === "fallback" ? port.reason : port.status, port };
      });
      if (projected && result.status === "unavailable" && result.preparation) return projected;
      const reason = result.status === "disabled" ? "disabled" : result.reason;
      const rule = reason !== "host_rule_context_conflict" && ruleDecision
        ? { activityKind: ruleDecision.activityKind, reasonCode: ruleDecision.reasonCode } : null;
      return { comparisonReady: false, reason, port: !rule ? null : {
        ruleDecision: rule, status: result.status === "disabled" ? "disabled" : "unavailable", experimentalAdvice: null,
      } };
    },
  };
  return service;
}
