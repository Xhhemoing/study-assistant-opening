import { describe, expect, it } from "vitest";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";

const SOURCE = "11111111-1111-4111-8111-111111111111";

function backup(overrides: Partial<OpeningBackup> = {}): OpeningBackup {
  return {
    format: "opening-backup",
    version: 1,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    privacyEpoch: 4,
    deletionJournal: [{ sourceId: SOURCE, deletedAt: "2026-09-21T00:00:00.000Z" }],
    tables: { opening_sources: [{ id: SOURCE }] },
    objects: [{ sourceId: SOURCE, sha256: "ab".repeat(32), bytes: 12, archivePath: "objects/a.bin" }],
    ...overrides,
  };
}

describe("opening restore preview", () => {
  it("rejects a deleted source, a wrong hash, and an unknown backup version", () => {
    const deleted = validateOpeningRestore(backup(), [{ sourceId: SOURCE, deletedAt: "2026-09-22T00:00:00.000Z" }]);
    expect(deleted.allowed).toBe(false);
    expect(deleted.errors.join(" ")).toMatch(/deleted/i);

    const wrongHash = validateOpeningRestore(
      backup({ deletionJournal: [], objects: [{ sourceId: SOURCE, sha256: "cd".repeat(32), bytes: 12, archivePath: "objects/a.bin", actualSha256: "ab".repeat(32) }] }),
      [],
    );
    expect(wrongHash.allowed).toBe(false);
    expect(wrongHash.errors.join(" ")).toMatch(/hash/i);

    const unknown = validateOpeningRestore({ ...backup({ deletionJournal: [] }), version: 2 }, []);
    expect(unknown.allowed).toBe(false);
    expect(unknown.errors.join(" ")).toMatch(/version/i);
  });
});
