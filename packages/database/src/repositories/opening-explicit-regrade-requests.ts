import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import {
  EXPLICIT_REGRADE_CONFIRMATION_TEXT, EXPLICIT_REGRADE_CONFIRMATION_VERSION,
  explicitRegradeConfirmSchema, explicitRegradePrepareSchema, explicitRegradeRequestSchema,
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

/** Stage one only: persist/consume consent. No reserve, enqueue, outbox or model I/O.
 * Worker admission must later consume this exact confirmed identity, never manufacture
 * an operation from a client key. Confirmation alone fences historical publication. */
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
        const context = await readOpeningExplicitRegradeCandidateContext(tx, scope, String(request.expected_head_id));
        const root = context.observation.rootObservationId ?? context.observation.id;
        if (root !== request.root_observation_id || context.answerRevision !== Number(request.answer_revision)
          || !isDeepStrictEqual(context.workSource, request.work_source)) throw conflict();
        const prior = await latest(tx, scope, root, context.answerRevision);
        // A consumed consent can only replay itself, never authorize the next version.
        if (request.confirmed_at != null) {
          if (prior?.id !== request.id) throw conflict();
          return record(request);
        }
        if (Number(prior?.grading_version ?? 0) !== Number(request.previous_grading_version)
          || String(prior?.operation_id ?? context.operationId) !== request.previous_operation_id) throw conflict();
        // The original may have settled since prepare. Do not silently broaden B
        // into regrading a known result, or rely on stale consent to an unknown fee.
        const ledger = await readOpeningAiGradingLedger(tx, scope, String(request.previous_operation_id));
        if (ledger !== "unknown") throw conflict();
        const [confirmed] = await tx`UPDATE opening_explicit_regrade_requests SET confirmed_at=clock_timestamp()
          WHERE id=${request.id} AND confirmed_at IS NULL RETURNING *`;
        return record(confirmed!);
      }) as Promise<ExplicitRegradeRequest>;
    },
  };
}
