import { expect, it } from "vitest";
import { selectLearningRecoveryTask } from "./opening-long-term-planning";
it("never attaches another course's first pending task to the current activity", () => {
  const tasks = [{ id: "b", status: "pending", courseId: "course-b" }, { id: "a", status: "pending", courseId: "course-a" }];
  expect(selectLearningRecoveryTask(tasks as never, { id: "activity-a", course_id: "course-a", create_intent: {} })).toBeUndefined();
  expect(selectLearningRecoveryTask(tasks as never, { id: "activity-a", course_id: "course-a", create_intent: { source: "task", taskId: "a" } })?.id).toBe("a");
});
