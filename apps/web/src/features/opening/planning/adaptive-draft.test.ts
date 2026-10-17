import { describe, expect, it } from "vitest";
import { uuidSchema } from "@aistudy/contracts";
import type { CourseGoal, TaskItem } from "@aistudy/contracts";
import { buildAdaptiveDraft, freeMinutes, suggestionTaskId, type BuildAdaptiveDraftInput } from "./adaptive-draft";

describe("adaptive draft helpers", () => {
  it("derives a stable, valid task id per workspace and suggestion key", () => {
    const key = "planner:2026-09-14:weak_skill:course:0123abcd";
    const id = suggestionTaskId("11111111-1111-4111-8111-111111111111", key);
    expect(uuidSchema.safeParse(id).success).toBe(true);
    expect(suggestionTaskId("11111111-1111-4111-8111-111111111111", key)).toBe(id);
    expect(suggestionTaskId("22222222-2222-4222-8222-222222222222", key)).not.toBe(id);
  });

  it("counts only free time as capacity", () => {
    expect(freeMinutes([
      { start: "2026-09-14T00:00:00.000Z", end: "2026-09-14T01:30:00.000Z", kind: "free" },
      { start: "2026-09-14T01:30:00.000Z", end: "2026-09-14T02:15:00.000Z", kind: "class" },
      { start: "2026-09-14T02:15:00.000Z", end: "2026-09-14T02:40:30.000Z", kind: "free" },
    ])).toBe(115);
  });
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const examCourse = id(901), otherCourse = id(902);
const pending = (n: number, changes: Partial<TaskItem> = {}): TaskItem => ({
  id: id(n), title: `待办 ${n}`, minutes: 30, dueAt: null, priority: 1, status: "pending", courseId: otherCourse, ...changes,
});
const draftInput = (goal: CourseGoal | null, tasks: TaskItem[] = []): BuildAdaptiveDraftInput => ({
  workspaceId: id(800), date: "2026-10-17", timeZone: "America/Los_Angeles", now: new Date("2026-10-17T14:00:00Z"),
  tasks, yesterdayAccepted: [], freeBlocks: [{ start: "2026-10-17T17:00:00Z", end: "2026-10-17T17:30:00Z", kind: "free" }],
  adaptive: { autonomy: "copilot", plannerInputRevision: "input-1", snapshot: {
    date: "2026-10-17", timeZone: "America/Los_Angeles", dueCardCount: 0, plannerHistory: [],
    courses: [{ courseId: examCourse, title: "Math I", goal, minutesThisWeek: 0, skills: [], nextSkills: ["积分"], hasUsableMaterials: true }],
  } },
  planDayOptions: preferredOrder => ({ preferredOrder, localDate: "2026-10-17", timeZone: "America/Los_Angeles", planningNow: "2026-10-17T14:00:00Z" }),
});

describe("goal-aware adaptive draft integration", () => {
  it("allows an imminent goal to use the budget and keeps displaced pending work visible", () => {
    const input = draftInput({ targetDate: "2026-10-20", weeklyMinutes: 0 }, [pending(1), pending(2)]);
    input.yesterdayAccepted = [{ taskId: id(1), start: "2026-10-16T17:00:00Z", end: "2026-10-16T17:30:00Z", reason: "昨天" }];
    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks).toMatchObject([{ courseId: examCourse, minutes: 24 }]);
    expect(result.blocks.map(block => block.taskId)).toEqual([result.adaptive.suggestedTasks![0]!.id]);
    expect(result.unscheduledTaskIds).toEqual([id(1), id(2)]);
    expect(input.tasks.every(task => task.status === "pending")).toBe(true);
    expect(buildAdaptiveDraft(input).adaptive.suggestedTasks).toEqual(result.adaptive.suggestedTasks);
  });

  it("reserves real deadlines first and fits the shortened exam task into the remaining budget", () => {
    const result = buildAdaptiveDraft(draftInput({ targetDate: "2026-10-20", weeklyMinutes: 0 }, [
      pending(1, { minutes: 10, dueAt: "2026-10-17T18:00:00Z" }), pending(2),
    ]));
    expect(result.blocks[0]?.taskId).toBe(id(1));
    expect(result.adaptive.suggestedTasks).toMatchObject([{ minutes: 14 }]);
    expect(result.blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0)).toBe(24);
    expect(result.unscheduledTaskIds).toContain(id(2));
  });

  it("keeps ordinary own work ahead without an active goal", () => {
    const result = buildAdaptiveDraft(draftInput(null, [pending(1)]));
    expect(result.adaptive.suggestedTasks).toEqual([]);
    expect(result.blocks.map(block => block.taskId)).toEqual([id(1)]);
  });

  it("does not charge impossible or future-deferred pending work as committed time", () => {
    const input = draftInput({ targetDate: "2026-10-20", weeklyMinutes: 0 }, [
      pending(1, { minutes: 90, dueAt: "2026-10-17T18:00:00Z" }),
      pending(2, { courseId: examCourse, notBefore: "2026-10-18T17:00:00Z" }),
    ]);
    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks).toHaveLength(1);
    expect(result.blocks).toHaveLength(1);
    expect(result.unscheduledTaskIds).toEqual([id(1)]);
  });

  it("still respects same-day suppression when a high-priority goal has spare time", () => {
    const input = draftInput({ targetDate: "2026-10-20", weeklyMinutes: 0 }, [pending(1)]);
    const first = buildAdaptiveDraft(input).adaptive.suggestedTasks![0]!;
    input.adaptive.snapshot.plannerHistory = [{ date: input.date, identity: first.key.replace(`planner:${input.date}:`, ""), status: "done" }];
    expect(buildAdaptiveDraft(input).adaptive.suggestedTasks).toEqual([]);
  });

  it("uses time remaining after a late page open and the confirmation buffer", () => {
    const input = draftInput({ targetDate: "2026-10-20", weeklyMinutes: 0 });
    input.now = new Date("2026-10-17T17:40:00Z");
    input.freeBlocks = [{ start: "2026-10-17T17:00:00Z", end: "2026-10-17T18:00:00Z", kind: "free" }];
    input.planDayOptions = preferredOrder => ({ preferredOrder, planningNow: input.now.toISOString(), localDate: input.date, timeZone: input.timeZone });
    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks).toMatchObject([{ minutes: 15 }]);
    expect(result.blocks).toMatchObject([{ start: "2026-10-17T17:41:00.000Z", end: "2026-10-17T17:56:00.000Z" }]);
    expect(result.unscheduledTaskIds).toEqual([]);
  });

  it("deduplicates overlapping free time and fits an exam block around fixed exclusions", () => {
    const input = draftInput({ targetDate: "2026-10-20", weeklyMinutes: 0 });
    input.freeBlocks = [
      { start: "2026-10-17T17:00:00Z", end: "2026-10-17T18:00:00Z", kind: "free" },
      { start: "2026-10-17T17:00:00Z", end: "2026-10-17T18:00:00Z", kind: "free" },
      { start: "2026-10-17T17:12:00Z", end: "2026-10-17T17:48:00Z", kind: "class" },
    ];
    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks).toMatchObject([{ minutes: 12 }]);
    expect(result.blocks).toMatchObject([{ start: "2026-10-17T17:00:00.000Z", end: "2026-10-17T17:12:00.000Z" }]);
    expect(result.unscheduledTaskIds).toEqual([]);
  });

  it("accounts for prior suggestions when consuming fragmented continuous slots", () => {
    const input = draftInput({ targetDate: "2026-10-20", weeklyMinutes: 0 });
    input.freeBlocks = [25, 10, 10].map((minutes, index) => ({
      start: `2026-10-17T${17 + index}:00:00Z`, end: `2026-10-17T${17 + index}:${minutes}:00Z`, kind: "free",
    }));
    input.adaptive.snapshot.courses = [{ ...input.adaptive.snapshot.courses[0]!, nextSkills: [], skills: ["a", "b", "c"].map(skillLabel => ({
      skillLabel, status: "needs_review", lastObservedAt: null, recentAssistance: [],
    })) }];
    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks?.map(task => task.minutes)).toEqual([25, 10]);
    expect(result.blocks).toHaveLength(2);
    expect(result.unscheduledTaskIds).toEqual([]);
  });

  it("does not propose an indivisible study block when every free fragment is below ten minutes", () => {
    const input = draftInput({ targetDate: "2026-10-20", weeklyMinutes: 0 });
    input.freeBlocks = [0, 1, 2].map(index => ({
      start: `2026-10-17T${17 + index}:00:00Z`, end: `2026-10-17T${17 + index}:09:00Z`, kind: "free",
    }));
    expect(buildAdaptiveDraft(input).adaptive.suggestedTasks).toEqual([]);
  });
});
