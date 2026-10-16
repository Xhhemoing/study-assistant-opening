import { expect, it } from "vitest";
import { validateBackupPlanFeedback } from "./backup-plan-feedback";

const task = { id: "11111111-1111-4111-8111-111111111111", workspace_id: "22222222-2222-4222-8222-222222222222", owner_user_id: "33333333-3333-4333-8333-333333333333", version: 2 };
const feedback = { id: "44444444-4444-4444-8444-444444444444", workspace_id: task.workspace_id,
  owner_user_id: task.owner_user_id, task_id: task.id, task_version: 2, action: "skipped", reason: null,
  origin: "manual", requirement_key: null, suggestion_kind: null, not_before: null, recorded_at: "2026-10-16T12:00:00.000Z" };
const errors = (rows: Record<string, unknown>[] | undefined) => {
  const result: string[] = [];
  validateBackupPlanFeedback({ opening_tasks: [task], ...(rows ? { opening_plan_feedback: rows } : {}) }, result);
  return result;
};

it("accepts legacy absence and owned feedback without inventing historical reasons", () => {
  expect(errors(undefined)).toEqual([]);
  expect(errors([feedback])).toEqual([]);
});
it.each([
  { task_id: "55555555-5555-4555-8555-555555555555" },
  { owner_user_id: "55555555-5555-4555-8555-555555555555" },
  { workspace_id: "55555555-5555-4555-8555-555555555555" },
  { task_version: 3 }, { action: "correct" }, { reason: "free text" },
  { action: "deferred", not_before: null }, { recorded_at: "invalid" },
])("rejects malformed or foreign planning history %j", patch => {
  expect(errors([{ ...feedback, ...patch }]).length).toBeGreaterThan(0);
});
it("rejects duplicate event identities and task versions", () => {
  expect(errors([feedback, { ...feedback, id: "55555555-5555-4555-8555-555555555555" }])).toContain("planning feedback identity is invalid or duplicated");
});
