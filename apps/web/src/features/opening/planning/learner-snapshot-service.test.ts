import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { nextLearningStep, type CourseEvidence, type EvidenceHelpExposure, type LearnerSnapshotSources } from "@aistudy/domain";
import {
  createLearnerSnapshotService,
  toSnapshotEvidence,
  toSnapshotKnowledgeNodes,
  toSnapshotTaskRow,
  type LearnerSnapshotDeps,
} from "./learner-snapshot-service";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const courseId = "33333333-3333-4333-8333-333333333333";

function deps(overrides: Partial<LearnerSnapshotDeps> = {}): LearnerSnapshotDeps {
  return {
    readBase: async () => ({
      courses: [{ courseId, title: "线代", hasUsableMaterials: true, knowledgeSnapshot: null }],
      tasks: [],
    }),
    readCourseEvidence: async () => ({ observations: [], evidenceContexts: {} }),
    readAdaptivePrefs: async () => ({
      prefs: { ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoals: { [courseId]: { targetDate: null, weeklyMinutes: 120 } } },
      saved: true,
      invalidStoredPrefs: false,
    }),
    countDueCards: async () => 12,
    assembleSnapshot: (sources: LearnerSnapshotSources) => ({
      date: sources.date, timeZone: sources.timeZone, courses: [], dueCardCount: sources.dueCardCount, plannerHistory: [],
    }),
    now: () => new Date("2026-10-15T02:00:00Z"),
    ...overrides,
  };
}

const read = (overrides: Partial<LearnerSnapshotDeps> = {}) =>
  createLearnerSnapshotService(deps(overrides)).read(scope, { date: "2026-10-15", timeZone: "Asia/Shanghai" });

describe("learner snapshot service", () => {
  it("passes goals and due cards through when every read succeeds", async () => {
    const result = await read();
    expect(result.sources.courses[0]).toMatchObject({ goal: { weeklyMinutes: 120 }, evidenceStatus: "available" });
    expect(result.sources.dueCardCount).toBe(12);
    expect(result.dataStatus).toEqual({ evidence: "available", goals: "available", dueCards: "available" });
    expect(result.autonomy).toBe("copilot");
  });

  it("degrades unreadable goals and due cards to unknown instead of failing the plan", async () => {
    const onReadFailure = vi.fn();
    const result = await read({
      onReadFailure,
      readAdaptivePrefs: async () => { throw new Error("prefs down"); },
      countDueCards: async () => { throw new Error("cards down"); },
    });
    expect(result.sources.courses[0]!.goal).toBeNull();
    expect(result.sources.dueCardCount).toBe(0);
    expect(result.dataStatus).toMatchObject({ goals: "unavailable", dueCards: "unavailable" });
    expect(result.autonomy).toBe("manual");
    expect(onReadFailure.mock.calls.map(([source]) => source).sort()).toEqual(["due_cards", "goals"]);
  });

  it("does not use goals from an unreadable stored document", async () => {
    const result = await read({
      readAdaptivePrefs: async () => ({ prefs: DEFAULT_OPENING_ADAPTIVE_PREFS, saved: true, invalidStoredPrefs: true }),
    });
    expect(result.sources.courses[0]!.goal).toBeNull();
    expect(result.dataStatus.goals).toBe("unavailable");
    expect(result.autonomy).toBe("manual");
  });

  it("propagates a failed course and task read", async () => {
    await expect(read({ readBase: async () => { throw new Error("db down"); } })).rejects.toThrow("db down");
  });
});

