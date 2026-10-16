import { describe, expect, it } from "vitest";
import type { TaskItem } from "@aistudy/contracts";
import { withTaskPlanningFields } from "./opening-task-fields";

const task: TaskItem = { id: "task", title: "Review", minutes: 5, dueAt: null, priority: 0, status: "pending" };

describe("planner task action projection", () => {
  it("recovers the action from the stored planner identity, including reduced reviews", () => {
    expect(withTaskPlanningFields(task, { origin: "planner", client_key: "planner:2026-10-16:review_cards:none:none" }))
      .toMatchObject({ origin: "planner", suggestionKind: "review_cards" });
    expect(withTaskPlanningFields(task, { origin: "planner", client_key: "planner:2026-10-16:weak_skill:course:hash" }))
      .toMatchObject({ suggestionKind: "weak_skill" });
  });
  it("does not infer an action from a user title, manual client key, or unknown identity", () => {
    for (const row of [{ origin: "manual", client_key: "planner:2026-10-16:review_cards:none:none" },
      { origin: "planner", client_key: "planner:2026-10-16:unknown:none:none" }, { origin: "planner" }]) {
      expect(withTaskPlanningFields(task, row)).not.toHaveProperty("suggestionKind");
    }
  });
});
