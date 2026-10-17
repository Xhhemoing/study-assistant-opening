import { describe, expect, it } from "vitest";
import type { GoalLearningContext } from "@aistudy/contracts";
import type { SnapshotKnowledgeNode, SnapshotObservation } from "./snapshot-sources";
import { selectPrerequisiteRepair } from "./prerequisite-repair";

const goalContext: GoalLearningContext = { mode: "exam", reasonCode: "deadline_near", targetDate: "2026-10-20",
  daysRemaining: 3, priority: 3, prerequisiteBudgetMinutes: 5 };
const nodes: SnapshotKnowledgeNode[] = [
  { id: "a", title: "代数", prerequisiteIds: [] },
  { id: "b", title: "求导", prerequisiteIds: ["a"] },
  { id: "c", title: "分部积分", prerequisiteIds: ["b"] },
];
const observation = (patch: Partial<SnapshotObservation> = {}): SnapshotObservation => ({
  id: "wrong", skillLabel: "求导", requirementKey: "apply", attemptedAt: "2026-10-16T10:00:00Z",
  verifiedCorrect: "no", usableForCurrentVersion: "yes", independentAttempt: "yes", assistance: "independent", problemId: null, ...patch,
});
const repair = (observations: SnapshotObservation[], knowledgeNodes = nodes) => selectPrerequisiteRepair({
  targetSkillLabel: "分部积分", knowledgeNodes, observations, goalContext, now: new Date("2026-10-17T12:00:00Z"),
});

describe("bounded prerequisite teaching", () => {
  it("selects a known weak direct prerequisite with a budget, stop condition and original return target", () => {
    expect(repair([observation()])).toMatchObject({ nodeId: "b", targetNodeId: "c", skillLabel: "求导",
      returnToSkillLabel: "分部积分", maxMinutes: 5, stopCondition: expect.stringContaining("关键一步") });
  });

  it("does not diagnose missing evidence, infer weakness up the graph, or chase ancestors", () => {
    expect(repair([])).toBeNull();
    expect(repair([observation({ skillLabel: "代数" })])).toBeNull();
  });

  it("measures elapsed time at the actual instant, including a Los Angeles evening on the next UTC day", () => {
    const input = { targetSkillLabel: "分部积分", knowledgeNodes: nodes, goalContext, now: new Date("2026-10-17T20:05:00-07:00") };
    expect(selectPrerequisiteRepair({ ...input, observations: [observation({ attemptedAt: "2026-10-18T03:00:00Z" })] })?.nodeId).toBe("b");
    expect(selectPrerequisiteRepair({ ...input, observations: [observation({ attemptedAt: "2026-10-18T03:06:00Z" })] })).toBeNull();
  });

  it.each([
    { usableForCurrentVersion: "unknown" }, { usableForCurrentVersion: "no" },
    { verifiedCorrect: "unknown" }, { attemptedAt: "2026-08-01T00:00:00Z" },
    { attemptedAt: "2026-10-20T00:00:00Z" }, { verifiedCorrect: "yes" },
  ] as const)("does not turn non-current or non-negative evidence into a detour: %j", patch => {
    expect(repair([observation(patch)])).toBeNull();
  });

  it("uses the latest qualified result, including unknown, instead of reviving an old error", () => {
    expect(repair([observation(), observation({ id: "new", attemptedAt: "2026-10-17T08:00:00Z", verifiedCorrect: "unknown" })])).toBeNull();
    expect(repair([observation(), observation({ id: "new", attemptedAt: "2026-10-17T08:00:00Z", verifiedCorrect: "yes" })])).toBeNull();
  });

  it("can use a verified assisted success as a need for a short reminder", () => {
    expect(repair([observation({ verifiedCorrect: "yes", independentAttempt: "no", assistance: "hinted" })])?.nodeId).toBe("b");
  });

  it("does not guess between duplicate target labels, prerequisite labels or requirements", () => {
    expect(repair([observation()], [...nodes, { ...nodes[2]!, id: "d" }])).toBeNull();
    expect(repair([observation()], [...nodes, { ...nodes[1]!, id: "d" }])).toBeNull();
    expect(repair([observation(), observation({ id: "prove", requirementKey: "prove" })])).toBeNull();
  });

  it("selects at most one direct prerequisite and leaves the graph and evidence unchanged", () => {
    const knowledgeNodes = nodes.map(node => node.id === "c" ? { ...node, prerequisiteIds: ["a", "b"] } : node);
    const observations = [observation(), observation({ id: "algebra", skillLabel: "代数", attemptedAt: "2026-10-17T08:00:00Z" })];
    const before = JSON.stringify({ knowledgeNodes, observations });
    expect(repair(observations, knowledgeNodes)?.nodeId).toBe("a");
    expect(JSON.stringify({ knowledgeNodes, observations })).toBe(before);
  });
});
