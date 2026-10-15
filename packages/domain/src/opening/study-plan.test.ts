import { describe, expect, it } from "vitest";
import { isLessonReviewDue, planStudyDay, projectStudyPlan, type StudyLessonProgress } from "./study-plan";

const fresh = (count: number): StudyLessonProgress[] =>
  Array.from({ length: count }, (_, index) => ({ index, taughtOn: null, lastReviewedOn: null }));

describe("planStudyDay", () => {
  it("teaches the next lessons up to the daily count", () => {
    expect(planStudyDay({ date: "2026-10-15", lessonsPerDay: 3, lessons: fresh(7) })).toEqual({ review: null, lessonIndexes: [0, 1, 2] });
  });

  it("puts due reviews and open mistakes first, then new lessons", () => {
    const lessons = fresh(7).map((l) => (l.index < 3 ? { ...l, taughtOn: "2026-10-15" } : l));
    expect(planStudyDay({ date: "2026-10-16", lessonsPerDay: 3, lessons })).toEqual({
      review: { lessonIndexes: [0, 1, 2], mistakes: false },
      lessonIndexes: [3, 4],
    });
    expect(planStudyDay({ date: "2026-10-15", lessonsPerDay: 3, lessons: fresh(2), openMistakes: 1 }).review).toEqual({ lessonIndexes: [], mistakes: true });
  });

  it("does not re-issue lessons waiting in unfinished tasks and counts them against today", () => {
    expect(planStudyDay({ date: "2026-10-16", lessonsPerDay: 3, lessons: fresh(7), reservedLessonIndexes: [0, 1], carryOver: 2 })).toEqual({ review: null, lessonIndexes: [2] });
  });

  it("with one lesson a day keeps new material moving until it runs out", () => {
    const lessons = [{ index: 0, taughtOn: "2026-10-15", lastReviewedOn: null }, { index: 1, taughtOn: null, lastReviewedOn: null }];
    expect(planStudyDay({ date: "2026-10-16", lessonsPerDay: 1, lessons })).toEqual({ review: null, lessonIndexes: [1] });
    expect(planStudyDay({ date: "2026-10-16", lessonsPerDay: 1, lessons: [lessons[0]!] }).review?.lessonIndexes).toEqual([0]);
  });
});

describe("isLessonReviewDue", () => {
  const lesson = { index: 0, taughtOn: "2026-10-15", lastReviewedOn: null as string | null };
  it("falls due on day 1, 3 and 7 and stays due until reviewed (missed days catch up)", () => {
    expect(isLessonReviewDue(lesson, "2026-10-15")).toBe(false);
    expect(isLessonReviewDue(lesson, "2026-10-16")).toBe(true);
    expect(isLessonReviewDue({ ...lesson, lastReviewedOn: "2026-10-16" }, "2026-10-17")).toBe(false);
    expect(isLessonReviewDue({ ...lesson, lastReviewedOn: "2026-10-16" }, "2026-10-18")).toBe(true);
    expect(isLessonReviewDue({ ...lesson, lastReviewedOn: "2026-10-16" }, "2026-10-20")).toBe(true);
    expect(isLessonReviewDue({ ...lesson, lastReviewedOn: "2026-10-22" }, "2026-11-30")).toBe(false);
  });
});

describe("projectStudyPlan", () => {
  it("lays seven lessons over the days at three a day, reviews included, and flags a target it misses", () => {
    const projection = projectStudyPlan({ today: "2026-10-15", startDate: "2026-10-15", lessonsPerDay: 3, targetDate: "2026-10-16", lessons: fresh(7) });
    expect(projection.lessons.map((l) => l.date)).toEqual([
      "2026-10-15", "2026-10-15", "2026-10-15", "2026-10-16", "2026-10-16", "2026-10-17", "2026-10-17",
    ]);
    expect(projection.finishDate).toBe("2026-10-17");
    expect(projection.behind).toBe(true);
    expect(projection.reviewDates.slice(0, 3)).toEqual(["2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(projection.reviewDates).toContain("2026-10-24");
  });

  it("keeps taught lessons on their day; today's issued lesson and a due review fill today", () => {
    const lessons = fresh(4).map((l) => (l.index === 0 ? { ...l, taughtOn: "2026-10-14" } : l));
    const projection = projectStudyPlan({ today: "2026-10-15", startDate: "2026-10-14", lessonsPerDay: 2, targetDate: null, lessons, scheduledToday: [1] });
    expect(projection.lessons).toEqual([
      { index: 0, taught: true, date: "2026-10-14" },
      { index: 1, taught: false, date: "2026-10-15" },
      { index: 2, taught: false, date: "2026-10-16" },
      { index: 3, taught: false, date: "2026-10-17" },
    ]);
    expect(projection.behind).toBe(false);
  });
});
