import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { OPENING_DATASET_POLICY_VERSION, type OpeningDatasetConsentInput, type OpeningDeidentifiedDataset } from "@aistudy/contracts";
import { projectOpeningDataset } from "@aistudy/domain";
import { readOpeningBackupTableRows } from "./opening-backup-record-table-queries";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import type { OpeningScope } from "./opening-sources";

/** Development capability. No HTTP/CLI export switch and no object-storage access.
 * All three views share an owner/consent checked read-only snapshot. Fresh secret is
 * destroyed after projection: identical raw identities cannot link separate exports.
 */
export function createOpeningDatasetRepository(sql: Sql) {
  return {
    async grantConsent(scope: OpeningScope, input: OpeningDatasetConsentInput): Promise<string> {
      const expires = new Date(input.expiresAt);
      if (input.consented !== true || input.policyVersion !== OPENING_DATASET_POLICY_VERSION
        || !Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) throw learningError("VALIDATION", "explicit current dataset consent required");
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const [owner] = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        const id = randomUUID();
        // Renewing permission never revives an earlier grant.
        await tx`UPDATE opening_dataset_consents SET revoked_at=now() WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND revoked_at IS NULL`;
        await tx`INSERT INTO opening_dataset_consents(id,workspace_id,owner_user_id,policy_version,privacy_epoch,expires_at)
          VALUES(${id},${scope.workspaceId},${scope.ownerUserId},${input.policyVersion},${Number(owner!.privacy_epoch)},${expires})`;
        return id;
      });
    },
    async revokeConsent(scope: OpeningScope, consentId: string): Promise<void> {
      await sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        const rows = await tx`UPDATE opening_dataset_consents SET revoked_at=coalesce(revoked_at,now())
          WHERE id=${consentId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} RETURNING id`;
        if (!rows.length) throw learningError("NOT_FOUND", "consent not found");
      });
    },
    async read(scope: OpeningScope): Promise<OpeningDeidentifiedDataset> {
      return sql.begin("isolation level repeatable read, read only", async tx => {
        const [owner] = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if (!owner) throw learningError("NOT_FOUND", "workspace not found");
        const epoch = Number(owner.privacy_epoch);
        const consent = await tx`SELECT id FROM opening_dataset_consents WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND policy_version=${OPENING_DATASET_POLICY_VERSION} AND privacy_epoch=${epoch} AND revoked_at IS NULL
          AND granted_at<=statement_timestamp() AND expires_at>statement_timestamp() LIMIT 1`;
        if (!consent.length) throw learningError("VALIDATION", "current dataset consent required");
        const tables = await readOpeningBackupTableRows(tx, scope.workspaceId, scope.ownerUserId);
        // Memory tombstones can be source-free. Conservatively retire all older
        // facts, including indirect/unrecorded memory derivations, even after reconsent.
        const deletions = await tx`SELECT updated_at, source_turn_ids FROM opening_memories WHERE workspace_id=${scope.workspaceId} AND status='deleted'`;
        const cutoff = deletions.length ? Math.max(...deletions.map(row => new Date(row.updated_at as Date).getTime())) : null;
        const deletedTurnIds = deletions.flatMap(row => Array.isArray(row.source_turn_ids) ? row.source_turn_ids as string[] : []);
        if (cutoff !== null) {
          for (const name of ["opening_turns", "opening_teaching_activities", "opening_learning_attempts"] as const) {
            tables[name] = tables[name].filter(row => {
              const time = row.created_at ?? row.started_at;
              return time != null && new Date(time as string | Date).getTime() > cutoff;
            });
          }
        }
        const secret = randomBytes(32);
        const token = (kind: string, id: string) => createHmac("sha256", secret).update(JSON.stringify([scope.workspaceId, scope.ownerUserId, epoch, kind, id])).digest("hex");
        return projectOpeningDataset({ scope, privacyEpoch: epoch, tables, deletedTurnIds }, token);
      });
    },
  };
}
