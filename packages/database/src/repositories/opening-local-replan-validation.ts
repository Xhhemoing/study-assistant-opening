import type { TransactionSql } from "postgres";
import { conversationPlanMetadataSchema, localReplanMetadataSchema, plannedBlockSchema, taskItemSchema, type PlannedBlock, type Scope } from "@aistudy/contracts";
import { localReplanFixedBlocks, samePlannedBlocks } from "@aistudy/domain";
import { OpeningPlanError } from "./opening-plan-error";
import { assertOpeningPlanConstraints } from "./opening-plan-constraints";

/** Persisted metadata is untrusted, including after backup import. Never let it exempt arbitrary blocks. */
export async function validateOpeningLocalReplan(tx: TransactionSql, scope: Scope, input: {
  day: string; state: Record<string, unknown>; draft: Record<string, unknown>; blocks: PlannedBlock[]; now: Date;
}) {
  const conflict = (message: string, reason: "stale_version" | "task_changed" | "slot_expired" = "stale_version") => {
    throw new OpeningPlanError("CONFLICT", message, reason);
  };
  const snapshot = input.draft.input_snapshot as { tasks?: unknown; localReplan?: unknown } | null;
  const meta = localReplanMetadataSchema.safeParse(snapshot?.localReplan);
  const tasks = taskItemSchema.array().safeParse(snapshot?.tasks);
  const baseline = plannedBlockSchema.array().safeParse(input.state.accepted_blocks ?? []);
  if (!meta.success || !tasks.success || !baseline.success) return conflict("invalid local replan metadata");
  if (meta.data.baseAcceptedVersion !== Number(input.state.accepted_version)
    || !samePlannedBlocks(meta.data.baselineBlocks, baseline.data)) return conflict("accepted baseline changed");
  if (tasks.data.some(task => !task.version) || new Set(tasks.data.map(task => task.id)).size !== tasks.data.length) return conflict("invalid task version snapshot");
  const proposedAt = new Date(meta.data.proposedAt);
  if (proposedAt > input.now) return conflict("invalid proposal time");
  const expected = localReplanFixedBlocks({ acceptedBlocks: baseline.data, tasks: tasks.data, now: proposedAt, preserveAll: meta.data.preserveAll });
  if (!samePlannedBlocks(expected.fixedBlocks, meta.data.fixedBlocks)
    || JSON.stringify([...expected.releasedTaskVersions].sort((a, b) => a.id.localeCompare(b.id))) !== JSON.stringify([...meta.data.releasedTaskVersions].sort((a, b) => a.id.localeCompare(b.id)))) return conflict("invalid preserved blocks");
  const removed = [...baseline.data];
  for (const block of meta.data.fixedBlocks) {
    const index = removed.findIndex(original => samePlannedBlocks([original], [block]));
    if (index >= 0) removed.splice(index, 1);
  }
  if (removed.some(block => Date.parse(block.start) <= input.now.getTime())) return conflict("released slot has already started", "slot_expired");
  const fresh = [...input.blocks];
  for (const fixed of meta.data.fixedBlocks) {
    const index = fresh.findIndex(block => samePlannedBlocks([block], [fixed]));
    if (index < 0) return conflict("preserved block removed");
    fresh.splice(index, 1);
  }
  if (input.draft.origin === "agent") {
    const conversation = conversationPlanMetadataSchema.safeParse((input.draft.input_snapshot as { conversationPlan?: unknown } | null)?.conversationPlan);
    if (!conversation.success || !meta.data.preserveAll || fresh.length !== 1 || fresh[0]!.taskId !== conversation.data.taskId
      || Date.parse(fresh[0]!.end) - Date.parse(fresh[0]!.start) !== conversation.data.minutes * 60_000) return conflict("conversation plan may only append its confirmed candidate");
  }
  if (fresh.some(block => Date.parse(block.start) < input.now.getTime())) return conflict("new slot has expired", "slot_expired");
  if (new Set(fresh.map(block => block.taskId)).size !== fresh.length) return conflict("duplicate new task block");
  const sorted = [...fresh].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (sorted.some((block, index) => !Number.isFinite(Date.parse(block.start)) || Date.parse(block.end) <= Date.parse(block.start)
    || (index > 0 && Date.parse(block.start) < Date.parse(sorted[index - 1]!.end))
    || meta.data.fixedBlocks.some(fixed => Date.parse(block.start) < Date.parse(fixed.end) && Date.parse(block.end) > Date.parse(fixed.start)))) return conflict("new blocks overlap");
  const futureFixed = meta.data.fixedBlocks.filter(block => Date.parse(block.end) > input.now.getTime());
  if (fresh.some(block => futureFixed.some(fixed => fixed.taskId === block.taskId))) return conflict("task already has a future block");
  const ids = [...new Set([...fresh, ...futureFixed].map(block => block.taskId).concat(meta.data.releasedTaskVersions.map(task => task.id)))];
  const suggestionIds = new Set(((input.draft.suggested_tasks ?? []) as { id: string }[]).map(item => item.id));
  const existingIds = ids.filter(id => !suggestionIds.has(id));
  if (existingIds.length) {
    const newIds = fresh.map(block => block.taskId).filter(id => !suggestionIds.has(id));
    if (newIds.length) {
      const started = await tx`SELECT id FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND status IN ('active','paused') AND create_intent->>'source'='task'
        AND lower(create_intent->>'taskId') IN ${tx(newIds)} LIMIT 1`;
      if (started.length) return conflict("task learning already started", "task_changed");
    }
    const current = await tx`SELECT id, version, status, not_before, minutes, due_at FROM opening_tasks WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND id IN ${tx(existingIds)} ORDER BY id FOR UPDATE`;
    if (current.length !== existingIds.length || current.some(task => {
      const saved = tasks.data.find(original => original.id === task.id);
      const scheduledNew = fresh.some(block => block.taskId === task.id);
      return !saved || Number(task.version) !== saved.version || task.status !== saved.status
        || (task.not_before ? new Date(task.not_before as string | Date).toISOString() : null) !== (saved.notBefore ?? null)
        || Number(task.minutes) !== saved.minutes
        || (task.due_at ? new Date(task.due_at as string | Date).toISOString() : null) !== saved.dueAt
        || (scheduledNew && (task.status !== "pending" || (task.not_before && new Date(task.not_before as string | Date) > input.now)));
    })) return conflict("task changed since proposal", "task_changed");
  }
  if (fresh.some(block => !tasks.data.some(task => task.id === block.taskId && task.status === "pending"
    && (!task.notBefore || Date.parse(task.notBefore) <= Date.parse(block.start))
    && Date.parse(block.end) - Date.parse(block.start) === task.minutes * 60_000
    && (!task.dueAt || Date.parse(block.end) <= Date.parse(task.dueAt))))) return conflict("unknown or deferred new task", "task_changed");
  await assertOpeningPlanConstraints(tx, scope, input.day, fresh, true, meta.data.explicitFree);
  await assertOpeningPlanConstraints(tx, scope, input.day, futureFixed, false);
}
