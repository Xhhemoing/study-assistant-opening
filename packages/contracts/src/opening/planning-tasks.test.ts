import { describe, expect, it } from "vitest";
import { taskItemSchema, taskRetestProjectionSchema } from "./planning-tasks";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const baseRetest = {
  candidateId: id(1),
  activityId: id(2),
  courseId: id(3),
  skillLabel: "matrix-rank",
  prompt: "3天后独立完成新题",
  recommendedAt: "2026-10-15T19:00:00.000Z",
};

const baseTask = {
  id: id(10),
  version: 1,
  title: "3天后独立完成新题",
  minutes: 25,
  dueAt: "2026-10-26T19:00:00.000Z",
  priority: 1,
  status: "pending" as const,
  notBefore: "2026-10-15T19:00:00.000Z",
  retest: baseRetest,
};

describe("planning-tasks contract compatibility", () => {
  it("parses legacy TaskItem snapshots without retest.scheduledStartAt", () => {
    const parsed = taskItemSchema.parse(baseTask);
    expect(parsed.retest).toEqual(baseRetest);
    expect(parsed.retest?.scheduledStartAt).toBeUndefined();
  });

  it("parses TaskItem snapshots with an explicit retest.scheduledStartAt or null", () => {
    const reserved = taskItemSchema.parse({
      ...baseTask,
      retest: { ...baseRetest, scheduledStartAt: "2026-10-16T19:15:00.000Z" },
    });
    expect(reserved.retest?.recommendedAt).toBe("2026-10-15T19:00:00.000Z");
    expect(reserved.retest?.scheduledStartAt).toBe("2026-10-16T19:15:00.000Z");

    const cleared = taskItemSchema.parse({
      ...baseTask,
      retest: { ...baseRetest, scheduledStartAt: null },
    });
    expect(cleared.retest?.scheduledStartAt).toBeNull();
  });

  it("rejects invalid scheduledStartAt timestamps and unknown retest keys", () => {
    expect(
      taskRetestProjectionSchema.safeParse({ ...baseRetest, scheduledStartAt: "Friday 19:15" }).success,
    ).toBe(false);
    expect(
      taskRetestProjectionSchema.safeParse({ ...baseRetest, extraField: "nope" }).success,
    ).toBe(false);
  });
});
