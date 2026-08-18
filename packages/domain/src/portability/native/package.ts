import {
  NATIVE_BACKUP_FORMAT_VERSION,
  type BackupIdentityCounts,
  type NativeBackupPackage,
} from "@aistudy/contracts";
import { packFiles } from "./files";
import { NATIVE_BACKUP_TABLES, type NativeBackupSnapshot } from "./types";

export function emptyBackupCounts(): BackupIdentityCounts {
  return {
    workspaces: 0,
    courses: 0,
    memberships: 0,
    goals: 0,
    windows: 0,
    documents: 0,
    blocks: 0,
    relations: 0,
    revisions: 0,
    explorations: 0,
    promotions: 0,
    cards: 0,
    events: 0,
    files: 0,
  };
}

export function buildNativeBackup(snapshot: NativeBackupSnapshot): NativeBackupPackage {
  const files = packFiles(snapshot.files);
  return {
    format: "aistudy-native",
    schemaManifest: {
      formatVersion: NATIVE_BACKUP_FORMAT_VERSION,
      latestMigrationId: snapshot.latestMigrationId,
      tables: [...NATIVE_BACKUP_TABLES],
      workspaceSchemaVersion: Number(snapshot.workspace.schemaVersion ?? 1),
    },
    sourceWorkspaceId: snapshot.sourceWorkspaceId,
    counts: {
      workspaces: 1,
      courses: snapshot.courses.length,
      memberships: snapshot.memberships.length,
      goals: snapshot.goals.length,
      windows: snapshot.windows.length,
      documents: snapshot.documents.length,
      blocks: snapshot.blocks.length,
      relations: snapshot.relations.length,
      revisions: snapshot.revisions.length,
      explorations: snapshot.explorations.length,
      promotions: snapshot.promotions.length,
      cards: snapshot.cards.length,
      events: snapshot.events.length,
      files: files.length,
    },
    records: {
      workspace: snapshot.workspace,
      courses: snapshot.courses,
      memberships: snapshot.memberships,
      goals: snapshot.goals,
      windows: snapshot.windows,
      documents: snapshot.documents,
      blocks: snapshot.blocks,
      relations: snapshot.relations,
      revisions: snapshot.revisions,
      explorations: snapshot.explorations,
      promotions: snapshot.promotions,
      cards: snapshot.cards,
      events: snapshot.events,
    },
    files,
  };
}
