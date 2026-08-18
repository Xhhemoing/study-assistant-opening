import { describe, expect, it } from "vitest";
import { backupExportRequestSchema, backupRestoreRequestSchema } from "@aistudy/contracts";
import { backupCopy, buildBackupExportRequest, buildBackupRestoreRequest } from "./backup-menu-model";
import { NATIVE_BACKUP_FORMAT_VERSION } from "@aistudy/contracts";

const packed = backupRestoreRequestSchema.parse({
  conflictPolicy: "skip",
  package: {
    format: "aistudy-native",
    schemaManifest: {
      formatVersion: NATIVE_BACKUP_FORMAT_VERSION,
      latestMigrationId: "0013_cards.sql",
      tables: ["workspaces"],
      workspaceSchemaVersion: 1,
    },
    sourceWorkspaceId: "11111111-1111-4111-8111-111111111111",
    counts: {
      workspaces: 1, courses: 0, memberships: 0, goals: 0, windows: 0,
      documents: 0, blocks: 0, relations: 0, revisions: 0, explorations: 0,
      promotions: 0, cards: 0, events: 0, files: 0,
    },
    records: {
      workspace: { id: "11111111-1111-4111-8111-111111111111" },
      courses: [], memberships: [], goals: [], windows: [], documents: [],
      blocks: [], relations: [], revisions: [], explorations: [], promotions: [],
      cards: [], events: [],
    },
    files: [],
  },
}).package;

describe("backup menu model", () => {
  it("builds requests without a client workspace id and describes a non-overwriting restore", () => {
    expect(buildBackupExportRequest()).toEqual({});
    expect(backupExportRequestSchema.parse({
      ...buildBackupExportRequest(),
      workspaceId: "22222222-2222-4222-8222-222222222222",
    })).toEqual({});
    expect(buildBackupRestoreRequest(packed, "reject")).toEqual({
      conflictPolicy: "reject",
      package: packed,
    });
    const copy = backupCopy(2);
    expect(copy.headline).toContain("完整备份");
    expect(copy.disclaimer).toContain("不会覆盖");
    expect(copy.restoreHint).toMatch(/拒绝|跳过/);
    expect(copy.resultSummary).toContain("2");
    expect(`${copy.headline}${copy.disclaimer}`).not.toMatch(/无损|lossless/i);
  });
});
