import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import type { LearnerSnapshotSources } from "@aistudy/domain";
import {
  createLearnerSnapshotService,
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

  it("dates a closed task in the workspace zone and leaves pending tasks open", () => {
    const row = { clientKey: null, minutes: 25, courseId: null, updatedAt: "2026-10-14T17:30:00.000Z" };
    expect(toSnapshotTaskRow({ ...row, status: "done" }, "Asia/Shanghai").closedLocalDate).toBe("2026-10-15");
    expect(toSnapshotTaskRow({ ...row, status: "done" }, "UTC").closedLocalDate).toBe("2026-10-14");
    expect(toSnapshotTaskRow({ ...row, status: "pending" }, "Asia/Shanghai").closedLocalDate).toBeNull();
  });
});
