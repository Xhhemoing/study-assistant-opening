import { describe, expect, it } from "vitest";
import { taskDeferInputSchema, taskStatusUpdateInputSchema } from "./planning-tasks";

const status = { status: "skipped", expectedVersion: 1, at: "2026-10-16T12:00:00.000Z" };
const defer = { expectedVersion: 1, notBefore: "2026-10-16T16:00:00.000Z" };

describe("optional planning feedback", () => {
  it("keeps old payloads valid and accepts a structured optional reason", () => {
    expect(taskStatusUpdateInputSchema.parse(status)).toEqual(status);
    expect(taskDeferInputSchema.parse(defer)).toEqual(defer);
    expect(taskStatusUpdateInputSchema.parse({ ...status, feedback: { reason: "time_short" } }).feedback).toEqual({ reason: "time_short" });
    expect(taskDeferInputSchema.parse({ ...defer, feedback: { reason: "prefer_not_say" } }).feedback).toEqual({ reason: "prefer_not_say" });
  });
  it.each([{ reason: "correct" }, { reason: "too_hard", origin: "planner" }, { reason: "other", text: "private" }])("rejects unsupported or server-owned feedback fields: %j", feedback => {
    expect(taskStatusUpdateInputSchema.safeParse({ ...status, feedback }).success).toBe(false);
    expect(taskDeferInputSchema.safeParse({ ...defer, feedback }).success).toBe(false);
  });
});
