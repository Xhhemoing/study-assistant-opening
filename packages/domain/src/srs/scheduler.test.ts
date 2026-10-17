import { describe, expect, it } from "vitest";
import { createInitialState, scheduleReview, SRS_VERSION } from "./scheduler";

const NOW = new Date("2026-08-02T08:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("srs scheduler srs-1", () => {
  it("starts a new card due immediately with ease 2.5", () => {
    const s = createInitialState("c", NOW);
    expect(s).toMatchObject({
      cardId: "c",
      ease: 2.5,
      intervalDays: 0,
      reps: 0,
      lapses: 0,
      lastGrade: null,
    });
    expect(s.dueAt).toBe(NOW.toISOString());
  });

  it("again: lapse, ease -0.2, due in 10 minutes", () => {
    const s1 = scheduleReview(createInitialState("c", NOW), "again", NOW);
    expect(s1.lapses).toBe(1);
    expect(s1.ease).toBeCloseTo(2.3);
    expect(Date.parse(s1.dueAt) - NOW.getTime()).toBe(10 * 60 * 1000);
  });

  it("good: first 1 day, then interval * ease", () => {
    const s1 = scheduleReview(createInitialState("c", NOW), "good", NOW);
    expect(s1.intervalDays).toBe(1);
    expect(Date.parse(s1.dueAt) - NOW.getTime()).toBe(DAY);
    const s2 = scheduleReview(s1, "good", new Date(NOW.getTime() + DAY));
    expect(s2.intervalDays).toBe(3); // Math.round(1 * 2.5) = 3 (rounds half up)
  });

  it("easy: first 3 days, ease +0.15", () => {
    const s1 = scheduleReview(createInitialState("c", NOW), "easy", NOW);
    expect(s1.intervalDays).toBe(3);
    expect(s1.ease).toBeCloseTo(2.65);
  });

  it("ease never drops below 1.3", () => {
    let s = createInitialState("c", NOW);
    for (let i = 0; i < 10; i += 1) s = scheduleReview(s, "again", NOW);
    expect(s.ease).toBe(1.3);
  });

  it.each(["hard", "good"] as const)("%s keeps increasing daily intervals even at minimum ease", (grade) => {
    let state = { ...createInitialState("c", NOW), ease: 1.3, intervalDays: 1 };
    for (let repetition = 0; repetition < 6; repetition += 1) {
      const now = new Date(state.dueAt);
      const previousInterval = state.intervalDays;
      state = scheduleReview(state, grade, now);
      expect(state.intervalDays).toBeGreaterThan(previousInterval);
      expect(Date.parse(state.dueAt) - now.getTime()).toBe(state.intervalDays * DAY);
    }
    // A lapse still returns to the existing short relearning step.
    const now = new Date(state.dueAt);
    const lapsed = scheduleReview(state, "again", now);
    expect(lapsed.intervalDays).toBe(0);
    expect(Date.parse(lapsed.dueAt) - now.getTime()).toBe(10 * 60 * 1000);
  });

  it("deterministic + versioned", () => {
    expect(scheduleReview(createInitialState("c", NOW), "hard", NOW)).toEqual(
      scheduleReview(createInitialState("c", NOW), "hard", NOW),
    );
    expect(SRS_VERSION).toBe("srs-1");
  });
});
