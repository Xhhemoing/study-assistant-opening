import { describe, expect, it } from "vitest";
import { composeOpeningBackupDraft, type OpeningBackupComposeInput } from "./backup-compose";
import { BACKUP_TABLES } from "./backup-compose-validation";
import { normalizeOpeningRestoreHistory, validateOpeningRestore } from "./backup-policy";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "11111111-1111-4111-8111-111111111111";
const oldHash = "ab".repeat(32), newHash = "cd".repeat(32);
function input(): OpeningBackupComposeInput {
  const tables: Record<string, Record<string, unknown>[]> = Object.fromEntries([...BACKUP_TABLES].map(name => [name, []]));
  delete tables.opening_workspace_history_revisions;
  tables.opening_sources = [{ id: sourceId, workspace_id: workspaceId, version: 2, bytes: 12, sha256: newHash }];
  tables.opening_source_versions = [1, 2].map(version => ({ source_id: sourceId, workspace_id: workspaceId, version,
    bytes: 12, sha256: version === 1 ? oldHash : newHash, availability: "available" }));
  tables.opening_source_chunks = [{ source_id: sourceId, source_version: 1 }];
  tables.opening_learning_observations = [{ workspace_id: workspaceId, source_ids: [sourceId], source_versions: null }];
  tables.opening_learning_attempts = [];
  tables.opening_learning_item_versions = [];
  tables.opening_learning_history_revisions = [];
  const memoryDeletions = { workspaceId, memories: [] };
  return { records: { privacyEpoch: 0, deletionJournal: [], memoryDeletions, tables }, staging: {
    snapshot: { workspaceId, privacyEpoch: 0, deletionJournal: [], memoryDeletions, sources: [1,2].map(version => ({ sourceId, version,
      bytes: 12, sha256: version === 1 ? oldHash : newHash })) },
    objects: [1,2].map(version => ({ sourceId, bytes: 12, sha256: version === 1 ? oldHash : newHash,
      actualSha256: version === 1 ? oldHash : newHash, archivePath: `objects/${sourceId}/v${version}.bin` })),
  } };
}
describe("historical learning backup", () => {
  it("keeps both version objects and legacy unknown facts", () => {
    const result = composeOpeningBackupDraft(input());
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.backup.objects.map(o => o.archivePath)).toEqual([`objects/${sourceId}/v1.bin`, `objects/${sourceId}/v2.bin`]);
      expect(result.backup.tables.opening_learning_observations![0]).toMatchObject({ source_versions: null });
    }
  });
  it("retains unavailable and unknown versions without inventing an object", () => {
    const value = input();
    value.records.tables.opening_source_versions![0]!.availability = "unavailable";
    value.records.tables.opening_source_versions!.push({ source_id: sourceId, workspace_id: workspaceId, version: 0,
      bytes: null, sha256: null, availability: "unknown" });
    value.staging.snapshot.sources.shift(); value.staging.objects.shift();
    expect(composeOpeningBackupDraft(value)).toMatchObject({ ok: true });
  });
  it("rejects missing available objects and a reused current digest for history", () => {
    const missing = input(); missing.staging.objects.shift();
    expect(composeOpeningBackupDraft(missing).ok).toBe(false);
    const wrong = input(); wrong.staging.snapshot.sources[0]!.sha256 = newHash;
    expect(composeOpeningBackupDraft(wrong).ok).toBe(false);
  });
});
it("refuses a missing current object rather than producing an uploaded source without bytes", () => {
  const value=input();
  value.staging.unavailableSources=[{sourceId,version:2}];
  value.staging.objects.pop();
  expect(composeOpeningBackupDraft(value)).toMatchObject({ok:false,code:"OBJECT_MISMATCH"});
});
it("rejects an object whose source identity does not match its version path", () => {
  const value=input();
  value.staging.objects[0]!.sourceId="33333333-3333-4333-8333-333333333333";
  expect(composeOpeningBackupDraft(value)).toMatchObject({ok:false,code:"OBJECT_MISMATCH"});
});


const ownerUserId = "44444444-4444-4444-8444-444444444444";
function snapshotInput(): OpeningBackupComposeInput {
  const value = input();
  value.records.tables.opening_workspace_history_revisions = [{ workspace_id: workspaceId, owner_user_id: ownerUserId, revision: 12 }];
  value.records.tables.opening_learning_observations = [0, 3, 9].map(revision => ({
    workspace_id: workspaceId, owner_user_id: ownerUserId, workspace_history_revision: revision,
    source_ids: [sourceId], source_versions: null,
  }));
  return value;
}

