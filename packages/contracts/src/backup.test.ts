import { describe, expect, it } from "vitest";
import {
  NATIVE_BACKUP_FORMAT_VERSION,
  backupExportRequestSchema,
  backupExportResponseSchema,
  backupRestoreRequestSchema,
  backupRestoreResponseSchema,
  nativeBackupPackageSchema,
} from "./backup";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const cardId = "33333333-3333-4333-8333-333333333333";

function counts(overrides: Partial<Record<string, number>> = {}) {
  return {
    workspaces: 1,
    courses: 1,
    memberships: 1,
    goals: 1,
    windows: 1,
    documents: 1,
    blocks: 1,
    relations: 1,
    revisions: 1,
    explorations: 1,
    promotions: 1,
    cards: 1,
    events: 1,
    files: 1,
    ...overrides,
  };
}

function samplePackage() {
  return {
    format: "aistudy-native" as const,
    schemaManifest: {
      formatVersion: NATIVE_BACKUP_FORMAT_VERSION,
      latestMigrationId: "0013_cards.sql",
      tables: [
        "workspaces",
        "courses",
        "course_asset_memberships",
        "course_goals",
        "goal_time_windows",
        "library_documents",
        "library_blocks",
        "library_relations",
        "library_revisions",
        "explorations",
        "promotion_records",
        "cards",
        "learning_events",
      ],
      workspaceSchemaVersion: 1,
    },
    sourceWorkspaceId: workspaceId,
    counts: counts(),
    records: {
      workspace: { id: workspaceId, schemaVersion: 1 },
      courses: [{ id: "44444444-4444-4444-8444-444444444444" }],
      memberships: [{ id: "55555555-5555-4555-8555-555555555555" }],
      goals: [{ id: "66666666-6666-4666-8666-666666666666" }],
      windows: [{ id: "77777777-7777-4777-8777-777777777777" }],
      documents: [{ id: documentId }],
      blocks: [{ id: "88888888-8888-4888-8888-888888888888" }],
      relations: [{ id: "99999999-9999-4999-8999-999999999999" }],
      revisions: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      explorations: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
      promotions: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }],
      cards: [{ id: cardId }],
      events: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }],
    },
    files: [
      {
        path: "attachments/scan.png",
        mediaType: "image/png",
        sha256: "a".repeat(64),
        byteLength: 4,
        bytesBase64: "AQIDBA==",
      },
    ],
  };
}

describe("native backup contracts", () => {
  it("strips a client workspace id from export and restore requests", () => {
    expect(backupExportRequestSchema.parse({ workspaceId })).toEqual({});
    expect(
      backupRestoreRequestSchema.parse({
        workspaceId,
        conflictPolicy: "reject",
        package: samplePackage(),
      }).conflictPolicy,
    ).toBe("reject");
    expect(
      backupRestoreRequestSchema.parse({
        workspaceId,
        conflictPolicy: "skip",
        package: samplePackage(),
      }),
    ).not.toHaveProperty("workspaceId");
  });

  it("requires a versioned schema manifest, identity counts, and file hashes", () => {
    const parsed = nativeBackupPackageSchema.parse(samplePackage());
    expect(parsed.format).toBe("aistudy-native");
    expect(parsed.schemaManifest.formatVersion).toBe(NATIVE_BACKUP_FORMAT_VERSION);
    expect(parsed.counts.documents).toBe(1);
    expect(parsed.counts.relations).toBe(1);
    expect(parsed.counts.revisions).toBe(1);
    expect(parsed.counts.files).toBe(1);
    expect(parsed.files[0]?.sha256).toHaveLength(64);

    expect(() =>
      nativeBackupPackageSchema.parse({
        ...samplePackage(),
        schemaManifest: {
          ...samplePackage().schemaManifest,
          formatVersion: 0,
        },
      }),
    ).toThrow();
  });

  it("requires restore to name a conflict policy and never imply overwrite", () => {
    expect(() => backupRestoreRequestSchema.parse({ package: samplePackage() })).toThrow();
    expect(() =>
      backupRestoreRequestSchema.parse({
        conflictPolicy: "overwrite",
        package: samplePackage(),
      }),
    ).toThrow();

    const exported = backupExportResponseSchema.parse({
      format: "aistudy-native",
      package: samplePackage(),
    });
    expect(exported.package.sourceWorkspaceId).toBe(workspaceId);

    const restored = backupRestoreResponseSchema.parse({
      conflictPolicy: "skip",
      applied: counts({ documents: 0, cards: 0 }),
      skipped: counts({
        workspaces: 0,
        courses: 0,
        memberships: 0,
        goals: 0,
        windows: 0,
        documents: 1,
        blocks: 0,
        relations: 0,
        revisions: 0,
        explorations: 0,
        promotions: 0,
        cards: 1,
        events: 0,
        files: 0,
      }),
      warnings: [
        {
          code: "id-conflict",
          feature: "documents",
          message: "Existing document id was skipped.",
          documentId,
        },
      ],
    });
    expect(restored.conflictPolicy).toBe("skip");
    expect(restored.warnings[0]?.code).toBe("id-conflict");
  });
});
