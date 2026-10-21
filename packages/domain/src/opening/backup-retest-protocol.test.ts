import { describe, expect, it } from "vitest";
import { validateBackupRetestProtocols } from "./backup-retest-protocol";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "./span-teaching-catalog";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const scope = { workspace_id: uuid(1), owner_user_id: uuid(2), course_id: uuid(3),
    skill_label: SPAN_SKILL_LABEL, requirement_key: SPAN_REQUIREMENT_KEY };
  const baseline = { ...scope, id: uuid(4), root_observation_id: uuid(4), attempt_id: uuid(5),
    submitted_at: "2026-10-01T12:00:00.000Z", recorded_at: "2026-10-01T12:00:01.000Z" };
  const activity = { ...scope, id: uuid(6), purpose: "retest", task_id: uuid(7), candidate_reference_id: uuid(8),
    accept_client_key: "span-accept-once", accepted_at: "2026-10-01T13:00:00.000Z", not_before_at: "2026-10-04T12:00:01.000Z",
    learning_protocol: { protocolId: "span-delayed-3d-v1", baselineObservationId: baseline.id,
      baselineRootId: baseline.id, priorAnswerPolicy: "require_unseen_problem" } };
  return { opening_learning_observations: [baseline], opening_retest_activities: [activity], opening_tasks: [{ ...scope, id: activity.task_id }] };
}
function errors(tables: Record<string, Record<string, unknown>[]>) {
  const result: string[] = []; validateBackupRetestProtocols(tables, result); return result;
}
describe("backup retest domain receipts", () => {
  it("keeps protocol, acceptance and stable aliases without a job reference", () => {
    expect(errors(fixture())).toEqual([]);
  });
  it("does not invent a protocol or receipt for a legacy backup", () => {
    const tables = fixture();
    const row = { ...tables.opening_retest_activities[0] } as Record<string, unknown>;
    delete row.learning_protocol; delete row.accept_client_key; delete row.candidate_reference_id;
    expect(errors({ ...tables, opening_retest_activities: [row] })).toEqual([]);
    expect(row).not.toHaveProperty("learning_protocol");
  });
  it.each(["owner_user_id", "course_id", "requirement_key"])("rejects a mismatched baseline %s", field => {
    const tables = fixture(); Object.assign(tables.opening_learning_observations[0]!, { [field]: uuid(20) });
    expect(errors(tables)).toContain("retest learning protocol baseline is missing or mismatched");
  });
  it("requires 72 hours after the later trusted sealing timestamp", () => {
    const tables = fixture(); tables.opening_retest_activities[0]!.not_before_at = "2026-10-04T12:00:00.999Z";
    expect(errors(tables)).toContain("retest learning protocol requires at least 72 hours after sealing");
  });
  it("preserves a historical baseline after its effective head is replaced or retracted", () => {
    const tables = fixture(); Object.assign(tables.opening_learning_observations[0]!, { effective_head_id: uuid(21) });
    tables.opening_learning_observations.push({ ...tables.opening_learning_observations[0]!, id: uuid(21) });
    expect(errors(tables)).toEqual([]);
  });
  it.each(["id", "alias"])("rejects an alias colliding with another activity %s", target => {
    const tables = fixture(), original = tables.opening_retest_activities[0]!;
    tables.opening_retest_activities.push({ ...original, id: target === "id" ? original.candidate_reference_id : uuid(22),
      candidate_reference_id: target === "alias" ? original.candidate_reference_id : uuid(23), accept_client_key: "different-client-key" });
    expect(errors(tables)).toContain("retest candidate reference identity is ambiguous");
  });
  it("rejects duplicate acceptance keys and a receipt without its protocol", () => {
    const tables = fixture(), original = tables.opening_retest_activities[0]!;
    tables.opening_retest_activities.push({ ...original, id: uuid(24), candidate_reference_id: uuid(25) });
    expect(errors(tables)).toContain("retest acceptance receipt is duplicated");
    expect(errors({ ...fixture(), opening_retest_activities: [{ ...original, learning_protocol: null }] }))
      .toContain("retest acceptance receipt is incomplete");
  });
  it.each(["candidate_reference_id", "task_id"])("rejects an acceptance receipt missing its %s", field => {
    const tables = fixture(); Object.assign(tables.opening_retest_activities[0]!, { [field]: null });
    expect(errors(tables)).toContain("retest acceptance receipt is incomplete");
  });
});
