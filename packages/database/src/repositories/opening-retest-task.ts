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

async function findRetestReplay(
  tx: TransactionSql,
  scope: OpeningScope,
  input: TaskCreateInput,
): Promise<TaskItem | null> {
  if (!input.clientKey) return null;
  const sameKey = await tx`
    SELECT id, payload FROM opening_jobs
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND kind = ${"retest"}
      AND payload->>'acceptClientKey' = ${input.clientKey}
    FOR UPDATE`;
  if (!sameKey.length) return null;
  const payload = (sameKey[0] as Record<string, unknown>).payload as {
    acceptPayloadHash?: string;
    taskId?: string;
  };
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

export async function insertOpeningTask(
  sql: Sql,
  scope: OpeningScope,
  input: TaskCreateInput & { dueText?: string | null },
): Promise<TaskCreateResult> {
  if (input.dueText && input.dueAt) {
    throw new OpeningPlanError("VALIDATION", "ambiguous dueText cannot become a formal deadline");
  }
  const insert = async (tx: TransactionSql): Promise<TaskItem> => {
    const rows = await tx`
      INSERT INTO opening_tasks (
        id, workspace_id, owner_user_id, title, minutes, due_at, due_text,
        priority, status, version, candidate_id
      ) VALUES (
        ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.title}, ${input.minutes},
        ${input.dueAt}, ${input.dueText ?? null}, ${input.priority}, ${"pending"}, ${1},
        ${input.candidateId}
      ) RETURNING *`;
    return mapTask(rows[0] as Record<string, unknown>);
  };
  if (input.candidateId && input.inputSnapshot?.kind !== "retest") {
    return acceptAssistantTask(sql, scope, input, insert);
  }
  return sql.begin(async (tx) => {
    const replay = await prepareRetestTask(tx, scope, input);
    if (replay) return replay;
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
    }
    return task;
  });
}
