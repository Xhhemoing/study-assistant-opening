import { describe, expect, it } from "vitest";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";
import { planOpeningRestoreApply } from "./backup-apply-plan";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const memoryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const turnId = "33333333-3333-4333-8333-333333333333";
const deletedAt = "2026-09-30T00:00:00.000Z";
const empty = { workspaceId, memories: [] as Array<{ memoryId: string; deletedAt: string }> };
const deleted = { workspaceId, memories: [{ memoryId: memoryId.toUpperCase(), deletedAt }] };

function legacyBackup(): OpeningBackup {
  return { format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0, deletionJournal: [], objects: [], tables: {
    opening_turns: [{ id: turnId, workspace_id: workspaceId, role: "assistant", context_source_refs: [], source_ids: [], citations: [] }],
    opening_memories: [{ id: memoryId, workspace_id: workspaceId, status: "active", source_turn_ids: [turnId], text: "private memory" }],
  } };
}

describe("memory deletion across the backup boundary", () => {
  it("rejects a legacy active memory after a source-free deletion with an unchanged source journal", () => {
    const backup = legacyBackup();
    expect(validateOpeningRestore(backup, [], empty).allowed).toBe(true);
    expect(validateOpeningRestore(backup, [], deleted).allowed).toBe(false);
  });

  it("rejects an apply plan for that legacy memory", () => {
    expect(planOpeningRestoreApply(legacyBackup(), [], { confirmLocalRestore: true, currentMemoryDeletions: deleted }))
      .toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED" });
  });

  it("requires live facts for memory payloads instead of assuming an empty deletion list", () => {
    expect(validateOpeningRestore(legacyBackup(), []).allowed).toBe(false);
    expect(planOpeningRestoreApply(legacyBackup(), [], { confirmLocalRestore: true }).ok).toBe(false);
  });

  it("rejects a current snapshot from another workspace even when empty", () => {
    expect(validateOpeningRestore(legacyBackup(), [], { ...empty, workspaceId: turnId }).allowed).toBe(false);
  });

  it("overlays archived deletion facts even when the current workspace has no memory tombstones", () => {
    const backup = { ...legacyBackup(), memoryDeletions: deleted };
    expect(validateOpeningRestore(backup, [], empty).allowed).toBe(false);
  });

  it("requires current facts even when an archive only carries tombstones", () => {
    const backup = { ...legacyBackup(), memoryDeletions: deleted };
    backup.tables.opening_memories = [];
    expect(validateOpeningRestore(backup, []).allowed).toBe(false);
  });

  it("accepts known-empty current facts with uppercase workspace IDs without mutating either input", () => {
    const backup = legacyBackup();
    const current = { ...empty, workspaceId: workspaceId.toUpperCase() };
    const before = structuredClone({ backup, current });
    expect(validateOpeningRestore(backup, [], current).allowed).toBe(true);
    expect(planOpeningRestoreApply(backup, [], { confirmLocalRestore: true, currentMemoryDeletions: current }).ok).toBe(true);
    expect({ backup, current }).toEqual(before);
  });

  it("keeps legacy archives with no memory payload compatible", () => {
    const backup = legacyBackup();
    backup.tables.opening_memories = [];
    expect(validateOpeningRestore(backup, []).allowed).toBe(true);
  });

  it("rejects an archived deletion snapshot for a different workspace", () => {
    const backup = { ...legacyBackup(), memoryDeletions: { ...deleted, workspaceId: turnId } };
    expect(validateOpeningRestore(backup, [], empty).allowed).toBe(false);
  });

  it.each([null, {}, { ...empty, memories: [{ memoryId, deletedAt: "bad" }] },
    { ...empty, memories: [{ memoryId: "bad", deletedAt }] },
    { ...deleted, memories: [...deleted.memories, { memoryId, deletedAt }] },
    { ...deleted, memories: [{ memoryId, deletedAt, text: "should never be exported" }] },
  ])("rejects malformed or body-bearing deletion facts %j", (value) => {
    expect(validateOpeningRestore(legacyBackup(), [], value as typeof empty).allowed).toBe(false);
  });

  it("preserves original turns when a clean archive carries deletion facts", () => {
    const backup = { ...legacyBackup(), memoryDeletions: deleted };
    backup.tables.opening_memories = [];
    const before = structuredClone(backup);
    expect(validateOpeningRestore(backup, [], deleted).allowed).toBe(true);
    expect(planOpeningRestoreApply(backup, [], { confirmLocalRestore: true, currentMemoryDeletions: deleted }).ok).toBe(true);
    expect(backup).toEqual(before);
  });

  it("detects a later unrelated memory deletion at the apply boundary", () => {
    const backup = { ...legacyBackup(), memoryDeletions: empty };
    backup.tables.opening_memories = [];
    expect(planOpeningRestoreApply(backup, [], { confirmLocalRestore: true, currentMemoryDeletions: deleted }))
      .toMatchObject({ ok: false, code: "JOURNAL_DRIFT" });
  });
});
