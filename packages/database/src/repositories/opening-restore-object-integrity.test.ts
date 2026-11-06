import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OpeningBackup } from "@aistudy/domain";
import { prepareOpeningRestoreObjects } from "./opening-restore-object-integrity";
import { parseOpeningRestoreObjectVersion } from "./opening-backup-apply";

const workspaceId = "a1000000-0000-4000-8000-000000000001";
const sourceId = "c3000000-0000-4000-8000-000000000010";
function fixture() {
  const body = Uint8Array.from([1, 2, 3, 4]);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const backup: OpeningBackup = { format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0,
    deletionJournal: [], tables: { opening_sources: [{ id: sourceId, workspace_id: workspaceId, version: 1, bytes: 4, sha256 }] },
    objects: [{ sourceId, bytes: 4, sha256, archivePath: `objects/${sourceId}/v1.bin` }] };
  return { body, backup };
}
describe("restore object integrity snapshots", () => {
  it("accepts legacy current-source metadata and snapshots actual bodies", async () => {
    const { body, backup } = fixture();
    const verified = await prepareOpeningRestoreObjects(backup, parseOpeningRestoreObjectVersion, async () => body);
    body.fill(0);
    expect(verified[0]?.body).toEqual(Uint8Array.from([1, 2, 3, 4]));
  });
  it("accepts a historical version and matching explicit current version", async () => {
    const { body, backup } = fixture();
    backup.tables.opening_source_versions = [1, 2].map(version => ({ source_id: sourceId, workspace_id: workspaceId,
      version, bytes: 4, sha256: backup.objects[0]!.sha256 }));
    backup.objects.push({ ...backup.objects[0]!, archivePath: `objects/${sourceId}/v2.bin` });
    expect(await prepareOpeningRestoreObjects(backup, parseOpeningRestoreObjectVersion, async () => body)).toHaveLength(2);
  });
  it.each([Uint8Array.from([9, 9, 9, 9]), Uint8Array.from([1]), Uint8Array.from([1, 2, 3, 4, 5])])(
    "rejects real corrupt bytes despite a forged actualSha256", async body => {
      const { backup } = fixture(); backup.objects[0]!.actualSha256 = backup.objects[0]!.sha256;
      await expect(prepareOpeningRestoreObjects(backup, parseOpeningRestoreObjectVersion, async () => body))
        .rejects.toThrow(/body length or SHA256 mismatch/);
    });
  it("rejects a duplicate source-version manifest even with a different path spelling", async () => {
    const { body, backup } = fixture();
    backup.objects.push({ ...backup.objects[0]!, archivePath: `objects/${sourceId}/v01.bin` });
    await expect(prepareOpeningRestoreObjects(backup, parseOpeningRestoreObjectVersion, async () => body))
      .rejects.toThrow(/object integrity/);
  });
  it("checks manifests without reading absent bodies on deferred application", async () => {
    const { backup } = fixture();
    expect(await prepareOpeningRestoreObjects(backup, parseOpeningRestoreObjectVersion)).toEqual([]);
    backup.objects[0]!.bytes++;
    await expect(prepareOpeningRestoreObjects(backup, parseOpeningRestoreObjectVersion)).rejects.toThrow(/metadata mismatch/);
  });
});