describe("snapshot row mapping", () => {
  it("ignores a malformed stored knowledge snapshot", () => {
    expect(toSnapshotKnowledgeNodes({ nodes: "broken" })).toEqual([]);
    expect(toSnapshotKnowledgeNodes(null)).toEqual([]);
  });

  it("uses only supported skills and supported edges, without treating missing evidence as mastery", () => {
    const a = "44444444-4444-4444-8444-444444444444", b = "55555555-5555-4555-8555-555555555555";
    const c = "66666666-6666-4666-8666-666666666666", chapter = "77777777-7777-4777-8777-777777777777";
    const base = { courseId, label: "skill", kind: "concept", status: "supported", evidenceChunkIds: [] };
    const edge = { to: b, kind: "prerequisite", status: "supported", evidenceChunkIds: [] };
    const graph = { courseId, version: 1,
      nodes: [{ ...base, id: a }, { ...base, id: b }, { ...base, id: c, status: "suggested" }, { ...base, id: chapter, kind: "chapter" }],
      edges: [{ ...edge, from: a }, { ...edge, from: c }, { ...edge, from: chapter }],
    };
    expect(toSnapshotKnowledgeNodes(graph)).toEqual([
      { id: a, title: "skill", prerequisiteIds: [] }, { id: b, title: "skill", prerequisiteIds: [a] },
    ]);
    for (const status of ["suggested", "needs_check"]) {
      expect(toSnapshotKnowledgeNodes({ ...graph, edges: [{ ...edge, from: a, status }] })[1]?.prerequisiteIds).toEqual([]);
    }
    expect(toSnapshotKnowledgeNodes({ ...graph, nodes: graph.nodes.map(node => ({ ...node, status: "needs_check" })) })).toEqual([]);
  });

  it("dates a closed task in the workspace zone and leaves pending tasks open", () => {
    const row = { clientKey: null, minutes: 25, courseId: null, updatedAt: "2026-10-14T17:30:00.000Z" };
    expect(toSnapshotTaskRow({ ...row, status: "done" }, "Asia/Shanghai").closedLocalDate).toBe("2026-10-15");
    expect(toSnapshotTaskRow({ ...row, status: "done" }, "UTC").closedLocalDate).toBe("2026-10-14");
    expect(toSnapshotTaskRow({ ...row, status: "pending" }, "Asia/Shanghai").closedLocalDate).toBeNull();
    expect(toSnapshotTaskRow({ ...row, status: "done", skillLabel: "Linear Algebra" }, "UTC").skillLabel).toBe("Linear Algebra");
    expect(toSnapshotTaskRow({ ...row, status: "done", requirementKey: null }, "UTC"))
      .toEqual(toSnapshotTaskRow({ ...row, status: "done" }, "UTC"));
    expect(toSnapshotTaskRow({ ...row, status: "done", requirementKey: "R1" }, "UTC").requirementKey).toBe("R1");
  });
});

describe("snapshot assistance qualification", () => {
  const at = "2026-10-16T08:00:00.000Z";
  const submittedAt = Date.parse(at);
  const exposure: EvidenceHelpExposure = { attemptId: "attempt", problemId: "problem", level: "hinted", kind: "hint", delivered: true, deliveredAt: submittedAt - 30_000 };
  const evidence = (exposures: readonly EvidenceHelpExposure[]): CourseEvidence => ({
    observations: [{ id: "revised-head", workspaceId: scope.workspaceId, sessionId: "session", courseId, skillLabel: "Linear Algebra",
      sourceIds: [], sourceTurnIds: [], answer: "1", outcome: "correct", assistance: "independent", clientKey: "revised-observation",
      occurredAt: at, submittedAt: at, verdictSource: "self_report", referenceSourceId: "reference", evidenceVerdict: "MASTERY_NOT_ESTABLISHED", problemId: "problem" }],
    evidenceContexts: { "revised-head": {
      observation: { attemptId: "attempt", problemId: "problem", itemVersionId: "version", courseId, requirementKey: "requirement",
        startedAt: submittedAt - 60_000, submittedAt, assistance: "independent", outcome: "correct", verdictSource: "self_report" },
      context: { helpHistory: { complete: true, exposures }, version: { applicability: "exact", currentItemVersionId: "version" },
        referenceCheckAuthority: "learner",
        referenceCheck: { attemptId: "attempt", problemId: "problem", itemVersionId: "version", referenceId: "reference", method: "learner_self_compare", scope: "whole_answer", checkerId: "owner", outcome: "correct" } },
    } },
  });

  it.each(["hinted", "revealed"] as const)("keeps delivered %s after a self-comparison revision and still requires diagnosis", level => {
    const input = evidence([{ ...exposure, level }]);
    const result = toSnapshotEvidence(input, new Date(at));
    expect(result.observations[0]).toMatchObject({ assistance: level, verifiedCorrect: "unknown", independentAttempt: "no" });
    expect(result.summaries[0]?.status).toBe("needs_check");
    expect(nextLearningStep({ status: result.summaries[0]!.status, observations: result.observations, wantsFullExplanation: false })).toMatchObject({
      activityKind: "diagnose", reasonCode: "unverified_only",
    });
    expect(input.observations[0]!.assistance).toBe("independent");
  });

  it.each([
    ["post-submission reference", { deliveredAt: submittedAt + 1 }],
    ["another attempt", { attemptId: "other-attempt", deliveredAt: submittedAt - 90_000, level: "revealed" }],
    ["undelivered hint", { delivered: false }],
    ["instruction", { kind: "instruction", level: "revealed" }],
  ] as const)("does not make %s a current-attempt hint", (_name, patch) => {
    const result = toSnapshotEvidence(evidence([{ ...exposure, ...patch }]), new Date(at));
    expect(result.observations[0]!.assistance).toBe("independent");
  });

  it("retains a declared help level when legacy evidence has no server context", () => {
    const input = evidence([]);
    input.evidenceContexts = {};
    input.observations[0]!.assistance = "revealed";
    expect(toSnapshotEvidence(input, new Date(at)).observations[0]!.assistance).toBe("revealed");
  });
});
