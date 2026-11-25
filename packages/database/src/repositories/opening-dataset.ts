import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { OPENING_DATASET_POLICY_VERSION, type OpeningDatasetConsentInput, type OpeningDeidentifiedDataset } from "@aistudy/contracts";
import { projectPrivacyGuardedOpeningDataset } from "@aistudy/domain/opening/deidentified-dataset";
import { notePublicationCardIds } from "./card-sources";
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
        const [consent] = await tx<{ as_of: Date }[]>`SELECT statement_timestamp() AS as_of FROM opening_dataset_consents
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND policy_version=${OPENING_DATASET_POLICY_VERSION} AND privacy_epoch=${epoch} AND revoked_at IS NULL
          AND granted_at<=statement_timestamp() AND expires_at>statement_timestamp() LIMIT 1`;
        if (!consent) throw learningError("VALIDATION", "current dataset consent required");
        const backup = await readOpeningBackupTableRows(tx, scope.workspaceId, scope.ownerUserId, { asOf: consent.as_of });
        const workspace = scope.workspaceId;
        const cards = await tx`SELECT c.id, c.workspace_id, c.owner_user_id, c.source_ids, c.source_document_id, c.origin_observation_root_id
          FROM cards c WHERE c.workspace_id=${workspace} AND c.owner_user_id=${scope.ownerUserId}
            AND NOT COALESCE(c.id::text = ANY(ARRAY(
              SELECT pub.card_id FROM (
                SELECT np.context_source_refs FROM opening_note_provenance np
                WHERE np.workspace_id<>${workspace} AND np.context_source_refs IS NOT NULL
                  AND COALESCE(jsonb_path_exists(np.context_source_refs, '$.**.publicationCardIds'), false)
              ) np
              CROSS JOIN LATERAL (${notePublicationCardIds(tx, () => tx`np.context_source_refs`)}) AS pub(card_id)
            )), false)`;
        const memories = await tx`SELECT id, workspace_id, course_id, kind, status, source_turn_ids, expires_at, updated_at
          FROM opening_memories WHERE workspace_id=${workspace}`;
        const sources = await tx`SELECT id, workspace_id, upload_state FROM opening_sources WHERE workspace_id=${workspace}`;
        const chunks = await tx`SELECT c.id, c.source_id FROM opening_source_chunks c
          JOIN opening_sources s ON s.id=c.source_id WHERE s.workspace_id=${workspace}`;
        const exclusions = await tx`SELECT workspace_id, source_id, memory_id FROM opening_privacy_exclusions WHERE workspace_id=${workspace}`;
        const noteProvenance = await tx`SELECT COALESCE(d.id, p.document_id) AS document_id,
            ${workspace}::uuid AS workspace_id,
            p.context_source_refs,
            CASE WHEN origin.document_id IS NOT NULL
              THEN origin.reason IS NOT DISTINCT FROM 'save-opening-snippet'
            END AS snippet_origin
          FROM (SELECT id, workspace_id FROM library_documents WHERE workspace_id=${workspace}) d
          FULL JOIN (SELECT document_id, context_source_refs FROM opening_note_provenance WHERE workspace_id=${workspace}) p
            ON p.document_id=d.id
          LEFT JOIN library_revisions origin ON origin.workspace_id=d.workspace_id
            AND origin.document_id=d.id AND origin.revision_number=1
          WHERE p.document_id IS NOT NULL
            OR origin.document_id IS NULL
            OR origin.reason IS NOT DISTINCT FROM 'save-opening-snippet'
            OR EXISTS (SELECT 1 FROM opening_note_provenance fp WHERE fp.document_id=d.id AND fp.workspace_id<>${workspace})`;
        const tutorJobs = await tx`SELECT j.workspace_id, j.conversation_id, j.user_turn_id, j.assistant_turn_id,
            row_number() OVER (PARTITION BY j.conversation_id ORDER BY u.created_at, u.id)::int AS history_position,
            u.status='complete' AND a.status='complete' AND NOT u.query_system AND NOT a.query_system
              AND a.system_query IS NULL AS consumable_history
          FROM opening_tutor_jobs j
          JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
          JOIN opening_turns u ON u.id=j.user_turn_id AND u.conversation_id=c.id AND u.workspace_id=j.workspace_id AND u.role='user'
          JOIN opening_turns a ON a.id=j.assistant_turn_id AND a.conversation_id=c.id AND a.workspace_id=j.workspace_id AND a.role='assistant'
          WHERE j.workspace_id=${workspace} AND c.owner_user_id=${scope.ownerUserId}`;
        const tables = {
          ...backup,
          cards,
          opening_memories: memories,
          opening_sources: sources,
          opening_source_chunks: chunks,
          opening_privacy_exclusions: exclusions,
          opening_note_provenance: noteProvenance,
          opening_tutor_jobs: tutorJobs,
        };
        // Memory tombstones can be source-free. Conservatively retire all older
        // facts, including indirect/unrecorded memory derivations, even after reconsent.
        const deletions = memories.filter(row => row.status === "deleted");
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
        return projectPrivacyGuardedOpeningDataset({
          scope, privacyEpoch: epoch, tables, deletedTurnIds, nowMs: consent.as_of.getTime(), mode: "solo", role: "learner",
        }, token).dataset;
      });
    },
  };
}
