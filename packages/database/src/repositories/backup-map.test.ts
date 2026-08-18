import { describe, expect, it } from "vitest";
import { NativeBackupError } from "@aistudy/domain";
import { camelRow, filesFromBlocks, wrapBackupError, BackupRestoreError } from "./backup-map";

describe("backup dump helpers", () => {
  it("camelCases rows and extracts attachment bytes for the file manifest", () => {
    const row = camelRow({
      id: "11111111-1111-4111-8111-111111111111",
      workspace_id: "22222222-2222-4222-8222-222222222222",
      created_at: new Date("2026-08-15T00:00:00.000Z"),
    });
    expect(row).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-08-15T00:00:00.000Z",
    });
    expect(filesFromBlocks([{
      id: "33333333-3333-4333-8333-333333333333",
      type: "attachment",
      content: {
        href: "attachments/scan.png",
        mediaType: "image/png",
        bytesBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      },
    }])).toEqual([{
      path: "attachments/scan.png",
      mediaType: "image/png",
      bytes: Uint8Array.from([1, 2, 3, 4]),
    }]);
  });

  it("wraps native conflict errors so restore never overwrites", () => {
    expect(() => wrapBackupError(new NativeBackupError("ID_CONFLICT", "exists"))).toThrow(
      BackupRestoreError,
    );
    try {
      wrapBackupError(new NativeBackupError("ID_CONFLICT", "exists"));
    } catch (error) {
      expect(error).toMatchObject({ name: "BackupRestoreError", code: "CONFLICT" });
    }
  });
});
