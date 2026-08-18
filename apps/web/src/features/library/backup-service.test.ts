import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../../lib/authorization";
import { exportBackupForPrincipal, restoreBackupForPrincipal } from "./backup-service";
import { NATIVE_BACKUP_FORMAT_VERSION, nativeBackupPackageSchema } from "@aistudy/contracts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspace = "22222222-2222-4222-8222-222222222222";
const principal = { userId: "33333333-3333-4333-8333-333333333333", workspaceId } as Principal;

function samplePackage() {
  return nativeBackupPackageSchema.parse({
    format: "aistudy-native",
    schemaManifest: {
      formatVersion: NATIVE_BACKUP_FORMAT_VERSION,
      latestMigrationId: "0013_cards.sql",
      tables: ["workspaces", "library_documents"],
      workspaceSchemaVersion: 1,
    },
    sourceWorkspaceId: workspaceId,
    counts: {
      workspaces: 1, courses: 0, memberships: 0, goals: 0, windows: 0,
      documents: 0, blocks: 0, relations: 0, revisions: 0, explorations: 0,
      promotions: 0, cards: 0, events: 0, files: 0,
    },
    records: {
      workspace: { id: workspaceId },
      courses: [], memberships: [], goals: [], windows: [], documents: [],
      blocks: [], relations: [], revisions: [], explorations: [], promotions: [],
      cards: [], events: [],
    },
    files: [],
  });
}

describe("native backup service", () => {
  it("exports and restores using the session workspace, ignoring a client workspace id", async () => {
    const packed = samplePackage();
    const exportWorkspace = vi.fn().mockResolvedValue(packed);
    const restoreWorkspace = vi.fn().mockResolvedValue({
      conflictPolicy: "skip",
      applied: packed.counts,
      skipped: packed.counts,
      warnings: [],
    });
    const runtime = { backups: { exportWorkspace, restoreWorkspace } } as never;

    const exported = await exportBackupForPrincipal(runtime, principal, { workspaceId: otherWorkspace });
    expect(exportWorkspace).toHaveBeenCalledWith({
      workspaceId,
      ownerUserId: principal.userId,
    });
    expect(exported.format).toBe("aistudy-native");

    await restoreBackupForPrincipal(runtime, principal, {
      workspaceId: otherWorkspace,
      conflictPolicy: "reject",
      package: packed,
    });
    expect(restoreWorkspace).toHaveBeenCalledWith({
      workspaceId,
      ownerUserId: principal.userId,
      packed,
      conflictPolicy: "reject",
    });
  });
});
