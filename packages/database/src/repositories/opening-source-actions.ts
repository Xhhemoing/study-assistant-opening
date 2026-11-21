import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { SourceActionInput, SourceDeletion, SourceImpact } from "@aistudy/contracts";
import { OpeningSourceError, type OpeningScope } from "./opening-sources";
import { lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { invalidateOpeningLearningEligibility } from "./opening-learning-eligibility";

type Keys = { stagingKey(id: string): string; finalKey(id: string, version: number): string };
export const CONNECTOR_PUT_TIMEOUT_MS = 30_000;
export const CONNECTOR_RESERVATION_GRACE_MS = 60_000;
type Cleanup = { keys: string[]; notBefore: string | null; connectorReservation?: boolean };
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

function isConnectorReservationRow(row: Record<string, unknown>): boolean {
  if (row.id == null || row.source_id == null || row.memory_id != null) return false;
  return String(row.id).toLowerCase() === connectorReservationId(String(row.source_id));
}

function validExtraObjectKeys(canonicalId: string, keys: Keys, extraKeys?: readonly string[]): string[] {
  if (!extraKeys?.length) return [];
  const ownPrefix = `opening/sources/${canonicalId}/`;
  const ownStagingKeyLower = keys.stagingKey(canonicalId).toLowerCase();
  return extraKeys.filter(extraKey => {
    const lowerExtra = extraKey.toLowerCase();
    return !extraKey.includes("..") && (lowerExtra === ownStagingKeyLower || lowerExtra.startsWith(ownPrefix));
  });
}

function cleanup(row: Record<string, unknown>): Cleanup {
  return {
    keys: (row.pending_object_keys as string[] | null) ?? [],
    notBefore: row.cleanup_not_before ? new Date(row.cleanup_not_before as Date).toISOString() : null,
    ...(isConnectorReservationRow(row) ? { connectorReservation: true } : {}),
  };
}

// Ordinary exclusions are generated as UUIDv4. Use the attempt's UUID with
// the application-defined UUIDv8 version nibble only for temporary receipts.
export function connectorReservationId(sourceId: string) {
  const normalized = sourceId.toLowerCase();
  return normalized.slice(0, 14) + "8" + normalized.slice(15);
}

async function tryReleaseConnectorReservation(
  tx: TransactionSql,
  scope: OpeningScope,
  id: string,
  key: string,
  options?: { enforceNotBefore?: boolean; now?: Date },
): Promise<"released" | "deferred" | "none"> {
  const canonicalId = id.toLowerCase();
  const [receipt] = await tx`SELECT id, cleanup_not_before FROM opening_privacy_exclusions
    WHERE workspace_id=${scope.workspaceId} AND source_id=${canonicalId} AND id=${connectorReservationId(canonicalId)}
      AND asset_deleted_at IS NOT NULL AND pending_object_keys=ARRAY[${key}]::text[]
      AND NOT EXISTS (SELECT 1 FROM opening_sources WHERE id=${canonicalId})
    FOR UPDATE`;
  if (!receipt) return "none";
  if (options?.enforceNotBefore && receipt.cleanup_not_before) {
    const cutoff = options.now ?? new Date();
    if (new Date(receipt.cleanup_not_before as Date) > cutoff) return "deferred";
  }
  const removed = await tx`DELETE FROM opening_source_versions WHERE workspace_id=${scope.workspaceId}
    AND source_id=${canonicalId} AND version=0 AND availability='unavailable' AND sha256 IS NULL
    AND material_manifest IS NULL RETURNING source_id`;
  if (!removed.length) throw new OpeningSourceError("CONFLICT", "Connector reservation changed");
  await tx`DELETE FROM opening_privacy_exclusions WHERE id=${receipt.id}`;
  return "released";
}

export async function releaseConnectorReservation(
  tx: TransactionSql,
  scope: OpeningScope,
  id: string,
  key: string,
  options?: { enforceNotBefore?: boolean; now?: Date },
) {
  return (await tryReleaseConnectorReservation(tx, scope, id, key, options)) === "released";
}

async function claimCleanup(tx: TransactionSql, scope: OpeningScope, id: string): Promise<Cleanup> {
  const canonicalInputId = id.toLowerCase();
  const [row] = await tx`SELECT id, source_id, pending_object_keys, cleanup_not_before FROM opening_privacy_exclusions
    WHERE workspace_id=${scope.workspaceId} AND source_id=${canonicalInputId} AND asset_deleted_at IS NOT NULL FOR UPDATE`;
  if (!row) throw new OpeningSourceError("NOT_FOUND", "Deletion receipt not found");
  const canonicalId = String(row.source_id).toLowerCase();
  if (String(row.id).toLowerCase() === connectorReservationId(canonicalId)) {
    // A running publisher may still commit this key. Only expose it once its
    // session lock is gone and its reservation row is still present.
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${canonicalId}, 0)) AS acquired`;
    if (!lock?.acquired) throw new OpeningSourceError("CONFLICT", "Connector upload in progress");
  }
  return cleanup(row);
}

export function createOpeningSourceActionsRepository(sql: Sql) {
  return {
    async impact(scope: OpeningScope, id: string): Promise<SourceImpact> {
      const canonicalId = id.toLowerCase();
      await owner(sql, scope);
      const rows = await sql`SELECT s.version, EXISTS(SELECT 1 FROM opening_privacy_exclusions e
          WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id) AS excluded
        FROM opening_sources s WHERE s.id=${canonicalId} AND s.workspace_id=${scope.workspaceId}`;
      if (!rows.length) throw new OpeningSourceError("NOT_FOUND", "Source not found");
      return { sourceId: canonicalId, version: Number(rows[0]!.version), aiExcluded: Boolean(rows[0]!.excluded), courses: await courses(sql, scope, canonicalId) };
    },

    async apply(
      scope: OpeningScope,
      id: string,
      input: Exclude<SourceActionInput, { action: "retry_cleanup" }>,
      keys: Keys,
      now: Date,
      options?: { extraKeys?: readonly string[] },
    ): Promise<{ deleted: boolean; cleanup: Cleanup }> {
      const canonicalId = id.toLowerCase();
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        await owner(tx, scope, true);
        const sourceRows = await tx`SELECT version, upload_url_expires_at FROM opening_sources
          WHERE id=${canonicalId} AND workspace_id=${scope.workspaceId} FOR UPDATE`;
        const existing = await tx`SELECT * FROM opening_privacy_exclusions WHERE workspace_id=${scope.workspaceId} AND source_id=${canonicalId} FOR UPDATE`;
        if (!sourceRows.length) {
          if (input.action === "delete" && existing[0]?.asset_deleted_at) {
            const receipt = existing[0];
            const receiptSourceId = String(receipt.source_id).toLowerCase();
            if (String(receipt.id).toLowerCase() === connectorReservationId(receiptSourceId)) {
              return { deleted: true, cleanup: await claimCleanup(tx, scope, receiptSourceId) };
            }
            const validExtra = validExtraObjectKeys(receiptSourceId, keys, options?.extraKeys);
            if (validExtra.length) {
              const existingKeys = (receipt.pending_object_keys as string[] | null) ?? [];
              const mergedKeys = [...new Set([...existingKeys, ...validExtra])];
              if (mergedKeys.length > existingKeys.length) {
                await tx`UPDATE opening_privacy_exclusions SET pending_object_keys=${mergedKeys}
                  WHERE workspace_id=${scope.workspaceId} AND source_id=${receiptSourceId} AND asset_deleted_at IS NOT NULL`;
                receipt.pending_object_keys = mergedKeys;
              }
            }
            return { deleted: true, cleanup: cleanup(receipt) };
          }
          throw new OpeningSourceError("NOT_FOUND", "Source not found");
        }
        const source = sourceRows[0]!;
        if (Number(source.version) !== input.expectedVersion) throw new OpeningSourceError("CONFLICT", "Source changed; review its impact again");
        if (input.action === "exclude" && existing.length) return { deleted: false, cleanup: { keys: [], notBefore: null } };
        const refs = await courses(tx, scope, canonicalId);
        if (refs.some(ref => !input.expectedMembershipIds.includes(ref.membershipId))) {
          throw new OpeningSourceError("CONFLICT", "Course references changed; review the impact again");
        }
        await tx`INSERT INTO opening_privacy_exclusions(id,workspace_id,source_id,deleted_at)
          VALUES(${randomUUID()},${scope.workspaceId},${canonicalId},${now}) ON CONFLICT(workspace_id,source_id) DO NOTHING`;
        // Both first exclusion and later asset deletion fence in-flight model/writeback snapshots.
        await tx`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
        await tx`UPDATE opening_course_knowledge SET node_definitions='{}'::jsonb
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND source_versions ? ${canonicalId}`;
        await nextWorkspaceLearningHistoryRevision(tx, scope);
        await invalidateOpeningLearningEligibility(tx, scope, { sourceIds: [canonicalId] });
        if (input.action === "exclude") return { deleted: false, cleanup: { keys: [], notBefore: null } };

        const versions = await tx`SELECT version FROM opening_source_versions WHERE workspace_id=${scope.workspaceId} AND source_id=${canonicalId}
          UNION SELECT source_version AS version FROM opening_source_chunks WHERE source_id=${canonicalId}`;
        const versionNumbers = [Number(source.version), ...versions.map(row => Number(row.version))];
        const upperId = canonicalId.toUpperCase();
        const variantIds = new Set([canonicalId]);
        if (upperId !== canonicalId) variantIds.add(upperId);
        if (id !== canonicalId) variantIds.add(id);
        const objectKeys = new Set<string>();
        for (const variantId of variantIds) {
          objectKeys.add(keys.stagingKey(variantId));
          for (const version of versionNumbers) {
            objectKeys.add(keys.finalKey(variantId, version));
          }
        }
        const sourcePrefix = "opening/sources/";
        const ownPrefix = `${sourcePrefix}${canonicalId}/`;
        for (const extraKey of validExtraObjectKeys(canonicalId, keys, options?.extraKeys)) {
          objectKeys.add(extraKey);
        }
        const images = await tx`SELECT image_object_key FROM opening_source_chunks
          WHERE source_id=${canonicalId} AND image_object_key IS NOT NULL
          UNION ALL SELECT key AS image_object_key FROM opening_jobs
          WHERE workspace_id=${scope.workspaceId} AND kind IN ('parse', 'parse-media')
            AND lower(payload->>'sourceId')=${canonicalId} AND lower(key) LIKE ${`${ownPrefix}v%`}`;
        for (const row of images) {
          const key = String(row.image_object_key);
          if (!key.toLowerCase().startsWith(ownPrefix) || key.includes("..")) {
            throw new OpeningSourceError("CONFLICT", "A stored image has unverifiable ownership; deletion requires repair");
          }
          objectKeys.add(key);
          const recordedId = key.slice(sourcePrefix.length, sourcePrefix.length + canonicalId.length);
          if (!variantIds.has(recordedId)) {
            variantIds.add(recordedId);
            objectKeys.add(keys.stagingKey(recordedId));
            for (const version of versionNumbers) {
              objectKeys.add(keys.finalKey(recordedId, version));
            }
          }
        }
        // Legacy rows predate lease tracking: wait one complete signing lifetime from this deletion.
        const notBefore = source.upload_url_expires_at ? new Date(source.upload_url_expires_at) : new Date(now.getTime() + 900_000);
        const pending = [...objectKeys];
        await tx`UPDATE opening_privacy_exclusions SET asset_deleted_at=${now}, pending_object_keys=${pending}, cleanup_not_before=${notBefore}
          WHERE workspace_id=${scope.workspaceId} AND source_id=${canonicalId}`;
        await tx`DELETE FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId} AND asset_type='source' AND asset_id=${canonicalId}`;
        await tx`UPDATE opening_source_versions SET availability='unavailable' WHERE workspace_id=${scope.workspaceId} AND source_id=${canonicalId}`;
        await tx`DELETE FROM opening_sources WHERE workspace_id=${scope.workspaceId} AND id=${canonicalId}`;
        return { deleted: true, cleanup: { keys: pending, notBefore: notBefore.toISOString() } };
      });
    },

    async cleanup(scope: OpeningScope, id: string): Promise<Cleanup> {
      return sql.begin(async tx => {
        await owner(tx, scope);
        return claimCleanup(tx, scope, id);
      });
    },

    async cleaned(scope: OpeningScope, id: string, key: string, now = new Date()): Promise<boolean> {
      const canonicalId = id.toLowerCase();
      return sql.begin(async tx => {
        await owner(tx, scope);
        const status = await tryReleaseConnectorReservation(tx, scope, canonicalId, key, {
          enforceNotBefore: true,
          now,
        });
        if (status === "released") return true;
        if (status === "deferred") return false;
        await tx`UPDATE opening_privacy_exclusions SET pending_object_keys=array_remove(pending_object_keys,${key})
          WHERE workspace_id=${scope.workspaceId} AND source_id=${canonicalId} AND asset_deleted_at IS NOT NULL`;
        return false;
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
