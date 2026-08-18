import type { Sql } from "postgres";
import {
  buildNativeBackup,
  type NativeBackupRecord,
  type NativeBackupSnapshot,
} from "@aistudy/domain";
import { listMigrationFiles } from "../migrate";
import { camelRow, filesFromBlocks } from "./backup-map";
import { BackupRestoreError } from "./backup-types";

export async function assertBackupWorkspaceOwner(
  sql: Sql,
  workspaceId: string,
  ownerUserId: string,
): Promise<Record<string, unknown> & { id: string }> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM workspaces WHERE id = ${workspaceId} LIMIT 1
  `;
  if (!rows.length) {
    throw new BackupRestoreError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
  }
  const workspace = camelRow(rows[0]!) as Record<string, unknown> & { id: string };
  if (workspace.ownerUserId !== ownerUserId) {
    throw new BackupRestoreError("WORKSPACE_MISMATCH", "Backup owner must match workspace owner");
  }
  return workspace;
}

export async function dumpWorkspaceSnapshot(
  sql: Sql,
  workspaceId: string,
  ownerUserId: string,
): Promise<NativeBackupSnapshot> {
  const workspace = await assertBackupWorkspaceOwner(sql, workspaceId, ownerUserId);
  const [
    courses,
    memberships,
    goals,
    windows,
    documents,
    blocks,
    relations,
    revisions,
    explorations,
    branches,
    explorationBlocks,
    promotions,
    promotionTargets,
    cards,
    cardStates,
    events,
  ] = await Promise.all([
    selectAll(sql, "courses", workspaceId),
    selectAll(sql, "course_asset_memberships", workspaceId),
    selectAll(sql, "course_goals", workspaceId),
    selectAll(sql, "goal_time_windows", workspaceId),
    selectAll(sql, "library_documents", workspaceId),
    selectAll(sql, "library_blocks", workspaceId),
    selectAll(sql, "library_relations", workspaceId),
    selectAll(sql, "library_revisions", workspaceId),
    selectAll(sql, "explorations", workspaceId),
    selectAll(sql, "exploration_branches", workspaceId),
    selectAll(sql, "exploration_blocks", workspaceId),
    selectAll(sql, "promotion_records", workspaceId),
    selectAll(sql, "promotion_targets", workspaceId),
    selectAll(sql, "cards", workspaceId),
    selectAll(sql, "card_review_states", workspaceId),
    selectAll(sql, "learning_events", workspaceId),
  ]);
  const latestMigrationId = (await listMigrationFiles()).at(-1);
  if (!latestMigrationId) {
    throw new BackupRestoreError("VALIDATION", "No migrations are registered");
  }
  return {
    sourceWorkspaceId: workspaceId,
    workspace,
    latestMigrationId,
    courses,
    memberships,
    goals,
    windows,
    documents,
    blocks,
    relations,
    revisions,
    explorations: nestBy(explorations, {
      branches: branches,
      blocks: explorationBlocks,
    }, "explorationId"),
    promotions: nestBy(promotions, { targets: promotionTargets }, "promotionId"),
    cards: nestBy(cards, { reviewStates: cardStates }, "cardId"),
    events,
    files: filesFromBlocks(blocks),
  };
}

export function snapshotToPackage(snapshot: NativeBackupSnapshot) {
  return buildNativeBackup(snapshot);
}

async function selectAll(sql: Sql, table: string, workspaceId: string): Promise<NativeBackupRecord[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM ${sql(table)} WHERE workspace_id = ${workspaceId}
  `;
  return rows.map((row) => camelRow(row) as NativeBackupRecord);
}

function nestBy(
  parents: NativeBackupRecord[],
  children: Record<string, Array<Record<string, unknown>>>,
  foreignKey: string,
): NativeBackupRecord[] {
  return parents.map((parent) => {
    const nested: Record<string, NativeBackupRecord[]> = {};
    for (const [key, rows] of Object.entries(children)) {
      nested[key] = rows
        .filter((row) => row[foreignKey] === parent.id)
        .map((row) => ({ id: String(row.id ?? parent.id), ...row }));
    }
    return { ...parent, ...nested };
  });
}
