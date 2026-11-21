import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { SourceActionInput, SourceDeletion, SourceImpact } from "@aistudy/contracts";
import { OpeningSourceError, type OpeningScope } from "./opening-sources";
import { lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { invalidateOpeningLearningEligibility } from "./opening-learning-eligibility";

type Keys = { stagingKey(id: string): string; finalKey(id: string, version: number): string };
type Cleanup = { keys: string[]; notBefore: string | null };
type Db = Sql | TransactionSql;

async function owner(db: Db, scope: OpeningScope, lock = false) {
  const rows = await db`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} ${lock ? db`FOR UPDATE` : db``}`;
  if (!rows.length) throw new OpeningSourceError("NOT_FOUND", "Workspace not found");
}

async function courses(db: Db, scope: OpeningScope, id: string): Promise<SourceImpact["courses"]> {
  const rows = await db`SELECT m.id, c.id AS course_id, c.title, c.archived_at
    FROM course_asset_memberships m JOIN courses c ON c.id=m.course_id AND c.workspace_id=m.workspace_id
    WHERE m.workspace_id=${scope.workspaceId} AND m.asset_type='source' AND m.asset_id=${id}
    ORDER BY c.title, m.id`;
  return rows.map(row => ({ membershipId: String(row.id), courseId: String(row.course_id), title: String(row.title),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null }));
}

function cleanup(row: Record<string, unknown>): Cleanup {
  return { keys: (row.pending_object_keys as string[] | null) ?? [],
    notBefore: row.cleanup_not_before ? new Date(row.cleanup_not_before as Date).toISOString() : null };
}

// Ordinary exclusions are generated as UUIDv4. Use the attempt's UUID with
// the application-defined UUIDv8 version nibble only for temporary receipts.
export function connectorReservationId(sourceId: string) {
  return sourceId.slice(0, 14) + "8" + sourceId.slice(15);
}

export async function releaseConnectorReservation(tx: TransactionSql, scope: OpeningScope, id: string, key: string) {
  const [receipt] = await tx`SELECT id FROM opening_privacy_exclusions
    WHERE workspace_id=${scope.workspaceId} AND source_id=${id} AND id=${connectorReservationId(id)}
      AND asset_deleted_at IS NOT NULL AND pending_object_keys=ARRAY[${key}]::text[]
      AND NOT EXISTS (SELECT 1 FROM opening_sources WHERE id=${id})
    FOR UPDATE`;
  if (!receipt) return false;
  const removed = await tx`DELETE FROM opening_source_versions WHERE workspace_id=${scope.workspaceId}
    AND source_id=${id} AND version=0 AND availability='unavailable' AND sha256 IS NULL
    AND material_manifest IS NULL RETURNING source_id`;
  if (!removed.length) throw new OpeningSourceError("CONFLICT", "Connector reservation changed");
  await tx`DELETE FROM opening_privacy_exclusions WHERE id=${receipt.id}`;
  return true;
}

async function claimCleanup(tx: TransactionSql, scope: OpeningScope, id: string): Promise<Cleanup> {
  const [row] = await tx`SELECT id, source_id, pending_object_keys, cleanup_not_before FROM opening_privacy_exclusions
    WHERE workspace_id=${scope.workspaceId} AND source_id=${id} AND asset_deleted_at IS NOT NULL FOR UPDATE`;
  if (!row) throw new OpeningSourceError("NOT_FOUND", "Deletion receipt not found");
  if (row.id === connectorReservationId(id)) {
    // A running publisher may still commit this key. Only expose it once its
    // session lock is gone and its reservation row is still present.
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${id}, 0)) AS acquired`;
    if (!lock?.acquired) throw new OpeningSourceError("CONFLICT", "Connector upload in progress");
  }
  return cleanup(row);
}

export function createOpeningSourceActionsRepository(sql: Sql) {
  return {
    async impact(scope: OpeningScope, id: string): Promise<SourceImpact> {
      await owner(sql, scope);
      const rows = await sql`SELECT s.version, EXISTS(SELECT 1 FROM opening_privacy_exclusions e
          WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id) AS excluded
        FROM opening_sources s WHERE s.id=${id} AND s.workspace_id=${scope.workspaceId}`;
      if (!rows.length) throw new OpeningSourceError("NOT_FOUND", "Source not found");
      return { sourceId: id, version: Number(rows[0]!.version), aiExcluded: Boolean(rows[0]!.excluded), courses: await courses(sql, scope, id) };
    },

    async apply(scope: OpeningScope, id: string, input: Exclude<SourceActionInput, { action: "retry_cleanup" }>, keys: Keys, now: Date): Promise<{ deleted: boolean; cleanup: Cleanup }> {
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        await owner(tx, scope, true);
        const sourceRows = await tx`SELECT version, upload_url_expires_at FROM opening_sources
          WHERE id=${id} AND workspace_id=${scope.workspaceId} FOR UPDATE`;
        const existing = await tx`SELECT * FROM opening_privacy_exclusions WHERE workspace_id=${scope.workspaceId} AND source_id=${id}`;
        if (!sourceRows.length) {
          if (input.action === "delete" && existing[0]?.asset_deleted_at) {
            const receipt = existing[0];
            return { deleted: true, cleanup: receipt.id === connectorReservationId(id)
              ? await claimCleanup(tx, scope, id) : cleanup(receipt) };
          }
          throw new OpeningSourceError("NOT_FOUND", "Source not found");
        }
        const source = sourceRows[0]!;
        if (Number(source.version) !== input.expectedVersion) throw new OpeningSourceError("CONFLICT", "Source changed; review its impact again");
        if (input.action === "exclude" && existing.length) return { deleted: false, cleanup: { keys: [], notBefore: null } };
        const refs = await courses(tx, scope, id);
        if (refs.some(ref => !input.expectedMembershipIds.includes(ref.membershipId))) {
          throw new OpeningSourceError("CONFLICT", "Course references changed; review the impact again");
        }
        await tx`INSERT INTO opening_privacy_exclusions(id,workspace_id,source_id,deleted_at)
          VALUES(${randomUUID()},${scope.workspaceId},${id},${now}) ON CONFLICT(workspace_id,source_id) DO NOTHING`;
        // Both first exclusion and later asset deletion fence in-flight model/writeback snapshots.
        await tx`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
        await tx`UPDATE opening_course_knowledge SET node_definitions='{}'::jsonb
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND source_versions ? ${id}`;
        await nextWorkspaceLearningHistoryRevision(tx, scope);
        await invalidateOpeningLearningEligibility(tx, scope, { sourceIds: [id] });
        if (input.action === "exclude") return { deleted: false, cleanup: { keys: [], notBefore: null } };

        const versions = await tx`SELECT version FROM opening_source_versions WHERE workspace_id=${scope.workspaceId} AND source_id=${id}
          UNION SELECT source_version AS version FROM opening_source_chunks WHERE source_id=${id}`;
        const objectKeys = new Set([keys.stagingKey(id), keys.finalKey(id, Number(source.version)),
          ...versions.map(row => keys.finalKey(id, Number(row.version)))]);
        const images = await tx`SELECT image_object_key FROM opening_source_chunks
          WHERE source_id=${id} AND image_object_key IS NOT NULL`;
        const ownPrefix = `opening/sources/${id}/`;
        for (const row of images) {
          const key = String(row.image_object_key);
          if (!key.startsWith(ownPrefix) || key.includes("..")) {
            throw new OpeningSourceError("CONFLICT", "A stored image has unverifiable ownership; deletion requires repair");
          }
          objectKeys.add(key);
        }
        // Legacy rows predate lease tracking: wait one complete signing lifetime from this deletion.
        const notBefore = source.upload_url_expires_at ? new Date(source.upload_url_expires_at) : new Date(now.getTime() + 900_000);
        const pending = [...objectKeys];
        await tx`UPDATE opening_privacy_exclusions SET asset_deleted_at=${now}, pending_object_keys=${pending}, cleanup_not_before=${notBefore}
          WHERE workspace_id=${scope.workspaceId} AND source_id=${id}`;
        await tx`DELETE FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId} AND asset_type='source' AND asset_id=${id}`;
        await tx`UPDATE opening_source_versions SET availability='unavailable' WHERE workspace_id=${scope.workspaceId} AND source_id=${id}`;
        await tx`DELETE FROM opening_sources WHERE workspace_id=${scope.workspaceId} AND id=${id}`;
        return { deleted: true, cleanup: { keys: pending, notBefore: notBefore.toISOString() } };
      });
    },

    async cleanup(scope: OpeningScope, id: string): Promise<Cleanup> {
      return sql.begin(async tx => {
        await owner(tx, scope);
        return claimCleanup(tx, scope, id);
      });
    },

    async cleaned(scope: OpeningScope, id: string, key: string): Promise<void> {
      await sql.begin(async tx => {
        await owner(tx, scope);
        if (await releaseConnectorReservation(tx, scope, id, key)) return;
        await tx`UPDATE opening_privacy_exclusions SET pending_object_keys=array_remove(pending_object_keys,${key})
          WHERE workspace_id=${scope.workspaceId} AND source_id=${id} AND asset_deleted_at IS NOT NULL`;
      });
    },

    async listPending(scope: OpeningScope, now: Date): Promise<SourceDeletion[]> {
      await owner(sql, scope);
      const rows = await sql`SELECT source_id, cardinality(pending_object_keys) AS pending, cleanup_not_before
        FROM opening_privacy_exclusions WHERE workspace_id=${scope.workspaceId} AND asset_deleted_at IS NOT NULL
          AND cardinality(pending_object_keys)>0 ORDER BY asset_deleted_at`;
      return rows.map(row => ({ sourceId: String(row.source_id), cleanupPending: Number(row.pending),
        retryAfter: row.cleanup_not_before && new Date(row.cleanup_not_before) > now ? new Date(row.cleanup_not_before).toISOString() : null }));
    },
  };
}
