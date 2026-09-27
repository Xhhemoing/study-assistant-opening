import { describe, expect, it } from "vitest";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "11111111-1111-4111-8111-111111111111";
const turnId = "33333333-3333-4333-8333-333333333333";
const mark = { sourceId, deletedAt: "2026-09-23T00:00:00.000Z" };
function backup(tables: OpeningBackup["tables"] = {}): OpeningBackup {
  return { format: "opening-backup", version: 1, workspaceId, privacyEpoch: 4,
    deletionJournal: [], tables, objects: [] };
}
const row = (fields: Record<string, unknown>) => ({ workspace_id: workspaceId, ...fields });

describe("opening restore privacy boundary", () => {
  it.each([null, {}, { ...backup(), tables: null }, { ...backup(), objects: null },
    { ...backup(), deletionJournal: undefined }, { ...backup(), privacyEpoch: -1 },
    { ...backup(), tables: { opening_sources: [null] } },
    { ...backup(), tables: { opening_sources: {} } },
  ])("fails closed for malformed archives without throwing: %j", (input) => {
    expect(validateOpeningRestore(input, []).allowed).toBe(false);
  });

  it("accepts actual schema tables and rejects obsolete aliases and secrets", () => {
    expect(validateOpeningRestore(backup({ opening_source_chunks: [], opening_memories: [],
      opening_learning_sessions: [], opening_problem_refs: [], opening_help_exposures: [],
      opening_learning_observations: [], opening_assistant_candidates: [], opening_privacy_exclusions: [],
      opening_plan_drafts: [], opening_plan_acceptances: [], opening_timetable_sessions: [],
      opening_hard_blocks: [], opening_plan_state: [], opening_tasks: [] }), []).allowed).toBe(true);
    for (const table of ["opening_chunks", "opening_memory", "opening_plans", "sessions", "opening_jobs"]) {
      expect(validateOpeningRestore(backup({ [table]: [] }), []).allowed).toBe(false);
    }
  });

  it("rejects foreign or absent workspace scope on database rows", () => {
    for (const fields of [{ workspace_id: "44444444-4444-4444-8444-444444444444" }, {}]) {
      expect(validateOpeningRestore(backup({ opening_sources: [fields] }), []).allowed).toBe(false);
    }
  });

  it("rejects deleted source rows even when the object manifest is empty", () => {
    const input = backup({ opening_sources: [row({ id: sourceId })] });
    expect(validateOpeningRestore(input, [mark]).allowed).toBe(false);
    input.deletionJournal = [mark];
    expect(validateOpeningRestore(input, []).allowed).toBe(false);
  });

  it.each([
    ["opening_source_chunks", { source_id: sourceId }],
    ["opening_turns", { source_ids: [sourceId] }],
    ["opening_turns", { citations: [{ sourceId, sourceVersion: 0 }] }],
    ["opening_turns", { source_versions: { [sourceId]: 0 } }],
  ])("rejects excluded lineage in %s: %j", (table, fields) => {
    expect(validateOpeningRestore(backup({ [table]: [row(fields)] }), [mark]).allowed).toBe(false);
  });

  it("accepts source-owned chunks without a workspace column", () => {
    const input = backup({ opening_sources: [row({ id: sourceId, version: 2 })],
      opening_source_chunks: [{ source_id: sourceId, source_version: 2 }] });
    expect(validateOpeningRestore(input, []).allowed).toBe(true);
    input.tables.opening_sources = [];
    expect(validateOpeningRestore(input, []).errors).toContain("chunk has no owned source");
  });

  it("rejects chunks whose source_version does not match the included source", () => {
    const input = backup({ opening_sources: [row({ id: sourceId, version: 2 })],
      opening_source_chunks: [{ source_id: sourceId, source_version: 1 }] });
    expect(validateOpeningRestore(input, []).errors).toContain("chunk source version does not match included source");
  });

  it("rejects memory linked through a citation-only excluded turn", () => {
    const input = backup({
      opening_turns: [row({ id: turnId, source_ids: [], citations: [{ sourceId, sourceVersion: 0 }] })],
      opening_memories: [row({ status: "active", source_turn_ids: [turnId] })],
    });
    expect(validateOpeningRestore(input, [mark]).errors).toContain("table opening_turns references a deleted source");
  });

  it.each([{ source_ids: "not-an-array" }, { citations: [null] },
    { citations: [{ sourceId, sourceVersion: -1 }] }, { citations: [{ sourceId, sourceVersion: 1.5 }] },
    { source_versions: [] }, { source_versions: { [sourceId]: -1 } },
    { source_versions: { [sourceId]: 1.5 } }, { source_id: 5 }])("rejects malformed lineage %j", (fields) => {
    expect(validateOpeningRestore(backup({ opening_turns: [row(fields)] }), []).errors)
      .toContain("table opening_turns has invalid source lineage");
  });

  it("accepts database uuid arrays and json text arrays, and still detects deleted sources", () => {
    const jsonIds = JSON.stringify([sourceId]);
    const citations = JSON.stringify([{ sourceId, sourceVersion: 0 }]);
    for (const fields of [{ source_ids: jsonIds }, { citations }]) {
      expect(validateOpeningRestore(backup({ opening_turns: [row(fields)] }), [mark]).errors)
        .toContain("table opening_turns references a deleted source");
    }
    expect(validateOpeningRestore(backup({
      opening_turns: [row({ source_ids: JSON.stringify([sourceId.toUpperCase()]) })],
    }), []).allowed).toBe(true);
  });

  it("fails closed on malformed json lineage and still reports deleted source rows", () => {
    const input = backup({
      opening_sources: [row({ id: sourceId, source_ids: "{not-json" })],
      opening_turns: [row({ citations: "[" })],
    });
    const errors = validateOpeningRestore(input, [mark]).errors;
    expect(errors).toContain("table opening_sources has invalid source lineage");
    expect(errors).toContain("table opening_turns has invalid source lineage");
    expect(errors).toContain("deleted source cannot be restored");
  });

  it("keeps privacy exclusion journal rows and requires their source in the journal", () => {
    const excluded = backup({ opening_privacy_exclusions: [row({ source_id: sourceId, memory_id: null })] });
    expect(validateOpeningRestore(excluded, [mark]).allowed).toBe(true);
    expect(validateOpeningRestore(excluded, []).errors).toContain("privacy exclusion does not match deletion journal");
    const preserved = backup({ opening_privacy_exclusions: [row({ source_id: sourceId })] });
    expect(validateOpeningRestore(preserved, [mark]).recordCounts.opening_privacy_exclusions).toBe(1);
  });

  it("rejects memory whose source turns are not owned by the workspace", () => {
    const foreign = "55555555-5555-4555-8555-555555555555";
    const input = backup({
      opening_turns: [{ id: turnId, workspace_id: foreign, source_ids: [] }],
      opening_memories: [row({ status: "active", source_turn_ids: JSON.stringify([turnId]) })],
    });
    expect(validateOpeningRestore(input, []).errors).toContain("memory source turn is missing or invalid");
  });

  it("compares UUIDs case-insensitively across database and object records", () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const input = backup({ opening_sources: [row({ id: id.toUpperCase() })] });
    input.objects = [{ sourceId: id.toUpperCase(), sha256: "ab".repeat(32), bytes: 12, archivePath: "objects/a.bin" }];
    const result = validateOpeningRestore(input, [{ ...mark, sourceId: id }]);
    expect(result.errors.filter((error) => error.includes("deleted source"))).toHaveLength(2);
  });

  it("rejects a deleted source nested in plan or candidate documents", () => {
    const nested = backup({ opening_plan_drafts: [row({ blocks: [{ sourceId }] })] });
    expect(validateOpeningRestore(nested, [mark]).errors).toContain("table opening_plan_drafts references a deleted source");
    const malformed = backup({ opening_assistant_candidates: [row({ payload: { sourceId: "bad" } })] });
    expect(validateOpeningRestore(malformed, []).errors).toContain("table opening_assistant_candidates has invalid source lineage");
  });

  it("rejects active memories with missing provenance and deleted memory payloads", () => {
    for (const fields of [
      { status: "active", source_turn_ids: [turnId] },
      { status: "active", source_turn_ids: [] },
      { status: "deleted", source_turn_ids: [turnId] },
    ]) {
      expect(validateOpeningRestore(backup({ opening_memories: [row(fields)] }), []).allowed).toBe(false);
    }
  });

  it("accepts clean linked memory without mutating the archive", () => {
    const input = backup({
      opening_turns: [row({ id: turnId, source_ids: [], citations: [] })],
      opening_memories: [row({ status: "active", source_turn_ids: [turnId] })],
    });
    const before = structuredClone(input);
    expect(validateOpeningRestore(input, [])).toEqual({ allowed: true, errors: [],
      recordCounts: { opening_turns: 1, opening_memories: 1 } });
    expect(input).toEqual(before);
  });

  it.each(["../secret", "/absolute", "objects/../secret", "objects\\file", "C:/file", "objects//file"])(
    "rejects unsafe object archive path %s", (archivePath) => {
      const input = backup();
      input.objects = [{ sourceId, sha256: "ab".repeat(32), bytes: 12, archivePath }];
      expect(validateOpeningRestore(input, []).allowed).toBe(false);
    },
  );

  it("rejects invalid current deletion metadata rather than ignoring it", () => {
    expect(validateOpeningRestore(backup(), [{ sourceId, deletedAt: "not-a-date" }]).allowed).toBe(false);
  });
});
