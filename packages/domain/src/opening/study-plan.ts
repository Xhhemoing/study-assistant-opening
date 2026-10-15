/**
 * Course study plan: the course's material split into lessons, taught a few a day,
 * with spaced review ahead of new material. Pure rules; the caller supplies what was
 * taught when (from completed lessons), so the plan follows what actually happened.
 */
import { addLocalDays } from "./daily-draft";

/** Review a lesson 1, 3 and 7 days after it was first taught. */
export const STUDY_REVIEW_OFFSETS_DAYS = [1, 3, 7] as const;
export const STUDY_PLAN_HORIZON_DAYS = 90;

export type StudyLessonProgress = {
  index: number;
  /** Local date the lesson was first taught; null = not yet. */
  taughtOn: string | null;
  /** Last later local date a lesson covering this one was completed. */
  lastReviewedOn: string | null;
};

export type StudyDayInput = {
  date: string;
  lessonsPerDay: number;
  lessons: readonly StudyLessonProgress[];
  /** Lessons already waiting in unfinished plan tasks (not re-issued). */
  reservedLessonIndexes?: readonly number[];
  /** Unfinished plan tasks from earlier days; they use today's capacity first. */
  carryOver?: number;
  /** Wrong answers from this course not yet reviewed. */
  openMistakes?: number;
};

export type StudyDaySlots = {
  /** Lessons due for review today, oldest first; null when no review slot. */
  review: { lessonIndexes: number[]; mistakes: boolean } | null;
  /** New lessons to teach today, in material order. */
  lessonIndexes: number[];
};

function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A review is due once an offset has passed and no review happened since it fell due. */
export function isLessonReviewDue(lesson: StudyLessonProgress, date: string): boolean {
  if (!lesson.taughtOn) return false;
  const age = daysFrom(lesson.taughtOn, date);
  const passed = STUDY_REVIEW_OFFSETS_DAYS.filter((offset) => offset <= age);
  if (!passed.length) return false;
  const dueSince = addLocalDays(lesson.taughtOn, passed[passed.length - 1]!);
  return lesson.lastReviewedOn == null || lesson.lastReviewedOn < dueSince;
}

/**
 * One day's slots. Review comes first when something is due, but with one lesson a
 * day new material keeps moving until it runs out (reviews then take the slot).
 */
export function planStudyDay(input: StudyDayInput): StudyDaySlots {
  let capacity = Math.max(0, input.lessonsPerDay - (input.carryOver ?? 0));
  const reserved = new Set(input.reservedLessonIndexes ?? []);
  const ordered = [...input.lessons].sort((a, b) => a.index - b.index);
  const untaught = ordered.filter((lesson) => lesson.taughtOn == null && !reserved.has(lesson.index));
  const dueLessons = ordered.filter((lesson) => isLessonReviewDue(lesson, input.date)).map((lesson) => lesson.index);
  const mistakes = (input.openMistakes ?? 0) > 0;
  let review: StudyDaySlots["review"] = null;
  if ((dueLessons.length || mistakes) && capacity > 0 && (input.lessonsPerDay >= 2 || untaught.length === 0)) {
    review = { lessonIndexes: dueLessons, mistakes };
    capacity -= 1;
  }
  return { review, lessonIndexes: untaught.slice(0, capacity).map((lesson) => lesson.index) };
}

export type StudyPlanProjection = {
  lessons: Array<{ index: number; date: string | null; taught: boolean }>;
  reviewDates: string[];
  /** Day the last new lesson is planned; null when it does not fit the horizon. */
  finishDate: string | null;
  /** Finishes after the target date at this pace. */
  behind: boolean;
};

/**
 * Projects the schedule day by day with the same rules as `planStudyDay`, assuming
 * each planned lesson is taught and each review done on its day.
 */
export function projectStudyPlan(input: {
  today: string;
  startDate: string;
  lessonsPerDay: number;
  targetDate: string | null;
  lessons: readonly StudyLessonProgress[];
  /** Lessons already issued for today (pending tasks). */
  scheduledToday?: readonly number[];
}): StudyPlanProjection {
  const state = new Map(input.lessons.map((lesson) => [lesson.index, { ...lesson }]));
  const planned = new Map<number, string>();
  const reviewDates: string[] = [];
  let date = input.startDate > input.today ? input.startDate : input.today;
  for (const index of input.scheduledToday ?? []) {
    const lesson = state.get(index);
    if (lesson && !lesson.taughtOn && date === input.today) { planned.set(index, date); }
  }
  for (let day = 0; day < STUDY_PLAN_HORIZON_DAYS; day += 1) {
    const today = date === input.today ? [...planned.keys()] : [];
    const slots = planStudyDay({ date, lessonsPerDay: input.lessonsPerDay, lessons: [...state.values()], reservedLessonIndexes: today, carryOver: today.length });
    for (const index of [...today, ...slots.lessonIndexes]) {
      planned.set(index, date);
      state.get(index)!.taughtOn = date;
    }
    if (slots.review) {
      reviewDates.push(date);
      for (const index of slots.review.lessonIndexes) state.get(index)!.lastReviewedOn = date;
    }
    date = addLocalDays(date, 1);
  }
  const lessons = [...input.lessons].sort((a, b) => a.index - b.index).map((lesson) => ({
    index: lesson.index,
    taught: lesson.taughtOn != null,
    date: lesson.taughtOn ?? planned.get(lesson.index) ?? null,
  }));
  const newDates = lessons.filter((lesson) => !lesson.taught).map((lesson) => lesson.date);
  const finishDate = newDates.includes(null)
    ? null
    : ([...lessons.map((lesson) => lesson.date!)].sort().at(-1) ?? null);
  return {
    lessons,
    reviewDates,
    finishDate,
    behind: input.targetDate != null && (finishDate == null || finishDate > input.targetDate),
  };
}
