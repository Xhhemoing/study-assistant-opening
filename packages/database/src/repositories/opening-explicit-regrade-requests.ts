import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import {
  EXPLICIT_REGRADE_CONFIRMATION_TEXT, EXPLICIT_REGRADE_CONFIRMATION_VERSION,
  explicitRegradeConfirmSchema, explicitRegradePrepareSchema, explicitRegradeRequestSchema, explicitRegradeStatusSchema, gradeObservationJobPayloadSchema,
  type ExplicitRegradeRequest, type Scope,
} from "@aistudy/contracts";
import { learningError, lockLearningOwner, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { readOpeningExplicitRegradeCandidateContext } from "./opening-ai-grading-context";
import { readOpeningAiGradingLedger } from "./opening-ai-grading-ledger";

type Row = Record<string, unknown>;
const conflict = () => learningError("CONFLICT", "批改身份或确认已变化，请刷新后重新确认；不会重发旧请求");

function record(row: Row): ExplicitRegradeRequest {
  return explicitRegradeRequestSchema.parse({
    requestId: row.id, rootObservationId: row.root_observation_id, expectedHead: row.expected_head_id,
    answerRevision: Number(row.answer_revision), privacyEpoch: Number(row.privacy_epoch),
    previousGradingVersion: Number(row.previous_grading_version), gradingVersion: Number(row.grading_version),
    previousOperationId: row.previous_operation_id, operationId: row.operation_id,
    confirmationVersion: row.confirmation_version, confirmationText: EXPLICIT_REGRADE_CONFIRMATION_TEXT,
    workSource: row.work_source, state: row.confirmed_at == null ? "prepared" : "confirmed",
    confirmedAt: row.confirmed_at == null ? null : new Date(row.confirmed_at as Date).toISOString(),
    jobId: row.job_id, resultObservationId: row.result_observation_id,
  });
}

async function lockIdentity(tx: TransactionSql, scope: Scope) {
  await lockWorkspaceLearningHistory(tx, scope);
  await lockLearningOwner(tx, scope);
  const [workspace] = await tx`SELECT w.privacy_epoch FROM workspaces w JOIN users u ON u.id=w.owner_user_id
    WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId} AND u.disabled_at IS NULL FOR SHARE OF u`;
  if (!workspace) throw learningError("NOT_FOUND", "workspace owner unavailable");
  return Number(workspace.privacy_epoch);
}

async function latest(tx: TransactionSql, scope: Scope, root: string, answerRevision: number) {
  const [row] = await tx`SELECT * FROM opening_explicit_regrade_requests
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND root_observation_id=${root} AND answer_revision=${answerRevision} AND confirmed_at IS NOT NULL
    ORDER BY grading_version DESC LIMIT 1`;
  return row;
}

/** Caller holds history/owner/request locks. The consent, job and outbox share a commit.
 * Existing confirmed rows without jobs use this same path; no budget reservation here. */
async function ensureJob(tx: TransactionSql, scope: Scope, request: Row) {
  if (request.confirmed_at == null) throw conflict();
  const payload = gradeObservationJobPayloadSchema.parse({ observationId: request.expected_head_id,
    rootObservationId: request.root_observation_id, answerRevision: Number(request.answer_revision),
    regrade: { requestId: request.id, operationId: request.operation_id, ownerUserId: scope.ownerUserId,
      privacyEpoch: Number(request.privacy_epoch), gradingVersion: Number(request.grading_version), workSource: request.work_source } });
  const [created] = await tx`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,privacy_epoch)
    VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${String(request.operation_id)},'grade-observation',
      ${tx.json(payload)},${Number(request.privacy_epoch)}) ON CONFLICT(workspace_id,key) DO NOTHING RETURNING *`;
  const [existing] = created ? [created] : await tx`SELECT * FROM opening_jobs
    WHERE workspace_id=${scope.workspaceId} AND key=${String(request.operation_id)}`;
  if (!existing || existing.owner_user_id !== scope.ownerUserId || existing.kind !== "grade-observation"
    || Number(existing.privacy_epoch) !== Number(request.privacy_epoch) || !isDeepStrictEqual(existing.payload, payload)
    || request.job_id != null && request.job_id !== existing.id) throw conflict();
  if (created) await tx`INSERT INTO opening_outbox(workspace_id,job_id,topic,payload)
    VALUES(${scope.workspaceId},${String(existing.id)},'opening.job.enqueue',${tx.json({ jobId: existing.id, kind: "grade-observation" })})`;
  const [linked] = await tx`UPDATE opening_explicit_regrade_requests SET job_id=${String(existing.id)}
    WHERE id=${String(request.id)} RETURNING *`;
  return record(linked!);
}

/** Consent never reserves or sends. Only the normal claimed worker may spend. */
export function createOpeningExplicitRegradeRequestRepository(sql: Sql) {
  return {
    async prepare(scope: Scope, raw: unknown): Promise<ExplicitRegradeRequest> {
      const input = explicitRegradePrepareSchema.parse(raw);
      return sql.begin(async tx => {
        const epoch = await lockIdentity(tx, scope);
        if (input.observationId !== input.expectedHead) throw conflict();
        const context = await readOpeningExplicitRegradeCandidateContext(tx, scope, input.observationId);
        const root = context.observation.rootObservationId ?? context.observation.id;
        const [replay] = await tx`SELECT * FROM opening_explicit_regrade_requests WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
        if (replay) {
          if (replay.expected_head_id !== input.expectedHead || replay.root_observation_id !== root
            || Number(replay.answer_revision) !== context.answerRevision || Number(replay.privacy_epoch) !== epoch
            || Number(replay.previous_grading_version) !== input.expectedGradingVersion
            || !isDeepStrictEqual(replay.work_source, context.workSource)) throw conflict();
          return record(replay);
        }
        const prior = await latest(tx, scope, root, context.answerRevision);
        const previousVersion = Number(prior?.grading_version ?? 0);
        if (input.expectedGradingVersion !== previousVersion) throw conflict();
        const previousOperation = String(prior?.operation_id ?? context.operationId);
        const ledger = await readOpeningAiGradingLedger(tx, scope, previousOperation);
        if (ledger !== "unknown") throw learningError("CONFLICT", "只有费用未决的原批改可准备显式重新批改");
        const id = randomUUID();
        const [created] = await tx`INSERT INTO opening_explicit_regrade_requests
          (id,workspace_id,owner_user_id,root_observation_id,expected_head_id,answer_revision,privacy_epoch,
           previous_grading_version,grading_version,previous_operation_id,operation_id,client_key,confirmation_version,work_source)
          VALUES(${id},${scope.workspaceId},${scope.ownerUserId},${root},${input.expectedHead},${context.answerRevision},${epoch},
            ${previousVersion},${previousVersion + 1},${previousOperation},${`ai-regrade:${scope.workspaceId}:${id}`},${input.clientKey},
            ${EXPLICIT_REGRADE_CONFIRMATION_VERSION},${context.workSource ? tx.json(context.workSource) : null}) RETURNING *`;
        return record(created!);
      }) as Promise<ExplicitRegradeRequest>;
    },
    async confirm(scope: Scope, raw: unknown): Promise<ExplicitRegradeRequest> {
      const input = explicitRegradeConfirmSchema.parse(raw);
      return sql.begin(async tx => {
        const epoch = await lockIdentity(tx, scope);
        const [request] = await tx`SELECT * FROM opening_explicit_regrade_requests WHERE id=${input.requestId}
          AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!request) throw learningError("NOT_FOUND", "找不到批改确认请求");
        if (request.confirmation_version !== input.confirmationVersion || Number(request.privacy_epoch) !== epoch) throw conflict();
        if (request.confirmed_at != null) {
          const prior = await latest(tx, scope, String(request.root_observation_id), Number(request.answer_revision));
          if (prior?.id !== request.id) throw conflict();
          return ensureJob(tx, scope, request);
        }
        const context = await readOpeningExplicitRegradeCandidateContext(tx, scope, String(request.expected_head_id));
        const root = context.observation.rootObservationId ?? context.observation.id;
        if (root !== request.root_observation_id || context.answerRevision !== Number(request.answer_revision)
          || !isDeepStrictEqual(context.workSource, request.work_source)) throw conflict();
        const prior = await latest(tx, scope, root, context.answerRevision);
        if (Number(prior?.grading_version ?? 0) !== Number(request.previous_grading_version)
          || String(prior?.operation_id ?? context.operationId) !== request.previous_operation_id) throw conflict();
        // The original may have settled since prepare. Do not silently broaden B
        // into regrading a known result, or rely on stale consent to an unknown fee.
        const ledger = await readOpeningAiGradingLedger(tx, scope, String(request.previous_operation_id));
        if (ledger !== "unknown") throw conflict();
        const [confirmed] = await tx`UPDATE opening_explicit_regrade_requests SET confirmed_at=clock_timestamp()
          WHERE id=${request.id} AND confirmed_at IS NULL RETURNING *`;
        return ensureJob(tx, scope, confirmed!);
      }) as Promise<ExplicitRegradeRequest>;
    },
    /** Read-only and bound to this exact version, not the legacy operation. */
    async read(scope: Scope, requestId: string) {
      return sql.begin("isolation level repeatable read read only", async tx => {
        const [row] = await tx`SELECT r.*,j.state AS job_state FROM opening_explicit_regrade_requests r
          JOIN workspaces w ON w.id=r.workspace_id AND w.owner_user_id=r.owner_user_id
          JOIN users u ON u.id=w.owner_user_id AND u.disabled_at IS NULL
          LEFT JOIN opening_jobs j ON j.id=r.job_id AND j.workspace_id=r.workspace_id AND j.owner_user_id=r.owner_user_id
          WHERE r.id=${requestId} AND r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId}`;
        if (!row) throw learningError("NOT_FOUND", "找不到批改确认请求");
        const ledger = await readOpeningAiGradingLedger(tx, scope, String(row.operation_id));
        const status = row.confirmed_at == null ? "prepared"
          : ledger === "unknown" || ledger === "in_flight" && row.job_state !== "running" ? "unknown_cost"
            : row.result_observation_id != null ? "graded" : row.job_state === "running" ? "grading"
              : row.job_state === "queued" ? "queued" : row.job_id == null ? "pending_enqueue" : "needs_manual";
        return explicitRegradeStatusSchema.parse({ request: record(row), ledger, jobState: row.job_state ?? null, status });
      });
    },
    /** Called by the existing worker sweep before generic recovery. A crash after
     * stage-one confirmation must not strand a durable paid-input identity. */
    async recoverConfirmed(limit = 50) {
      const rows = await sql`SELECT r.id,r.workspace_id,r.owner_user_id FROM opening_explicit_regrade_requests r
        JOIN workspaces w ON w.id=r.workspace_id AND w.owner_user_id=r.owner_user_id
        JOIN users u ON u.id=w.owner_user_id AND u.disabled_at IS NULL
        WHERE r.confirmed_at IS NOT NULL AND r.job_id IS NULL ORDER BY r.confirmed_at LIMIT ${limit}`;
      let recovered = 0;
      for (const row of rows) {
        const scope = { workspaceId: String(row.workspace_id), ownerUserId: String(row.owner_user_id) };
        const changed = await sql.begin(async tx => {
          await lockIdentity(tx, scope);
          const [request] = await tx`SELECT * FROM opening_explicit_regrade_requests WHERE id=${row.id} FOR UPDATE`;
          if (!request || request.job_id != null) return false;
          // Even stale consent gets its durable job. The worker rejects obsolete
          // owner/epoch/head before reserve; recovery never invents fresh consent.
          await ensureJob(tx, scope, request);
          return true;
        });
        if (changed) recovered += 1;
      }
      return recovered;
    },
  };
}
