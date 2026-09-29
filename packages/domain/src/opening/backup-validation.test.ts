import { expect, it } from "vitest";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";
import { sourceReferences } from "./backup-validation";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const referenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
