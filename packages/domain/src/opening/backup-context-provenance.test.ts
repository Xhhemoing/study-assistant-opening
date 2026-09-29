import { describe, expect, it } from "vitest";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";
import { sourceReferences } from "./backup-validation";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const ownerId = "33333333-3333-4333-8333-333333333333";
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherSourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const turnId = "44444444-4444-4444-8444-444444444444";
const conversationId = "55555555-5555-4555-8555-555555555555";
const candidateId = "66666666-6666-4666-8666-666666666666";
const mark = { sourceId, deletedAt: "2026-09-29T00:00:00.000Z" };
const row = (fields: Record<string, unknown>) => ({ workspace_id: workspaceId, ...fields });
const turn = (fields: Record<string, unknown>) => row({
  id: turnId, conversation_id: conversationId, role: "assistant", source_ids: [], citations: [], source_versions: {},
  ...fields,
});
function backup(turns: Record<string, unknown>[]): OpeningBackup {
  return { format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0, deletionJournal: [], objects: [],
    tables: { opening_turns: turns, opening_conversations: [row({ id: conversationId, owner_user_id: ownerId })] } };
}

describe("context provenance at the backup boundary", () => {
  it("collects every context source version with normalized UUIDs without changing the row", () => {
    const input = { context_source_refs: [
      { sourceId: sourceId.toUpperCase(), sourceVersion: 1 },
      { sourceId, sourceVersion: 2 },
      { sourceId: otherSourceId, sourceVersion: 3 },
    ] };
    const before = structuredClone(input);
    expect(sourceReferences(input)).toEqual([sourceId, sourceId, otherSourceId]);
    expect(input).toEqual(before);
  });

  it.each([{}, "[]", [null], [{}], [{ sourceId, sourceVersion: "1" }],
    [{ sourceId, sourceVersion: -1 }], [{ sourceId, sourceVersion: 1.5 }],
    [{ sourceId, sourceVersion: Number.MAX_SAFE_INTEGER + 1 }],
    [{ sourceId: "not-a-uuid", sourceVersion: 1 }],
  ].map(context_source_refs => ({ context_source_refs })))("rejects malformed context references $context_source_refs", (fields) => {
    expect(sourceReferences(fields)).toBeNull();
    expect(validateOpeningRestore(backup([turn(fields)]), []).allowed).toBe(false);
  });

  it.each([{}, { context_source_refs: null }])("quarantines legacy assistant and dependent memory with unknown provenance %j", (fields) => {
    const input = backup([turn(fields)]);
    input.tables.opening_memories = [row({ status: "active", source_turn_ids: [turnId] })];
    expect(validateOpeningRestore(input, []).allowed).toBe(false);
  });

  it.each([undefined, null, "system"])("rejects missing or unknown turn role %s even with explicit empty provenance", (role) => {
    expect(validateOpeningRestore(backup([turn({ role, context_source_refs: [] })]), []).allowed).toBe(false);
  });

  it("accepts explicit empty assistant provenance and its linked memory", () => {
    const input = backup([turn({ context_source_refs: [] })]);
    input.tables.opening_memories = [row({ status: "active", source_turn_ids: [turnId] })];
    expect(validateOpeningRestore(input, []).allowed).toBe(true);
  });

  it.each([{}, { context_source_refs: null }])("preserves original user leaves with legacy provenance %j", (fields) => {
    const input = backup([turn({ role: "user", text: "Original user text", ...fields })]);
    const before = structuredClone(input);
    expect(validateOpeningRestore(input, []).allowed).toBe(true);
    expect(input).toEqual(before);
  });

  it("overlays the current deletion journal on mixed context-only sources and dependent rows", () => {
    const input = backup([turn({ context_source_refs: [
      { sourceId: sourceId.toUpperCase(), sourceVersion: 1 },
      { sourceId, sourceVersion: 2 },
      { sourceId: otherSourceId, sourceVersion: 3 },
    ] })]);
    input.tables.opening_memories = [row({ status: "active", source_turn_ids: [turnId] })];
    input.tables.opening_assistant_candidates = [row({ id: candidateId, conversation_id: conversationId,
      source_turn_id: turnId, source_ids: [], payload: {} })];
    const before = structuredClone(input);
    expect(validateOpeningRestore(input, []).allowed).toBe(true);
    expect(validateOpeningRestore(input, [mark]).errors).toContain("table opening_turns references a deleted source");
    expect(input).toEqual(before);
  });

  it.each([undefined, null, turnId])("rejects a candidate whose parent provenance is absent: %s", (source_turn_id) => {
    const input = backup([]);
    input.tables.opening_assistant_candidates = [row({ id: candidateId, conversation_id: conversationId,
      source_turn_id, source_ids: [], payload: {} })];
    expect(validateOpeningRestore(input, []).allowed).toBe(false);
  });
});
