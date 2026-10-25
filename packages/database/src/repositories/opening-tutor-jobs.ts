import { appendOpeningStudyIntentInTx, createOpeningStudyIntentRepository, readOpeningStudyIntentInTx } from "./opening-study-intent-events";
import { composerMessageText, parseExplicitStudyMessage, DEFAULT_STUDY_SESSION_INTENT, studyIntentForMessage, tutorFailureForDisplay, TUTOR_STALE_MESSAGE } from "@aistudy/domain";
import { isDeepStrictEqual } from "node:util";
import { openingCanonicalLanguageQuestion } from "./opening-study-context";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { generateOpeningStudyExposure, releaseOpeningStudyExposure, type OpeningStudyExposureInput } from "./opening-study-exposure";
import { insertOpeningDeliveredHelp } from "./opening-learning-help";
import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { TERMINAL_TURN_STATUSES, terminalTurnStatusForJobError, systemQueryReceiptSchema, type Citation, type SystemQueryReceipt, type StudyContextAnchor, type ComposerPurpose, type StudyIntentEvent } from "@aistudy/contracts";
import { contextSourceRefsIncluded, mergeContextSourceRefs } from "./opening-context-provenance";
import type { OpeningScope } from "./opening-sources";
import type { ContextSourceRef } from "./opening-context-provenance";
import { loadTutorHistory, loadTutorHistoryContext, type TutorHistoryPurpose } from "./opening-tutor-history";

/** Terminal job error; nextAction "clarify" routes a refusal to the Clarify path (LAB-A01). */
export type OpeningTutorJobError = { message: string; code?: string; nextAction?: "clarify" };

export type OpeningTutorJobRecord = {
  id: string;
  workspaceId: string;
  ownerUserId?: string;
  conversationId: string;
  userTurnId: string;
  assistantTurnId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";
  mode: string;
  error: OpeningTutorJobError | null;
  createdAt: string;
  updatedAt: string;
  claimToken?: string;
};

function mapJob(row: Record<string, unknown>): OpeningTutorJobRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    conversationId: row.conversation_id as string,
    userTurnId: row.user_turn_id as string,
    assistantTurnId: row.assistant_turn_id as string,
    status: row.status as OpeningTutorJobRecord["status"],
    mode: row.mode as string,
    error: tutorFailureForDisplay(row.status, row.error),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    ...(typeof row.claim_token === "string" ? { claimToken: row.claim_token } : {}),
  };
}

export type OpeningTutorJobsRepository = ReturnType<typeof createOpeningTutorJobsRepository>;

type CompletedCandidateTarget = {
  scope: OpeningScope;
  jobId: string;
  assistantTurnId: string;
  expectedPrivacyEpoch?: number;
  claimToken?: string;
  metadataLease?: { id: string; claimToken?: string };
};

/** Optional metadata consumes exactly the saved answer's still-authorized context. */
async function findCompletedCandidateTarget(db: Sql | TransactionSql, input: CompletedCandidateTarget) {
  const [target] = await db`
    SELECT j.conversation_id, j.user_turn_id, j.mode, t.text AS answer, u.text AS question, t.context_source_refs
    FROM opening_tutor_jobs j
    JOIN workspaces w ON w.id=j.workspace_id AND w.owner_user_id=${input.scope.ownerUserId}
    JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
      AND c.owner_user_id=w.owner_user_id
    JOIN opening_turns t ON t.id=j.assistant_turn_id AND t.workspace_id=j.workspace_id
      AND t.conversation_id=j.conversation_id AND t.role='assistant' AND t.status='complete'
    JOIN opening_turns u ON u.id=j.user_turn_id AND u.workspace_id=j.workspace_id
      AND u.conversation_id=j.conversation_id AND u.role='user'
    WHERE j.id=${input.jobId} AND j.workspace_id=${input.scope.workspaceId}
      AND j.assistant_turn_id=${input.assistantTurnId} AND j.status='succeeded'
      AND j.claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid
      AND (${input.expectedPrivacyEpoch ?? null}::integer IS NULL OR w.privacy_epoch=${input.expectedPrivacyEpoch ?? null})
      AND ${contextSourceRefsIncluded(db, input.scope.workspaceId, db`t.context_source_refs`)}
      AND (${input.metadataLease === undefined} OR EXISTS (
        SELECT 1 FROM opening_jobs metadata WHERE metadata.id=${input.metadataLease?.id ?? null}::uuid
          AND metadata.workspace_id=j.workspace_id AND metadata.owner_user_id=w.owner_user_id
          AND metadata.kind='tutor-metadata' AND metadata.state='running'
          AND metadata.claim_token IS NOT DISTINCT FROM ${input.metadataLease?.claimToken ?? null}::uuid
          AND metadata.privacy_epoch=w.privacy_epoch AND metadata.payload->>'tutorJobId'=j.id::text
          AND metadata.payload->>'assistantTurnId'=t.id::text
      ))
      AND NOT EXISTS (SELECT 1 FROM opening_assistant_candidates candidate
        WHERE candidate.workspace_id=j.workspace_id AND candidate.source_turn_id=t.id)
  `;
  return target;
}

