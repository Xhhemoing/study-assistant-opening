import { expect, it } from "vitest";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";
import { sourceReferences } from "./backup-validation";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const referenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

it.each(["library_blocks", "library_revisions"])("checks only typed block citations in %s", table => {
  const documentId = "33333333-3333-4333-8333-333333333333";
  const id = "44444444-4444-4444-8444-444444444444";
  const block = { id, type: "text", position: 0, content: {
    meta: { sourceId: "external-reference", referenceSourceId: referenceId },
  } };
  const row = { id, document_id: documentId, workspace_id: workspaceId };
  const archive: OpeningBackup = { format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0,
    deletionJournal: [], objects: [], tables: { library_documents: [{ id: documentId, workspace_id: workspaceId }] } };
  const currentJournal = [{ sourceId: referenceId, deletedAt: "2026-09-28T00:00:00.000Z" }];
  const addBlock = (content: Record<string, unknown>) => {
    archive.tables[table] = [table === "library_blocks" ? { ...row, content } : { ...row, blocks: [{ ...block, content }] }];
  };
  addBlock(block.content);
  expect(validateOpeningRestore(archive, currentJournal)).toMatchObject({ allowed: true, errors: [] });

  const citationBinding = { blockId: id, role: "teach", status: "bound", factualSupport: "unverified",
    refs: [{ sourceId: referenceId.toUpperCase(), sourceVersion: 1, chunkId: id, page: null }] };
  addBlock({ ...block.content, citationBinding });
  expect(validateOpeningRestore(archive, []).errors).toContain(`table ${table} references a source missing from the backup`);
  expect(validateOpeningRestore(archive, currentJournal).errors).toContain(`table ${table} references a deleted source`);
  addBlock({ ...block.content, citationBinding: { ...citationBinding, refs: [{ sourceId: "external-reference", sourceVersion: 1 }] } });
  expect(validateOpeningRestore(archive, []).errors).toContain(`table ${table} has invalid source lineage`);
});

it("rejects restoring a historical check whose only source link is reference_check.referenceId", () => {
  const archive: OpeningBackup = {
    format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0,
    deletionJournal: [], objects: [], tables: {
      opening_learning_observations: [{ workspace_id: workspaceId, source_ids: [], reference_source_id: null,
        reference_check: { referenceId: referenceId.toUpperCase() } }],
    },
  };
  expect(validateOpeningRestore(archive, [{ sourceId: referenceId, deletedAt: "2026-09-28T00:00:00.000Z" }]).errors)
    .toContain("table opening_learning_observations references a deleted source");
});

it("collects an owned reference check source without changing the saved fact", () => {
  const row = { reference_check: { referenceId: referenceId.toUpperCase(), method: "Compare every step" } };
  const before = structuredClone(row);
  expect(sourceReferences(row)).toEqual([referenceId]);
  expect(row).toEqual(before);
});

it.each([{}, { referenceId: null }, { referenceId: "not-a-source" }, [], "invalid"].map(reference_check => ({ reference_check })))(
  "rejects malformed check provenance at the archive boundary: $reference_check", ({ reference_check }) => {
    expect(sourceReferences({ reference_check })).toBeNull();
  },
);

it("keeps legacy null checks and unrelated referenceId documents compatible", () => {
  expect(sourceReferences({ reference_check: null })).toEqual([]);
  expect(sourceReferences({})).toEqual([]);
  expect(sourceReferences({ payload: { referenceId: "non-source-business-reference" } })).toEqual([]);
});

it("accepts source-free question lineage only for question tables and retains malformed-source rejection", () => {
  const row = { workspace_id: workspaceId, source_id: null, source_version: null, stem_snapshot: "17 × 23" };
  const backup = (table: string, question: Record<string, unknown> = row): OpeningBackup => ({ format: "opening-backup", version: 1,
    workspaceId, privacyEpoch: 0, deletionJournal: [], objects: [], tables: { [table]: [question] } });
  for (const table of ["opening_problem_refs", "opening_learning_item_versions"]) {
    expect(validateOpeningRestore(backup(table), []).allowed).toBe(true);
    expect(validateOpeningRestore(backup(table, { ...row, source_id: "invalid" }), []).allowed).toBe(false);
  }
  expect(validateOpeningRestore(backup("opening_source_chunks"), []).allowed).toBe(false);
  expect(sourceReferences(row)).toBeNull();
});
