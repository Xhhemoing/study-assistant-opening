import { describe, expect, it } from "vitest";
import { planOpeningRestoreApply } from "./backup-apply-plan";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";
import { composeOpeningBackupDraft } from "./backup-compose";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "11111111-1111-4111-8111-111111111111";
const courseId = "33333333-3333-4333-8333-333333333333";
const memberId = "44444444-4444-4444-8444-444444444444";
const at = "2026-09-20T00:00:00.000Z";
const later = "2026-09-29T00:00:00.000Z";
const flags = {
  assessment_enabled: true, retest_suggestions_enabled: true, automatic_reminders_enabled: true,
  retest_suggestions_enabled_at: at, automatic_reminders_enabled_at: at,
};
const preference = () => ({ workspace_id: workspaceId, default_entry: "learn", ...flags });
const course = () => ({ id: courseId, workspace_id: workspaceId, title: "Math", slug: "math", description: "", schema_version: 1,
  archived_at: null, ...flags });
const member = () => ({ id: memberId, workspace_id: workspaceId, course_id: courseId, asset_type: "source", asset_id: sourceId,
  role: "core", sort_order: 0, visibility: "private" });
function backup(): OpeningBackup {
  return { format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0, deletionJournal: [], objects: [], tables: {
    workspace_preferences: [preference()], courses: [course()], course_asset_memberships: [member()],
    opening_sources: [{ id: sourceId, workspace_id: workspaceId, version: 1 }],
  } };
}
const emptyTarget = { workspacePreferences: null, courses: [] };
const options = { confirmLocalRestore: true, currentLearningState: emptyTarget };

it("plans included courses before their source memberships and linked learning rows", () => {
  const value = backup();
  value.tables.opening_learning_sessions = [{ workspace_id: workspaceId, course_id: courseId }];
  const result = planOpeningRestoreApply(value, [], options);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const names = result.plan.batches.map(batch => batch.table);
  expect(names.indexOf("courses")).toBeLessThan(names.indexOf("opening_learning_sessions"));
  expect(names.indexOf("opening_sources")).toBeLessThan(names.indexOf("course_asset_memberships"));
  expect(result.plan.batches).toContainEqual({ table: "workspace_preferences", rows: 1 });
  expect(result.plan.batches).toContainEqual({ table: "course_asset_memberships", rows: 1 });
});

it("requires current target state when the archive can overwrite learning choices", () => {
  const result = planOpeningRestoreApply(backup(), [], { confirmLocalRestore: true });
  expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining("current learning state")] });
});

it("keeps legacy absent learning state absent and still checks external courses", () => {
  const value = backup();
  delete value.tables.workspace_preferences; delete value.tables.courses; delete value.tables.course_asset_memberships;
  value.tables.opening_learning_sessions = [{ workspace_id: workspaceId, course_id: courseId }];
  expect(planOpeningRestoreApply(value, [], { confirmLocalRestore: true }).ok).toBe(false);
  const result = planOpeningRestoreApply(value, [], { confirmLocalRestore: true, availableCourseIds: [courseId] });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.plan.batches.filter(batch => ["workspace_preferences", "courses"].includes(batch.table)))
    .toEqual([{ table: "workspace_preferences", rows: 0 }, { table: "courses", rows: 0 }]);
  expect(value.tables).not.toHaveProperty("workspace_preferences");
});

