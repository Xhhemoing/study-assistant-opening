import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningRetestRepository } from "./opening-retests";

const scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};
const courseId = "33333333-3333-4333-8333-333333333333";

describe("opening retest due identities", () => {
  it("maps due activity rows to worker evidence identities", async () => {
    const sql = (async () => [{
      id: "44444444-4444-4444-8444-444444444444",
      evidence_cycle_id: "55555555-5555-4555-8555-555555555555",
      course_id: courseId,
      skill_label: "fractions",
      requirement_key: "requirement-a",
      purpose: "retest",
      status: "accepted",
      result: null,
      task_id: "66666666-6666-4666-8666-666666666666",
      candidate_id: null,
      version: 2,
      snoozed_until: null,
      proposed_at: "2026-09-28T10:00:00.000Z",
      accepted_at: "2026-09-28T10:05:00.000Z",
      started_at: null,
      completed_at: null,
      declined_at: null,
      cancelled_at: null,
      invalidated_at: null,
      superseded_at: null,
      not_before_at: null,
      recommended_at: "2026-09-29T10:00:00.000Z",
      scheduled_start_at: null,
      deadline_at: null,
      reason: null,
      reopened_from_activity_id: null,
    }]) as unknown as Sql;
    const repository = createOpeningRetestRepository(sql);

    await expect(repository.listDueEvidence(scope, courseId, "2026-09-29T12:00:00.000Z")).resolves.toEqual([{
      courseId,
      skillLabel: "fractions",
      requirementKey: "requirement-a",
    }]);
  });
});
