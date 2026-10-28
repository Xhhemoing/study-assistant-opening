import { describe, expect, it } from "vitest";
import { allocateLearningCapacity, learningRecoveryChoice } from "./long-term-planning";

const at = (minute: number) => `2026-11-01T${String(9 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
describe("workspace learning capacity", () => {
  it("shares one cap across courses and counts overlapping accepted intervals once", () => {
    const result = allocateLearningCapacity({ dailyMinutes: 60, bufferMinutes: 5, spentMinutes: 0,
      free: [{ start: at(0), end: at(120), kind: "free" }], accepted: [
        { taskId: "a", start: at(0), end: at(20), reason: "accepted" },
        { taskId: "b", start: at(10), end: at(30), reason: "accepted" }],
      reservations: [{ key: "task:a", minutes: 20 }, { key: "task:a", minutes: 20 }, { key: "activity:x", minutes: 10 }],
      acceptedTaskIds: new Set(["a", "b"]) });
    expect(result.committedMinutes).toBe(40);
    expect(result.remainingMinutes).toBe(15);
    expect(result.free).toEqual([{ start: at(30), end: at(45), kind: "free" }]);
  });
  it("keeps accepted history when the cap is halved and exposes overcommitment", () => {
    const result = allocateLearningCapacity({ dailyMinutes: 15, bufferMinutes: 0, spentMinutes: 0,
      free: [{ start: at(0), end: at(90), kind: "free" }], accepted: [{ taskId: "a", start: at(0), end: at(30), reason: "accepted" }], reservations: [] });
    expect(result.remainingMinutes).toBe(0); expect(result.overcommittedMinutes).toBe(15); expect(result.free).toEqual([]);
  });
  it("never converts absence into a failed learning result", () => {
    expect(learningRecoveryChoice({ activityId: "activity", taskId: "task", pending: true })).toEqual({ kind: "continue", activityId: "activity", taskId: "task" });
    expect(learningRecoveryChoice({ activityId: null, taskId: "task", pending: true })).toEqual({ kind: "replan", activityId: null, taskId: "task" });
  });
});
