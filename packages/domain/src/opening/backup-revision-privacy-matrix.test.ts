import { describe, expect, it } from "vitest";
import { normalizeOpeningRestoreHistory, validateOpeningRestore, type OpeningBackup } from "./backup-policy";
import { sourceReferences } from "./backup-validation";
import { privacyIds as id } from "./revision-privacy.fixtures";

type Row = Record<string, unknown>;
const row = (fields: Row): Row => ({ workspace_id: id.workspace, owner_user_id: id.owner, ...fields });
const mark = { sourceId: id.source, deletedAt: "2026-11-01T00:00:00.000Z" };
function archive(historical: Row): OpeningBackup {
  return { format: "opening-backup", version: 1, workspaceId: id.workspace, privacyEpoch: 4, deletionJournal: [], objects: [], tables: {
    opening_learning_observations: [
      row({ id: id.root, root_observation_id: id.root, revision_kind: "original", answer: "synthetic original", ...historical }),
      row({ id: id.head, root_observation_id: id.root, revises_observation_id: id.root, revision_kind: "replace", answer: "synthetic correction", reference_source_id: null, reference_check: null }),
    ],
  } };
}

const historicalRefs: Array<{ name: string; fields: Row }> = [
  { name: "reference column", fields: { reference_source_id: id.source } },
  { name: "reference check", fields: { reference_check: { referenceId: id.source, method: "comparison" } } },
  { name: "source array", fields: { source_ids: [id.source] } },
  { name: "source versions", fields: { source_versions: { [id.source]: 1 } } },
  { name: "citations", fields: { citations: [{ sourceId: id.source, sourceVersion: 1 }] } },
  { name: "context provenance", fields: { context_source_refs: [{ sourceId: id.source, sourceVersion: 1 }] } },
  { name: "nested captured input", fields: { input_snapshot: { previous: { sourceId: id.source } } } },
];

describe("privacy withdrawal overlays every retained revision, not only a cleared head (pure restore preflight)", () => {
  it.each(historicalRefs)("rejects excluded historical $name even with clean current replacement", ({ fields }) => {
    const value = archive(fields), before = structuredClone(value);
    expect(validateOpeningRestore(value, []).allowed).toBe(true);
    const result = validateOpeningRestore(value, [mark]);
    expect(result.allowed).toBe(false);
    expect(result.errors).toContain("table opening_learning_observations references a deleted source");
    expect(value).toEqual(before);
  });

  it.each(historicalRefs)("archive-carried withdrawal cannot be bypassed by an empty live journal: $name", ({ fields }) => {
    const value = archive(fields); value.deletionJournal = [mark];
    expect(validateOpeningRestore(value, []).errors).toContain("table opening_learning_observations references a deleted source");
    expect(value.tables.opening_learning_observations).toHaveLength(2);
  });

  it.each(["original", "replace", "retract"])("revision kind %s is not permission to revive historical private lineage", revisionKind => {
    const value = archive({ source_ids: [id.source] });
    (value.tables.opening_learning_observations![0] as Row).revision_kind = revisionKind;
    expect(validateOpeningRestore(value, [mark]).allowed).toBe(false);
  });

  it.each([1, 2, 0])("source withdrawal covers every historical source version %s", version => {
    const value = archive({ source_versions: { [id.source.toUpperCase()]: version } });
    expect(sourceReferences(value.tables.opening_learning_observations![0] as Row)).toContain(id.source);
    expect(validateOpeningRestore(value, [mark]).allowed).toBe(false);
  });

  it.each([false, true])("an unrelated deletion preserves original and corrected facts (reverse=%s)", reverse => {
    const value = archive({ source_ids: [id.otherSource] });
    if (reverse) value.tables.opening_learning_observations!.reverse();
    const before = structuredClone(value);
    expect(validateOpeningRestore(value, [mark]).allowed).toBe(true);
    expect(value).toEqual(before);
    expect(value.tables.opening_learning_observations).toHaveLength(2);
  });

  it.each([0, 3, 99])("legacy history normalization does not infer answer order from course revision %s", revision => {
    const value = archive({ history_revision: revision });
    const before = structuredClone(value);
    const restored = normalizeOpeningRestoreHistory(value);
    expect(restored.tables.opening_learning_observations).toEqual(value.tables.opening_learning_observations!.map(record => ({ ...(record as Row), workspace_history_revision: 0 })));
    expect(value).toEqual(before);
    expect(normalizeOpeningRestoreHistory(restored)).toEqual(restored);
  });
});
