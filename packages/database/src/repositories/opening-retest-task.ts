import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { Sql } from "postgres";
import { randomUUID } from "node:crypto";
import type { TaskCreateInput, TaskItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";

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
    title: row.title as string,
    minutes: Number(row.minutes),
    dueAt: row.due_at ? new Date(row.due_at as string | Date).toISOString() : null,
    priority: Number(row.priority),
    status: row.status as TaskItem["status"],
  };
}

/** Lock and validate a retest job. Returns the existing task on same-key replay. */
export async function prepareRetestTask(
  tx: TransactionSql,
  scope: OpeningScope,
  input: TaskCreateInput,
): Promise<TaskItem | null> {
  if (input.inputSnapshot?.kind !== "retest" || !input.candidateId) return null;
  if (input.clientKey) {
    const sameKey = await tx`
      SELECT id, payload FROM opening_jobs
      WHERE workspace_id = ${scope.workspaceId}
        AND owner_user_id = ${scope.ownerUserId}
        AND kind = ${"retest"}
        AND payload->>'acceptClientKey' = ${input.clientKey}
      FOR UPDATE`;
    if (sameKey.length) {
      const payload = (sameKey[0] as Record<string, unknown>).payload as {
        acceptPayloadHash?: string;
        taskId?: string;
      };
      if (payload.acceptPayloadHash !== retestPayloadHash(input)) {
        throw new OpeningPlanError("CONFLICT", "clientKey payload differs");
      }
      const tasks = await tx`
        SELECT * FROM opening_tasks
        WHERE id = ${payload.taskId ?? ""}
          AND workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}`;
      if (!tasks.length) throw new OpeningPlanError("NOT_FOUND", "replayed retest task missing");
      return mapTask(tasks[0] as Record<string, unknown>);
    }
  }
  const jobs = await tx`
    SELECT id, payload FROM opening_jobs
    WHERE id = ${input.candidateId}
      AND workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND kind = ${"retest"}
    FOR UPDATE`;
  if (!jobs.length) throw new OpeningPlanError("NOT_FOUND", "retest candidate not found");
  const payload = (jobs[0] as Record<string, unknown>).payload as { kind?: string; accepted?: boolean };
  if (payload?.kind !== "task") {
    throw new OpeningPlanError("VALIDATION", "retest candidate payload.kind must be task");
  }
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
      AND COALESCE((payload->>'accepted')::boolean, false) = false
    RETURNING id`;
  if (!marked.length) {
    throw new OpeningPlanError("CONFLICT", "retest candidate missing or already consumed");
  }
}

export async function insertOpeningTask(
  sql: Sql,
  scope: OpeningScope,
  input: TaskCreateInput & { dueText?: string | null },
): Promise<TaskItem> {
  if (input.dueText && input.dueAt) {
    throw new OpeningPlanError("VALIDATION", "ambiguous dueText cannot become a formal deadline");
  }
  const id = randomUUID();
  return sql.begin(async (tx) => {
    const replay = await prepareRetestTask(tx, scope, input);
    if (replay) return replay;
    if (input.candidateId && input.inputSnapshot?.kind !== "retest") {
      const consumed = await tx`
        UPDATE opening_assistant_candidates
        SET status = 'accepted', updated_at = now()
        WHERE id = ${input.candidateId}
          AND workspace_id = ${scope.workspaceId}
          AND status = 'pending'
        RETURNING id`;
      if (!consumed.length) {
        throw new OpeningPlanError("CONFLICT", "candidate missing or already consumed");
      }
    }
    const rows = await tx`
      INSERT INTO opening_tasks (
        id, workspace_id, owner_user_id, title, minutes, due_at, due_text,
        priority, status, version, candidate_id
      ) VALUES (
        ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.title}, ${input.minutes},
        ${input.dueAt}, ${input.dueText ?? null}, ${input.priority}, ${"pending"}, ${1},
        ${input.candidateId}
      ) RETURNING *`;
    const task = mapTask(rows[0] as Record<string, unknown>);
    await consumeRetestCandidate(tx, scope, input, task.id);
    return task;
  });
}
