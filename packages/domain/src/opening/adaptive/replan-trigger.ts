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
  const missed = input.acceptedBlocks.filter(
    (block) => byId.get(block.taskId)?.status === "pending" && Date.parse(block.end) <= nowMs,
  );
  const futurePending = new Set(
    input.acceptedBlocks
      .filter((block) => Date.parse(block.end) > nowMs && byId.get(block.taskId)?.status === "pending")
      .map((block) => block.taskId),
  );
  const unplanned = input.tasks.filter((task) => task.status === "pending" && !futurePending.has(task.id));

  if (missed.length) {
    const taskIds = [...new Set([...missed.map((block) => block.taskId), ...unplanned.map((task) => task.id)])];
    return { offer: true, taskIds, reason: "missed_block" };
  }
  const freed = input.acceptedBlocks.some((block) => {
    const status = byId.get(block.taskId)?.status;
    return (status === "done" || status === "skipped")
      && Date.parse(block.start) > nowMs
      && (Date.parse(block.end) - Date.parse(block.start)) / 60_000 >= MIN_FREED_MINUTES;
  });
  if (freed && unplanned.length) {
    return { offer: true, taskIds: unplanned.map((task) => task.id), reason: "freed_time" };
  }
  return { offer: false, taskIds: [], reason: null };
}
