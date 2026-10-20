import { createHash } from "node:crypto";
import type { CourseGoal, PlannedBlock, PlanningAutonomy, SuggestedTask, TaskItem, TimeBlock } from "@aistudy/contracts";
import {
  ADAPTIVE_STRATEGY_VERSION,
  availableTimeSlots,
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
  courseMaterialRevisions?: Record<string, string>;
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
  suppressedSuggestionIdentities?: readonly string[];
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
 * snapshot → proposeAdaptiveTasks → rankForPlan → planDay. Each course's suggestions
 * reserve capacity only for schedulable work that actually outranks that goal.
 * Suggestions that do not fit land in unscheduledTaskIds like any other task.
 */
export function buildAdaptiveDraft(input: BuildAdaptiveDraftInput): {
  blocks: PlannedBlock[];
  unscheduledTaskIds: string[];
  unscheduledReasons: Array<{ taskId: string; reason: string }>;
  adaptive: AdaptiveDraftInput;
} {
  const { tasks, yesterdayAccepted, date, timeZone, now } = input;
  const courseGoals = Object.fromEntries(input.adaptive.snapshot.courses
    .filter((course): course is typeof course & { goal: CourseGoal } => course.goal !== null)
    .map(course => [course.courseId, course.goal]));
  const rankInput = { tasks, yesterdayAccepted, date, timeZone, now, courseGoals };
  const optionsFor = (preferredOrder: readonly string[]): PlanDayOptions => {
    const options = { ...input.planDayOptions(preferredOrder) };
    // Leave one minute to review and confirm before acceptance.
    if (options.planningNow) {
      options.planningNow = new Date(Math.ceil((Date.parse(options.planningNow) + 60_000) / 60_000) * 60_000).toISOString();
    }
    return options;
  };
  const planningNow = optionsFor([]).planningNow;
  const planningNowMs = planningNow ? Date.parse(planningNow) : Number.NEGATIVE_INFINITY;
  const remainingFree = availableTimeSlots(input.freeBlocks)
    .map(block => ({ ...block, start: new Date(Math.max(Date.parse(block.start), planningNowMs)).toISOString() }))
    .filter(block => Date.parse(block.start) < Date.parse(block.end));
  const ownById = new Map(tasks.map(task => [task.id, task]));
  const resourcesBeforeSuggestion = (courseId: string | null, suggestions: readonly SuggestedTask[]) => {
    // A non-persisted probe uses the same ranker as the final plan. Ordinary
    // carry-over cannot consume a higher-goal suggestion's budget in advance.
    const probe: SuggestedTask = {
      id: suggestionTaskId(input.workspaceId, `budget:${date}:${courseId ?? "cards"}`),
      key: "budget-probe", title: "budget-probe", minutes: 10, kind: "new_skill",
      courseId, skillLabel: null, reasonCode: "new_skill", reason: "budget-probe",
    };
    const ranked = rankForPlan({ ...rankInput, suggestions: [...suggestions, probe] });
    const earlierIds = ranked.orderedTaskIds.slice(0, ranked.orderedTaskIds.indexOf(probe.id));
    const byId = new Map([...ownById, ...suggestionsAsTasks(suggestions).map(task => [task.id, task] as const)]);
    const earlierTasks = earlierIds.map(id => byId.get(id)).filter((task): task is TaskItem => Boolean(task));
    const reserved = planDay(earlierTasks, remainingFree, optionsFor(earlierIds));
    const minutes = reserved.blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0);
    const slots = availableTimeSlots([...remainingFree, ...reserved.blocks.map(block => ({
      start: block.start, end: block.end, kind: "locked" as const,
    }))]);
    const maxContinuousMinutes = Math.floor(Math.max(0, ...slots.map(block => (Date.parse(block.end) - Date.parse(block.start)) / 60_000)));
    return { minutes, maxContinuousMinutes };
  };
  const commitments = new Map<string | null, number>();
  const committedMinutesForCourse = (courseId: string | null): number => {
    const cached = commitments.get(courseId);
    if (cached !== undefined) return cached;
    const { minutes } = resourcesBeforeSuggestion(courseId, []);
    commitments.set(courseId, minutes);
    return minutes;
  };
  // Production acceptance needs admissible course material. Filter before the
  // suggestion/count budget so unavailable courses cannot crowd out usable ones.
  const availableCourses = input.adaptive.snapshot.courses.filter(course => course.hasUsableMaterials);
  const { suggestions } = proposeAdaptiveTasks({ ...input.adaptive.snapshot, courses: availableCourses }, {
    autonomy: input.adaptive.autonomy,
    capacityMinutes: freeMinutes(remainingFree),
    committedMinutes: 0,
    committedMinutesForCourse,
    maxContinuousMinutesForCourse: (courseId, suggestions) => resourcesBeforeSuggestion(courseId, suggestions).maxContinuousMinutes,
    pendingTasks: tasks.filter((task) => task.status === "pending"),
    idFor: (key) => suggestionTaskId(input.workspaceId, key),
    suppressedSuggestionIdentities: input.suppressedSuggestionIdentities,
  });
  const ranked = rankForPlan({ ...rankInput, suggestions });
  const byId = new Map([...tasks, ...suggestionsAsTasks(suggestions)].map((task) => [task.id, task]));
  const ordered = ranked.orderedTaskIds
    .map((id) => byId.get(id))
    .filter((task): task is TaskItem => Boolean(task));
  const planned = planDay(ordered, input.freeBlocks, optionsFor(ranked.orderedTaskIds));
  return {
    blocks: planned.blocks.map((block) => {
      const reason = ranked.reasons[block.taskId];
      return reason ? { ...block, reason: reason.label } : block;
    }),
    unscheduledTaskIds: planned.unscheduledTaskIds,
    unscheduledReasons: planned.unscheduled,
    adaptive: {
      suggestedTasks: suggestions,
      reasons: ranked.reasons,
      strategyVersion: ADAPTIVE_STRATEGY_VERSION,
      plannerInputRevision: input.adaptive.plannerInputRevision,
      availableCourseIds: availableCourses.map(course => course.courseId),
      courseMaterialRevisions: input.adaptive.courseMaterialRevisions,
    },
  };
}
