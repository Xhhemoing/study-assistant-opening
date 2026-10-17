import { describe, expect, it } from "vitest";
import { courseGoalSchema, courseMilestoneSchema, openingAdaptivePrefsPatchSchema } from "./adaptive-planning";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const milestone = { id, title: "矩阵乘法迁移", successCriteria: "隔天无提示完成两道新题并说明维数要求。", targetDate: null, evidenceRefs: [] };
const goal = { targetDate: null, weeklyMinutes: 120 };
const patch = (changes: object, expectedRevision?: number) => ({ courseGoal: { courseId: id, goal: { ...goal, ...changes }, ...(expectedRevision === undefined ? {} : { expectedRevision }) } });

describe("versioned course milestones", () => {
  it("keeps legacy goals and goal patches exactly compatible", () => {
    expect(courseGoalSchema.parse(goal)).toEqual(goal);
    expect(openingAdaptivePrefsPatchSchema.parse(patch({}))).toEqual(patch({}));
  });
  it("requires a revision for milestone updates and unique ids", () => {
    expect(openingAdaptivePrefsPatchSchema.safeParse(patch({ milestones: [milestone] })).success).toBe(false);
    expect(openingAdaptivePrefsPatchSchema.safeParse(patch({ milestones: [milestone] }, 0)).success).toBe(true);
    expect(openingAdaptivePrefsPatchSchema.safeParse(patch({ milestones: [milestone, milestone] }, 0)).success).toBe(false);
  });
  it.each(["revision", "history", "status", "confirmedAt"])("rejects client-owned %s fields", field => {
    expect(openingAdaptivePrefsPatchSchema.safeParse(patch({ milestones: [{ ...milestone, [field]: field === "revision" ? 9 : [] }] }, 0)).success).toBe(false);
  });
  it("rejects fabricated goal versions, excessive outcomes and invalid criteria/dates", () => {
    expect(openingAdaptivePrefsPatchSchema.safeParse(patch({ revision: 8 })).success).toBe(false);
    expect(openingAdaptivePrefsPatchSchema.safeParse(patch({ milestones: Array.from({ length: 9 }, () => milestone) }, 0)).success).toBe(false);
    expect(openingAdaptivePrefsPatchSchema.safeParse(patch({ milestones: [{ ...milestone, successCriteria: "  " }] }, 0)).success).toBe(false);
    expect(openingAdaptivePrefsPatchSchema.safeParse(patch({ milestones: [{ ...milestone, targetDate: "2026-02-30" }] }, 0)).success).toBe(false);
  });
  it("reads server confirmation and historical versions separately from public updates", () => {
    const saved = { ...milestone, revision: 1, status: "confirmed_by_learner", confirmedAt: "2026-10-16T12:00:00.000Z", history: [] };
    expect(courseMilestoneSchema.parse(saved)).toEqual(saved);
    expect(courseGoalSchema.parse({ ...goal, revision: 1, milestones: [saved] }).milestones).toHaveLength(1);
  });
});