describe("current closure and activation boundaries", () => {
  it.each(["assessment_enabled", "retest_suggestions_enabled", "automatic_reminders_enabled"])("does not enable account %s when the target only chose a default entry", key => {
    const current = { workspace_id: workspaceId, default_entry: "library", assessment_enabled: null,
      retest_suggestions_enabled: null, automatic_reminders_enabled: null,
      retest_suggestions_enabled_at: null, automatic_reminders_enabled_at: null,
      created_at: new Date(later), updated_at: new Date(later) };
    const value = backup();
    value.tables.workspace_preferences = [{ ...current, assessment_enabled: false,
      retest_suggestions_enabled: false, automatic_reminders_enabled: false, [key]: true }];
    const result = planOpeningRestoreApply(value, [], { ...options,
      currentLearningState: { workspacePreferences: current, courses: [] } });
    expect(result).toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED",
      errors: [expect.stringContaining(`closed learning preference: ${key}`)] });
  });
  it("retains explicit account closure instead of replacing it with unknown", () => {
    const value = backup(); (value.tables.workspace_preferences[0] as Record<string, unknown>).assessment_enabled = null;
    expect(planOpeningRestoreApply(value, [], { ...options,
      currentLearningState: { workspacePreferences: { ...preference(), assessment_enabled: false }, courses: [] } }).ok).toBe(false);
  });
  it("keeps course null as inheritance rather than an account-level closure", () => {
    const current = { ...course(), assessment_enabled: null, retest_suggestions_enabled: null, automatic_reminders_enabled: null };
    expect(planOpeningRestoreApply(backup(), [], { ...options,
      currentLearningState: { workspacePreferences: preference(), courses: [current] } }).ok).toBe(true);
  });
  it.each(["assessment_enabled", "retest_suggestions_enabled", "automatic_reminders_enabled"])("does not undo account %s=false", key => {
    const result = planOpeningRestoreApply(backup(), [], { ...options,
      currentLearningState: { workspacePreferences: { ...preference(), [key]: false }, courses: [] } });
    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining("closed learning preference")] });
  });
  it.each([true, null])("does not undo course closure with %s", incoming => {
    const value = backup(); (value.tables.courses[0] as Record<string, unknown>).assessment_enabled = incoming;
    const result = planOpeningRestoreApply(value, [], { ...options,
      currentLearningState: { workspacePreferences: null, courses: [{ ...course(), assessment_enabled: false }] } });
    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining("closed learning preference")] });
  });
  it("does not unarchive a current course", () => {
    const result = planOpeningRestoreApply(backup(), [], { ...options,
      currentLearningState: { workspacePreferences: null, courses: [{ ...course(), archived_at: later }] } });
    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining("archived course")] });
  });
  it.each(["retest_suggestions_enabled_at", "automatic_reminders_enabled_at"])("does not rewind %s", key => {
    const result = planOpeningRestoreApply(backup(), [], { ...options,
      currentLearningState: { workspacePreferences: { ...preference(), [key]: later }, courses: [] } });
    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining("activation time")] });
    const courseResult = planOpeningRestoreApply(backup(), [], { ...options,
      currentLearningState: { workspacePreferences: null, courses: [{ ...course(), [key]: later }] } });
    expect(courseResult.ok).toBe(false);
  });
  it.each(["retest_suggestions_enabled_at", "automatic_reminders_enabled_at"])("compares all PostgreSQL microseconds in %s", key => {
    const value = backup(), older = "2026-09-29T00:00:00.000100Z", newer = "2026-09-29T00:00:00.000900Z";
    (value.tables.workspace_preferences[0] as Record<string, unknown>)[key] = older;
    (value.tables.courses[0] as Record<string, unknown>)[key] = older;
    expect(planOpeningRestoreApply(value, [], { ...options,
      currentLearningState: { workspacePreferences: { ...preference(), [key]: newer }, courses: [] } }).ok).toBe(false);
    expect(planOpeningRestoreApply(value, [], { ...options,
      currentLearningState: { workspacePreferences: null, courses: [{ ...course(), [key]: newer }] } }).ok).toBe(false);
  });
  it.each([at, new Date(at), "2026-09-20T08:00:00.000000+08:00"])("accepts equivalent legacy activation timestamp %s", current => {
    const value = backup(); (value.tables.workspace_preferences[0] as Record<string, unknown>).retest_suggestions_enabled_at = "2026-09-20T00:00:00.000000Z";
    expect(planOpeningRestoreApply(value, [], { ...options,
      currentLearningState: { workspacePreferences: { ...preference(), retest_suggestions_enabled_at: current }, courses: [] } }).ok).toBe(true);
  });
  it("accepts matching closed and archived state without changing input rows", () => {
    const value = backup(), row = value.tables.courses[0] as Record<string, unknown>;
    row.archived_at = later; row.assessment_enabled = false;
    const original = structuredClone(value);
    expect(planOpeningRestoreApply(value, [], { ...options,
      currentLearningState: { workspacePreferences: preference(), courses: [row] } }).ok).toBe(true);
    expect(value).toEqual(original);
  });
  it("rejects foreign or incomplete current state instead of assuming a clean target", () => {
    expect(planOpeningRestoreApply(backup(), [], { ...options, currentLearningState: {
      workspacePreferences: { ...preference(), workspace_id: sourceId }, courses: [],
    } }).ok).toBe(false);
    expect(planOpeningRestoreApply(backup(), [], { ...options, currentLearningState: {} as typeof emptyTarget }).ok).toBe(false);
  });
});

