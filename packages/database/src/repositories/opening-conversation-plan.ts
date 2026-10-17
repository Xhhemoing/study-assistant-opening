import type { TransactionSql } from "postgres";
import {
  assistantCandidateSchema, conversationPlanMetadataSchema, uuidSchema,
  type ConversationPlanMetadata, type Scope, type SuggestedTask,
} from "@aistudy/contracts";
import { OpeningPlanError } from "./opening-plan-error";
import { admitTaskCandidate } from "./opening-task-candidate-admission";

export const admitOpeningConversationPlanReplay = admitTaskCandidate;

/** Existing task-candidate admission owns privacy, turn lineage and source-version checks. */
export async function readOpeningConversationPlanCandidate(tx: TransactionSql, scope: Scope, id: string) {
  await admitTaskCandidate(tx, scope, id);
  const [row] = await tx`SELECT c.id, c.status, c.payload, c.source_turn_id, c.source_ids
    FROM opening_assistant_candidates c
    WHERE c.id=${id} AND c.workspace_id=${scope.workspaceId} FOR UPDATE`;
  const payload = assistantCandidateSchema.safeParse(row?.payload);
  const sourceIds = uuidSchema.array().max(32).safeParse(row?.source_ids);
  if (!row || row.status !== "pending" || !payload.success || payload.data.kind !== "task" || !sourceIds.success) {
    throw new OpeningPlanError("CONFLICT", "对话建议已处理或不可用，请重新读取。", "task_changed");
  }
  const dueText = payload.data.dueText === "" ? null : payload.data.dueText;
  if (dueText !== null && dueText.length > 200) throw new OpeningPlanError("VALIDATION", "时间备注超过200字，请先缩短对话建议后再安排。");
  return {
    id: String(row.id), sourceTurnId: String(row.source_turn_id), sourceIds: sourceIds.data,
    title: payload.data.title, minutes: payload.data.minutes, dueText,
  };
}

export async function assertOpeningConversationPlanCourse(tx: TransactionSql, scope: Scope, courseId: string | null) {
  if (courseId === null) return;
  const rows = await tx`SELECT id FROM courses WHERE id=${courseId} AND workspace_id=${scope.workspaceId}
    AND archived_at IS NULL FOR SHARE`;
  if (!rows.length) throw new OpeningPlanError("CONFLICT", "所选课程已不可用，请重新选择。", "source_unavailable");
}

/** Called only inside the plan-accept transaction after the day/workspace locks. */
export async function lockOpeningConversationPlanCandidate(tx: TransactionSql, scope: Scope, raw: unknown) {
  const parsed = conversationPlanMetadataSchema.safeParse(raw);
  if (!parsed.success) throw new OpeningPlanError("VALIDATION", "invalid stored conversation plan");
  const metadata = parsed.data;
  const candidate = await readOpeningConversationPlanCandidate(tx, scope, metadata.candidateId);
  if (candidate.sourceTurnId !== metadata.sourceTurnId || candidate.title !== metadata.title
    || (candidate.minutes !== null && candidate.minutes !== metadata.minutes)
    || candidate.dueText !== metadata.dueText
    || JSON.stringify([...candidate.sourceIds].sort()) !== JSON.stringify([...metadata.sourceIds].sort())) {
    throw new OpeningPlanError("CONFLICT", "对话建议来源已变化，请重新预览。", "source_unavailable");
  }
  await assertOpeningConversationPlanCourse(tx, scope, metadata.courseId);
  return metadata;
}

/** One candidate row serializes this path with the existing direct task-accept path. */
export async function consumeOpeningConversationPlanCandidate(
  tx: TransactionSql, scope: Scope, raw: unknown, suggestion: SuggestedTask,
): Promise<{ taskId: string; version: 1 }> {
  const metadata = await lockOpeningConversationPlanCandidate(tx, scope, raw);
  if (suggestion.id !== metadata.taskId || suggestion.key !== `conversation:${metadata.candidateId}`
    || suggestion.title !== metadata.title || suggestion.minutes !== metadata.minutes
    || suggestion.courseId !== metadata.courseId || suggestion.skillLabel !== null
    || (suggestion.requirementKey ?? null) !== null || suggestion.kind !== "course_pace"
    || suggestion.reasonCode !== "pending_task") {
    throw new OpeningPlanError("VALIDATION", "conversation suggestion differs from its saved candidate");
  }
  const existing = await tx`SELECT id FROM opening_tasks WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND candidate_id=${metadata.candidateId} FOR UPDATE`;
  if (existing.length) throw new OpeningPlanError("CONFLICT", "对话建议已生成任务，请重新读取。", "task_changed");
  const inserted = await tx`INSERT INTO opening_tasks
    (id, workspace_id, owner_user_id, title, minutes, due_at, due_text, priority, status, version,
      candidate_id, client_key, course_id, skill_label, requirement_key, origin)
    VALUES (${metadata.taskId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${metadata.title}, ${metadata.minutes},
      NULL, ${metadata.dueText}, 0, 'pending', 1, ${metadata.candidateId}, ${suggestion.key},
      ${metadata.courseId}, NULL, NULL, 'agent') ON CONFLICT DO NOTHING RETURNING id`;
  if (!inserted.length) throw new OpeningPlanError("CONFLICT", "任务身份已被使用，请重新预览。", "task_changed");
  const updated = await tx`UPDATE opening_assistant_candidates SET status='accepted', updated_at=now(),
    task_result_ref=${tx.json({ kind: "task", id: metadata.taskId })}
    WHERE id=${metadata.candidateId} AND workspace_id=${scope.workspaceId} AND status='pending' RETURNING id`;
  if (!updated.length) throw new OpeningPlanError("CONFLICT", "对话建议已处理，请重新读取。", "task_changed");
  return { taskId: metadata.taskId, version: 1 };
}

export function conversationPlanSuggestion(metadata: ConversationPlanMetadata): SuggestedTask {
  return {
    id: metadata.taskId, key: `conversation:${metadata.candidateId}`, kind: "course_pace",
    title: metadata.title, minutes: metadata.minutes, courseId: metadata.courseId,
    skillLabel: null, requirementKey: null, reasonCode: "pending_task", reason: "来自你已保存的对话请求，确认草案后才创建任务。",
  };
}
