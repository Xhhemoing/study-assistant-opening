import { expect, it, vi } from "vitest";
import { createLearningGoalClient } from "./learning-goal-client";

const courseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const id = "11111111-1111-4111-8111-111111111111";
const definition = { courseIds: [courseId], title: "理解课程", kind: "custom" as const, targetDate: "2026-12-01", examDate: null, weeklyMinutes: 120, priority: 0, learningMode: "understand" as const, successCriteria: "能独立解释方法" };
const goal = { ...definition, id, workspaceId: courseId, revision: 2, lifecycle: "active", maintenanceIntervalDays: null, milestones: [], createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" };

it("creates a formal goal without treating an ordinary target date as an exam", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json(goal));
  await createLearningGoalClient(transport).create({ ...definition, clientKey: "goal-create-1" });
  expect(transport.mock.calls[0]).toEqual(["/api/opening/learning-goals", expect.objectContaining({ method: "POST", body: JSON.stringify({ ...definition, clientKey: "goal-create-1" }) })]);
});
it("selects with both the goal revision and the previous explicit selection", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ goals: [goal], selectedGoalIds: { [courseId]: id }, legacyConflicts: [] }));
  const input = { courseId, goalId: id, expectedRevision: 2, expectedSelectedGoalId: null, resolveLegacy: true };
  await createLearningGoalClient(transport).select(input);
  expect(transport.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "POST", body: JSON.stringify(input) }));
});
it("rejects malformed input before making a request", async () => {
  const transport = vi.fn();
  await expect(createLearningGoalClient(transport).create({ ...definition, examDate: "2026-12-01", clientKey: "goal-create-1" })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
it("retains server rejection status and does not accept a malformed receipt", async () => {
  const transport = vi.fn().mockResolvedValueOnce(Response.json({ message: "目标已更新，请重新读取。" }, { status: 409 })).mockResolvedValueOnce(Response.json({ id }));
  const client = createLearningGoalClient(transport);
  await expect(client.update(id, { expectedRevision: 1, title: "新目标" })).rejects.toMatchObject({ status: 409, message: "目标已更新，请重新读取。" });
  await expect(client.create({ ...definition, clientKey: "goal-create-1" })).rejects.toThrow();
});
