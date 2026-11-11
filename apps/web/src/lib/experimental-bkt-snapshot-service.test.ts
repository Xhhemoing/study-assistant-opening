import { describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExperimentalLearningAdvice } from "../features/opening/teaching/experimental-learning-advice";
import * as realWrapper from "../../../../packages/domain/src/opening/adaptive/experimental-bkt-advice";
import { createOpeningExperimentalBktSnapshotRepository } from "../../../../packages/database/src/repositories/opening-experimental-bkt-snapshot";
import type { ExperimentalBktSnapshot } from "../../../../packages/database/src/repositories/opening-experimental-bkt-snapshot";
import { createExperimentalBktSnapshotService } from "./experimental-bkt-snapshot-service";
import type { ExperimentalBktSnapshotWrapper, ExperimentalBktTrustedHostContext } from "./experimental-bkt-snapshot-service-types";

const context: ExperimentalBktTrustedHostContext = {
  scope: { workspaceId: "00000000-0000-4000-8000-000000000001", ownerUserId: "00000000-0000-4000-8000-000000000002" },
  ruleInput: { status: "observed_independent", wantsFullExplanation: false },
  ruleDecision: { activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: "observation-one" },
  target: { courseId: "00000000-0000-4000-8000-000000000003", requirementKey: "span",
    problemId: "00000000-0000-4000-8000-000000000004", itemVersionId: "00000000-0000-4000-8000-000000000005",
    cutoff: "2026-11-11T08:00:00Z", excludedProblemIds: ["held-out"] },
};
function snapshot(): ExperimentalBktSnapshot {
  const attemptedAt = "2026-11-11T07:00:00Z", id = "observation-one";
  return { status: "available", reason: null, scope: { ...context.scope, courseId: context.target.courseId },
    cutoff: context.target.cutoff, dataAsOf: "2026-11-11T08:01:00Z", stateVersion: "bkt-read:test:1:asof",
    features: [{ observationId: id, attemptId: "attempt-one", courseId: context.target.courseId, requirementKey: context.target.requirementKey,
      itemVersionId: "version-one", skillLabel: "span", attemptedAt, recordedAt: "2026-11-11T07:01:00Z",
      sourceIds: [], sourceVersions: {}, eligibility: { policyVersion: "test", independentAttempt: "yes", verifiedCorrect: "no",
        usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown", reasonCodes: ["deterministic_incorrect"] },
      availability: "available", views: ["independent"], transfer: { usable: "unknown", knowledgeComponents: [], reasonCodes: [] },
      retention: { protocolId: null, earliestAt: null, recordedIntervalSupportCount: null, intervalExposureComplete: null },
      gaps: [], outcome: "incorrect", ordinal: 0 }],
    observationHeads: [{ id, skillLabel: "span", requirementKey: context.target.requirementKey, itemVersionId: "version-one", attemptedAt,
      assistance: "independent", verifiedCorrect: "no", independentAttempt: "yes", usableForCurrentVersion: "yes", problemId: "problem-one" }],
    families: [{ observationId: id, familyId: "span:inconsistent-3d", provenance: "span_catalogue" }], excluded: {} };
}
function fixture() {
  const host = { resolveAuthenticatedContext: vi.fn(async () => structuredClone(context) as ExperimentalBktTrustedHostContext | null),
    isCurrent: vi.fn(() => true), canPrepare: vi.fn(() => true), canCompare: vi.fn(() => true) };
  const repository = { read: vi.fn(async () => snapshot()) };
  return { host, repository, service: createExperimentalBktSnapshotService({ host, repository }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Real R2 repository execution, with a postgres.js tag/begin boundary fake only.
// It records parameterized calls and supplies typed rows; it does NOT execute SQL.
type DbRow = Record<string, unknown>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const requirement = "span:linear-combination:v1";
const spec = (problemId = "span-independent-3d", familyId = "span:inconsistent-3d", key = requirement) => ({
  kind: "span", specVersion: "span-v1", problemId, version: 1, familyId, requirementKey: key,
});
function dbHead(n = 10): DbRow {
  const attempted = "2026-11-11T07:00:00Z";
  return { id: uuid(n), workspace_id: context.scope.workspaceId, owner_user_id: context.scope.ownerUserId,
    course_id: context.target.courseId, requirement_key: requirement, skill_label: "span", problem_id: uuid(n + 100),
    item_version_id: uuid(n + 200), attempt_id: uuid(n + 300), submitted_at: attempted, recorded_at: "2026-11-11T07:01:00Z",
    attempt_started_at: attempted, item_created_at: attempted, outcome: "correct", assistance: "independent",
    verdict_source: "deterministic", revision_kind: "original", root_observation_id: null, revises_observation_id: null,
    workspace_history_revision: "8", effective_head_id: uuid(n), attempt_problem_id: uuid(n + 100),
    attempt_item_version_id: uuid(n + 200), attempt_requirement_key: requirement, attempt_submitted_at: attempted,
    attempt_observation_id: uuid(n), item_problem_id: uuid(n + 100), head_observation_id: uuid(n), head_revision: "8",
    input_revision: "9", policy_version: evaluateEvidenceEligibility({}, {}).policyVersion, independent_attempt: "yes",
    verified_correct: "yes", usable_for_current_version: "yes", reason_codes: ["deterministic_correct", "version_exact"],
    version_applicability: "exact", item_matches: true, spec_metadata: spec(), sources_current: true, item_current: true,
    has_course_help: false, answer_conditions: false, has_ai: false, has_conflicting_history: false,
    source_ids: [uuid(900)], source_versions: { [uuid(900)]: 1 } };
}
function realRepositoryFixture(heldOutIds: string[] = []) {
  const trusted = structuredClone(context); trusted.target.requirementKey = requirement;
  trusted.target.excludedProblemIds = heldOutIds;
  trusted.ruleDecision = { activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null };
  const readContext: DbRow = { workspace_id: context.scope.workspaceId, owner_user_id: context.scope.ownerUserId,
    course_id: context.target.courseId, data_as_of: "2026-11-11T08:01:00Z", snapshot_token: "100:100:", revision: "9" };
  const target: DbRow = { id: context.target.itemVersionId, workspace_id: context.scope.workspaceId,
    owner_user_id: context.scope.ownerUserId, course_id: context.target.courseId, problem_id: context.target.problemId,
    target_current: true, target_created_at: "2026-11-11T06:00:00Z", spec_metadata: spec("span-example-2d", "span:independent-2d") };
  const heads: DbRow[] = [dbHead()];
  const bindings: DbRow[] = heldOutIds.map(held_out_id => ({ held_out_id, workspace_id: context.scope.workspaceId,
    owner_user_id: context.scope.ownerUserId, course_id: context.target.courseId, problem_id: uuid(110),
    item_version_id: uuid(210), requirement_key: "other-requirement", item_created_at: "2026-11-11T06:00:00Z",
    resolver_current: true, spec_metadata: spec("span-independent-3d", "span:inconsistent-3d", "other-requirement") }));
  const queries: Array<{ text: string; values: readonly unknown[] }> = [], modes: string[] = [];
  let onQuery: ((number: number) => void) | undefined;
  let queryFailure: { number: number; error: Error } | undefined;
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?"), values });
    onQuery?.(queries.length);
    if (queryFailure?.number === queries.length) throw queryFailure.error;
    if (queries.length === 1) return [readContext];
    if (queries.length === 2) return [target];
    if (queries.length === 3 && heldOutIds.length) return bindings;
    return heads;
  };
  const sql = Object.assign(tag, { begin: async (mode: string, callback: (tx: TransactionSql) => Promise<unknown>) => {
    modes.push(mode); return callback(tag as unknown as TransactionSql);
  } }) as unknown as Sql;
  const host = { resolveAuthenticatedContext: vi.fn(async () => trusted as ExperimentalBktTrustedHostContext | null),
    isCurrent: vi.fn(() => true), canPrepare: vi.fn(() => true), canCompare: vi.fn(() => true) };
  const repository = createOpeningExperimentalBktSnapshotRepository(sql);
  const service = createExperimentalBktSnapshotService({ host, repository });
  return { trusted, readContext, target, heads, bindings, queries, modes, host, repository, service,
    onQuery(fn: (number: number) => void) { onQuery = fn; },
    failQuery(number: number, error: Error) { queryFailure = { number, error }; } };
}

// Five real catalogue problems, intentionally only two families. The frozen
// wrapper threshold is five distinct problems, NOT five distinct families.
function fiveProblems(f: ReturnType<typeof realRepositoryFixture>, correct = true) {
  const identities: Array<[string, string]> = [
    ["span-independent-3d", "span:inconsistent-3d"], ["span-reserved-20261021-q03", "span:inconsistent-3d"],
    ["span-contrast-dependent", "span:dependent-generators"], ["span-simulation-dependent", "span:dependent-generators"],
    ["span-reserved-20261021-q04", "span:dependent-generators"],
  ];
  f.heads.splice(0, f.heads.length, ...identities.map(([problem, family], index) => ({ ...dbHead(10 + index),
    spec_metadata: spec(problem, family), ...(correct ? {} : { outcome: "incorrect", verified_correct: "no",
      reason_codes: ["deterministic_incorrect", "version_exact"] }) })));
}

describe("experimental BKT host snapshot seam", () => {
  it.each([undefined, false])("defaults off without resolving host or repository (%s)", async enabled => {
    const f = fixture();
    expect(await f.service.read({ enabled })).toEqual({ status: "disabled" });
    expect(f.host.resolveAuthenticatedContext).not.toHaveBeenCalled();
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it("requires real host and authenticated context", async () => {
    expect(await createExperimentalBktSnapshotService().read({ enabled: true }))
      .toEqual({ status: "unavailable", reason: "trusted_host_unavailable" });
    const f = fixture(); f.host.resolveAuthenticatedContext.mockResolvedValue(null);
    expect(await f.service.read({ enabled: true })).toEqual({ status: "unavailable", reason: "authenticated_context_unavailable" });
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it("passes only host-resolved scope and exact version target to readonly repo", async () => {
    const f = fixture();
    expect(await f.service.read({ enabled: true })).toMatchObject({ status: "unavailable", reason: "comparison_not_requested" });
    expect(f.repository.read).toHaveBeenCalledExactlyOnceWith(context.scope, context.target);
  });
  it("does not call repo for revoked host or missing repository", async () => {
    const f = fixture(); f.host.isCurrent.mockReturnValue(false);
    expect(await f.service.read({ enabled: true })).toEqual({ status: "unavailable", reason: "host_authorization_revoked" });
    expect(f.repository.read).not.toHaveBeenCalled();
    f.host.isCurrent.mockReturnValue(true);
    expect(await createExperimentalBktSnapshotService({ host: f.host }).read({ enabled: true }))
      .toEqual({ status: "unavailable", reason: "snapshot_repository_unavailable" });
  });
  it("propagates authentication and repository failures by identity", async () => {
    const f = fixture(), error = new Error("boundary failed");
    f.host.resolveAuthenticatedContext.mockRejectedValueOnce(error);
    await expect(f.service.read({ enabled: true })).rejects.toBe(error);
    f.repository.read.mockRejectedValueOnce(error);
    await expect(f.service.read({ enabled: true })).rejects.toBe(error);
  });
  it("checks authorization again after read, never reuses old result", async () => {
    const f = fixture(); f.host.isCurrent.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await f.service.read({ enabled: true })).toEqual({ status: "unavailable", reason: "host_authorization_revoked" });
    expect(await f.service.read()).toEqual({ status: "disabled" });
    expect(f.repository.read).toHaveBeenCalledTimes(1);
  });
  it("abort before auth does not resolve or read", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect(await f.service.read({ enabled: true, signal: controller.signal })).toEqual({ status: "unavailable", reason: "cancelled" });
    expect(f.host.resolveAuthenticatedContext).not.toHaveBeenCalled();
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it.each(["cancel", "disable", "abort"])("discards pending read on %s", async mode => {
    const f = fixture(), pending = deferred<ExperimentalBktSnapshot>(), controller = new AbortController();
    f.repository.read.mockReturnValueOnce(pending.promise);
    const read = f.service.read({ enabled: true, signal: controller.signal });
    await vi.waitFor(() => expect(f.repository.read).toHaveBeenCalledTimes(1));
    if (mode === "cancel") f.service.cancel();
    if (mode === "disable") await f.service.read();
    if (mode === "abort") controller.abort();
    pending.resolve(snapshot());
    expect(await read).toEqual({ status: "unavailable", reason: "cancelled" });
  });
  it("cancels during auth without calling repo", async () => {
    const f = fixture(), pending = deferred<ExperimentalBktTrustedHostContext | null>();
    f.host.resolveAuthenticatedContext.mockReturnValueOnce(pending.promise);
    const read = f.service.read({ enabled: true }); f.service.cancel(); pending.resolve(context);
    expect(await read).toEqual({ status: "unavailable", reason: "cancelled" });
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it("preserves explicit repository unavailable reason, no fake healthy empty", async () => {
    const f = fixture();
    f.repository.read.mockResolvedValue({ ...snapshot(), status: "not_available", reason: "canonical_target_family_unavailable" });
    expect(await f.service.read({ enabled: true })).toEqual({ status: "unavailable", reason: "snapshot:canonical_target_family_unavailable" });
  });
  const invalidCases: Array<[string, (s: ExperimentalBktSnapshot) => void, string]> = [
    ["owner", s => { s.scope.ownerUserId = "other"; }, "snapshot_scope_conflict"],
    ["workspace", s => { s.scope.workspaceId = "other"; }, "snapshot_scope_conflict"],
    ["course", s => { s.scope.courseId = "other"; }, "snapshot_scope_conflict"],
    ["cutoff", s => { s.cutoff = "2026-11-11T07:59:59Z"; }, "snapshot_scope_conflict"],
    ["read version", s => { s.stateVersion = null; }, "snapshot_identity_unavailable"],
    ["asof before cutoff", s => { s.dataAsOf = "2026-11-11T07:59:59Z"; }, "snapshot_identity_unavailable"],
    ["invalid calendar", s => { s.dataAsOf = "2026-02-30T09:00:00Z"; }, "snapshot_identity_unavailable"],
    ["no samples", s => { s.features = []; }, "no_qualified_heads"],
    ["missing head", s => { s.observationHeads = []; }, "snapshot_pair_conflict"],
    ["different head", s => { s.observationHeads[0]!.id = "other"; }, "snapshot_pair_conflict"],
    ["wrong version", s => { s.observationHeads[0]!.itemVersionId = "other"; }, "snapshot_pair_conflict"],
    ["wrong requirement", s => { s.features[0]!.requirementKey = "other"; }, "snapshot_pair_conflict"],
    ["target leakage", s => { s.observationHeads[0]!.problemId = context.target.problemId; }, "snapshot_pair_conflict"],
    ["heldout leakage", s => { s.observationHeads[0]!.problemId = "held-out"; }, "snapshot_pair_conflict"],
    ["missing family", s => { s.families = []; }, "snapshot_pair_conflict"],
    ["unknown family", s => { s.families[0]!.familyId = ""; }, "snapshot_pair_conflict"],
    ["late recorded", s => { s.features[0]!.recordedAt = context.target.cutoff; }, "strict_asof_unavailable"],
    ["missing recorded", s => { s.features[0]!.recordedAt = null; }, "strict_asof_unavailable"],
    ["timezone absent", s => { s.features[0]!.recordedAt = "2026-11-11T07:01:00"; }, "strict_asof_unavailable"],
    ["recorded before attempted", s => { s.features[0]!.recordedAt = "2026-11-11T06:59:59Z"; }, "strict_asof_unavailable"],
    ["head time", s => { s.observationHeads[0]!.attemptedAt = "2026-11-11T07:00:01Z"; }, "strict_asof_unavailable"],
    ["unknown truth", s => { s.features[0]!.eligibility.verifiedCorrect = "unknown"; }, "snapshot_qualification_conflict"],
    ["head truth conflict", s => { s.observationHeads[0]!.verifiedCorrect = "yes"; }, "snapshot_qualification_conflict"],
    ["AI evidence", s => { s.features[0]!.eligibility.reasonCodes = ["ai_feedback"]; }, "snapshot_qualification_conflict"],
    ["help", s => { s.features[0]!.views.push("help"); }, "snapshot_qualification_conflict"],
  ];
  it.each(invalidCases)("rejects %s without partial qualification", async (_name, mutate, reason) => {
    const f = fixture(), value = snapshot(); mutate(value); f.repository.read.mockResolvedValue(value);
    expect(await f.service.read({ enabled: true })).toEqual({ status: "unavailable", reason });
  });
  it("rejects duplicate features/heads/problems/families rather than Map overwriting", async () => {
    const f = fixture(), value = snapshot();
    value.features.push(structuredClone(value.features[0]!));
    value.observationHeads.push(structuredClone(value.observationHeads[0]!));
    value.families.push(structuredClone(value.families[0]!));
    f.repository.read.mockResolvedValue(value);
    expect(await f.service.read({ enabled: true })).toEqual({ status: "unavailable", reason: "snapshot_pair_conflict" });
  });
  it("never combines cached arrays between reads or exposes repository mutation", async () => {
    const f = fixture(), value = snapshot(); f.repository.read.mockResolvedValueOnce(value);
    const first = await f.service.read({ enabled: true });
    expect(first.status).toBe("unavailable");
    value.features.length = 0;
    if (first.status === "unavailable") expect(first.preparation!.snapshot.features).toHaveLength(1);
    f.repository.read.mockResolvedValueOnce(value);
    expect(await f.service.read({ enabled: true })).toEqual({ status: "unavailable", reason: "no_qualified_heads" });
    expect(f.repository.read).toHaveBeenCalledTimes(2);
  });
  it("projects disabled typed provider input from one read, never comparison-ready", async () => {
    const f = fixture(), result = await f.service.read({ enabled: true });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable" || !result.preparation) throw new Error("Expected blocked prepared data");
    expect(result.comparisonReady).toBe(false);
    expect(result.reason).toBe("comparison_not_requested");
    const { qualification } = result.preparation;
    expect(qualification.experiment).toMatchObject({ enabled: false, target: {
      courseId: context.target.courseId, requirementKey: context.target.requirementKey,
      problemId: context.target.problemId, itemVersionId: context.target.itemVersionId }, cutoff: context.target.cutoff,
      excludedProblemIds: context.target.excludedProblemIds });
    expect(qualification.observationHeads[0]!.id).toBe(qualification.experiment.features[0]!.observationId);
    expect(qualification.experiment.features[0]!.eligibility.verifiedCorrect).toBe("no");
  });
  it("drops answers, source bodies/IDs, probabilities and arbitrary extensions", async () => {
    const f = fixture(), value = snapshot();
    Object.assign(value, { answer: "ANSWER_CANARY", probability: 0.77391, sourceBody: "SOURCE_CANARY" });
    Object.assign(value.features[0]!, { answer: "ANSWER_CANARY", sourceBody: "SOURCE_CANARY", p: 0.77391 });
    Object.assign(value.observationHeads[0]!, { answers: "ANSWER_CANARY", sourceText: "SOURCE_CANARY" });
    value.features[0]!.sourceIds = ["SOURCE_ID_CANARY"];
    value.features[0]!.sourceVersions = { SOURCE_ID_CANARY: 1 };
    f.repository.read.mockResolvedValue(value);
    const result = await f.service.read({ enabled: true });
    expect(result.status).toBe("unavailable");
    for (const secret of ["ANSWER_CANARY", "SOURCE_CANARY", "SOURCE_ID_CANARY", "0.77391"]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(value.features[0]!.sourceIds).toEqual(["SOURCE_ID_CANARY"]);
  });
  const ruleDecision = { activityKind: "independent_practice", focusObservationId: null, reasonCode: "independent" } as const;
  it("port defaults false and performs no read or wrapper invocation", async () => {
    const f = fixture(), wrapper = vi.fn<ExperimentalBktSnapshotWrapper>();
    const service = createExperimentalBktSnapshotService({ ...f, ruleDecision, wrapper });
    expect(await service.readPort()).toEqual({ comparisonReady: false, reason: "disabled",
      port: { ruleDecision: { activityKind: ruleDecision.activityKind, reasonCode: ruleDecision.reasonCode },
        status: "disabled", experimentalAdvice: null } });
    expect(f.repository.read).not.toHaveBeenCalled(); expect(wrapper).not.toHaveBeenCalled();
  });
  it.each([true, false])("ignores caller wrapper and uses real R4 priority fallback (%s)", async inject => {
    const f = fixture(), wrapper = vi.fn<ExperimentalBktSnapshotWrapper>(() => { throw new Error("MUST_NOT_RUN_KNOWN_RED"); });
    const service = createExperimentalBktSnapshotService({ ...f, ruleDecision, wrapper: inject ? wrapper : undefined });
    expect(await service.readPort({ enabled: true })).toMatchObject({ comparisonReady: false, reason: "priority_rule",
      port: { status: "fallback", reason: "priority_rule", experimentalAdvice: null } });
    expect(wrapper).not.toHaveBeenCalled(); expect(f.repository.read).toHaveBeenCalledTimes(1);
  });
  it("does not invent host rule/authentication when missing", async () => {
    const f = fixture();
    expect(await f.service.readPort({ enabled: true })).toMatchObject({ comparisonReady: false, port: { status: "fallback" } });
    expect(await createExperimentalBktSnapshotService({ ruleDecision }).readPort({ enabled: true }))
      .toMatchObject({ reason: "trusted_host_unavailable", port: { status: "unavailable", experimentalAdvice: null } });
  });
  it("port propagates repository failures, never converts them to false success", async () => {
    const f = fixture(), failure = new Error("read failed"); f.repository.read.mockRejectedValue(failure);
    const service = createExperimentalBktSnapshotService({ ...f, ruleDecision });
    await expect(service.readPort({ enabled: true })).rejects.toBe(failure);
  });
  it("port rechecks revoke and off, and never reuses earlier advice/data", async () => {
    const f = fixture(), service = createExperimentalBktSnapshotService({ ...f, ruleDecision });
    expect(await service.readPort({ enabled: true })).toMatchObject({ reason: "priority_rule" });
    f.host.isCurrent.mockReturnValue(false);
    expect(await service.readPort({ enabled: true })).toMatchObject({ reason: "host_authorization_revoked", port: { status: "unavailable" } });
    expect(await service.readPort()).toMatchObject({ reason: "disabled", port: { status: "disabled" } });
    expect(f.repository.read).toHaveBeenCalledTimes(1);
  });
  it.each(["cancel", "off", "revoke"])("port drops pending preparation on %s", async mode => {
    const f = fixture(), pending = deferred<ExperimentalBktSnapshot>();
    const service = createExperimentalBktSnapshotService({ ...f, ruleDecision });
    f.repository.read.mockReturnValueOnce(pending.promise);
    const first = service.readPort({ enabled: true });
    await vi.waitFor(() => expect(f.repository.read).toHaveBeenCalledTimes(1));
    if (mode === "cancel") service.cancel();
    if (mode === "off") await service.readPort();
    if (mode === "revoke") f.host.isCurrent.mockReturnValue(false);
    pending.resolve(snapshot());
    expect(await first).toMatchObject({ comparisonReady: false,
      reason: mode === "revoke" ? "host_authorization_revoked" : "cancelled",
      port: { status: "unavailable", experimentalAdvice: null } });
  });
  it("later run supersedes pending read; no cross-run snapshot join", async () => {
    const f = fixture(), pending = deferred<ExperimentalBktSnapshot>();
    f.repository.read.mockReturnValueOnce(pending.promise);
    const first = f.service.read({ enabled: true });
    await vi.waitFor(() => expect(f.repository.read).toHaveBeenCalledTimes(1));
    const second = await f.service.read({ enabled: true });
    expect(second).toMatchObject({ status: "unavailable", reason: "comparison_not_requested" });
    pending.resolve(snapshot());
    expect(await first).toEqual({ status: "unavailable", reason: "cancelled" });
    expect(f.repository.read).toHaveBeenCalledTimes(2);
  });
});

describe("service with exact snapshot R2 repository (typed SQL fake, NOT PG)", () => {
  it("executes three-query no-heldout read and prepares sanitized provider input", async () => {
    const f = realRepositoryFixture();
    const result = await f.service.read({ enabled: true });
    expect(f.modes).toEqual(["isolation level repeatable read read only"]);
    expect(f.queries).toHaveLength(3);
    expect(result).toMatchObject({ status: "unavailable", reason: "comparison_not_requested", comparisonReady: false,
      preparation: { qualification: { dataAsOf: "2026-11-11T08:01:00.000Z", stateVersion: "bkt-read:100:100::9:2026-11-11T08:01:00.000Z",
        experiment: { enabled: false, target: { problemId: context.target.problemId, itemVersionId: context.target.itemVersionId } } } } });
    if (result.status !== "unavailable" || !result.preparation) throw new Error("Expected prepared R2 input");
    expect(result.preparation.qualification.experiment.features.map(row => row.observationId)).toEqual([uuid(10)]);
    expect(result.preparation.qualification.experiment.features[0]!.sourceIds).toEqual([]);
    expect(f.queries[2]!.values).toEqual([context.scope.workspaceId, context.scope.ownerUserId, context.target.courseId, requirement]);
  });
  it.each([uuid(10), uuid(110)])("uses R2 fourth head query after outside-requirement heldout metadata (%s)", async heldout => {
    const f = realRepositoryFixture([heldout]);
    // Only a distinct-family row remains. Held-out need not appear in head rows.
    f.heads.splice(0, 1, { ...dbHead(20), spec_metadata: spec("span-faded-3d", "span:consistent-3d") });
    const result = await f.service.read({ enabled: true });
    expect(f.queries).toHaveLength(4);
    expect(f.queries[2]!.text).toContain("WITH bindings AS");
    expect(f.queries[2]!.values).toEqual([context.scope.workspaceId, context.scope.ownerUserId, context.target.courseId, [heldout],
      context.scope.workspaceId, context.scope.ownerUserId, context.target.courseId, [heldout],
      context.scope.workspaceId, context.scope.ownerUserId, context.target.courseId]);
    expect(f.queries[3]!.values).toEqual([context.scope.workspaceId, context.scope.ownerUserId, context.target.courseId, requirement]);
    expect(result).toMatchObject({ reason: "comparison_not_requested", preparation: { qualification: {
      observationHeads: [{ id: uuid(20) }], experiment: { enabled: false, excludedProblemIds: [heldout] },
    } } });
  });
  it("prepare defaults off and cannot self-grant through the caller flag", async () => {
    const f = realRepositoryFixture();
    expect(await f.service.prepare()).toEqual({ status: "disabled" });
    expect(f.queries).toHaveLength(0);
    f.host.canPrepare.mockReturnValue(false);
    expect(await f.service.prepare({ enabled: true })).toEqual({ status: "unavailable", reason: "host_prepare_not_authorized" });
    expect(f.queries).toHaveLength(0);
  });
  it("missing host prepare capability is unavailable, not an implicit grant", async () => {
    const f = realRepositoryFixture();
    const host = { resolveAuthenticatedContext: f.host.resolveAuthenticatedContext, isCurrent: f.host.isCurrent };
    const service = createExperimentalBktSnapshotService({ host, repository: f.repository });
    expect(await service.prepare({ enabled: true })).toEqual({ status: "unavailable", reason: "host_prepare_not_authorized" });
    expect(f.queries).toHaveLength(0);
  });
  it("prepares explicitly host-authorized input but keeps experiment disabled", async () => {
    const f = realRepositoryFixture();
    const result = await f.service.prepare({ enabled: true });
    expect(result).toMatchObject({ status: "unavailable", reason: "comparison_not_requested", comparisonReady: false,
      preparation: { mode: "read_only", authorization: "host_checked", qualification: { experiment: { enabled: false } } } });
    expect(f.host.canPrepare).toHaveBeenCalledTimes(3);
    expect(f.host.canPrepare).toHaveBeenNthCalledWith(1, f.trusted);
    expect(f.host.canPrepare).toHaveBeenNthCalledWith(2, f.trusted);
  });
  it("revoking prepare grant during repository IO drops all prepared data", async () => {
    const f = realRepositoryFixture(); f.onQuery(n => { if (n === 3) f.host.canPrepare.mockReturnValue(false); });
    expect(await f.service.prepare({ enabled: true })).toEqual({ status: "unavailable", reason: "host_prepare_not_authorized" });
    expect(f.queries).toHaveLength(3);
  });
  it("host prepare checker errors propagate, without touching repository", async () => {
    const f = realRepositoryFixture(), error = new Error("host authorization unavailable");
    f.host.canPrepare.mockImplementation(() => { throw error; });
    await expect(f.service.prepare({ enabled: true })).rejects.toBe(error);
    expect(f.queries).toHaveLength(0);
  });
  it("does not invent authentication merely because the repository is approved", async () => {
    const f = realRepositoryFixture(); f.host.resolveAuthenticatedContext.mockResolvedValue(null);
    expect(await f.service.prepare({ enabled: true })).toEqual({ status: "unavailable", reason: "authenticated_context_unavailable" });
    expect(f.host.canPrepare).not.toHaveBeenCalled(); expect(f.queries).toHaveLength(0);
    expect(await createExperimentalBktSnapshotService({ repository: f.repository }).prepare({ enabled: true }))
      .toEqual({ status: "unavailable", reason: "trusted_host_unavailable" });
  });
  it.each([uuid(10), uuid(110)])("real R2 excludes all heldout-family siblings for ID %s", async heldout => {
    const f = realRepositoryFixture([heldout]);
    f.heads.push({ ...dbHead(20), spec_metadata: spec("span-reserved-20261021-q03", "span:inconsistent-3d") },
      { ...dbHead(30), spec_metadata: spec("span-faded-3d", "span:consistent-3d") });
    const result = await f.service.prepare({ enabled: true });
    expect(result).toMatchObject({ reason: "comparison_not_requested", preparation: { qualification: {
      observationHeads: [{ id: uuid(30) }], experiment: { enabled: false, features: [{ observationId: uuid(30) }] },
    } } });
    expect(f.queries).toHaveLength(4);
  });
  it.each([uuid(10), uuid(110)])("excludes sibling even when heldout %s is absent from effective-head/requirement query", async heldout => {
    const f = realRepositoryFixture([heldout]);
    f.heads.splice(0, 1, { ...dbHead(20), spec_metadata: spec("span-reserved-20261021-q03", "span:inconsistent-3d") });
    expect(await f.service.prepare({ enabled: true })).toEqual({ status: "unavailable", reason: "snapshot:no_qualified_heads" });
    expect(f.queries).toHaveLength(4);
    expect(f.queries[2]!.text).not.toContain("effective_head_id");
    expect(f.bindings[0]!.requirement_key).not.toBe(requirement);
  });
  it.each([
    ["late recording", { recorded_at: context.target.cutoff }],
    ["equal attempted cutoff", { submitted_at: context.target.cutoff, attempt_submitted_at: context.target.cutoff }],
    ["reverse times", { recorded_at: "2026-11-11T06:59:59Z" }],
    ["missing recording", { recorded_at: null }],
    ["timezone absent", { recorded_at: "2026-11-11T07:01:00" }],
  ] satisfies Array<[string, DbRow]>)("real repo two-time exclusion: %s", async (_name, patch) => {
    const f = realRepositoryFixture(); Object.assign(f.heads[0]!, patch);
    expect(await f.service.prepare({ enabled: true })).toEqual({ status: "unavailable", reason: "snapshot:no_qualified_heads" });
    expect(f.queries).toHaveLength(3);
  });
  it("equal attempted/recorded strictly before cutoff is valid negative evidence", async () => {
    const f = realRepositoryFixture();
    Object.assign(f.heads[0]!, { recorded_at: f.heads[0]!.submitted_at, outcome: "incorrect", verified_correct: "no",
      reason_codes: ["deterministic_incorrect", "version_exact"] });
    const result = await f.service.prepare({ enabled: true });
    expect(result).toMatchObject({ reason: "comparison_not_requested", preparation: { qualification: {
      experiment: { enabled: false, features: [{ outcome: "incorrect", eligibility: { verifiedCorrect: "no" } }] },
      observationHeads: [{ verifiedCorrect: "no" }],
    } } });
  });
  it.each([
    ["stale global revision", { input_revision: "8" }],
    ["head revision mismatch", { head_revision: "7" }],
    ["current privacy excludes source", { sources_current: false }],
    ["source currentness unknown", { sources_current: null }],
    ["item changed", { item_current: false }],
    ["help present", { has_course_help: true }],
    ["AI present", { has_ai: true }],
  ] satisfies Array<[string, DbRow]>)("strict current-MVCC projection rejects %s", async (_name, patch) => {
    const f = realRepositoryFixture(); Object.assign(f.heads[0]!, patch);
    expect(await f.service.prepare({ enabled: true })).toEqual({ status: "unavailable", reason: "snapshot:no_qualified_heads" });
  });
  it("future cutoff stops after context read, no metadata or heads", async () => {
    const f = realRepositoryFixture(); f.readContext.data_as_of = "2026-11-11T07:59:59Z";
    expect(await f.service.prepare({ enabled: true })).toEqual({ status: "unavailable", reason: "snapshot:snapshot_unavailable" });
    expect(f.queries).toHaveLength(1);
  });
  it.each([false, null])("heldout privacy/currentness %s fails closed before head read", async current => {
    const f = realRepositoryFixture([uuid(110)]); f.bindings[0]!.resolver_current = current;
    expect(await f.service.prepare({ enabled: true })).toEqual({ status: "unavailable", reason: "snapshot:held_out_family_unavailable" });
    expect(f.queries).toHaveLength(3);
  });
  it("privacy-safe successful prepare never returns source IDs/body/answers/p or compares", async () => {
    const f = realRepositoryFixture();
    Object.assign(f.heads[0]!, { answer: "ANSWER_CANARY", source_body: "BODY_CANARY", probability: 0.734192 });
    const result = await f.service.prepare({ enabled: true });
    expect(result).toMatchObject({ status: "unavailable", reason: "comparison_not_requested", comparisonReady: false,
      preparation: { mode: "read_only", qualification: { experiment: { enabled: false } } } });
    for (const secret of ["ANSWER_CANARY", "BODY_CANARY", "0.734192", uuid(900)]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(f.queries.every(query => !/\b(?:INSERT|UPDATE|DELETE)\b/i.test(query.text))).toBe(true);
    expect(f.queries.every(query => !/SELECT\s+\*|\bo\.\*|\bv\.answer\b|source_body|body_text/i.test(query.text))).toBe(true);
  });
  it.each([1, 2, 3, 4])("real R2 SQL tag error at query %i propagates by identity, no fake comparison", async number => {
    const f = realRepositoryFixture([uuid(110)]), error = new Error(`query-${number}-failed`);
    f.failQuery(number, error);
    await expect(f.service.prepare({ enabled: true })).rejects.toBe(error);
    expect(f.queries).toHaveLength(number);
  });
  it.each(["session", "prepare", "cancel", "abort"])("drops real R2 read output on %s revocation", async mode => {
    const f = realRepositoryFixture(), controller = new AbortController();
    f.onQuery(number => {
      if (number !== 3) return;
      if (mode === "session") f.host.isCurrent.mockReturnValue(false);
      if (mode === "prepare") f.host.canPrepare.mockReturnValue(false);
      if (mode === "cancel") f.service.cancel();
      if (mode === "abort") controller.abort();
    });
    expect(await f.service.prepare({ enabled: true, signal: controller.signal })).toEqual({ status: "unavailable",
      reason: mode === "session" ? "host_authorization_revoked" : mode === "prepare" ? "host_prepare_not_authorized" : "cancelled" });
    expect(f.queries).toHaveLength(3);
  });
  it("prepared results are owned, but new prepare uses a fresh transaction, never cached proof", async () => {
    const f = realRepositoryFixture();
    const result = await f.service.prepare({ enabled: true });
    if (result.status !== "unavailable" || !result.preparation) throw new Error("Expected preparation");
    result.preparation.qualification.experiment.features[0]!.eligibility.verifiedCorrect = "unknown";
    expect(f.heads[0]!.verified_correct).toBe("yes");
    // Another host read cannot reuse previous evidence after session invalidation.
    f.host.isCurrent.mockReturnValue(false);
    expect(await f.service.prepare({ enabled: true })).toEqual({ status: "unavailable", reason: "host_authorization_revoked" });
    expect(f.modes).toHaveLength(1);
  });
  it("real R2 readPort returns real R4 insufficient fallback, ignoring injected substitute", async () => {
    const f = realRepositoryFixture(), wrapper = vi.fn<ExperimentalBktSnapshotWrapper>(() => { throw new Error("UNAPPROVED_WRAPPER"); });
    const ruleDecision = { activityKind: "independent_practice", focusObservationId: uuid(10), reasonCode: "independent" } as const;
    const service = createExperimentalBktSnapshotService({ host: f.host, repository: f.repository, wrapper, ruleDecision });
    expect(await service.readPort({ enabled: true })).toEqual({ comparisonReady: false, reason: "insufficient_samples",
      port: { ruleDecision: { activityKind: "transfer_check", reasonCode: "independent" }, status: "fallback", reason: "insufficient_samples", experimentalAdvice: null } });
    expect(wrapper).not.toHaveBeenCalled(); expect(f.queries).toHaveLength(3);
  });
  it("constructs R4 rule input from host controls and same-read sanitized heads only", async () => {
    const f = realRepositoryFixture();
    f.trusted.ruleInput = { status: "observed_independent", wantsFullExplanation: false, dueRetest: true };
    Object.assign(f.trusted.ruleInput, { observations: [{ id: "CLIENT_HEAD_CANARY" }], privateBody: "PRIVATE_CONTROL_CANARY" });
    const result = await f.service.prepare({ enabled: true });
    if (result.status !== "unavailable" || !result.preparation) throw new Error("Expected preparation");
    const input = result.preparation.qualification.ruleInput;
    expect(input).toMatchObject({ status: "observed_independent", wantsFullExplanation: false, dueRetest: true,
      observations: [{ id: uuid(10), itemVersionId: uuid(210), attemptedAt: "2026-11-11T07:00:00.000Z" }] });
    expect(input!.observations).toEqual(result.preparation.qualification.observationHeads);
    expect(result.preparation.qualification.experiment.features[0]!.attemptedAt).toBe(input!.observations[0]!.attemptedAt);
    expect(JSON.stringify(result)).not.toContain("CLIENT_HEAD_CANARY");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CONTROL_CANARY");
  });
  it("missing host rule controls do not synthesize a ready rule input", async () => {
    const f = realRepositoryFixture(); delete f.trusted.ruleInput;
    const result = await f.service.prepare({ enabled: true });
    if (result.status !== "unavailable" || !result.preparation) throw new Error("Expected preparation");
    expect(result.preparation.qualification.ruleInput).toBeUndefined();
    expect(result.preparation.qualification.experiment.enabled).toBe(false);
  });
  it("five different problems in only two families reach real R4 and port, high p retains rule", async () => {
    const f = realRepositoryFixture(); fiveProblems(f);
    const before = structuredClone(f.heads), result = await f.service.readPort({ enabled: true });
    expect(result).toEqual({ comparisonReady: true, reason: "compared", port: { status: "compared",
      ruleDecision: { activityKind: "transfer_check", reasonCode: "independent" }, experimentalAdvice: { kind: "continue_rule" } } });
    expect(f.heads).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/probability|stateVersion|observation|source|problemId|itemVersion|mastery|promotion/);
    expect(f.queries).toHaveLength(3);
  });
  it("real low-p comparison only suggests support and never changes rule authority", async () => {
    const f = realRepositoryFixture(); fiveProblems(f, false);
    // A recent independent success leaves an otherwise error-heavy model eligible
    // for comparison; rule still comes from same-read latest-first heads.
    Object.assign(f.heads[4]!, { submitted_at: "2026-11-11T07:02:00Z", attempt_submitted_at: "2026-11-11T07:02:00Z",
      recorded_at: "2026-11-11T07:03:00Z", outcome: "correct", verified_correct: "yes", reason_codes: ["deterministic_correct", "version_exact"] });
    const result = await f.service.readPort({ enabled: true });
    expect(result.port?.ruleDecision).toEqual({ activityKind: "transfer_check", reasonCode: "independent" });
    expect(result.port?.status).toBe("compared");
    // Low-p support is advisory; the authoritative rule is unchanged above.
    expect(result.port?.experimentalAdvice).toEqual({ kind: "supported_practice" });
  });
  it.each(["dueRetest", "wantsFullExplanation", "learningPhase"])("real R4 keeps priority control %s above high-p advice", async key => {
    const f = realRepositoryFixture(); fiveProblems(f);
    f.trusted.ruleInput = { status: "observed_independent", wantsFullExplanation: key === "wantsFullExplanation",
      ...(key === "dueRetest" ? { dueRetest: true } : {}), ...(key === "learningPhase" ? { learningPhase: "new_learning" } : {}) };
    f.trusted.ruleDecision = key === "dueRetest"
      ? { activityKind: "transfer_check", reasonCode: "due_retest", focusObservationId: null, phase: "maintain", phaseSource: "automatic" }
      : { activityKind: "full_explain", reasonCode: "requested_full", focusObservationId: null,
        ...(key === "learningPhase" ? { phase: "new_learning", phaseSource: "explicit" } : {}) };
    const result = await f.service.readPort({ enabled: true });
    expect(result).toMatchObject({ comparisonReady: false, reason: "priority_rule", port: { status: "fallback", experimentalAdvice: null } });
    if (key !== "dueRetest") expect(result.port?.ruleDecision.activityKind).toBe("full_explain");
  });
  it.each([uuid(10), uuid(110)])("real composition excludes heldout-family siblings before threshold (%s)", async heldout => {
    const f = realRepositoryFixture([heldout]); fiveProblems(f);
    expect(await f.service.readPort({ enabled: true })).toMatchObject({ comparisonReady: false, reason: "insufficient_samples",
      port: { status: "fallback", experimentalAdvice: null } });
    expect(f.queries).toHaveLength(4);
  });
  it("real composition excludes target family and cannot fake fifth sample", async () => {
    const f = realRepositoryFixture(); fiveProblems(f);
    f.target.spec_metadata = spec("span-independent-3d", "span:inconsistent-3d");
    expect(await f.service.readPort({ enabled: true })).toMatchObject({ reason: "insufficient_samples", port: { status: "fallback" } });
  });
  it.each([false, true])("duplicate head in real repo path cannot qualify threshold (reverse=%s)", async reverse => {
    const f = realRepositoryFixture(); fiveProblems(f);
    const duplicate = { ...f.heads[0]!, has_ai: true };
    f.heads.push(duplicate); if (reverse) f.heads.reverse();
    expect(await f.service.readPort({ enabled: true })).toMatchObject({ comparisonReady: false, reason: "insufficient_samples" });
  });
  it("ignores private target getters on successful real repo/wrapper/port path", async () => {
    const f = realRepositoryFixture(); fiveProblems(f);
    const getter = vi.fn(() => { throw new Error("PRIVATE_TARGET_GETTER"); });
    Object.defineProperty(f.trusted.target, "answer", { enumerable: true, get: getter });
    Object.defineProperty(f.trusted.target, "sourceBody", { enumerable: true, get: getter });
    const result = await f.service.readPort({ enabled: true });
    expect(result.port?.status).toBe("compared"); expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TARGET_GETTER");
  });
  it("private rule-control getter is never spread into wrapper input", async () => {
    const f = realRepositoryFixture(); fiveProblems(f);
    const getter = vi.fn(() => { throw new Error("PRIVATE_RULE_GETTER"); });
    Object.defineProperty(f.trusted.ruleInput!, "answerSource", { enumerable: true, get: getter });
    expect((await f.service.readPort({ enabled: true })).port?.status).toBe("compared");
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["missing", "false", "rule"])("missing host comparison authority %s stops before repo", async mode => {
    const f = realRepositoryFixture(); fiveProblems(f);
    if (mode === "rule") delete f.trusted.ruleInput;
    if (mode === "false") f.host.canCompare.mockReturnValue(false);
    const host = mode === "missing" ? { resolveAuthenticatedContext: f.host.resolveAuthenticatedContext,
      isCurrent: f.host.isCurrent, canPrepare: f.host.canPrepare } : f.host;
    const service = createExperimentalBktSnapshotService({ host, repository: f.repository });
    expect(await service.readPort({ enabled: true })).toMatchObject({ comparisonReady: false,
      reason: mode === "rule" ? "host_rule_input_unavailable" : "host_comparison_not_authorized", port: null });
    expect(f.queries).toHaveLength(0);
  });
  it.each(["session", "prepare", "compare"])("drops actual completed wrapper result when %s revokes in wrapper", async mode => {
    const f = realRepositoryFixture(); fiveProblems(f);
    const original = realWrapper.nextLearningStepWithExperimentalBkt;
    const spy = vi.spyOn(realWrapper, "nextLearningStepWithExperimentalBkt").mockImplementation((input, experiment) => {
      const result = original(input, experiment);
      if (mode === "session") f.host.isCurrent.mockReturnValue(false);
      if (mode === "prepare") f.host.canPrepare.mockReturnValue(false);
      if (mode === "compare") f.host.canCompare.mockReturnValue(false);
      return result;
    });
    try {
      expect(await f.service.readPort({ enabled: true })).toMatchObject({ comparisonReady: false, port: null,
        reason: mode === "session" ? "host_authorization_revoked" : mode === "prepare" ? "host_prepare_not_authorized" : "host_comparison_not_authorized" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
  it("host complete-rule conflict prevents a filtered subset from bypassing error priority", async () => {
    const f = realRepositoryFixture(); fiveProblems(f);
    f.trusted.ruleDecision = { activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: "filtered-error" };
    const spy = vi.spyOn(realWrapper, "nextLearningStepWithExperimentalBkt");
    try {
      expect(await f.service.readPort({ enabled: true })).toMatchObject({ comparisonReady: false, reason: "host_rule_context_conflict", port: null });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it("missing authoritative host decision stays unavailable before repo", async () => {
    const f = realRepositoryFixture(); delete f.trusted.ruleDecision;
    expect(await f.service.readPort({ enabled: true })).toMatchObject({ reason: "host_rule_input_unavailable", port: null });
    expect(f.queries).toHaveLength(0);
  });
  it("real component SSR stays default off and displays no private comparison payload", async () => {
    const f = realRepositoryFixture(); fiveProblems(f);
    const result = await f.service.readPort({ enabled: true });
    if (!result.port) throw new Error("Expected port");
    const html = renderToStaticMarkup(createElement(ExperimentalLearningAdvice, { advice: result.port }));
    expect(html).toContain("查看未校准实验建议");
    expect(html).toContain("实验展示默认关闭");
    expect(html).toContain("规则建议 · 当前使用");
    expect(html).not.toContain("checked");
    for (const id of [uuid(10), uuid(110), uuid(210), uuid(900), context.scope.ownerUserId]) expect(html).not.toContain(id);
    expect(html).not.toMatch(/probability|stateVersion|sourceBody|answerSource/);
  });
  it.each(["session", "prepare", "compare"])("revocation after repository IO (%s) prevents wrapper call", async mode => {
    const f = realRepositoryFixture(); fiveProblems(f);
    f.onQuery(number => {
      if (number !== 3) return;
      if (mode === "session") f.host.isCurrent.mockReturnValue(false);
      if (mode === "prepare") f.host.canPrepare.mockReturnValue(false);
      if (mode === "compare") f.host.canCompare.mockReturnValue(false);
    });
    const spy = vi.spyOn(realWrapper, "nextLearningStepWithExperimentalBkt");
    try {
      expect(await f.service.readPort({ enabled: true })).toMatchObject({ comparisonReady: false, port: null,
        reason: mode === "session" ? "host_authorization_revoked" : mode === "prepare" ? "host_prepare_not_authorized" : "host_comparison_not_authorized" });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it("cancel during actual synchronous wrapper invalidates the completed comparison", async () => {
    const f = realRepositoryFixture(); fiveProblems(f);
    const original = realWrapper.nextLearningStepWithExperimentalBkt;
    const spy = vi.spyOn(realWrapper, "nextLearningStepWithExperimentalBkt").mockImplementation((input, experiment) => {
      const result = original(input, experiment); f.service.cancel(); return result;
    });
    try { expect(await f.service.readPort({ enabled: true })).toMatchObject({ comparisonReady: false, reason: "cancelled", port: null }); }
    finally { spy.mockRestore(); }
  });
  it("real wrapper exception propagates by identity; no fake fallback", async () => {
    const f = realRepositoryFixture(); fiveProblems(f); const error = new Error("wrapper boundary failed");
    const spy = vi.spyOn(realWrapper, "nextLearningStepWithExperimentalBkt").mockImplementation(() => { throw error; });
    try { await expect(f.service.readPort({ enabled: true })).rejects.toBe(error); }
    finally { spy.mockRestore(); }
  });
  it("comparison permission checker exception propagates without repo access", async () => {
    const f = realRepositoryFixture(), error = new Error("permission read failed");
    f.host.canCompare.mockImplementation(() => { throw error; });
    await expect(f.service.readPort({ enabled: true })).rejects.toBe(error);
    expect(f.queries).toHaveLength(0);
  });
  it("real wrapper is not called while off or grant missing", async () => {
    const f = realRepositoryFixture(), spy = vi.spyOn(realWrapper, "nextLearningStepWithExperimentalBkt");
    try {
      await f.service.readPort(); f.host.canCompare.mockReturnValue(false); await f.service.readPort({ enabled: true });
      expect(spy).not.toHaveBeenCalled(); expect(f.queries).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
  it("unresolved heldout metadata stops before heads with explicit unavailable", async () => {
    const f = realRepositoryFixture([uuid(110)]); f.bindings.length = 0;
    expect(await f.service.read({ enabled: true })).toEqual({ status: "unavailable", reason: "snapshot:held_out_family_unavailable" });
    expect(f.queries).toHaveLength(3);
  });
});
