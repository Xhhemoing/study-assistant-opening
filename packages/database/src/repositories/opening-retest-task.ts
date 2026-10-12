import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { Sql } from "postgres";
import { randomUUID } from "node:crypto";
import type { TaskCreateInput, TaskCreateResult, TaskItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { acceptAssistantTask } from "./opening-task-candidate-accept";
import { OpeningPlanError } from "./opening-plan-error";
import { lockOpeningRetestReviewCandidate } from "./opening-review-candidates";
import { insertAcceptedRetestActivity } from "./opening-retest-activities";
import { lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";

export function retestPayloadHash(input: TaskCreateInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        candidateId: input.candidateId,
        title: input.title,
        minutes: input.minutes,
        dueAt: input.dueAt,
        priority: input.priority,
        baseVersion: input.baseVersion ?? null,
        inputSnapshot: input.inputSnapshot ?? null,
      }),
    )
    .digest("hex");
}

function mapTask(row: Record<string, unknown>): TaskItem {
  return {
    id: row.id as string,
    version: Number(row.version),
    title: row.title as string,
    minutes: Number(row.minutes),
    dueAt: row.due_at ? new Date(row.due_at as string | Date).toISOString() : null,
    priority: Number(row.priority),
    status: row.status as TaskItem["status"],
    retest: null,
  };
}

async function findRetestReplay(
  tx: TransactionSql,
  scope: OpeningScope,
  input: TaskCreateInput,
): Promise<TaskItem | null> {
  if (!input.clientKey) return null;
  // Same expression as 0060's opening_jobs_retest_accept_key_uidx: the current spelling
  // (payload.acceptClientKey) and the legacy JSON-only writer's result.clientKey.
  const sameKey = await tx`
    SELECT id, payload FROM opening_jobs
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND kind = ${"retest"}
      AND COALESCE(payload->>'acceptClientKey', result->>'clientKey') = ${input.clientKey}
    FOR UPDATE`;
  if (!sameKey.length) return null;
  const payload = (sameKey[0] as Record<string, unknown>).payload as {
    acceptPayloadHash?: string;
    taskId?: string;
  };
  if (payload.acceptPayloadHash === undefined) {
    // Legacy accept receipt (result.clientKey only, no task): nothing to replay.
    throw new OpeningPlanError("CONFLICT", "clientKey already used by a legacy retest accept");
  }
  if (payload.acceptPayloadHash !== retestPayloadHash(input)) {
    throw new OpeningPlanError("CONFLICT", "clientKey payload differs");
  }
  if (!payload.taskId) throw new OpeningPlanError("NOT_FOUND", "replayed retest task missing");
  const tasks = await tx`
    SELECT * FROM opening_tasks
    WHERE id = ${payload.taskId}
      AND workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}`;
  if (!tasks.length) throw new OpeningPlanError("NOT_FOUND", "replayed retest task missing");
  return mapTask(tasks[0] as Record<string, unknown>);
}

/** Lock and validate a retest job. Returns the existing task on same-key replay. */
export async function prepareRetestTask(
  tx: TransactionSql,
  scope: OpeningScope,
  input: TaskCreateInput,
): Promise<TaskItem | null> {
  if (input.inputSnapshot?.kind !== "retest" || !input.candidateId) return null;
  const payload = await lockOpeningRetestReviewCandidate(tx, scope, input.candidateId);
  // Admission and the candidate lock precede every replay, including a concurrent accept.
  const replay = await findRetestReplay(tx, scope, input);
  if (replay) return replay;
  if (payload.invalidated) throw new OpeningPlanError("CONFLICT", "retest candidate evidence was revised");
  if (payload.discarded) throw new OpeningPlanError("CONFLICT", "retest candidate was discarded");
  if (payload.accepted) throw new OpeningPlanError("CONFLICT", "retest candidate already consumed");
  return null;
}

