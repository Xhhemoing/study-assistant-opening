import type { PlanningAutonomy, PlanReasonCode, SuggestedTask, SuggestionKind, TaskItem } from "@aistudy/contracts";
import { addLocalDays } from "../daily-draft";
import {
  suggestionIdentity,
  suggestionKey,
  taskCourseId,
  taskSkillLabel,
  type CourseSignal,
  type LearnerSnapshot,
  type SkillSignal,
} from "./types";
import { normalizeSkillLabelKey, normalizedSuggestionIdentity } from "./skill-identity";

export const MAX_DAILY_SUGGESTIONS = 3;
/** Suggestions may fill at most this share of the day's free time, after committed tasks. */
export const SUGGESTION_CAPACITY_SHARE = 0.8;
const SUGGESTION_MINUTES = 25;
const MIN_SUGGESTION_MINUTES = 10;
const REVIEW_CARDS_THRESHOLD = 5;
const REVIEW_CARDS_MAX_MINUTES = 30;

const KIND_PRIORITY: Record<SuggestionKind, number> = {
  weak_skill: 5,
  review_cards: 6,
  new_skill: 7,
  course_pace: 7.5,
};
/** A course behind its weekly goal moves its suggestions ahead of other courses' same-kind work. */
const BEHIND_BOOST = 1.5;

export type ProposeAdaptiveTasksOptions = {
  autonomy: PlanningAutonomy;
  /** Free minutes today after classes, meals and sleep. */
  capacityMinutes: number;
  /** Minutes of the learner's own pending work planned ahead of suggestions. */
  committedMinutes: number;
  /** Pending tasks; a suggestion for a course+skill that already has one is skipped. */
  pendingTasks: readonly TaskItem[];
  /** Pre-assigns the task id for a suggestion key (deterministic in production). */
  idFor: (key: string) => string;
  maxSuggestions?: number;
};

type Candidate = {
  kind: SuggestionKind;
  courseId: string | null;
  skillLabel: string | null;
  title: string;
  minutes: number;
  reasonCode: PlanReasonCode;
  reason: string;
  rank: number;
  urgency: number;
};

/** Hinted/revealed on most of the latest three observations (at least two observed). */
function leansOnHints(skill: SkillSignal): boolean {
  const recent = skill.recentAssistance.slice(0, 3);
  if (recent.length < 2) return false;
  const assisted = recent.filter((value) => value === "hinted" || value === "revealed").length;
  return assisted * 2 > recent.length;
}

