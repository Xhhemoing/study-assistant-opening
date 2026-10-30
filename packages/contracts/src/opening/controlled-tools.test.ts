import { expect, it } from "vitest";
import { controlledLearningToolPermission, controlledLearningTools } from "./controlled-tools";

it("does not turn feature availability or course consent into acceptance of a plan", () => {
  expect(controlledLearningToolPermission("plan_draft", { enabled: true, authorized: true })).toBe("automatic");
  for (const tool of ["accept_plan", "accept_proposal", "undo_plan", "cancel_retest"]) {
    expect(controlledLearningToolPermission(tool, { enabled: true, authorized: true })).toBe("confirmation_required");
    expect(controlledLearningToolPermission(tool, { enabled: true, authorized: true, explicitlyConfirmed: true })).toBe("automatic");
    expect(controlledLearningToolPermission(tool, { enabled: false, authorized: true, explicitlyConfirmed: true })).toBe("forbidden");
    expect(controlledLearningToolPermission(tool, { enabled: true, authorized: false, explicitlyConfirmed: true })).toBe("forbidden");
  }
});
it("forbids unsupported tools and revoked automatic actions", () => {
  for (const tool of ["next_question", "resume_activity", "schedule_retest", "open_fragment"]) {
    expect(controlledLearningToolPermission(tool, { enabled: true, authorized: false })).toBe("forbidden");
  }
  expect(controlledLearningToolPermission("delete_history", { enabled: true, authorized: true })).toBe("forbidden");
  expect(controlledLearningToolPermission("toString", { enabled: true, authorized: true })).toBe("forbidden");
});
it("keeps the native next and automatic retest boundary strict", () => {
  expect(controlledLearningTools.next_question.input.safeParse({}).success).toBe(false);
  expect(controlledLearningTools.schedule_retest.input.safeParse({ observationId: "10000000-0000-4000-8000-000000000001", clientKey: "request-1" }).success).toBe(false);
});