export async function consumeRetestCandidate(
  tx: TransactionSql,
  scope: OpeningScope,
  input: TaskCreateInput,
  taskId: string,
): Promise<void> {
  if (input.inputSnapshot?.kind !== "retest" || !input.candidateId) return;
  const marked = await tx`
    UPDATE opening_jobs
    SET payload = payload || ${tx.json({
          accepted: true,
          acceptClientKey: input.clientKey ?? null,
          acceptPayloadHash: retestPayloadHash(input),
          taskId,
        } as never)},
        result = ${tx.json({
          accepted: true,
          clientKey: input.clientKey ?? null,
          payloadHash: retestPayloadHash(input),
          taskId,
          baseVersion: input.baseVersion ?? 0,
          inputSnapshot: input.inputSnapshot,
          scheduled: false,
        } as never)},
        updated_at = now()
    WHERE id = ${input.candidateId}
      AND workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND kind = ${"retest"}
      AND COALESCE(payload->>'kind', '') = 'task'
      AND COALESCE(payload->>'invalidated', 'false') = 'false'
      AND COALESCE((payload->>'accepted')::boolean, false) = false
    RETURNING id`;
  if (!marked.length) {
    throw new OpeningPlanError("CONFLICT", "retest candidate missing or already consumed");
  }
}

type QuickAddIntent = {
  title: string;
  minutes: number;
  priority: number;
  dueAt: string | null;
  dueText: string | null;
};

/**
 * Stable request fingerprint for the quick-add namespace (S5). Only the user-visible
 * intent participates; status/version changes after creation never alter it.
 */
export function quickAddFingerprint(intent: QuickAddIntent): string {
  return createHash("sha256")
    .update(JSON.stringify([
      "quick-add/v1",
      intent.title,
      intent.minutes,
      intent.priority,
      intent.dueAt === null ? null : new Date(intent.dueAt).toISOString(),
      intent.dueText,
    ]))
    .digest("hex");
}

function inputIntent(input: TaskCreateInput & { dueText?: string | null }): QuickAddIntent {
  return {
    title: input.title,
    minutes: input.minutes,
    priority: input.priority,
    dueAt: input.dueAt ?? null,
    dueText: input.dueText ?? null,
  };
}

function rowIntent(row: Record<string, unknown>): QuickAddIntent {
  return {
    title: row.title as string,
    minutes: Number(row.minutes),
    priority: Number(row.priority),
    dueAt: row.due_at ? new Date(row.due_at as string | Date).toISOString() : null,
    dueText: (row.due_text as string | null | undefined) ?? null,
  };
}

export type TaskCreateOutcome = { task: TaskCreateResult; replayed: boolean };

/**
 * Quick-add with a clientKey (namespace: workspace + owner + quick-add + clientKey).
 * One statement claims the key: INSERT … ON CONFLICT DO NOTHING RETURNING. A loser waits
 * on the 0046 unique index for the winner, then re-reads the committed row in a fresh
 * statement snapshot. The task row is placeholder, creation and result reference at once.
 */
async function insertQuickAddWithKey(
  tx: TransactionSql,
  scope: OpeningScope,
  input: TaskCreateInput & { dueText?: string | null },
  clientKey: string,
): Promise<TaskCreateOutcome> {
  const fingerprint = quickAddFingerprint(inputIntent(input));
  const inserted = await tx`
    INSERT INTO opening_tasks (
      id, workspace_id, owner_user_id, title, minutes, due_at, due_text,
      priority, status, version, candidate_id, client_key
    ) VALUES (
      ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.title}, ${input.minutes},
      ${input.dueAt}, ${input.dueText ?? null}, ${input.priority}, ${"pending"}, ${1},
      ${null}, ${clientKey}
    )
    ON CONFLICT (workspace_id, owner_user_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
    RETURNING *`;
  if (inserted.length) return { task: mapTask(inserted[0] as Record<string, unknown>), replayed: false };
  const existing = await tx`
    SELECT * FROM opening_tasks
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND client_key = ${clientKey}`;
  const row = existing[0] as Record<string, unknown> | undefined;
  // The key holder vanished between statements (e.g. a restore replaced the workspace).
  if (!row) throw new OpeningPlanError("CONFLICT", "clientKey holder changed; retry");
  if (row.candidate_id !== null && row.candidate_id !== undefined) {
    throw new OpeningPlanError("CONFLICT", "clientKey belongs to another task kind");
  }
  if (quickAddFingerprint(rowIntent(row)) !== fingerprint) {
    throw new OpeningPlanError("CONFLICT", "clientKey payload differs");
  }
  return { task: mapTask(row), replayed: true };
}

