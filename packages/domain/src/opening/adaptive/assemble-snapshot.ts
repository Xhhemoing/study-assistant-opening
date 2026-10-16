import { addLocalDays } from "../daily-draft";
import type { LearnerSnapshotSources, SnapshotCourseSource, SnapshotObservation, SnapshotSkillSummary } from "./snapshot-sources";
import { parseSuggestionKey, type LearnerSnapshot, type SkillSignal, type SkillStatus } from "./types";

function newestObservationFirst(a: SnapshotObservation, b: SnapshotObservation): number {
  const time = Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt);
  // Effective heads can have the same attempt time; ids make selection order-independent.
  return time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function summaryStatus(rows: readonly SnapshotSkillSummary[]): SkillStatus {
  if (rows.some((row) => row.status === "needs_review")) return "needs_review";
  if (rows.length > 0 && rows.every((row) => row.status === "observed_independent")) return "observed_independent";
  return "needs_check";
}

function assembleSkills(course: SnapshotCourseSource): SkillSignal[] {
  const groups = new Map<string, { summaries: SnapshotSkillSummary[]; observations: SnapshotObservation[] }>();
  const groupFor = (skillLabel: string) => {
    let group = groups.get(skillLabel);
    if (!group) {
      group = { summaries: [], observations: [] };
      groups.set(skillLabel, group);
    }
    return group;
  };
  for (const summary of course.summaries) groupFor(summary.skillLabel).summaries.push(summary);
  for (const observation of course.observations) groupFor(observation.skillLabel).observations.push(observation);

  return [...groups].map(([skillLabel, { summaries, observations }]) => {
    observations.sort(newestObservationFirst);
    let lastObservedAt: string | null = null;
    for (const row of summaries) {
      if (row.lastObservedAt !== null &&
        (lastObservedAt === null || Date.parse(row.lastObservedAt) > Date.parse(lastObservedAt))) {
        lastObservedAt = row.lastObservedAt;
      }
    }
    return {
      skillLabel,
      status: observations[0]?.verifiedCorrect === "no" ? "needs_review" : summaryStatus(summaries),
      lastObservedAt,
      recentAssistance: observations.slice(0, 3).map((row) => row.assistance),
    };
  });
}

function nextSkills(course: SnapshotCourseSource, skills: readonly SkillSignal[]): string[] {
  if (!course.hasUsableMaterials) return [];
  const bySkill = new Map(skills.map((skill) => [skill.skillLabel, skill.status]));
  const byNodeId = new Map(course.knowledgeNodes.map((node) => [node.id, node]));
  return course.knowledgeNodes.filter((node) =>
    !bySkill.has(node.title) && node.prerequisiteIds.every((id) => {
      const prerequisite = byNodeId.get(id);
      return prerequisite !== undefined && bySkill.get(prerequisite.title) === "observed_independent";
    }),
  ).map((node) => node.title);
}

/** Assemble full, already-qualified course evidence without performing IO or changing sources. */
export function assembleLearnerSnapshot(sources: LearnerSnapshotSources): LearnerSnapshot {
  // date and closedLocalDate are already local calendar dates; use UTC only for calendar arithmetic.
  const weekday = new Date(`${sources.date}T00:00:00Z`).getUTCDay();
  const weekStart = addLocalDays(sources.date, -((weekday + 6) % 7));
  const weekEnd = addLocalDays(weekStart, 6);
  const historyStart = addLocalDays(sources.date, -7);
  const minutesByCourse = new Map<string, number>();
  const plannerHistory: LearnerSnapshot["plannerHistory"][number][] = [];

  for (const task of sources.tasks) {
    if (task.status === "done" && task.courseId !== null && task.closedLocalDate !== null &&
      task.closedLocalDate >= weekStart && task.closedLocalDate <= weekEnd) {
      minutesByCourse.set(task.courseId, (minutesByCourse.get(task.courseId) ?? 0) + task.minutes);
    }
    const suggestion = task.clientKey === null ? null : parseSuggestionKey(task.clientKey);
    if (suggestion && suggestion.date >= historyStart && suggestion.date <= sources.date) {
      plannerHistory.push({ ...suggestion, status: task.status });
    }
  }

  return {
    date: sources.date,
    timeZone: sources.timeZone,
    dueCardCount: sources.dueCardCount,
    courses: sources.courses.map((course) => {
      const available = course.evidenceStatus === "available";
      const skills = available ? assembleSkills(course) : [];
      return {
        courseId: course.courseId,
        title: course.title,
        goal: course.goal,
        hasUsableMaterials: course.hasUsableMaterials,
        minutesThisWeek: minutesByCourse.get(course.courseId) ?? 0,
        skills,
        nextSkills: available ? nextSkills(course, skills) : [],
      };
    }),
    plannerHistory,
  };
}
