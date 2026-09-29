import type { Sql, TransactionSql } from "postgres";
import { reviewResultSchema, type ReviewResult, type TaskCreateInput, type TaskCreateResult, type TaskItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";
import { admitTaskCandidate } from "./opening-task-candidate-admission";

type Candidate = { status: string; task_result_ref: unknown };

function intent(input: TaskCreateInput) {
  return {
    origin: "assistant", kind: "task", id: input.candidateId!.toLowerCase(), action: "accept",
    expectedVersion: input.expectedVersion ?? 0, baseVersion: input.baseVersion ?? null,
    title: input.title, minutes: input.minutes, priority: input.priority,
    dueAt: input.dueAt === null ? null : new Date(input.dueAt).toISOString(), dueText: input.dueText ?? null,
  };
}

function result(task: TaskItem, input: TaskCreateInput, disposition: ReviewResult["disposition"]): TaskCreateResult {
  return input.candidateRef ? { ...task, reviewResult: { disposition, resultRef: { kind: "task", id: task.id } } } : task;
}

async function existingTask(tx: TransactionSql, scope: OpeningScope, input: TaskCreateInput, ref: unknown): Promise<TaskItem> {
  const parsed = reviewResultSchema.shape.resultRef.safeParse(ref);
  if (ref !== null && (!parsed.success || parsed.data?.kind !== "task")) {
    throw new OpeningPlanError("NOT_FOUND", "accepted task reference unavailable");
  }
  const id = parsed.success ? parsed.data?.id ?? null : null;
  // Historical accepted candidates have no receipt: their existing task is authoritative.
  // Never recreate a missing result or select a foreign owner's object.
  const rows = await tx`
    SELECT id, title, minutes, due_at, priority, status FROM opening_tasks
    WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      AND candidate_id = ${input.candidateId}
      AND (${id}::uuid IS NULL OR id = ${id})
    ORDER BY created_at, id LIMIT 2`;
  if (rows.length !== 1) throw new OpeningPlanError("NOT_FOUND", "accepted task unavailable");
  const row = rows[0]!;
  return {
    id: row.id as string, title: row.title as string, minutes: Number(row.minutes), priority: Number(row.priority),
    status: row.status as TaskItem["status"], dueAt: row.due_at ? new Date(row.due_at as Date).toISOString() : null,
  };
}

async function findReplay(tx: TransactionSql, scope: OpeningScope, input: TaskCreateInput): Promise<TaskCreateResult | null> {
  if (!input.clientKey) return null;
  const rows = await tx`
    SELECT c.task_result_ref, c.task_accept_intent = ${tx.json(intent(input))} AS same_intent
    FROM opening_assistant_candidates c
    JOIN opening_conversations conv ON conv.id = c.conversation_id AND conv.workspace_id = c.workspace_id
      AND conv.owner_user_id = ${scope.ownerUserId}
    WHERE c.workspace_id = ${scope.workspaceId} AND c.task_accept_client_key = ${input.clientKey}`;
  if (!rows.length) return null;
  if (!rows[0]!.same_intent) throw new OpeningPlanError("CONFLICT", "clientKey payload differs");
  return result(await existingTask(tx, scope, input, rows[0]!.task_result_ref), input, "replayed");
}

/** Assistant-specific receipt on the candidate row; no hash or generic command store. */
export async function acceptAssistantTask(
  sql: Sql, scope: OpeningScope, input: TaskCreateInput,
  createTask: (tx: TransactionSql) => Promise<TaskItem>,
): Promise<TaskCreateResult> {
  try {
    return await sql.begin(async (tx) => {
      await admitTaskCandidate(tx, scope, input.candidateId!);
      const replay = await findReplay(tx, scope, input);
      if (replay) return replay;
      const rows = await tx<Candidate[]>`
        SELECT status, task_result_ref FROM opening_assistant_candidates
        WHERE id = ${input.candidateId} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
      const candidate = rows[0];
      if (!candidate) throw new OpeningPlanError("CONFLICT", "task candidate unavailable");
      // A competing accept may have committed while this transaction waited for the row.
      const lockedReplay = await findReplay(tx, scope, input);
      if (lockedReplay) return lockedReplay;
      if (candidate.status === "accepted") {
        return result(await existingTask(tx, scope, input, candidate.task_result_ref), input, "already_processed");
      }
      if (candidate.status !== "pending" || (input.expectedVersion ?? 0) !== 0) {
        throw new OpeningPlanError("CONFLICT", "task candidate is not pending or version is stale");
      }
      const task = await createTask(tx);
      await tx`
        UPDATE opening_assistant_candidates SET status = 'accepted', updated_at = now(),
          task_accept_client_key = ${input.clientKey ?? null}, task_accept_intent = ${tx.json(intent(input))},
          task_result_ref = ${tx.json({ kind: "task", id: task.id })}
        WHERE id = ${input.candidateId} AND workspace_id = ${scope.workspaceId}`;
      return result(task, input, "applied");
    });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "23505"
      || !("constraint_name" in error) || error.constraint_name !== "opening_assistant_task_accept_key_idx") throw error;
    // PostgreSQL has aborted the losing transaction. Re-read only after its rollback,
    // and repeat current admission before comparing the winner's committed receipt.
    return sql.begin(async (tx) => {
      await admitTaskCandidate(tx, scope, input.candidateId!);
      const replay = await findReplay(tx, scope, input);
      if (!replay) throw error;
      return replay;
    });
  }
}
