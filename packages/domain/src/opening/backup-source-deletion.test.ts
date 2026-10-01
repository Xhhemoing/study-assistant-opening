import { describe, expect, it } from "vitest";
import { composeOpeningBackupDraft } from "./backup-compose";
import { BACKUP_TABLES } from "./backup-compose-validation";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
describe("asset deletion journal composition", () => {
  it("carries the distinct deletion time and rejects loss between inventory and staging", () => {
    const mark = { sourceId, deletedAt: "2026-09-20T00:00:00.000Z", assetDeletedAt: "2026-09-22T00:00:00.000Z" };
    const tables = Object.fromEntries([...BACKUP_TABLES].map(name => [name, [] as Record<string, unknown>[]]));
    tables.opening_privacy_exclusions = [{ workspace_id: workspaceId, source_id: sourceId, deleted_at: new Date(mark.deletedAt), asset_deleted_at: new Date(mark.assetDeletedAt) }];
    const memoryDeletions = { workspaceId, memories: [] };
    const records = { privacyEpoch: 2, deletionJournal: [mark], memoryDeletions, tables };
    const staging = { snapshot: { workspaceId, privacyEpoch: 2, deletionJournal: [mark], memoryDeletions, sources: [] }, objects: [] };
    const result = composeOpeningBackupDraft({ records, staging });
    expect(result).toMatchObject({ ok: true, backup: { deletionJournal: [mark] } });
    expect(composeOpeningBackupDraft({ records, staging: { ...staging, snapshot: { ...staging.snapshot, deletionJournal: [{ sourceId, deletedAt: mark.deletedAt }] } } }))
      .toMatchObject({ ok: false, code: "JOURNAL_MISMATCH" });
  });
});
