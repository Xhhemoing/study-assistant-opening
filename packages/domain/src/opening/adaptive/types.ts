import type { CourseGoal, TaskItem } from "@aistudy/contracts";

/** Rule set that produced a draft; stored on drafts and shown in the reason drawer. */
export const ADAPTIVE_STRATEGY_VERSION = "adaptive-2";

export type SkillStatus = "unobserved" | "needs_check" | "observed_independent" | "needs_review";
export type Assistance = "independent" | "hinted" | "revealed" | "unknown";

export type SkillSignal = {
  skillLabel: string;
  requirementKey?: string | null;
  status: SkillStatus;
  lastObservedAt: string | null;
  /** Assistance on the latest observations, newest first. */
  recentAssistance: readonly Assistance[];
};

export type CourseSignal = {
  courseId: string;
  title: string;
  skills: readonly SkillSignal[];
  /** Unobserved knowledge nodes whose prerequisites are met, in study order. */
  nextSkills: readonly string[];
  /** At least one course material is parsed and usable for questions. */
  hasUsableMaterials: boolean;
  goal: CourseGoal | null;
  /** Minutes of tasks attributed to this course completed in the current local week. */
  minutesThisWeek: number;
};

/** One planner suggestion that became a task, by local day. */
export type PlannerHistoryEntry = {
  date: string;
  identity: string;
  status: TaskItem["status"];
};

/** Everything the rules read about the learner for one local day. */
export type LearnerSnapshot = {
  /** Local YYYY-MM-DD being planned. */
  date: string;
  timeZone: string;
  courses: readonly CourseSignal[];
  dueCardCount: number;
  plannerHistory: readonly PlannerHistoryEntry[];
};

/** FNV-1a 32-bit, browser-safe; keeps keys short and stable for long skill labels. */
export function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Same suggestion across days (kind + course + skill); used for skip history. */
export function suggestionIdentity(kind: string, courseId: string | null, skillLabel: string | null, requirementKey?: string | null): string {
  const skill = skillLabel === null ? "none" : requirementKey == null
    ? stableHash(skillLabel)
    : `requirement-${stableHash(JSON.stringify([skillLabel, requirementKey]))}`;
  return `${kind}:${courseId ?? "none"}:${skill}`;
}

/** Task clientKey of a suggestion; one per identity per local day. */
export function suggestionKey(date: string, identity: string): string {
  return `planner:${date}:${identity}`;
}

/** Inverse of suggestionKey for history rebuilt from task client keys. */
export function parseSuggestionKey(key: string): { date: string; identity: string } | null {
  const match = /^planner:(\d{4}-\d{2}-\d{2}):(.+)$/.exec(key);
  return match ? { date: match[1]!, identity: match[2]! } : null;
}

export function taskCourseId(task: TaskItem): string | null {
  return task.courseId ?? task.retest?.courseId ?? null;
}

export function taskSkillLabel(task: TaskItem): string | null {
  return task.skillLabel ?? task.retest?.skillLabel ?? null;
}

export function taskRequirementKey(task: TaskItem): string | null {
  return task.requirementKey ?? task.retest?.requirementKey ?? null;
}
