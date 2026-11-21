import { describe, expect, it } from "vitest";
import { planOpeningRestoreApply } from "./backup-apply-plan";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";
import {
  noteProvenanceSourceReferences,
  sourceReferences,
  turnMemoryDependencyIds,
  turnSourceReferences,
} from "./backup-validation";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const ownerId = "33333333-3333-4333-8333-333333333333";
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherSourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const turnId = "44444444-4444-4444-8444-444444444444";
const conversationId = "55555555-5555-4555-8555-555555555555";
const candidateId = "66666666-6666-4666-8666-666666666666";
const mark = { sourceId, deletedAt: "2026-09-29T00:00:00.000Z" };
const currentMemoryDeletions = { workspaceId, memories: [] };
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

  it("accepts publication metadata on notes while requiring citations in other contexts", () => {
    const source = { sourceId, sourceVersion: 1, publication: true };
    const note = { context_source_refs: [source, { answerKeyBlockIds: [turnId] }, { publicationCardIds: [candidateId] }] };
    expect(noteProvenanceSourceReferences(note)).toEqual([sourceId]);
    expect(sourceReferences(note)).toBeNull();
    expect(noteProvenanceSourceReferences({ context_source_refs: [source, { answerKeyBlockIds: [null] }] })).toBeNull();
    expect(noteProvenanceSourceReferences({ context_source_refs: [{ sourceId, answerKeyBlockIds: [turnId] }] })).toBeNull();
  });

  it.each([{}, "[]", [null], [{}], [{ sourceId, sourceVersion: "1" }],
    [{ sourceId, sourceVersion: -1 }], [{ sourceId, sourceVersion: 1.5 }],
    [{ sourceId, sourceVersion: Number.MAX_SAFE_INTEGER + 1 }],
    [{ sourceId: "not-a-uuid", sourceVersion: 1 }],
  ].map(context_source_refs => ({ context_source_refs })))("rejects malformed context references $context_source_refs", (fields) => {
    expect(sourceReferences(fields)).toBeNull();
    expect(validateOpeningRestore(backup([turn(fields)]), [], currentMemoryDeletions).allowed).toBe(false);
  });

  it.each([{}, { context_source_refs: null }])("quarantines legacy assistant and dependent memory with unknown provenance %j", (fields) => {
    const input = backup([turn(fields)]);
    input.tables.opening_memories = [row({ id: candidateId, status: "active", source_turn_ids: [turnId] })];
    expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(false);
  });

  it.each([undefined, null, "system"])("rejects missing or unknown turn role %s even with explicit empty provenance", (role) => {
    expect(validateOpeningRestore(backup([turn({ role, context_source_refs: [] })]), [], currentMemoryDeletions).allowed).toBe(false);
  });

  it("accepts explicit empty assistant provenance and its linked memory", () => {
    const input = backup([turn({ context_source_refs: [] })]);
    input.tables.opening_memories = [row({ id: candidateId, status: "active", source_turn_ids: [turnId] })];
    expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(true);
  });

  it.each([{}, { context_source_refs: null }])("preserves original user leaves with legacy provenance %j", (fields) => {
    const input = backup([turn({ role: "user", text: "Original user text", ...fields })]);
    const before = structuredClone(input);
    expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(true);
    expect(input).toEqual(before);
  });

  it("overlays the current deletion journal on mixed context-only sources and dependent rows", () => {
    const input = backup([turn({ context_source_refs: [
      { sourceId: sourceId.toUpperCase(), sourceVersion: 1 },
      { sourceId, sourceVersion: 2 },
      { sourceId: otherSourceId, sourceVersion: 3 },
    ] })]);
    input.tables.opening_memories = [row({ id: candidateId, status: "active", source_turn_ids: [turnId] })];
    input.tables.opening_assistant_candidates = [row({ id: candidateId, conversation_id: conversationId,
      source_turn_id: turnId, source_ids: [], payload: {} })];
    const before = structuredClone(input);
    expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(true);
    expect(validateOpeningRestore(input, [mark], currentMemoryDeletions).errors).toContain("table opening_turns references a deleted source");
    expect(input).toEqual(before);
  });

  it.each([undefined, null, turnId])("rejects a candidate whose parent provenance is absent: %s", (source_turn_id) => {
    const input = backup([]);
    input.tables.opening_assistant_candidates = [row({ id: candidateId, conversation_id: conversationId,
      source_turn_id, source_ids: [], payload: {} })];
    expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(false);
  });

  it("accepts assistant turn memoryDependencyIds in restore validation and apply planning when backed by exported memories", () => {
    const originTurnId = "77777777-7777-4777-8777-777777777777";
    const memoryId = "88888888-8888-4888-8888-888888888888";
    const documentlessTurn = turn({ context_source_refs: [{ memoryDependencyIds: [memoryId.toUpperCase()] }] });
    expect(turnMemoryDependencyIds(documentlessTurn)).toEqual([memoryId]);
    expect(turnSourceReferences(documentlessTurn)).toEqual([]);

    const mixedTurn = turn({
      context_source_refs: [
        { sourceId, sourceVersion: 0, memoryOnly: true },
        { memoryDependencyIds: [memoryId] },
      ],
    });
    expect(turnMemoryDependencyIds(mixedTurn)).toEqual([memoryId]);
    expect(turnSourceReferences(mixedTurn)).toEqual([sourceId]);
    // Non-turn tables must still reject memoryDependencyIds strictly.
    expect(sourceReferences(documentlessTurn)).toBeNull();
    expect(noteProvenanceSourceReferences(documentlessTurn)).toBeNull();

    const originTurn = turn({ id: originTurnId, role: "user", context_source_refs: null });
    const memoryRow = row({ id: memoryId, status: "active", source_turn_ids: [originTurnId] });
    for (const assistantTurn of [documentlessTurn, mixedTurn]) {
      const input = backup([originTurn, assistantTurn]);
      input.tables.opening_memories = [memoryRow];
      const before = structuredClone(input);
      expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(true);
      expect(planOpeningRestoreApply(input, [], {
        confirmLocalRestore: true,
        currentMemoryDeletions,
      }).ok).toBe(true);
      expect(input).toEqual(before);
    }
  });

  it.each([
    { name: "empty array", refs: [{ memoryDependencyIds: [] }] },
    { name: "non-UUID element", refs: [{ memoryDependencyIds: ["not-a-uuid"] }] },
    { name: "extra property", refs: [{ memoryDependencyIds: [candidateId], extra: true }] },
    { name: "mixed sourceId and memoryDependencyIds", refs: [{ sourceId, sourceVersion: 0, memoryDependencyIds: [candidateId] }] },
    { name: "duplicate memory IDs", refs: [{ memoryDependencyIds: [candidateId, candidateId.toUpperCase()] }] },
    { name: "multiple metadata elements", refs: [{ memoryDependencyIds: [candidateId] }, { memoryDependencyIds: [turnId] }] },
    { name: "user turn carrying memoryDependencyIds", role: "user", refs: [{ memoryDependencyIds: [candidateId] }] },
  ])("rejects malformed turn memoryDependencyIds ($name)", ({ role, refs }) => {
    const malformedTurn = turn({ role: role ?? "assistant", context_source_refs: refs });
    expect(turnMemoryDependencyIds(malformedTurn)).toBeNull();
    expect(turnSourceReferences(malformedTurn)).toBeNull();
    const input = backup([malformedTurn]);
    const preview = validateOpeningRestore(input, [], currentMemoryDeletions);
    expect(preview.allowed).toBe(false);
    expect(preview.errors).toContain("table opening_turns has invalid source lineage");
  });

  it("rejects memoryDependencyIds on non-turn tables and rejects dangling or deleted turn memory dependencies", () => {
    const originTurnId = "77777777-7777-4777-8777-777777777777";
    const memoryId = "88888888-8888-4888-8888-888888888888";

    // 1. Non-turn table (opening_note_provenance) carrying memoryDependencyIds fails closed.
    const noteBackup = backup([]);
    noteBackup.tables.opening_note_provenance = [row({
      document_id: candidateId,
      context_source_refs: [{ memoryDependencyIds: [memoryId] }],
    })];
    expect(validateOpeningRestore(noteBackup, [], currentMemoryDeletions).errors)
      .toContain("table opening_note_provenance has invalid source lineage");

    // 2. Dangling memoryDependencyIds (missing from opening_memories) fails closed and requires live memory deletion facts.
    const danglingBackup = backup([turn({ context_source_refs: [{ memoryDependencyIds: [memoryId] }] })]);
    const missingFacts = validateOpeningRestore(danglingBackup, []);
    expect(missingFacts.allowed).toBe(false);
    expect(missingFacts.errors).toContain("current owner-scoped memory deletion facts are required");
    expect(missingFacts.errors).toContain("table opening_turns references a memory missing from the backup");

    // 3. Turn referencing a memory deleted in currentMemoryDeletions fails closed.
    const deletedBackup = backup([
      turn({ id: originTurnId, role: "user", context_source_refs: null }),
      turn({ context_source_refs: [{ memoryDependencyIds: [memoryId] }] }),
    ]);
    deletedBackup.tables.opening_memories = [row({ id: memoryId, status: "active", source_turn_ids: [originTurnId] })];
    const deletedFacts = {
      workspaceId,
      memories: [{ memoryId, deletedAt: "2026-11-21T00:00:00.000Z" }],
    };
    const deletedPreview = validateOpeningRestore(deletedBackup, [], deletedFacts);
    expect(deletedPreview.allowed).toBe(false);
    expect(deletedPreview.errors).toContain("table opening_turns references a deleted memory");
  });
});
