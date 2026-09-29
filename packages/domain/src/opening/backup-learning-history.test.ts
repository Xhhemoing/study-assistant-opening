import { describe, expect, it } from "vitest";
import { composeOpeningBackupDraft, type OpeningBackupComposeInput } from "./backup-compose";
import { BACKUP_TABLES } from "./backup-compose-validation";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "11111111-1111-4111-8111-111111111111";
const oldHash = "ab".repeat(32), newHash = "cd".repeat(32);
function input(): OpeningBackupComposeInput {
  const tables: Record<string, Record<string, unknown>[]> = Object.fromEntries([...BACKUP_TABLES].map(name => [name, []]));
  tables.opening_sources = [{ id: sourceId, workspace_id: workspaceId, version: 2, bytes: 12, sha256: newHash }];
  tables.opening_source_versions = [1, 2].map(version => ({ source_id: sourceId, workspace_id: workspaceId, version,
    bytes: 12, sha256: version === 1 ? oldHash : newHash, availability: "available" }));
  tables.opening_source_chunks = [{ source_id: sourceId, source_version: 1 }];
  tables.opening_learning_observations = [{ workspace_id: workspaceId, source_ids: [sourceId], source_versions: null }];
  tables.opening_learning_attempts = [];
  tables.opening_learning_item_versions = [];
  tables.opening_learning_history_revisions = [];
  return { records: { privacyEpoch: 0, deletionJournal: [], tables }, staging: {
    snapshot: { workspaceId, privacyEpoch: 0, deletionJournal: [], sources: [1,2].map(version => ({ sourceId, version,
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
