import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningOutboxRecord } from "./opening-jobs";
import { failOpeningJob } from "./opening-job-failure";

const MAX_DELIVERY_ATTEMPTS = 10;

/** Claim in SQL, publish outside the transaction, then acknowledge by lease. */
export async function dispatchOpeningOutbox(
  sql: Sql, enqueue: (outbox: OpeningOutboxRecord) => Promise<void>, limit: number,
): Promise<number> {
  const token = randomUUID();
  const rows = await sql`
    UPDATE opening_outbox o SET dispatch_token = ${token},
      lease_until = now() + interval '30 seconds', attempts = o.attempts + 1, updated_at = now()
    FROM (
      SELECT o.id FROM opening_outbox o
      JOIN opening_jobs j ON j.id = o.job_id
      WHERE (o.state IN ('pending', 'failed') OR (o.state = 'published' AND o.updated_at < now() - interval '1 minute'))
        AND NOT EXISTS (SELECT 1 FROM opening_outbox newer WHERE newer.job_id = o.job_id
          AND (newer.created_at, newer.id) > (o.created_at, o.id))
        AND j.state = 'queued'
        AND o.next_attempt_at <= now() AND (o.lease_until IS NULL OR o.lease_until < now())
        AND o.attempts < ${MAX_DELIVERY_ATTEMPTS}
      ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT ${limit}
    ) due WHERE o.id = due.id
    RETURNING o.id, o.workspace_id, o.job_id, o.payload, o.attempts
  `;
  let published = 0;
  for (const row of rows) {
    const item: OpeningOutboxRecord = { id: row.id, workspaceId: row.workspace_id, jobId: row.job_id, payload: row.payload };
    try {
      await enqueue(item);
      const ack = await sql`
        UPDATE opening_outbox SET state = 'published', dispatch_token = NULL, attempts = 0,
          lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = ${item.id} AND dispatch_token = ${token} RETURNING id`;
      published += ack.length;
    } catch (error) {
      const attempts = Number(row.attempts);
      const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
      await sql`
        UPDATE opening_outbox SET state = 'pending', dispatch_token = NULL, lease_until = NULL,
          last_error = ${(error instanceof Error ? error.message : "enqueue failed").slice(0, 1000)},
          next_attempt_at = now() + ${delaySeconds} * interval '1 second', updated_at = now()
        WHERE id = ${item.id} AND dispatch_token = ${token}`;
    }
  }
  // Covers a process that died during its last permitted delivery as well.
  const exhausted = await sql`
    SELECT DISTINCT o.job_id FROM opening_outbox o JOIN opening_jobs j ON j.id = o.job_id
    WHERE o.state IN ('pending', 'failed') AND j.state = 'queued'
      AND NOT EXISTS (SELECT 1 FROM opening_outbox newer WHERE newer.job_id = o.job_id
        AND (newer.created_at, newer.id) > (o.created_at, o.id))
      AND o.attempts >= ${MAX_DELIVERY_ATTEMPTS}
      AND (o.lease_until IS NULL OR o.lease_until < now()) LIMIT ${limit}`;
  for (const row of exhausted) {
    await failOpeningJob(sql, row.job_id, { error: "queue delivery failed after repeated attempts", retryable: true }, "failed", { expectedState: "queued" });
  }
  return published;
}