it.each(["document", "block", "card"])("does not admit %s memberships without their native assets", type => {
  const value = backup(); (value.tables.course_asset_memberships[0] as Record<string, unknown>).asset_type = type;
  expect(validateOpeningRestore(value, []).errors).toContain("Opening backup only supports source course memberships");
});
it("rejects unresolved, excluded and cross-workspace source memberships", () => {
  const value = backup();
  value.tables.opening_sources = [];
  expect(validateOpeningRestore(value, []).errors).toContain("course membership source is not included");
  const excluded = backup();
  expect(validateOpeningRestore(excluded, [{ sourceId, deletedAt: later }]).errors)
    .toContain("table course_asset_memberships references a deleted source");
  (excluded.tables.course_asset_memberships[0] as Record<string, unknown>).workspace_id = sourceId;
  expect(validateOpeningRestore(excluded, []).allowed).toBe(false);
});
it.each([
  ["courses", "assessment_enabled", "true"], ["courses", "archived_at", "not-a-time"],
  ["workspace_preferences", "automatic_reminders_enabled_at", "not-a-time"],
  ["course_asset_memberships", "course_id", sourceId], ["course_asset_memberships", "visibility", "bad"],
] as const)("rejects invalid %s %s", (table, key, value) => {
  const input = backup(); (input.tables[table][0] as Record<string, unknown>)[key] = value;
  expect(validateOpeningRestore(input, []).allowed).toBe(false);
});
it("rejects duplicate course identities, slugs and memberships", () => {
  for (const table of ["courses", "workspace_preferences", "course_asset_memberships"]) {
    const value = backup(); value.tables[table].push(value.tables[table][0]);
    expect(validateOpeningRestore(value, []).allowed).toBe(false);
  }
});
it("preserves null account choices as unknown without turning them on", () => {
  const value = backup(), row = value.tables.workspace_preferences[0] as Record<string, unknown>;
  row.assessment_enabled = null; row.retest_suggestions_enabled = null; row.automatic_reminders_enabled = null;
  expect(planOpeningRestoreApply(value, [], options).ok).toBe(true);
  expect(row.assessment_enabled).toBeNull();
});
it("composes the new optional state tables alongside a legacy complete table inventory", () => {
  const value = backup();
  const legacy = ["opening_sources", "opening_source_chunks", "opening_conversations", "opening_turns", "opening_learning_sessions",
    "opening_problem_refs", "opening_help_exposures", "opening_learning_observations", "opening_assistant_candidates", "opening_memories",
    "opening_privacy_exclusions", "opening_tasks", "opening_retest_activities", "opening_timetable_sessions", "opening_hard_blocks",
    "opening_plan_state", "opening_plan_drafts", "opening_plan_acceptances", "opening_source_versions", "opening_learning_item_versions",
    "opening_learning_attempts", "opening_learning_history_revisions"];
  value.tables = { ...Object.fromEntries(legacy.map(table => [table, []])), ...value.tables };
  value.tables.opening_sources = [{ id: sourceId, workspace_id: workspaceId, version: 1, bytes: 4, sha256: "ab".repeat(32) }];
  const result = composeOpeningBackupDraft({ records: { ...value, tables: value.tables as Record<string, Record<string, unknown>[]> }, staging: {
    snapshot: { workspaceId, privacyEpoch: 0, deletionJournal: [], sources: [{ sourceId, version: 1, bytes: 4, sha256: "ab".repeat(32) }] },
    objects: [{ sourceId, bytes: 4, sha256: "ab".repeat(32), actualSha256: "ab".repeat(32), archivePath: `objects/${sourceId}/v1.bin` }],
  } });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.backup.tables.courses).toEqual([course()]);
});
