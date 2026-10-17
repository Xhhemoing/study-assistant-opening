import type { PlannedBlock, TaskItem } from "@aistudy/contracts";

/** A freed block shorter than this is not worth re-planning for. */
export const MIN_FREED_MINUTES = 15;

export type ReplanOffer = {
  offer: boolean;
  /** Pending tasks to re-place in the rest of the day. */
  taskIds: string[];
  reason: "missed_block" | "freed_time" | null;
};

/**
 * Same-day re-plan hint after the learner finishes, skips or misses planned work:
 * a confirmed block already ended with its task still pending, or a finished/skipped
 * task frees a future block while pending work sits outside the remaining plan.
 */
export function shouldOfferReplan(input: {
  acceptedBlocks: readonly PlannedBlock[];
  tasks: readonly TaskItem[];
  now: Date;
}): ReplanOffer {
  const nowMs = input.now.getTime();
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  const eligible = (task: TaskItem | undefined) => task?.status === "pending" && (!task.notBefore || Date.parse(task.notBefore) <= nowMs);
  const futurePending = new Set(
    input.acceptedBlocks
      .filter((block) => Date.parse(block.end) > nowMs && eligible(byId.get(block.taskId)))
      .map((block) => block.taskId),
  );
  const missed = input.acceptedBlocks.filter(
    (block) => eligible(byId.get(block.taskId)) && !futurePending.has(block.taskId) && Date.parse(block.end) <= nowMs,
  );
  const unplanned = input.tasks.filter((task) => eligible(task) && !futurePending.has(task.id));

  if (missed.length) {
    const taskIds = [...new Set([...missed.map((block) => block.taskId), ...unplanned.map((task) => task.id)])];
    return { offer: true, taskIds, reason: "missed_block" };
  }
  const freed = input.acceptedBlocks.some((block) => {
    const status = byId.get(block.taskId)?.status;
    const task = byId.get(block.taskId);
    return (status === "done" || status === "skipped" || (task?.notBefore && Date.parse(task.notBefore) > nowMs))
      && Date.parse(block.start) > nowMs
      && (Date.parse(block.end) - Date.parse(block.start)) / 60_000 >= MIN_FREED_MINUTES;
  });
  if (freed && unplanned.length) {
    return { offer: true, taskIds: unplanned.map((task) => task.id), reason: "freed_time" };
  }
  return { offer: false, taskIds: [], reason: null };
}