function weekdayIndexMonday0(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 6 : day - 1;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Behind when this week's completed minutes trail the goal's pro-rata share up to today. */
export function isCourseBehind(course: CourseSignal, date: string): boolean {
  const goal = course.goal;
  if (!goal || goal.weeklyMinutes <= 0) return false;
  if (goal.targetDate !== null && goal.targetDate < date) return false;
  const expected = goal.weeklyMinutes * ((weekdayIndexMonday0(date) + 1) / 7);
  return course.minutesThisWeek < expected;
}

/** Courses ordered by urgency: behind first, then nearest target date, then id. */
function courseUrgency(snapshot: LearnerSnapshot): Map<string, number> {
  const ranked = [...snapshot.courses].sort((a, b) => {
    const behind = Number(isCourseBehind(b, snapshot.date)) - Number(isCourseBehind(a, snapshot.date));
    if (behind) return behind;
    const daysA = a.goal?.targetDate ? daysBetween(snapshot.date, a.goal.targetDate) : Number.POSITIVE_INFINITY;
    const daysB = b.goal?.targetDate ? daysBetween(snapshot.date, b.goal.targetDate) : Number.POSITIVE_INFINITY;
    if (daysA !== daysB) return daysA < daysB ? -1 : 1;
    return a.courseId < b.courseId ? -1 : a.courseId > b.courseId ? 1 : 0;
  });
  return new Map(ranked.map((course, index) => [course.courseId, index]));
}

/** Consecutive earlier days on which this suggestion was created and then skipped. */
function consecutiveSkippedDays(snapshot: LearnerSnapshot, identities: readonly string[]): number {
  let days = 0;
  for (let back = 1; back <= 7; back += 1) {
    const day = addLocalDays(snapshot.date, -back);
    const skipped = snapshot.plannerHistory.some(
      (entry) => entry.date === day && identities.includes(entry.identity) && entry.status === "skipped",
    );
    if (!skipped) break;
    days += 1;
  }
  return days;
}

function collectCandidates(snapshot: LearnerSnapshot, pendingTasks: readonly TaskItem[]): Candidate[] {
  const urgency = courseUrgency(snapshot);
  const covered = new Set(
    pendingTasks
      .filter((task) => task.status === "pending" && taskCourseId(task) && taskSkillLabel(task))
      .map((task) => `${taskCourseId(task)}::${normalizeSkillLabelKey(taskSkillLabel(task)!)}`),
  );
  // One task per identity per local day: do not revive a task the learner has
  // already completed or skipped when a draft is recomputed later that day.
  const unavailableIdentities = new Set(
    snapshot.plannerHistory
      .filter((entry) => entry.status === "pending" || entry.date === snapshot.date)
      .map((entry) => entry.identity),
  );
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: Omit<Candidate, "rank" | "urgency">, behind: boolean) => {
    const identity = suggestionIdentity(candidate.kind, candidate.courseId, candidate.skillLabel);
    const comparable = normalizedSuggestionIdentity(candidate.kind, candidate.courseId, candidate.skillLabel);
    if (unavailableIdentities.has(identity) || unavailableIdentities.has(comparable) || seen.has(comparable)) return;
    if (candidate.courseId && candidate.skillLabel && covered.has(`${candidate.courseId}::${normalizeSkillLabelKey(candidate.skillLabel)}`)) return;
    seen.add(comparable);
    out.push({
      ...candidate,
      rank: KIND_PRIORITY[candidate.kind] - (behind ? BEHIND_BOOST : 0),
      urgency: candidate.courseId ? urgency.get(candidate.courseId) ?? Number.MAX_SAFE_INTEGER : -1,
    });
  };

  for (const course of snapshot.courses) {
    const behind = isCourseBehind(course, snapshot.date);
    let courseHasCandidate = false;
    for (const skill of course.skills) {
      const reviewDue = skill.status === "needs_review";
      const assisted = skill.status !== "observed_independent" && leansOnHints(skill);
      if (!reviewDue && !assisted) continue;
      push({
        kind: "weak_skill",
        courseId: course.courseId,
        skillLabel: skill.skillLabel,
        title: `${course.title} · ${skill.skillLabel} 巩固练习`,
        minutes: SUGGESTION_MINUTES,
        reasonCode: "weak_skill",
        reason: reviewDue ? `最近作答需要复习：${skill.skillLabel}` : `近期作答多依赖提示：${skill.skillLabel}`,
      }, behind);
      courseHasCandidate = true;
    }
    const next = course.hasUsableMaterials ? course.nextSkills[0] : undefined;
    if (next) {
      push({
        kind: "new_skill",
        courseId: course.courseId,
        skillLabel: next,
        title: `${course.title} · 学习 ${next}`,
        minutes: SUGGESTION_MINUTES,
        reasonCode: "new_skill",
        reason: `下一个可以学的知识点：${next}`,
      }, behind);
      courseHasCandidate = true;
    }
    if (behind && !courseHasCandidate) {
      push({
        kind: "course_pace",
        courseId: course.courseId,
        skillLabel: null,
        title: `${course.title} · 进度补足`,
        minutes: SUGGESTION_MINUTES,
        reasonCode: "course_pace",
        reason: `本周投入低于目标（${course.minutesThisWeek}/${course.goal?.weeklyMinutes ?? 0} 分钟）`,
      }, behind);
    }
  }

  if (snapshot.dueCardCount >= REVIEW_CARDS_THRESHOLD) {
    push({
      kind: "review_cards",
      courseId: null,
      skillLabel: null,
      title: `复习到期卡片 ${snapshot.dueCardCount} 张`,
      minutes: Math.min(REVIEW_CARDS_MAX_MINUTES, snapshot.dueCardCount),
      reasonCode: "review_cards",
      reason: `有 ${snapshot.dueCardCount} 张卡片到期`,
    }, false);
  }
  return out;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.urgency !== b.urgency) return a.urgency - b.urgency;
  const courseA = a.courseId ?? "", courseB = b.courseId ?? "";
  if (courseA !== courseB) return courseA < courseB ? -1 : 1;
  const skillA = a.skillLabel ?? "", skillB = b.skillLabel ?? "";
  return skillA < skillB ? -1 : skillA > skillB ? 1 : 0;
}

/**
 * Rule set `adaptive-1`: weak skills, due cards, the next learnable node and courses behind
 * their weekly goal become suggestions. Manual mode proposes nothing. Suggestions are
 * proposals only; they become tasks when the learner (or the coach) accepts the draft.
 */
export function proposeAdaptiveTasks(
  snapshot: LearnerSnapshot,
  options: ProposeAdaptiveTasksOptions,
): { suggestions: SuggestedTask[] } {
  if (options.autonomy === "manual") return { suggestions: [] };
  const max = options.maxSuggestions ?? MAX_DAILY_SUGGESTIONS;
  let budget = Math.max(0, Math.floor(options.capacityMinutes * SUGGESTION_CAPACITY_SHARE) - options.committedMinutes);
  const suggestions: SuggestedTask[] = [];

  for (const candidate of collectCandidates(snapshot, options.pendingTasks).sort(compareCandidates)) {
    if (suggestions.length >= max) break;
    const identity = suggestionIdentity(candidate.kind, candidate.courseId, candidate.skillLabel);
    const comparable = normalizedSuggestionIdentity(candidate.kind, candidate.courseId, candidate.skillLabel);
    const skippedDays = consecutiveSkippedDays(snapshot, [identity, comparable]);
    if (skippedDays >= 3) continue;
    let { minutes, reasonCode, reason } = candidate;
    if (skippedDays === 2) {
      // Card reviews can start below the study-block minimum. Applying the
      // 10-minute floor to them would increase, rather than reduce, the burden.
      const minimum = candidate.kind === "review_cards" ? 1 : MIN_SUGGESTION_MINUTES;
      minutes = Math.max(minimum, Math.round(minutes / 2));
      reasonCode = "repeatedly_skipped";
      reason = `连续两天跳过，缩短为 ${minutes} 分钟（${candidate.reason}）`;
    }
    if (minutes > budget) continue;
    budget -= minutes;
    const key = suggestionKey(snapshot.date, identity);
    suggestions.push({
      key,
      id: options.idFor(key),
      kind: candidate.kind,
      title: candidate.title.slice(0, 240),
      minutes,
      courseId: candidate.courseId,
      skillLabel: candidate.skillLabel,
      reasonCode,
      reason: reason.slice(0, 500),
    });
  }
  return { suggestions };
}
