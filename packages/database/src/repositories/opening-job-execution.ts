import type { Sql, TransactionSql } from "postgres";
import type { OpeningJobRecord } from "./opening-jobs";

export type OpeningJobScope = {
  workspaceId: string;
  ownerUserId: string;
  jobExecution?: { id: string; token: string; privacyEpoch: number };
};

/** Execution identity travels with the worker's scope through its dependencies. */
export function openingJobScope(job: OpeningJobRecord): OpeningJobScope {
  return {
    workspaceId: job.workspaceId,
    ownerUserId: job.ownerUserId,
    ...(job.claimToken ? { jobExecution: { id: job.id, token: job.claimToken, privacyEpoch: job.privacyEpoch } } : {}),
  };
}

/**
 * Call inside the write transaction, before locking source/activity/document
 * rows. The workspace lock serializes this write with cancel, privacy deletion
 * and recovery; token + state prevent a late execution from publishing.
 */
export async function lockOpeningJobExecution(tx: Sql | TransactionSql, scope: OpeningJobScope): Promise<void> {
  const execution = scope.jobExecution;
  if (!execution) return;
  const workspaces = await tx`SELECT id FROM workspaces
    WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      AND privacy_epoch = ${execution.privacyEpoch} FOR SHARE`;
  const jobs = workspaces.length ? await tx`SELECT id FROM opening_jobs
    WHERE id = ${execution.id} AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      AND state = 'running' AND claim_token = ${execution.token} FOR SHARE` : [];
  if (!jobs.length) throw Object.assign(new Error("job execution is no longer current"), { code: "CONFLICT" });
}
