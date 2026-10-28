import { DEFAULT_OPENING_PLANNING_SETTINGS, type FirstLearningInput, type OpeningPlanningSettings } from "@aistudy/contracts";
import { addLocalDays, resolveLocalDayBounds } from "@aistudy/domain";
import type { FirstLearningDaySeed } from "@aistudy/database";

export { firstLearningInputSchema, type FirstLearningInput } from "@aistudy/contracts";

/** A first, bounded plan; future tasks stay out of today's queue until their local day. */
export function initialLearningDays(input: FirstLearningInput, startDate: string, timeZone: string): FirstLearningDaySeed[] {
  if (input.startTime === null) return [];
  const remaining = input.targetDate
    ? Math.ceil((Date.parse(`${input.targetDate}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / 86_400_000)
    : 7;
  const days = Math.max(1, Math.min(28, remaining));
  return Array.from({ length: days }, (_, index) => {
    const date = addLocalDays(startDate, index);
    const { dayStart, nextDayStart } = resolveLocalDayBounds(date, timeZone);
    const nearExam = input.targetDate && remaining <= 28;
    const focus = index === 0 ? "首次学习"
      : nearExam && index === days - 1 ? "回顾错题与关键方法"
      : nearExam && days >= 4 && index === days - 2 ? "限时练习与查漏"
      : index < Math.ceil(days / 2) ? "核心概念与例题" : "独立练习与错题回顾";
    return { date, title: `${input.topic} · ${index === 0 ? focus : `第 ${index + 1} 天 · ${focus}`}`,
      minutes: input.minutes, notBefore: dayStart.toISOString(),
      dueAt: new Date(nextDayStart.getTime() - 1).toISOString() };
  });
}

export function initialLearningSchedule(input: FirstLearningInput, today: string): OpeningPlanningSettings | null {
  if (input.startTime === null) return null;
  const [hour, minute] = input.startTime.split(":").map(Number);
  const end = hour! * 60 + minute! + input.minutes;
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  return { ...DEFAULT_OPENING_PLANNING_SETTINGS, weekOneMonday: addLocalDays(today, -((weekday + 6) % 7)),
    timeZone: input.timeZone, dailyWindow: { start: input.startTime, end: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}` } };
}
