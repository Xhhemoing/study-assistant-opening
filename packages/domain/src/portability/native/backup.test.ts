import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NATIVE_BACKUP_FORMAT_VERSION,
  nativeBackupPackageSchema,
} from "@aistudy/contracts";
import {
  NATIVE_BACKUP_TABLES,
  RESTORE_TOPOLOGY,
  buildNativeBackup,
  planNativeRestore,
  NativeBackupError,
  type NativeBackupSnapshot,
} from "./index";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const COURSE = "33333333-3333-4333-8333-333333333333";
const DOC = "44444444-4444-4444-8444-444444444444";
const BLOCK = "55555555-5555-4555-8555-555555555555";
const REL = "66666666-6666-4666-8666-666666666666";
const REV = "77777777-7777-4777-8777-777777777777";
const GOAL = "88888888-8888-4888-8888-888888888888";
const WINDOW = "99999999-9999-4999-8999-999999999999";
const MEMBER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROMO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CARD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EVENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshot(): NativeBackupSnapshot {
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  return {
    sourceWorkspaceId: SOURCE,
    workspace: { id: SOURCE, schemaVersion: 1 },
    latestMigrationId: "0013_cards.sql",
    courses: [{ id: COURSE, title: "高数" }],
    memberships: [{ id: MEMBER, courseId: COURSE, assetId: DOC }],
    goals: [{ id: GOAL, courseId: COURSE, kind: "final-exam" }],
    windows: [{ id: WINDOW, goalId: GOAL, phase: "rehearsal" }],
    documents: [{ id: DOC, title: "导数" }],
    blocks: [{
      id: BLOCK,
      documentId: DOC,
      type: "attachment",
      content: { href: "attachments/scan.png" },
    }],
    relations: [{ id: REL, fromId: DOC, toId: BLOCK }],
    revisions: [{ id: REV, documentId: DOC, revisionNumber: 1 }],
    explorations: [{ id: EXP, title: "追问" }],
    promotions: [{ id: PROMO, explorationId: EXP }],
    cards: [{ id: CARD, front: "导数", back: "极限" }],
    events: [{ id: EVENT, type: "review", contentId: CARD }],
    files: [{
      path: "attachments/scan.png",
      mediaType: "image/png",
      bytes,
    }],
  };
}

describe("native backup package", () => {
  it("stamps a schema manifest and identity counts that survive a round-trip", () => {
    const packed = buildNativeBackup(snapshot());
    const parsed = nativeBackupPackageSchema.parse(packed);
    expect(parsed.schemaManifest.formatVersion).toBe(NATIVE_BACKUP_FORMAT_VERSION);
    expect(parsed.schemaManifest.tables).toEqual([...NATIVE_BACKUP_TABLES]);
    expect(parsed.schemaManifest.latestMigrationId).toBe("0013_cards.sql");
    expect(parsed.counts).toEqual({
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
    });
    expect(parsed.files[0]?.sha256).toBe(sha256(Uint8Array.from([1, 2, 3, 4])));
    expect(parsed.records.documents[0]).toMatchObject({ id: DOC, title: "导数" });
  });

  it("restores along a dependency topology and remaps workspace without changing entity ids", () => {
    expect(RESTORE_TOPOLOGY.slice(0, 6)).toEqual([
      "courses",
      "documents",
      "blocks",
      "revisions",
      "relations",
      "memberships",
    ]);
    const packed = buildNativeBackup(snapshot());
    const plan = planNativeRestore({
      packed,
      targetWorkspaceId: TARGET,
      targetOwnerUserId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      existingIds: {},
      conflictPolicy: "reject",
      compatibleMigrationIds: ["0013_cards.sql"],
    });
    expect(plan.steps.map((step) => step.collection)).toEqual([...RESTORE_TOPOLOGY]);
    expect(plan.applied.documents).toBe(1);
    expect(plan.applied.relations).toBe(1);
    expect(plan.applied.revisions).toBe(1);
    expect(plan.applied.files).toBe(1);
    expect(plan.records.documents[0]?.id).toBe(DOC);
    expect(plan.records.workspaceId).toBe(TARGET);
    expect(plan.warnings).toEqual([]);
  });

  it("rejects incompatible schema versions and mismatched file hashes", () => {
    const packed = buildNativeBackup(snapshot());
    expect(() =>
      planNativeRestore({
        packed: {
          ...packed,
          schemaManifest: { ...packed.schemaManifest, latestMigrationId: "0099_future.sql" },
        },
        targetWorkspaceId: TARGET,
        targetOwnerUserId: TARGET,
        existingIds: {},
        conflictPolicy: "reject",
        compatibleMigrationIds: ["0013_cards.sql"],
      }),
    ).toThrow(NativeBackupError);

    packed.files[0]!.sha256 = "b".repeat(64);
    expect(() =>
      planNativeRestore({
        packed,
        targetWorkspaceId: TARGET,
        targetOwnerUserId: TARGET,
        existingIds: {},
        conflictPolicy: "reject",
        compatibleMigrationIds: ["0013_cards.sql"],
      }),
    ).toThrow(/hash|sha256|file/i);
  });

  it("never overwrites existing ids: reject rolls back, skip keeps the original record", () => {
    const packed = buildNativeBackup(snapshot());
    expect(() =>
      planNativeRestore({
        packed,
        targetWorkspaceId: TARGET,
        targetOwnerUserId: TARGET,
        existingIds: { documents: [DOC], cards: [CARD] },
        conflictPolicy: "reject",
        compatibleMigrationIds: ["0013_cards.sql"],
      }),
    ).toThrow(NativeBackupError);

    const skipped = planNativeRestore({
      packed,
      targetWorkspaceId: TARGET,
      targetOwnerUserId: TARGET,
      existingIds: { documents: [DOC], cards: [CARD] },
      conflictPolicy: "skip",
      compatibleMigrationIds: ["0013_cards.sql"],
    });
    expect(skipped.records.documents).toEqual([]);
    expect(skipped.records.cards).toEqual([]);
    expect(skipped.skipped.documents).toBe(1);
    expect(skipped.skipped.cards).toBe(1);
    expect(skipped.applied.blocks).toBe(1);
    expect(skipped.warnings.some((item) => item.code === "id-conflict")).toBe(true);
  });
});
