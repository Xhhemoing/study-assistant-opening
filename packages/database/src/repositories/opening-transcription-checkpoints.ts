import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import { providerOutputSchema, type Scope } from "@aistudy/contracts";
import type { OpeningBudgetRepository } from "./opening-budget";

export type TranscriptionChunkIdentity = {
  jobId: string; sourceId: string; sourceVersion: number; privacyEpoch: number;
  index: number; offsetMs: number; durationMs: number;
};
const receiptSchema = z.object({
  output: providerOutputSchema,
  reservationId: z.string().uuid(),
  settledCents: z.number().int().nonnegative().nullable(),
}).strict();
export type TranscriptionChunkReceipt = z.infer<typeof receiptSchema>;

/** Terminal parse-media receipt rows use existing storage, with no outbox or executable job. */
export function createOpeningTranscriptionCheckpointsRepository(sql: Sql) {
  const keyFor = (chunk: TranscriptionChunkIdentity) => `transcribe:${chunk.jobId}:${chunk.index}`;
  async function assertCurrent(db: Sql | TransactionSql, scope: Scope, chunk: TranscriptionChunkIdentity, writing = false) {
    const rows = await db`
      SELECT j.id FROM workspaces w
      JOIN opening_jobs j ON j.workspace_id=w.id AND j.owner_user_id=w.owner_user_id
      JOIN opening_sources s ON s.workspace_id=w.id AND s.id=${chunk.sourceId}
      WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}
        AND w.privacy_epoch=${chunk.privacyEpoch} AND j.privacy_epoch=${chunk.privacyEpoch}
        AND j.id=${chunk.jobId} AND j.kind='parse-media' AND j.payload->>'receiptKind' IS NULL
        AND j.payload->>'sourceId'=${chunk.sourceId}
        AND (j.payload->>'sourceVersion' IS NULL OR j.payload->>'sourceVersion'=${String(chunk.sourceVersion)})
        AND j.state <> 'cancelled' AND (${!writing} OR j.state='running')
        AND s.version=${chunk.sourceVersion}
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=w.id AND e.source_id=s.id)
      FOR SHARE OF w, j, s`;
    if (!rows.length) throw new Error("transcription source, job or privacy state changed");
  }
  async function load(scope: Scope, chunk: TranscriptionChunkIdentity) {
    return sql.begin(async tx => {
      await assertCurrent(tx, scope, chunk);
      // The Inbox retry creates a new parse job. Reuse receipts from the same
      // immutable source version/epoch, while retaining each call's ledger key.
      const rows = await tx`SELECT payload, result, key FROM opening_jobs
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND kind='parse-media' AND payload->>'receiptKind'='transcribe-chunk' AND state='succeeded'
          AND payload->>'sourceId'=${chunk.sourceId} AND payload->>'sourceVersion'=${String(chunk.sourceVersion)}
          AND privacy_epoch=${chunk.privacyEpoch} AND payload->>'index'=${String(chunk.index)}
        ORDER BY created_at, id LIMIT 1`;
      if (!rows.length) {
        // A missing response is not permission to send again under the new job
        // id. Only a positively released, not-sent call is safe to retry.
        const unresolved = await tx`SELECT b.id FROM opening_budget_reservations b
          JOIN opening_jobs j ON j.workspace_id=b.workspace_id
            AND b.request_id IN ('transcribe:' || j.id::text || ':' || ${String(chunk.index)},
              'transcribe:' || j.id::text || ':' || ${String(chunk.index)} || ':fallback')
          WHERE b.workspace_id=${scope.workspaceId} AND b.purpose='transcribe' AND b.state <> 'released'
            AND j.owner_user_id=${scope.ownerUserId} AND j.kind='parse-media' AND j.payload->>'receiptKind' IS NULL AND j.id <> ${chunk.jobId}
            AND j.payload->>'sourceId'=${chunk.sourceId} AND j.payload->>'sourceVersion'=${String(chunk.sourceVersion)}
            AND j.privacy_epoch=${chunk.privacyEpoch} LIMIT 1`;
        if (unresolved.length) throw new Error("previous transcription outcome is unresolved; no duplicate request sent");
        return null;
      }
      const [same] = await tx`SELECT (${tx.json(rows[0]!.payload)}::jsonb - 'jobId' - 'receiptKind') = (${tx.json(chunk)}::jsonb - 'jobId') AS matches`;
      if (!same?.matches) throw new Error("transcription chunk identity changed");
      return { receipt: receiptSchema.parse(rows[0]!.result), key: String(rows[0]!.key) };
    });
  }
  async function ledgerState(scope: Scope, receipt: TranscriptionChunkReceipt, key: string) {
    const rows = await sql`SELECT state, pending_reconcile_cents, amount_cents, result_ref
      FROM opening_budget_reservations b JOIN workspaces w ON w.id=b.workspace_id
      WHERE b.id=${receipt.reservationId} AND b.workspace_id=${scope.workspaceId}
        AND w.owner_user_id=${scope.ownerUserId} AND b.purpose='transcribe'
        AND b.request_id IN (${key}, ${`${key}:fallback`})`;
    if (!rows.length) throw new Error("transcription receipt has no matching reservation");
    return rows[0]!;
  }
  return {
    async save(scope: Scope, chunk: TranscriptionChunkIdentity, value: TranscriptionChunkReceipt) {
      const receipt = receiptSchema.parse(value);
      const key = keyFor(chunk);
      const payload = { ...chunk, receiptKind: 'transcribe-chunk' };
      await ledgerState(scope, receipt, key);
      await sql.begin(async tx => {
        await assertCurrent(tx, scope, chunk, true);
        await tx`INSERT INTO opening_jobs (workspace_id, owner_user_id, key, kind, payload, result, state, privacy_epoch)
          VALUES (${scope.workspaceId}, ${scope.ownerUserId}, ${key}, 'parse-media',
            ${tx.json(payload)}, ${tx.json(receipt)}, 'succeeded', ${chunk.privacyEpoch})
          ON CONFLICT (workspace_id, key) DO NOTHING`;
        const [row] = await tx`SELECT payload=${tx.json(payload)}::jsonb AND result=${tx.json(receipt)}::jsonb AS matches
          FROM opening_jobs WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
            AND key=${key} AND kind='parse-media' AND payload->>'receiptKind'='transcribe-chunk' AND state='succeeded'`;
        if (!row?.matches) throw new Error("transcription receipt already exists with different content");
      });
    },
    async recover(scope: Scope, chunk: TranscriptionChunkIdentity, budget: OpeningBudgetRepository) {
      const saved = await load(scope, chunk);
      if (!saved) return null;
      const { receipt, key } = saved;
      const row = await ledgerState(scope, receipt, key);
      if (receipt.settledCents !== null) {
        const matches = (r: typeof row) => r.state === 'completed' && Number(r.pending_reconcile_cents) === 0
          && Number(r.amount_cents) === receipt.settledCents && r.result_ref === key;
        if (!matches(row)) {
          try {
            await budget.settle(scope, receipt.reservationId, receipt.settledCents, { resultRef: key });
          } catch (error) {
            // Another delivery may have settled this exact saved receipt concurrently.
            if (!matches(await ledgerState(scope, receipt, key))) throw error;
          }
        }
      } else if (row.state === 'reserved') {
        await budget.markUnknown(scope, receipt.reservationId);
      }
      return receipt.output;
    },
  };
}
