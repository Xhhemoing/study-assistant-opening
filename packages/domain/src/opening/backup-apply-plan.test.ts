import { describe, expect, it } from "vitest";
import type { OpeningBackup } from "./backup-policy";
import { planOpeningRestoreApply } from "./backup-apply-plan";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "11111111-1111-4111-8111-111111111111";
const courseId = "33333333-3333-4333-8333-333333333333";
const tables = [
  "workspace_preferences", "courses", "course_asset_memberships",
  "opening_sources", "opening_source_chunks", "opening_conversations", "opening_turns",
  "opening_learning_sessions", "opening_problem_refs", "opening_help_exposures",
  "opening_learning_observations", "opening_assistant_candidates", "opening_memories",
  "opening_privacy_exclusions", "opening_tasks", "opening_retest_activities", "opening_timetable_sessions", "opening_hard_blocks",
  "opening_plan_state", "opening_plan_drafts", "opening_plan_acceptances",
  "opening_source_versions", "opening_learning_item_versions", "opening_learning_attempts", "opening_learning_history_revisions",
] as const;

function backup(): OpeningBackup {
  return {
    format: "opening-backup",
    version: 1,
    workspaceId,
    privacyEpoch: 4,
    deletionJournal: [],
    tables: Object.fromEntries(tables.map((name) => [name,
      name === "opening_sources" ? [{ id: sourceId, workspace_id: workspaceId, version: 1, bytes: 4, sha256: "ab".repeat(32) }] : [],
    ])),
    objects: [{ sourceId, sha256: "ab".repeat(32), bytes: 4, archivePath: `objects/${sourceId}/v1.bin` }],
  };
}

describe("planOpeningRestoreApply", () => {
  it("does not let a legacy exclusion-only backup erase a later asset deletion", () => {
    const mark = { sourceId, deletedAt: "2026-09-22T00:00:00.000Z" };
    const value = backup(); value.objects = []; value.tables.opening_sources = [];
    value.deletionJournal = [mark];
    value.tables.opening_privacy_exclusions = [{ workspace_id: workspaceId, source_id: sourceId, deleted_at: mark.deletedAt }];
    expect(planOpeningRestoreApply(value, [mark], { confirmLocalRestore: true }).ok).toBe(true);
    expect(planOpeningRestoreApply(value, [{ ...mark, assetDeletedAt: "2026-09-23T00:00:00.000Z" }], { confirmLocalRestore: true })).toMatchObject({ ok: false, code: "JOURNAL_DRIFT" });
  });
  it("refuses to plan without the explicit local confirmation flag", () => {
    const missing = planOpeningRestoreApply(backup(), [], { confirmLocalRestore: false });
    expect(missing).toMatchObject({ ok: false, code: "REQUIRES_EXPLICIT_CONFIRMATION" });
    const mutated = planOpeningRestoreApply(backup(), [], { confirmLocalRestore: "true" as unknown as boolean });
    expect(mutated).toMatchObject({ ok: false, code: "REQUIRES_EXPLICIT_CONFIRMATION" });
  });

  it("rejects backups that fail the structural privacy preflight", () => {
    const poisoned = backup();
    (poisoned.tables.opening_memories as unknown[]).push({
      id: "33333333-3333-4333-8333-333333333333", workspace_id: workspaceId,
      status: "deleted", source_turn_ids: [sourceId],
    });
    const result = planOpeningRestoreApply(poisoned, [], { confirmLocalRestore: true });
    expect(result).toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED" });
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects journal drift between the backup and the current journal", () => {
    const mark = { sourceId, deletedAt: "2026-09-22T00:00:00.000Z" };
    const result = planOpeningRestoreApply(backup(), [mark], { confirmLocalRestore: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["PREFLIGHT_REJECTED", "JOURNAL_DRIFT"]).toContain(result.code);
    const sameSetDifferentTime = planOpeningRestoreApply(
      { ...backup(), deletionJournal: [{ sourceId, deletedAt: "2026-09-21T00:00:00.000Z" }] },
      [{ sourceId, deletedAt: "2026-09-22T00:00:00.000Z" }],
      { confirmLocalRestore: true },
    );
    expect(sameSetDifferentTime.ok).toBe(false);
    if (sameSetDifferentTime.ok) return;
    expect(sameSetDifferentTime.code).not.toBe("REQUIRES_EXPLICIT_CONFIRMATION");
  });

  it("requires the restore executor to prove course ownership before applying linked records", () => {
    const value = backup();
    value.tables.opening_retest_activities = [{
      id: "44444444-4444-4444-8444-444444444444",
      workspace_id: workspaceId,
      owner_user_id: "55555555-5555-4555-8555-555555555555",
      course_id: courseId,
      candidate_id: null,
      task_id: null,
      reopened_from_activity_id: null,
    }];
    expect(planOpeningRestoreApply(value, [], { confirmLocalRestore: true })).toMatchObject({
      ok: false,
      code: "PREFLIGHT_REJECTED",
      errors: ["target course preflight is required before restoring course-linked records"],
    });
    expect(planOpeningRestoreApply(value, [], { confirmLocalRestore: true, availableCourseIds: [courseId] }).ok).toBe(true);
    expect(planOpeningRestoreApply(value, [], { confirmLocalRestore: true, availableCourseIds: [] })).toMatchObject({
      ok: false,
      code: "PREFLIGHT_REJECTED",
    });
    expect(planOpeningRestoreApply(value, [], {
      confirmLocalRestore: true,
      availableCourseIds: "not-a-list" as unknown as readonly string[],
    })).toMatchObject({
      ok: false,
      code: "PREFLIGHT_REJECTED",
    });
  });

  it("plans every durable table exactly once in dependency order with counts", () => {
    const filled = backup();
    filled.tables.opening_source_chunks = [{
      id: "44444444-4444-4444-8444-444444444444", source_id: sourceId, source_version: 1,
    }];
    const result = planOpeningRestoreApply(filled, [], { confirmLocalRestore: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.plan.batches.map((batch) => batch.table);
    expect(new Set(names).size).toBe(25);
    expect(names.indexOf("opening_sources")).toBeLessThan(names.indexOf("opening_source_chunks"));
    expect(names.indexOf("opening_conversations")).toBeLessThan(names.indexOf("opening_turns"));
    expect(names.indexOf("opening_turns")).toBeLessThan(names.indexOf("opening_assistant_candidates"));
    expect(names.indexOf("opening_learning_sessions")).toBeLessThan(names.indexOf("opening_problem_refs"));
    expect(names.indexOf("opening_plan_drafts")).toBeLessThan(names.indexOf("opening_plan_acceptances"));
    expect(result.plan.batches.find((batch) => batch.table === "opening_sources")?.rows).toBe(1);
    expect(result.plan.batches.find((batch) => batch.table === "opening_source_chunks")?.rows).toBe(1);
    expect(result.plan.objectCount).toBe(1);
  });

  it("never plans queue, budget, tutor, or auth tables", () => {
    const result = planOpeningRestoreApply(backup(), [], { confirmLocalRestore: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.plan.batches.map((batch) => batch.table);
    for (const banned of ["opening_jobs", "opening_outbox", "opening_budget_reservations", "opening_tutor_jobs", "auth_sessions"]) {
      expect(names).not.toContain(banned);
    }
    expect(new Set(names)).toEqual(new Set(tables));
  });
});