/** Legacy shape: returns only the task. Prefer insertOpeningTaskWithOutcome. */
export async function insertOpeningTask(
  sql: Sql,
  scope: OpeningScope,
  input: TaskCreateInput & { dueText?: string | null },
): Promise<TaskCreateResult> {
  return (await insertOpeningTaskWithOutcome(sql, scope, input)).task;
}

export async function insertOpeningTaskWithOutcome(
  sql: Sql,
  scope: OpeningScope,
  input: TaskCreateInput & { dueText?: string | null },
): Promise<TaskCreateOutcome> {
  if (input.dueText && input.dueAt) {
    throw new OpeningPlanError("VALIDATION", "ambiguous dueText cannot become a formal deadline");
  }
  if (input.candidateId === null && input.clientKey) {
    const clientKey = input.clientKey;
    return sql.begin((tx) => insertQuickAddWithKey(tx, scope, input, clientKey));
  }
  // Candidate accepts keep their own receipts (assistant: task_accept_client_key,
  // retest: opening_jobs.payload.acceptClientKey). No-key quick-add is not idempotent.
  // `replayed` = this call created no task (same-key replay or an already-accepted candidate).
  // A rolled-back insert's id is never returned, so id equality proves creation.
  let createdId: string | null = null;
  const insert = async (tx: TransactionSql): Promise<TaskItem> => {
    const rows = await tx`
      INSERT INTO opening_tasks (
        id, workspace_id, owner_user_id, title, minutes, due_at, due_text,
        priority, status, version, candidate_id, client_key
      ) VALUES (
        ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.title}, ${input.minutes},
        ${input.dueAt}, ${input.dueText ?? null}, ${input.priority}, ${"pending"}, ${1},
        ${input.candidateId}, ${null}
      ) RETURNING *`;
    const task = mapTask(rows[0] as Record<string, unknown>);
    createdId = task.id;
    return task;
  };
  if (input.candidateId && input.inputSnapshot?.kind !== "retest") {
    const task = await acceptAssistantTask(sql, scope, input, insert);
    return { task, replayed: task.id !== createdId };
  }
  try {
    const task = await insertRetestOrPlainTask(sql, scope, input, insert);
    return { task, replayed: task.id !== createdId };
  } catch (error) {
    if (!isRetestAcceptKeyViolation(error)) throw error;
    // The 0060 index rejected a racing writer that bypassed the workspace learning lock.
    // PostgreSQL aborted this transaction; compare against the committed winner afresh.
    const replay = await sql.begin((tx) => findRetestReplay(tx, scope, input));
    if (!replay) throw error;
    return { task: replay, replayed: true };
  }
}

function isRetestAcceptKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "23505"
    && (error as { constraint_name?: unknown }).constraint_name === "opening_jobs_retest_accept_key_uidx";
}

async function insertRetestOrPlainTask(
  sql: Sql,
  scope: OpeningScope,
  input: TaskCreateInput & { dueText?: string | null },
  insert: (tx: TransactionSql) => Promise<TaskItem>,
): Promise<TaskItem> {
  return sql.begin(async (tx) => {
    if (input.inputSnapshot?.kind === "retest") await lockWorkspaceLearningHistory(tx, scope);
    const retestReplay = await prepareRetestTask(tx, scope, input);
    if (retestReplay) return retestReplay;
    const task = await insert(tx);
    await consumeRetestCandidate(tx, scope, input, task.id);
    const candidateRows = await tx`SELECT payload FROM opening_jobs
      WHERE id=${input.candidateId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      FOR SHARE`;
    const candidate = (candidateRows[0] as Record<string, unknown> | undefined)?.payload as {
      courseId?: string; skillLabel?: string; requirementKey?: string | null; dueAt?: string;
    } | undefined;
    if (candidate?.courseId && candidate.skillLabel && input.candidateId) {
      await insertAcceptedRetestActivity(tx, scope, {
        cycleId: input.candidateId,
        candidateId: input.candidateId,
        taskId: task.id,
        courseId: candidate.courseId,
        skillLabel: candidate.skillLabel,
        requirementKey: candidate.requirementKey ?? null,
        proposedAt: candidate.dueAt ?? null,
        recommendedAt: candidate.dueAt ?? null,
        acceptedAt: new Date().toISOString(),
      });
      await nextWorkspaceLearningHistoryRevision(tx, scope);
    }
    return task;
  });
}
