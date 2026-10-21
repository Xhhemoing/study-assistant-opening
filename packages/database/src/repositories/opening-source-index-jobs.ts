import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";

/** Called in the parsing transaction, so ready material and its index work are committed together. */
export async function enqueueOpeningSourceIndex(tx: Sql | TransactionSql, scope: OpeningScope, sourceId: string, sourceVersion: number): Promise<string | null> {
  const [owner] = await tx`SELECT w.privacy_epoch FROM workspaces w JOIN opening_sources s ON s.workspace_id=w.id
    WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}
      AND s.id=${sourceId} AND s.version=${sourceVersion} AND s.upload_state='uploaded' AND s.parse_state='ready'
      AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=w.id AND e.source_id=s.id)`;
  if (!owner) return null;
  const jobId = randomUUID();
  await tx`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,privacy_epoch)
    VALUES(${jobId},${scope.workspaceId},${scope.ownerUserId},${`index-source:${sourceId}:${sourceVersion}:${jobId}`},
      'index-source',${tx.json({ sourceId, sourceVersion })},${Number(owner.privacy_epoch)})`;
  await tx`INSERT INTO opening_outbox(workspace_id,job_id,topic,payload)
    VALUES(${scope.workspaceId},${jobId},'opening.job.enqueue',${tx.json({ jobId, kind: "index-source", sourceId })})`;
  return jobId;
}