/**
 * Durable tutor job state machine (0017). Claims are CAS so a BullMQ
 * redelivery rechecks the DB before executing. The answer and job finish
 * atomically; optional suggestions may be appended after that completion.
 */
export type OpeningTutorJobsRepositoryOptions = {
  /**
   * When set, reads (get / findPendingForConversation) end a job that has been
   * queued (never claimed, e.g. its queue message was lost or deduplicated) or
   * running without a heartbeat for this long, so polling clients always reach a
   * terminal status. The worker sweep (expireStale) covers jobs nobody is polling.
   */
  staleMs?: number;
};

export const TUTOR_INTERRUPTED_MESSAGE = "回答任务已中断，执行结果待确认；为避免重复调用未自动重发。";

export function createOpeningTutorJobsRepository(sql: Sql, options: OpeningTutorJobsRepositoryOptions = {}) {
  async function markTerminal(input: {
    scope: OpeningScope;
    jobId: string;
    message: string;
    status: "failed" | "outcome_unknown";
    detail?: { code: string; nextAction?: "clarify" };
    claimToken?: string;
    staleBefore?: Date;
  }): Promise<boolean> {
    const errorJson: OpeningTutorJobError = { message: input.message, ...(input.detail ?? {}) };
    return sql.begin(async (tx) => {
      // Use the same workspace-first lock order as completeTurn/cancel.
      await tx`
        SELECT id FROM workspaces
        WHERE id = ${input.scope.workspaceId}
        FOR UPDATE
      `;
      const rows = input.status === "failed"
        ? await tx`
            UPDATE opening_tutor_jobs SET status = 'failed', error = ${tx.json(errorJson as never)},
              updated_at = now()
            WHERE id = ${input.jobId} AND workspace_id = ${input.scope.workspaceId}
              AND status IN ('running', 'queued')
              AND (${input.staleBefore !== undefined} OR claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid)
              AND (${input.staleBefore ?? null}::timestamptz IS NULL OR updated_at < ${input.staleBefore ?? null}::timestamptz)
            RETURNING assistant_turn_id
          `
        : await tx`
            UPDATE opening_tutor_jobs SET status = 'outcome_unknown',
              error = ${tx.json({ message: input.message } as never)}, updated_at = now()
            WHERE id = ${input.jobId} AND workspace_id = ${input.scope.workspaceId}
              AND status = 'running'
              AND (${input.staleBefore !== undefined} OR claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid)
              AND (${input.staleBefore ?? null}::timestamptz IS NULL OR updated_at < ${input.staleBefore ?? null}::timestamptz)
            RETURNING assistant_turn_id
          `;
      if (!rows.length) return false;
      const assistantTurnId = (rows[0] as Record<string, unknown>).assistant_turn_id as string;
      // A terminal turn (complete/failed/clarify/outcome_unknown) is never
      // rewritten, even if a stale job row is swept or re-terminated later.
      const terminal = [...TERMINAL_TURN_STATUSES];
      if (input.status === "failed" && terminalTurnStatusForJobError(input.detail) === "clarify") {
        // LAB-U01: a page-citation refusal is a Clarify follow-up, not a failure.
        await tx`
          UPDATE opening_turns SET text = ${input.message}, status = 'clarify'
          WHERE id = ${assistantTurnId} AND workspace_id = ${input.scope.workspaceId}
            AND NOT (status = ANY(${terminal}::text[]))
        `;
      } else if (input.status === "failed") {
        await tx`
          UPDATE opening_turns SET text = ${input.message}, status = 'failed'
          WHERE id = ${assistantTurnId} AND workspace_id = ${input.scope.workspaceId}
            AND NOT (status = ANY(${terminal}::text[]))
        `;
      } else {
        await tx`
          UPDATE opening_turns SET text = ${input.message}, status = 'outcome_unknown'
          WHERE id = ${assistantTurnId} AND workspace_id = ${input.scope.workspaceId}
            AND NOT (status = ANY(${terminal}::text[]))
        `;
      }
      return true;
    });
  }

  /**
   * End tutor jobs stuck past staleMs. A queued job was never claimed, so no model
   * call happened: it fails with code TUTOR_JOB_STALE and the client can ask again.
   * A running job without heartbeat may have spent money: like recoverExpired it
   * becomes outcome_unknown and is never re-executed. Both writes are CAS-fenced on
   * updated_at, so a job claimed or heart-beaten meanwhile is left alone.
   */
  async function expireStale(input: { staleMs: number; jobId?: string; workspaceId?: string; limit?: number }): Promise<number> {
    const staleSeconds = Math.max(1, Math.floor(input.staleMs / 1000));
    const rows = await sql<{ id: string; workspace_id: string; status: string; stale_before: Date }[]>`
      SELECT id, workspace_id, status, now() - make_interval(secs => ${staleSeconds}) AS stale_before
      FROM opening_tutor_jobs
      WHERE status IN ('queued', 'running')
        AND updated_at < now() - make_interval(secs => ${staleSeconds})
        AND (${input.jobId ?? null}::uuid IS NULL OR id = ${input.jobId ?? null}::uuid)
        AND (${input.workspaceId ?? null}::uuid IS NULL OR workspace_id = ${input.workspaceId ?? null}::uuid)
      ORDER BY updated_at LIMIT ${input.limit ?? 50}`;
    let expired = 0;
    for (const row of rows) {
      const scope = { workspaceId: row.workspace_id, ownerUserId: "" };
      const ended = row.status === "queued"
        ? await markTerminal({ scope, jobId: row.id, message: TUTOR_STALE_MESSAGE, status: "failed",
          detail: { code: "TUTOR_JOB_STALE" }, staleBefore: row.stale_before })
        : await markTerminal({ scope, jobId: row.id, message: TUTOR_INTERRUPTED_MESSAGE, status: "outcome_unknown",
          staleBefore: row.stale_before });
      if (ended) expired += 1;
    }
    return expired;
  }

  async function findPending(scope: OpeningScope, conversationId: string): Promise<{
    id: string;
    status: OpeningTutorJobRecord["status"];
    error: OpeningTutorJobError | null;
    updatedAt: string;
  } | null> {
    const rows = await sql`
      SELECT j.id, j.status, j.error, j.updated_at, t.status AS turn_status
      FROM opening_tutor_jobs j
      JOIN opening_conversations c ON c.id = j.conversation_id
      JOIN opening_turns t ON t.id = j.assistant_turn_id
      WHERE j.conversation_id = ${conversationId}
        AND j.workspace_id = ${scope.workspaceId}
        AND c.workspace_id = ${scope.workspaceId}
        AND c.owner_user_id = ${scope.ownerUserId}
        AND t.workspace_id = ${scope.workspaceId}
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT 1
    `;
    if (!rows.length) return null;
    const row = rows[0] as Record<string, unknown>;
    // Inspect the latest job before filtering statuses so an older unknown
    // result cannot resurface after a newer answer has already ended.
    const active = (row.status === "queued" || row.status === "running") && row.turn_status === "pending";
    const unknown = row.status === "outcome_unknown"
      && (row.turn_status === "pending" || row.turn_status === "outcome_unknown");
    if (!active && !unknown) return null;
    return {
      id: row.id as string,
      status: row.status as OpeningTutorJobRecord["status"],
      error: tutorFailureForDisplay(row.status, row.error),
      updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    };
  }

  async function getJob(scope: OpeningScope, id: string): Promise<OpeningTutorJobRecord | null> {
    const rows = await sql`
      SELECT j.* FROM opening_tutor_jobs j
      JOIN opening_conversations c ON c.id = j.conversation_id
      WHERE j.id = ${id}
        AND j.workspace_id = ${scope.workspaceId}
        AND c.workspace_id = ${scope.workspaceId}
        AND c.owner_user_id = ${scope.ownerUserId}
      LIMIT 1
    `;
    return rows.length ? mapJob(rows[0] as Record<string, unknown>) : null;
  }

  /** Read-time reconciliation for one job a client is looking at. */
  async function expireIfStale(scope: OpeningScope, jobId: string, status: string): Promise<boolean> {
    if (!options.staleMs || (status !== "queued" && status !== "running")) return false;
    return (await expireStale({ staleMs: options.staleMs, jobId, workspaceId: scope.workspaceId, limit: 1 })) > 0;
  }

  return {
    loadHistory: (scope: OpeningScope, currentTurnId: string) => loadTutorHistory(sql, scope, currentTurnId),
    loadHistoryContext: (scope: OpeningScope, currentTurnId: string, purpose?: TutorHistoryPurpose) => loadTutorHistoryContext(sql, scope, currentTurnId, purpose),
    async claim(id: string): Promise<OpeningTutorJobRecord | null> {
      const rows = await sql`
        UPDATE opening_tutor_jobs j SET status = 'running', claim_token = ${randomUUID()}, updated_at = now()
        FROM workspaces w,opening_conversations c
        WHERE j.id = ${id} AND j.workspace_id = w.id
          AND c.id=j.conversation_id AND c.workspace_id=j.workspace_id AND c.owner_user_id=w.owner_user_id
          AND j.status = 'queued'
        RETURNING j.*, w.owner_user_id
      `;
      if (!rows.length) return null;
      const row = rows[0] as Record<string, unknown>;
      return { ...mapJob(row), ownerUserId: row.owner_user_id as string };
    },

    async heartbeat(id: string, claimToken: string): Promise<boolean> {
      const rows = await sql`UPDATE opening_tutor_jobs SET updated_at = now()
        WHERE id = ${id} AND status = 'running' AND claim_token = ${claimToken} RETURNING id`;
      return rows.length > 0;
    },

    async recoverExpired(limit = 50): Promise<number> {
      const rows = await sql`SELECT id, workspace_id, now() - interval '5 minutes' AS stale_before FROM opening_tutor_jobs
        WHERE status = 'running' AND updated_at < now() - interval '5 minutes' ORDER BY updated_at LIMIT ${limit}`;
      let recovered = 0;
      for (const row of rows) {
        if (await markTerminal({ scope: { workspaceId: row.workspace_id, ownerUserId: "" }, jobId: row.id,
          message: TUTOR_INTERRUPTED_MESSAGE, status: "outcome_unknown", staleBefore: row.stale_before as Date })) recovered += 1;
      }
      return recovered;
    },

    expireStale,

    async findPendingForConversation(
      scope: OpeningScope,
      conversationId: string,
    ): Promise<{
      id: string;
      status: OpeningTutorJobRecord["status"];
      error: OpeningTutorJobError | null;
      updatedAt: string;
    } | null> {
      const pending = await findPending(scope, conversationId);
      if (pending && await expireIfStale(scope, pending.id, pending.status)) return findPending(scope, conversationId);
      return pending;
    },

    async cancel(scope: OpeningScope, id: string): Promise<OpeningTutorJobRecord | null> {
      return sql.begin(async (tx) => {
        // Keep cancellation in the workspace-first order used by writeback.
        await tx`
          SELECT id FROM workspaces
          WHERE id = ${scope.workspaceId}
          FOR UPDATE
        `;
        const rows = await tx`
          UPDATE opening_tutor_jobs j
          SET status = 'cancelled', updated_at = now(), error = ${tx.json({ message: "cancelled by user" } as never)}
          FROM opening_conversations c
          WHERE j.id = ${id}
            AND j.workspace_id = ${scope.workspaceId}
            AND c.id = j.conversation_id
            AND c.workspace_id = ${scope.workspaceId}
            AND c.owner_user_id = ${scope.ownerUserId}
            AND j.status IN ('queued', 'running')
          RETURNING j.*
        `;
        if (!rows.length) return null;
        await tx`
          UPDATE opening_turns
          SET status = 'failed', text = '回答任务已取消'
          WHERE id = ${rows[0]!.assistant_turn_id}
            AND workspace_id = ${scope.workspaceId}
            AND NOT (status = ANY(${[...TERMINAL_TURN_STATUSES]}::text[]))
        `;
        return mapJob(rows[0] as Record<string, unknown>);
      });
    },

    async get(scope: OpeningScope, id: string): Promise<OpeningTutorJobRecord | null> {
      const job = await getJob(scope, id);
      if (job && await expireIfStale(scope, job.id, job.status)) return getJob(scope, id);
      return job;
    },

    /** Authorize every nonempty stream delivery and record help before bytes leave HTTP. */
    async readStream(scope: OpeningScope, id: string, context: {
      privacyEpoch: number; contextSourceRefs: ContextSourceRef[]; exposureReceiptId: string | null; claimToken?: string;
    }): Promise<OpeningTutorJobRecord | null> {
      return sql.begin(async tx => {
        if (context.exposureReceiptId) await lockWorkspaceLearningHistory(tx, scope);
        const [workspace] = await tx`SELECT privacy_epoch FROM workspaces
          WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!workspace) return null;
        const [row] = await tx`SELECT j.* FROM opening_tutor_jobs j
          JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
          WHERE j.id=${id} AND j.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId} FOR UPDATE OF j`;
        if (!row) return null;
        const job = mapJob(row as Record<string, unknown>);
        if (job.status !== "running") return job;
        if (Number(workspace.privacy_epoch) !== context.privacyEpoch || row.claim_token !== (context.claimToken ?? null)) {
          throw new Error("stream authorization changed");
        }
        const [available] = await tx`SELECT 1 WHERE ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`${tx.json(context.contextSourceRefs)}::jsonb`)}`;
        if (!available) throw new Error("stream material unavailable or excluded");
        if (context.exposureReceiptId) {
          const [exposure] = await tx`SELECT id FROM opening_help_exposures WHERE id=${context.exposureReceiptId}
            AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
            AND turn_id=${job.assistantTurnId} AND exposure_origin='assistant'`;
          if (!exposure) throw new Error("stream exposure does not belong to assistant turn");
          await releaseOpeningStudyExposure(tx, scope, context.exposureReceiptId);
        }
        return job;
      }) as Promise<OpeningTutorJobRecord | null>;
    },

    async listQueued(limit: number): Promise<OpeningTutorJobRecord[]> {
      // Short dispatch lease bounds Redis traffic and is recovered after a crash.
      const rows = await sql`
        UPDATE opening_tutor_jobs j SET dispatch_after = now() + interval '1 minute'
        FROM (SELECT id FROM opening_tutor_jobs WHERE status = 'queued' AND dispatch_after <= now()
          ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT ${limit}) due
        WHERE j.id = due.id RETURNING j.*
      `;
      return rows.map((row) => mapJob(row as Record<string, unknown>));
    },

    /**
     * One transaction: assistant turn completes, validated candidates are
     * stored pending with program-assigned provenance, job succeeds.
     */
    async completeTurn(input: {
      scope: OpeningScope;
      jobId: string;
      assistantTurnId: string;
      text: string;
      citations: Citation[];
      candidates: Array<{ payload: unknown; sourceIds: string[] }>;
      contextSourceRefs?: ContextSourceRef[];
      systemQuery?: SystemQueryReceipt;
      generatedExposure?: OpeningStudyExposureInput;
      helpExposure?: {
        contextAnchor?: StudyContextAnchor;
        supportDomain?: "language" | "math" | "unknown";
        id: string;
        sessionId: string;
        problemId: string | null;
        attemptId?: string | null;
        activityId?: string | null;
        itemVersionId?: string | null;
        turnId: string;
        kind: "instruction" | "hint" | "solution";
        level: "hinted" | "revealed";
        delivered: true;
      };
      expectedPrivacyEpoch?: number;
      claimToken?: string;
      enqueueMetadata?: boolean;
    }): Promise<void> {
      await sql.begin(async (tx) => {
        if (input.helpExposure || input.generatedExposure) await lockWorkspaceLearningHistory(tx, input.scope);
        const workspace = await tx`
          SELECT privacy_epoch FROM workspaces WHERE id = ${input.scope.workspaceId} AND owner_user_id=${input.scope.ownerUserId} FOR UPDATE
        `;
        if (!workspace.length) throw new Error("workspace permission changed");
        const receipt = input.systemQuery ? systemQueryReceiptSchema.parse(input.systemQuery) : null;
        if (receipt) {
          if (receipt.authorization.purpose !== "system_record_lookup" || receipt.authorization.workspaceId !== input.scope.workspaceId
            || receipt.authorization.principalId !== input.scope.ownerUserId || receipt.privacyEpoch !== Number(workspace[0]!.privacy_epoch)) throw new Error("query receipt grant changed");
          const refs = mergeContextSourceRefs(...receipt.results.map(result => result.sourceRefs));
          const provided = input.contextSourceRefs ?? [];
          if (refs.some(ref => !provided.some(item => item.sourceId === ref.sourceId && item.sourceVersion === ref.sourceVersion))) throw new Error("query lineage incomplete");
          const [admitted] = await tx`SELECT ${contextSourceRefsIncluded(tx, input.scope.workspaceId, tx`${tx.json(provided)}::jsonb`, true, true)} AS included`;
          if (!admitted?.included) throw new Error("query source unavailable before persistence");
        }
        if (input.expectedPrivacyEpoch !== undefined) {
          const currentEpoch = Number((workspace[0] as { privacy_epoch?: number } | undefined)?.privacy_epoch);
          if (currentEpoch !== input.expectedPrivacyEpoch) {
            throw new Error(
              `privacy epoch drift: expected ${input.expectedPrivacyEpoch} current ${currentEpoch}`,
            );
          }
        }
        const claimed = await tx`
          UPDATE opening_tutor_jobs SET status = 'succeeded', error = NULL, updated_at = now()
          WHERE id = ${input.jobId}
            AND workspace_id = ${input.scope.workspaceId}
            AND status = 'running'
            AND claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid
          RETURNING id
        `;
        if (!claimed.length) return;
        const assistant = await tx`
          UPDATE opening_turns SET text = ${input.text}, citations = ${tx.json(input.citations as never)},
            system_query=${receipt ? tx.json(receipt as never) : null},
            context_source_refs = ${input.contextSourceRefs === undefined ? null : tx.json(input.contextSourceRefs as never)}, status = 'complete'
          WHERE id = ${input.assistantTurnId} AND workspace_id = ${input.scope.workspaceId} AND (${receipt === null} OR query_system)
          RETURNING id
        `;
        if (!assistant.length) throw new Error("assistant turn was not persisted");
        for (const candidate of input.candidates) {
          await tx`
            INSERT INTO opening_assistant_candidates (
              id, workspace_id, conversation_id, source_turn_id, source_ids, payload
            ) VALUES (
              ${randomUUID()}, ${input.scope.workspaceId},
              (SELECT conversation_id FROM opening_tutor_jobs WHERE id = ${input.jobId}),
              ${input.assistantTurnId},
              ${tx.json(candidate.sourceIds as never)}, ${tx.json(candidate.payload as never)}
            )
          `;
        }
        if (input.helpExposure) await insertOpeningDeliveredHelp(tx, input.scope, input.helpExposure, { generatedOnly: true });
        if (input.generatedExposure) await generateOpeningStudyExposure(tx, input.scope, input.generatedExposure);
        if (input.enqueueMetadata) {
          const jobId = randomUUID();
          const payload = { tutorJobId: input.jobId, assistantTurnId: input.assistantTurnId, tutorClaimToken: input.claimToken ?? null };
          const queued = await tx`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
            VALUES (${jobId}, ${input.scope.workspaceId}, ${input.scope.ownerUserId}, ${`tutor-metadata:${input.jobId}`},
              'tutor-metadata', ${tx.json(payload)}, ${Number(workspace[0]!.privacy_epoch)})
            ON CONFLICT (workspace_id, key) DO NOTHING RETURNING id`;
          if (queued.length) await tx`INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
            VALUES (${input.scope.workspaceId}, ${jobId}, 'opening.job.enqueue', ${tx.json({ jobId, kind: "tutor-metadata" })})`;
        }
      });
    },

    async loadCompletedTurnForMetadata(input: CompletedCandidateTarget): Promise<{
      question: string; answer: string; mode: string; userTurnId: string;
    } | null> {
      const target = await findCompletedCandidateTarget(sql, input);
      return target ? { question: String(target.question), answer: String(target.answer),
        mode: String(target.mode), userTurnId: String(target.user_turn_id) } : null;
    },

    async canAppendCompletedTurnCandidates(input: CompletedCandidateTarget): Promise<boolean> {
      return Boolean(await findCompletedCandidateTarget(sql, input));
    },

    /** Late suggestions never reopen a completed answer or change its text, usage, or exposure. */
    async appendCompletedTurnCandidates(input: CompletedCandidateTarget & { candidates: unknown[] }): Promise<boolean> {
      return sql.begin(async tx => {
        // Serialize against privacy/deletion and another metadata write for this answer.
        await tx`SELECT id FROM workspaces WHERE id=${input.scope.workspaceId}
          AND owner_user_id=${input.scope.ownerUserId} FOR UPDATE`;
        const target = await findCompletedCandidateTarget(tx, input);
        if (!target) return false;
        const sourceIds = [...new Set((target.context_source_refs as ContextSourceRef[]).map(ref => ref.sourceId))];
        for (const payload of input.candidates) {
          await tx`INSERT INTO opening_assistant_candidates
            (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
            VALUES (${randomUUID()}, ${input.scope.workspaceId}, ${target.conversation_id}, ${input.assistantTurnId},
              ${tx.json(sourceIds)}, ${tx.json(payload as never)})`;
        }
        return true;
      });
    },

    /** Apply the immutable saved user text once, after validating the actual running job and owned target. */
    async applyUserTurnIntent(scope: OpeningScope, input: { userTurnId: string; jobId: string; claimToken?: string }): Promise<Pick<StudyIntentEvent, "intent" | "action"> | null> {
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const [row] = await tx`SELECT t.text,t.attempt_id,t.context_anchor,t.learning_session_id,t.query_system,t.composer_purpose FROM opening_tutor_jobs j
          JOIN opening_turns t ON t.id=j.user_turn_id AND t.workspace_id=j.workspace_id
          JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
          WHERE j.id=${input.jobId} AND j.user_turn_id=${input.userTurnId} AND j.workspace_id=${scope.workspaceId}
            AND c.owner_user_id=${scope.ownerUserId} AND j.status='running'
            AND j.claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid FOR SHARE OF j`;
        if (!row) throw new Error("study intent job lease is no longer current");
        if (row.query_system === true || row.composer_purpose && row.composer_purpose !== "answer" && row.composer_purpose !== "teach"
          || (row.context_anchor as StudyContextAnchor | null)?.purpose === "language_support") {
          throw new Error("read-only or proposal composer purpose cannot change study intent");
        }
        const attemptId = row.attempt_id ?? (row.context_anchor as StudyContextAnchor | null)?.attemptId ?? null;
        const [attempt] = attemptId ? await tx`SELECT id,session_id FROM opening_learning_attempts WHERE id=${String(attemptId)}
          AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}` : [];
        const sessionId = attempt?.session_id ?? row.learning_session_id;
        if (!sessionId) return null;
        const [session] = await tx`SELECT id FROM opening_learning_sessions WHERE id=${String(sessionId)}
          AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if (!session || attemptId && !attempt) throw new Error("study intent target is not owned");
        const latest = await readOpeningStudyIntentInTx(tx, scope, String(sessionId));
        const clientKey = `tutor-intent:${input.userTurnId}`;
        const replay = await tx`SELECT id FROM opening_study_intent_events WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND (client_key=${clientKey} OR client_key LIKE ${`${clientKey}:signal:%`}) LIMIT 1`;
        // A retry must not reapply an older message over a subsequently confirmed preference.
        if (replay.length) return latest;
        const text = composerMessageText(String(row.text)), current = latest?.intent ?? DEFAULT_STUDY_SESSION_INTENT;
        const applied = parseExplicitStudyMessage(current, text);
        if (!applied) return latest;
        const changed = !isDeepStrictEqual(current, applied.intent);
        if (!changed && !applied.signals.length && !applied.needsConfirmation) return latest;
        const target = { sessionId: String(sessionId), ...(attempt ? { attemptId: String(attempt.id) } : {}) };
        if (text.length <= 2000 && (attempt || !applied.signals.some(signal => signal === "guessed" || signal === "copied_answer"))) {
          return appendOpeningStudyIntentInTx(tx, scope, { ...target, clientKey, change: { kind: "explicit_request", text } });
        }
        // Without an actual attempt, answer-condition reports cannot become evidence about an arbitrary question.
        if (changed) await appendOpeningStudyIntentInTx(tx, scope, { ...target, clientKey, change: { kind: "preference", intent: applied.intent } });
        for (const signal of applied.signals) {
          if (!attempt && (signal === "guessed" || signal === "copied_answer")) continue;
          await appendOpeningStudyIntentInTx(tx, scope, { ...target, clientKey: `${clientKey}:signal:${signal}`, change: { kind: "signal", signal } });
        }
        return studyIntentForMessage(latest, text);
      });
    },

    async getUserTurn(id: string, workspaceId: string): Promise<{
      text: string;
      mode: string;
      sourceIds: string[];
      sourceVersions: Record<string, number>;
      currentPage: number | null;
      chunkId: string | null;
      learningSessionId: string | null;
      attemptId?: string | null;
      strategyTemplateId: string | null;
      querySystem?: boolean;
      courseId?: string | null;
      contextAnchor?: StudyContextAnchor;
      purpose?: ComposerPurpose;
      languageSupportQuestion?: string | null;
      studyIntent?: StudyIntentEvent | null;
    } | null> {
      const rows = await sql`
        SELECT t.text,t.mode,t.source_ids,t.source_versions,t.current_page,t.chunk_id,t.learning_session_id,t.attempt_id,t.strategy_template_id,t.query_system,t.context_anchor,t.composer_purpose,c.course_id,c.owner_user_id,v.evaluation_spec,
          COALESCE(t.learning_session_id,(SELECT a.session_id FROM opening_learning_attempts a WHERE a.workspace_id=t.workspace_id AND a.owner_user_id=c.owner_user_id
            AND (a.id=t.attempt_id OR a.id::text=t.context_anchor->>'attemptId') LIMIT 1)) AS intent_session_id
        FROM opening_turns t JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
        LEFT JOIN opening_learning_item_versions v ON v.workspace_id=t.workspace_id AND v.owner_user_id=c.owner_user_id
          AND v.id::text=COALESCE(t.context_anchor->>'itemVersionId',(SELECT a.item_version_id::text FROM opening_learning_attempts a WHERE a.id=t.attempt_id AND a.workspace_id=t.workspace_id AND a.owner_user_id=c.owner_user_id))
        WHERE t.id = ${id} AND t.workspace_id = ${workspaceId} LIMIT 1
      `;
      if (!rows.length) return null;
      const row = rows[0] as Record<string, unknown>;
      const studyIntent = row.intent_session_id && row.owner_user_id ? await createOpeningStudyIntentRepository(sql).latest(
        { workspaceId, ownerUserId: String(row.owner_user_id) }, String(row.intent_session_id)) : null;
      return {
        studyIntent,
        text: row.text as string,
        mode: row.mode as string,
        sourceIds: (row.source_ids as string[]) ?? [],
        sourceVersions: (row.source_versions as Record<string, number>) ?? {},
        currentPage: (row.current_page as number | null) ?? null,
        chunkId: (row.chunk_id as string | null) ?? null,
        learningSessionId: (row.learning_session_id as string | null) ?? null,
        attemptId: (row.attempt_id as string | null) ?? null,
        ...(row.context_anchor ? { contextAnchor: row.context_anchor as StudyContextAnchor } : {}),
        ...(row.composer_purpose ? { purpose: row.composer_purpose as ComposerPurpose } : {}),
        languageSupportQuestion: openingCanonicalLanguageQuestion(row.evaluation_spec),
        strategyTemplateId: (row.strategy_template_id as string | null) ?? null,
        querySystem: row.query_system === true, courseId: (row.course_id as string | null) ?? null,
      };
    },

    /**
     * PR-D replay: resolve a budget ledger resultRef ("opening_turn:<id>") to the
     * persisted assistant turn, scope-bound. Null when absent or foreign.
     */
    async loadReplayedTurn(scope: OpeningScope, resultRef: string): Promise<{
      id: string;
      status: string;
      text: string;
    } | null> {
      const match = /^opening_turn:([0-9a-f-]{36})$/i.exec(resultRef);
      if (!match) return null;
      const rows = await sql`
        SELECT t.id, t.status, t.text FROM opening_turns t
        JOIN workspaces w ON w.id = t.workspace_id
        WHERE t.id = ${match[1]!} AND t.workspace_id = ${scope.workspaceId}
          AND w.owner_user_id = ${scope.ownerUserId}
        LIMIT 1
      `;
      if (!rows.length) return null;
      const row = rows[0] as Record<string, unknown>;
      return { id: row.id as string, status: row.status as string, text: (row.text as string | null) ?? "" };
    },

    /**
     * PR-D replay: the provider result is already persisted on the complete
     * assistant turn; finish the running job without re-writing the turn.
     * Returns false when the job is no longer running or the turn is not complete.
     */
    async completeFromReplay(scope: OpeningScope, jobId: string, assistantTurnId: string, claimToken?: string): Promise<boolean> {
      const rows = await sql`
        UPDATE opening_tutor_jobs j SET status = 'succeeded', error = NULL, updated_at = now()
        WHERE j.id = ${jobId} AND j.workspace_id = ${scope.workspaceId}
          AND j.assistant_turn_id = ${assistantTurnId}
          AND j.status = 'running'
          AND j.claim_token IS NOT DISTINCT FROM ${claimToken ?? null}::uuid
          AND EXISTS (
            SELECT 1 FROM opening_turns t
            WHERE t.id = ${assistantTurnId} AND t.workspace_id = ${scope.workspaceId} AND t.status = 'complete'
          )
        RETURNING j.id
      `;
      return rows.length === 1;
    },

    async fail(
      scope: OpeningScope,
      jobId: string,
      message: string,
      detail?: { code: string; nextAction?: "clarify" },
      claimToken?: string,
    ): Promise<void> {
      await markTerminal({ scope, jobId, message, status: "failed", detail, claimToken });
    },

    async markUnknown(scope: OpeningScope, jobId: string, message: string, claimToken?: string): Promise<void> {
      await markTerminal({ scope, jobId, message, status: "outcome_unknown", claimToken });
    },
  };
}
