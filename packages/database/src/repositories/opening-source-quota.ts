import type { Sql, TransactionSql } from "postgres";
import { OpeningSourceError } from "./opening-source-errors";

export type OpeningSourceQuota = { maxBytes: number; maxObjects: number };
export const DEFAULT_OPENING_SOURCE_QUOTA: OpeningSourceQuota = { maxBytes: 2 * 1024 ** 3, maxObjects: 200 };

/** Reserve one new original object inside its INSERT/version-bump transaction.
 * Lock before any source rows, and retain the lock until the reservation commits.
 */
export async function reserveOpeningSourceQuota(
  tx: TransactionSql,
  scope: { workspaceId: string; ownerUserId: string },
  bytes: number,
  quota: OpeningSourceQuota = DEFAULT_OPENING_SOURCE_QUOTA,
): Promise<void> {
  // NO KEY UPDATE serializes reservations without blocking the foreign-key
  // KEY SHARE checks performed while an existing source finishes uploading.
  const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR NO KEY UPDATE`;
  if (!owners.length) throw new OpeningSourceError("NOT_FOUND", "Workspace not found");
  const usage = await readOpeningSourceQuotaUsage(tx, scope.workspaceId, quota.maxBytes);
  if (usage.bytes + BigInt(bytes) > BigInt(quota.maxBytes) || usage.objects + 1n > BigInt(quota.maxObjects)) {
    throw new OpeningSourceError("CONFLICT", "工作区上传存储配额不足，请清理材料后重试。");
  }
}

/** Original uploads and versions; a pending row reserves its declared size.
 * Current versions are counted once. Deleted source versions keep their charge
 * until object cleanup finishes; the retained version journal is then free.
 * Legacy deletion receipts without size metadata conservatively reserve a full
 * quota until cleaned, rather than turning deletion into unbounded storage.
 * The caller must hold the workspace row lock through the subsequent INSERT.
 */
export async function readOpeningSourceQuotaUsage(tx: Sql | TransactionSql, workspaceId: string, unknownBytes: number): Promise<{ bytes: bigint; objects: bigint }> {
  const [row] = await tx`WITH quota_objects AS (
    SELECT s.bytes FROM opening_sources s WHERE s.workspace_id=${workspaceId}
    UNION ALL
    SELECT v.bytes FROM opening_source_versions v
    WHERE v.workspace_id=${workspaceId}
      AND (v.availability='available' OR EXISTS (SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id=v.workspace_id AND e.source_id=v.source_id
          AND e.asset_deleted_at IS NOT NULL AND cardinality(e.pending_object_keys)>0))
      AND NOT EXISTS (SELECT 1 FROM opening_sources s
        WHERE s.workspace_id=v.workspace_id AND s.id=v.source_id AND s.version=v.version)
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id=v.workspace_id AND e.source_id=v.source_id
          AND e.asset_deleted_at IS NOT NULL AND COALESCE(cardinality(e.pending_object_keys),0)=0)
    UNION ALL
    SELECT NULL::bigint FROM opening_privacy_exclusions e
    WHERE e.workspace_id=${workspaceId} AND e.asset_deleted_at IS NOT NULL
      AND cardinality(e.pending_object_keys)>0
      AND NOT EXISTS (SELECT 1 FROM opening_source_versions v
        WHERE v.workspace_id=e.workspace_id AND v.source_id=e.source_id)
      AND NOT EXISTS (SELECT 1 FROM opening_sources s
        WHERE s.workspace_id=e.workspace_id AND s.id=e.source_id)
  ) SELECT COALESCE(sum(CASE WHEN bytes>0 THEN bytes ELSE ${unknownBytes} END),0)::text AS bytes,
    count(*)::text AS objects FROM quota_objects`;
  if (!row) throw new Error("Source quota usage could not be read");
  return { bytes: BigInt(String(row.bytes)), objects: BigInt(String(row.objects)) };
}
