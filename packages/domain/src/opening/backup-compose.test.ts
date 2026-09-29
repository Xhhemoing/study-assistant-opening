import { describe, expect, it } from "vitest";
import {
  composeOpeningBackupDraft,
  type OpeningBackupComposeInput,
} from "./backup-compose";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "11111111-1111-4111-8111-111111111111";
const hash = "ab".repeat(32);
const backupTables = [
  "opening_sources", "opening_source_chunks", "opening_conversations", "opening_turns",
  "opening_learning_sessions", "opening_problem_refs", "opening_help_exposures",
  "opening_learning_observations", "opening_assistant_candidates", "opening_memories",
  "opening_privacy_exclusions", "opening_tasks", "opening_retest_activities", "opening_timetable_sessions", "opening_hard_blocks",
  "opening_plan_state", "opening_plan_drafts", "opening_plan_acceptances",
  "opening_source_versions", "opening_learning_item_versions", "opening_learning_attempts", "opening_learning_history_revisions",
] as const;

function input(overrides: Partial<OpeningBackupComposeInput> = {}): OpeningBackupComposeInput {
  return {
    records: {
      privacyEpoch: 4,
      deletionJournal: [],
      tables: Object.fromEntries(backupTables.map((table) => [table, table === "opening_sources"
        ? [{ id: sourceId, workspace_id: workspaceId, version: 2, bytes: 12, sha256: hash }]
        : []])),
      },
    staging: {
      snapshot: {
        workspaceId,
        privacyEpoch: 4,
        deletionJournal: [],
        sources: [{ sourceId, version: 2, bytes: 12, sha256: hash }],
      },
      objects: [{ sourceId, sha256: hash, bytes: 12, archivePath: `objects/${sourceId}/v2.bin`, actualSha256: hash }],
    },
    ...overrides,
  };
}

describe("composeOpeningBackupDraft", () => {
  it("joins matching records and staged objects into a validated draft", () => {
    const result = composeOpeningBackupDraft(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backup).toMatchObject({ format: "opening-backup", version: 1, workspaceId, privacyEpoch: 4 });
    expect(result.backup.objects[0]).not.toHaveProperty("actualSha256");
  });

  it.each([
    ["EPOCH_MISMATCH", { records: { ...input().records, privacyEpoch: 5 } }],
    ["WORKSPACE_MISMATCH", { staging: { ...input().staging, snapshot: { ...input().staging.snapshot, workspaceId: "33333333-3333-4333-8333-333333333333" } } }],
    ["JOURNAL_MISMATCH", { records: { ...input().records, deletionJournal: [{ sourceId, deletedAt: "2026-09-21T00:00:00.000Z" }] } }],
  ] as const)("rejects %s before preview", (code, overrides) => {
    const result = composeOpeningBackupDraft(input(overrides));
    expect(result).toMatchObject({ ok: false, code });
  });

  it("rejects missing, extra, or mismatched source objects", () => {
    const missing = composeOpeningBackupDraft(input({ staging: { ...input().staging, objects: [] } }));
    expect(missing).toMatchObject({ ok: false, code: "OBJECT_MISMATCH" });
    const extra = composeOpeningBackupDraft(input({ staging: { ...input().staging, objects: [
      ...input().staging.objects,
      { sourceId: "44444444-4444-4444-8444-444444444444", sha256: hash, bytes: 12, archivePath: "objects/extra.bin" },
    ] } }));
    expect(extra).toMatchObject({ ok: false, code: "OBJECT_MISMATCH" });
    const wrong = composeOpeningBackupDraft(input({ staging: { ...input().staging, objects: [
      { ...input().staging.objects[0], bytes: 13 },
    ] } }));
    expect(wrong).toMatchObject({ ok: false, code: "OBJECT_METADATA_MISMATCH" });
  });

  it("requires the table exclusion journal to match both snapshots", () => {
    const deletedId = "33333333-3333-4333-8333-333333333333";
    const records = input();
    records.records = {
      ...records.records,
      deletionJournal: [{ sourceId: deletedId, deletedAt: "2026-09-21T00:00:00.000Z" }],
      tables: {
        ...records.records.tables,
        opening_privacy_exclusions: [{
          id: "55555555-5555-4555-8555-555555555555",
          workspace_id: workspaceId,
          source_id: deletedId,
          deleted_at: "2026-09-21T00:00:00.000Z",
        }],
      },
    };
    const result = composeOpeningBackupDraft(records);
    expect(result).toMatchObject({ ok: false, code: "JOURNAL_MISMATCH" });
  });

  it("rejects duplicate journals, unsafe paths, and missing actual digests", () => {
    const mark = { sourceId: "33333333-3333-4333-8333-333333333333", deletedAt: "2026-09-21T00:00:00.000Z" };
    const duplicate = input({ records: { ...input().records, deletionJournal: [mark, mark] }, staging: {
      ...input().staging, snapshot: { ...input().staging.snapshot, deletionJournal: [mark, mark] },
    } });
    expect(composeOpeningBackupDraft(duplicate)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(composeOpeningBackupDraft(input({ staging: { ...input().staging, objects: [
      { ...input().staging.objects[0], archivePath: "objects/../secret", actualSha256: undefined },
    ] } }))).toMatchObject({ ok: false, code: "OBJECT_METADATA_MISMATCH" });
  });

  it("rejects unknown tables and foreign workspace rows before preview", () => {
    const unknown = composeOpeningBackupDraft(input({ records: {
      ...input().records, tables: { ...input().records.tables, opening_jobs: [] },
    } }));
    expect(unknown).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const foreign = composeOpeningBackupDraft(input({ records: {
      ...input().records, tables: { ...input().records.tables, opening_conversations: [{
        id: "66666666-6666-4666-8666-666666666666", workspace_id: "33333333-3333-4333-8333-333333333333",
      }] },
    } }));
    expect(foreign).toMatchObject({ ok: false, code: "WORKSPACE_MISMATCH" });
  });

  it("rejects a deleted source object and does not retain caller mutations", () => {
    const source = { ...input() };
    const mark = { sourceId, deletedAt: "2026-09-21T00:00:00.000Z" };
    source.records = {
      ...source.records,
      deletionJournal: [mark],
      tables: {
        ...source.records.tables,
        opening_privacy_exclusions: [{
          id: "55555555-5555-4555-8555-555555555555",
          workspace_id: workspaceId,
          source_id: sourceId,
          deleted_at: mark.deletedAt,
        }],
      },
    };
    source.staging = { ...source.staging, snapshot: { ...source.staging.snapshot, deletionJournal: [mark] } };
    const result = composeOpeningBackupDraft(source);
    expect(result).toMatchObject({ ok: false, code: "PREVIEW_REJECTED" });

    const clean = composeOpeningBackupDraft(input());
    expect(clean.ok).toBe(true);
    source.records.tables.opening_sources[0]!.bytes = 99;
    if (clean.ok) expect(clean.backup.tables.opening_sources[0]!.bytes).toBe(12);
  });
});
