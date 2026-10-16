import { createHash } from "node:crypto";
import type { PlannedBlock, PlanningAutonomy, TaskItem, TimeBlock } from "@aistudy/contracts";
import {
  ADAPTIVE_STRATEGY_VERSION,
  planDay,
  proposeAdaptiveTasks,
  rankForPlan,
  suggestionsAsTasks,
  type LearnerSnapshot,
  type PlanDayOptions,
} from "@aistudy/domain";
import type { AdaptiveDraftInput } from "@aistudy/database";

export type AdaptiveDraftSnapshot = {
  snapshot: LearnerSnapshot;
  autonomy: PlanningAutonomy;
  plannerInputRevision: string;
};

export type BuildAdaptiveDraftInput = {
  workspaceId: string;
  adaptive: AdaptiveDraftSnapshot;
  tasks: readonly TaskItem[];
  freeBlocks: readonly TimeBlock[];
  yesterdayAccepted: readonly PlannedBlock[];
  date: string;
  timeZone: string;
  now: Date;
  planDayOptions(preferredOrder: readonly string[]): PlanDayOptions;
};

/**
 * Deterministic task id for a suggestion key, so a rebuilt draft and the accepted
 * task refer to the same id. Formatted as an RFC 4122 name-based (v5-style) UUID.
 */
export function suggestionTaskId(workspaceId: string, key: string): string {
  const hex = createHash("sha256").update(`opening-suggestion:${workspaceId}:${key}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function freeMinutes(blocks: readonly TimeBlock[]): number {
  return Math.floor(blocks
    .filter((block) => block.kind === "free")
    .reduce((sum, block) => sum + Math.max(0, Date.parse(block.end) - Date.parse(block.start)), 0) / 60_000);
}

/**
 * snapshot → proposeAdaptiveTasks → rankForPlan → planDay. Suggestions only budget
 * the capacity left after the learner's own work that would be placed today.
 * Suggestions that do not fit land in unscheduledTaskIds like any other task.
 */
export function buildAdaptiveDraft(input: BuildAdaptiveDraftInput): {
  blocks: PlannedBlock[];
  unscheduledTaskIds: string[];
  adaptive: AdaptiveDraftInput;
} {
  const { tasks, yesterdayAccepted, date, timeZone, now } = input;
  const own = rankForPlan({ tasks, suggestions: [], yesterdayAccepted, date, timeZone, now });
  const minutesById = new Map(tasks.map((task) => [task.id, task.minutes]));
  const committedMinutes = own.orderedTaskIds.reduce((sum, id) => sum + (minutesById.get(id) ?? 0), 0);
  const { suggestions } = proposeAdaptiveTasks(input.adaptive.snapshot, {
    autonomy: input.adaptive.autonomy,
    capacityMinutes: freeMinutes(input.freeBlocks),
    committedMinutes,
    pendingTasks: tasks.filter((task) => task.status === "pending"),
    idFor: (key) => suggestionTaskId(input.workspaceId, key),
  });
  const ranked = rankForPlan({ tasks, suggestions, yesterdayAccepted, date, timeZone, now });
  const byId = new Map([...tasks, ...suggestionsAsTasks(suggestions)].map((task) => [task.id, task]));
  const ordered = ranked.orderedTaskIds
    .map((id) => byId.get(id))
    .filter((task): task is TaskItem => Boolean(task));
  const planned = planDay(ordered, input.freeBlocks, input.planDayOptions(ranked.orderedTaskIds));
  return {
    blocks: planned.blocks.map((block) => {
      const reason = ranked.reasons[block.taskId];
      return reason ? { ...block, reason: reason.label } : block;
    }),
    unscheduledTaskIds: planned.unscheduledTaskIds,
    adaptive: {
      suggestedTasks: suggestions,
      reasons: ranked.reasons,
      strategyVersion: ADAPTIVE_STRATEGY_VERSION,
      plannerInputRevision: input.adaptive.plannerInputRevision,
    },
  };
}