describe("workspace snapshot history backup", () => {
  it("preserves the counter above retained facts and permits committed legacy zero facts", () => {
    const value = snapshotInput(), result = composeOpeningBackupDraft(value);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.backup.tables.opening_workspace_history_revisions).toEqual([
      { workspace_id: workspaceId, owner_user_id: ownerUserId, revision: 12 },
    ]);
    expect(result.backup.tables.opening_learning_observations!.map(row => (row as Record<string, unknown>).workspace_history_revision))
      .toEqual([0, 3, 9]);
    expect(normalizeOpeningRestoreHistory(result.backup)).toEqual(result.backup);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "12", null, undefined])("rejects invalid new counter %j", revision => {
    const value = snapshotInput();
    value.records.tables.opening_workspace_history_revisions![0]!.revision = revision;
    expect(composeOpeningBackupDraft(value).ok).toBe(false);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "3", null, undefined])("rejects invalid fact revision %j", revision => {
    const value = snapshotInput();
    value.records.tables.opening_learning_observations![0]!.workspace_history_revision = revision;
    expect(composeOpeningBackupDraft(value).ok).toBe(false);
  });

  it("rejects missing, behind, foreign-owner and duplicate workspace counters", () => {
    for (const rows of [[], [{ workspace_id: workspaceId, owner_user_id: ownerUserId, revision: 8 }],
      [{ workspace_id: workspaceId, owner_user_id: sourceId, revision: 12 }],
      [
        { workspace_id: workspaceId, owner_user_id: ownerUserId, revision: 12 },
        { workspace_id: workspaceId, owner_user_id: ownerUserId.toUpperCase(), revision: 13 },
      ],
    ]) {
      const value = snapshotInput();
      value.records.tables.opening_workspace_history_revisions = rows;
      expect(composeOpeningBackupDraft(value).ok).toBe(false);
    }
  });

  it("rejects partially stripped history metadata instead of reinterpreting it as legacy", () => {
    const noCounter = snapshotInput();
    delete noCounter.records.tables.opening_workspace_history_revisions;
    expect(composeOpeningBackupDraft(noCounter).ok).toBe(false);
    const noRevision = snapshotInput();
    delete noRevision.records.tables.opening_learning_observations![0]!.workspace_history_revision;
    expect(composeOpeningBackupDraft(noRevision).ok).toBe(false);
  });

  it("accepts the largest safe counter without requiring dense retained history", () => {
    const value = snapshotInput();
    value.records.tables.opening_workspace_history_revisions![0]!.revision = Number.MAX_SAFE_INTEGER;
    value.records.tables.opening_learning_observations![2]!.workspace_history_revision = Number.MAX_SAFE_INTEGER;
    expect(composeOpeningBackupDraft(value).ok).toBe(true);
  });

  it("converts legacy rows explicitly to zero without inventing order from course counters", () => {
    const value = input();
    value.records.tables.opening_learning_observations = [11, 3].map(historyRevision => ({
      workspace_id: workspaceId, owner_user_id: ownerUserId, history_revision: historyRevision,
    }));
    value.records.tables.opening_learning_history_revisions = [{ workspace_id: workspaceId, owner_user_id: ownerUserId, revision: 11 }];
    const result = composeOpeningBackupDraft(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = structuredClone(result.backup);
    const restored = normalizeOpeningRestoreHistory(result.backup);
    expect(restored.tables.opening_learning_observations).toEqual([
      { workspace_id: workspaceId, owner_user_id: ownerUserId, history_revision: 11, workspace_history_revision: 0 },
      { workspace_id: workspaceId, owner_user_id: ownerUserId, history_revision: 3, workspace_history_revision: 0 },
    ]);
    expect(restored.tables.opening_workspace_history_revisions).toEqual([
      { workspace_id: workspaceId, owner_user_id: ownerUserId, revision: 0 },
    ]);
    expect(result.backup).toEqual(before);
    expect(validateOpeningRestore(restored, [], { workspaceId, memories: [] }).allowed).toBe(true);
    expect(normalizeOpeningRestoreHistory(restored)).toEqual(restored);
  });
});
