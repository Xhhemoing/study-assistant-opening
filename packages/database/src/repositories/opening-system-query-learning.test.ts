import type { TransactionSql } from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as domain from "@aistudy/domain";
import { buildDecisionInput, nextLearningStep, toSnapshotEvidence, type ObservationEligibilityInput } from "@aistudy/domain";
import { learningObservation, qualifiedInput } from "../../../domain/src/opening/learning-summary-fixtures";
import { readSystemLearningQuery } from "./opening-system-query-learning";
import { mapLearningObservation } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { readSystemQueryAncestry } from "./opening-system-query-admission";
import type { OpeningSystemQueryDraft } from "./opening-system-query";

vi.mock("./opening-learning-eligibility", () => ({ openingEligibilityStateQuery: vi.fn(), openingEligibilityPolicyVersion: () => "test" }));
vi.mock("./opening-learning-evidence-context", () => ({ readOpeningLearningEvidenceContexts: vi.fn() }));
vi.mock("./opening-system-query-admission", () => ({ readSystemQueryAncestry: vi.fn() }));
const scope = { workspaceId: learningObservation.workspaceId, ownerUserId: "22222222-2222-4222-8222-222222222222" };
function row(id: string, time: number, extra: Record<string, unknown> = {}) {
  return { id, current_root_id: id, workspace_id: scope.workspaceId, course_id: learningObservation.courseId, skill_label: "fractions",
    answer: "1/2", assistance: "independent", outcome: "correct", verdict_source: "reference_checked", problem_id: "problem-1",
    occurred_at: new Date(time), submitted_at: new Date(time), fresh: true, version_applicability: "exact", ...extra };
}
function input(time: number, extra: Partial<ObservationEligibilityInput> = {}): ObservationEligibilityInput {
  return { observation: { ...qualifiedInput.observation, requirementKey: null, submittedAt: time }, context: qualifiedInput.context, ...extra };
}
function draft(): OpeningSystemQueryDraft {
  return { name: "recommendation", status: "ok", reason: "read", asOf: new Date().toISOString(), version: "test", data: [], evidence: [], sourceRefs: [], nextOffset: null,
    authorization: { workspaceId: scope.workspaceId, principalId: scope.ownerUserId, role: "workspace_owner", purpose: "source_review", permissionRevision: "epoch:0" } };
}
async function read(rows: ReturnType<typeof row>[], contexts: Record<string, ObservationEligibilityInput>, limit = 10) {
  const out = draft();
  vi.mocked(readOpeningLearningEvidenceContexts).mockResolvedValue(contexts);
  vi.mocked(readSystemQueryAncestry).mockResolvedValue({ complete: true, admitted: new Map(rows.map(r => [r.id, []])) });
  const tx = vi.fn().mockResolvedValueOnce([{ id: learningObservation.courseId }]).mockResolvedValueOnce(rows);
  await readSystemLearningQuery(tx as unknown as TransactionSql, scope,
    { name: "recommendation", arguments: { courseId: learningObservation.courseId, limit, offset: 0 } }, out, limit, 0);
  return out;
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
describe("system recommendation canonical evidence input", () => {
  it("uses latest usable status instead of the all-history legacy summary", async () => {
    const rows = [row("new", 301), row("old", 300)];
    const contexts = { new: input(301), old: input(300, { context: { ...qualifiedInput.context, helpHistory: { complete: false, exposures: [] } } }) };
    const out = await read(rows, contexts);
    const expected = { activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null };
    expect(out.data[0]?.step).toEqual(expected);
    const projected = toSnapshotEvidence({ observations: rows.map(mapLearningObservation), evidenceContexts: contexts }, new Date());
    expect(projected.summaries[0]?.status).toBe("needs_check");
    expect(nextLearningStep(buildDecisionInput({ observations: projected.observations, wantsFullExplanation: false }))).toEqual(expected);
    expect(out.data[0]?.limitations).toEqual(["未读取复测到期状态或教学策略编译结果", "不是已保存或已接受的计划"]);
  });

  it.each([false, true])("sorts by captured attempt time then ID, not query row/revision order (tie=%s)", async tie => {
    // Query rows appear newest by persisted submitted_at. The captured fact time
    // is authoritative, and equal captured times use ascending IDs.
    const rows = [row("z", 900), row("a", 100)];
    const contexts = { z: input(tie ? 300 : 299, { observation: { ...qualifiedInput.observation, requirementKey: null, submittedAt: tie ? 300 : 299, outcome: "incorrect" },
      context: { ...qualifiedInput.context, referenceCheck: { ...qualifiedInput.context.referenceCheck!, outcome: "incorrect" } } }), a: input(300) };
    const out = await read(rows, contexts);
    expect(out.data[0]?.step).toEqual({ activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null });
    expect(out.data[0]?.evidenceIds).toEqual(["z", "a"]); // Public record references retain their existing order.
  });

  it("preserves requirement and exact display-label grouping while using the shared projection", async () => {
    const rows = [row("first", 300), row("alias", 301, { skill_label: "ＦＲＡＣＴＩＯＮＳ" }), row("other", 302)];
    const contexts = { first: input(300), alias: input(301), other: input(302, {
      observation: { ...qualifiedInput.observation, requirementKey: "other", submittedAt: 302, verdictSource: "self_report" },
    }) };
    const out = await read(rows, contexts);
    expect(out.data).toHaveLength(3);
    expect(out.data.find(r => (r.evidenceIds as string[]).includes("other"))?.step)
      .toEqual({ activityKind: "diagnose", reasonCode: "unverified_only", focusObservationId: null });
    expect(out.data.filter(r => !(r.evidenceIds as string[]).includes("other")).every(r =>
      (r.step as { reasonCode: string }).reasonCode === "independent")).toBe(true);
  });

  it("retains verified repeated step errors and excludes them when version qualification is lost", async () => {
    const contexts: Record<string, ObservationEligibilityInput> = {};
    const rows = ["newer", "older"].map((id, index) => {
      const time = 301 - index;
      const evaluation = { observationId: id, attemptId: "attempt-2", problemId: "problem-1", itemVersionId: "version-1",
        requirementKey: "span:v1", evaluatorVersion: "span-exact-v1" as const, specVersion: "span-v1" as const,
        outcome: "incorrect" as const, decision: "incorrect" as const, reasonCodes: ["incorrect"], evaluatedAt: new Date(time).toISOString(),
        coreEvidenceComplete: false, skills: { coefficients: "incorrect" as const } };
      contexts[id] = input(time, { observation: { ...qualifiedInput.observation, observationId: id, requirementKey: "span:v1",
        submittedAt: time, verdictSource: "deterministic", outcome: "incorrect", assistance: "hinted" },
      context: { ...qualifiedInput.context, serverEvaluation: evaluation, helpHistory: { complete: true, exposures: [
        { attemptId: "attempt-2", problemId: "problem-1", delivered: true, deliveredAt: 250, level: "hinted" },
      ] } } });
      return row(id, time, { outcome: "incorrect", verdict_source: "deterministic", assistance: "hinted", server_evaluation: evaluation });
    });
    expect((await read(rows, contexts)).data[0]?.step)
      .toEqual({ activityKind: "full_explain", reasonCode: "repeated_assisted_error", focusObservationId: "newer" });
    contexts.older!.context = { ...contexts.older!.context, version: { applicability: "unavailable" } };
    expect((await read(rows, contexts)).data[0]?.step)
      .toEqual({ activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: "newer" });
  });

  it("displays the historical v3 reason without enabling its policy writer", async () => {
    vi.spyOn(domain, "nextLearningStep").mockReturnValueOnce({ activityKind: "reduced_help_practice",
      reasonCode: "assisted_success", focusObservationId: null } as never);
    const out = await read([row("helped", 301)], { helped: input(301) });
    expect(out.data[0]?.step).toMatchObject({ reasonCode: "assisted_success" });
    expect(out.data[0]?.summary).toContain("最近一次在获得帮助后答对，接下来减少帮助练习");
    expect(domain.NEXT_LEARNING_STEP_VERSION).toBe("next-learning-step-2");
  });

  it.each([0, 1, 2])("uses the v2 rule after %i independent successes", async priorChecks => {
    for (const assistance of ["hinted", "revealed"] as const) {
      const rows = [row("helped", 301), ...Array.from({ length: priorChecks }, (_, i) => row(`prior-${i}`, 300 - i))];
      const contexts = Object.fromEntries(rows.map((r, i) => [r.id, input(301 - i)]));
      contexts.helped = input(301, { observation: { ...qualifiedInput.observation, requirementKey: null, submittedAt: 301, assistance },
        context: { ...qualifiedInput.context, helpHistory: { complete: true, exposures: [
          { attemptId: "attempt-2", problemId: "problem-1", delivered: true, deliveredAt: 250, level: assistance },
        ] } } });
      const out = await read(rows, contexts);
      expect(out.data[0]?.step).toEqual({ activityKind: priorChecks === 0 ? "reduced_help_practice" : "diagnose",
        reasonCode: priorChecks === 0 ? "assistance_dependent" : "needs_check", focusObservationId: null });
      contexts.helped.context = { ...contexts.helped.context, version: { applicability: "unavailable" } };
      expect((await read(rows, contexts)).data[0]?.step).not.toMatchObject({ reasonCode: "assisted_success" });
    }
  });

  it("leaves unqualified legacy identity unknown and does not invent a usable observation", async () => {
    const out = await read([row("legacy", 300)], { legacy: { observation: { courseId: learningObservation.courseId,
      assistance: "independent", outcome: "correct", verdictSource: "reference_checked" }, context: {} } });
    expect(out.data[0]?.step).toEqual({ activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null });
  });

  it.each(["stale", "truncated"])("keeps the incomplete evidence refusal (%s)", async incomplete => {
    const rows = [row("first", 301), row("second", 300, incomplete === "stale" ? { fresh: false } : {})];
    const out = await read(rows, { first: input(301), second: input(300) }, incomplete === "truncated" ? 1 : 10);
    expect(out.data).toEqual([{ summary: expect.any(String), recommendationStatus: "unknown" }]);
    expect(out.data[0]).not.toHaveProperty("step");
  });
});
