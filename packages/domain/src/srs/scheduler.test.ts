import { describe, expect, it } from "vitest";
import { createInitialState, migrateReviewHistory, scheduleReview, SRS_VERSION } from "./scheduler";
const NOW = new Date("2026-08-02T08:00:00.000Z"), DAY = 86_400_000;
describe("FSRS scheduling", () => {
  it("starts due now and persists memory state and algorithm", () => {
    expect(createInitialState("c", NOW)).toMatchObject({ dueAt: NOW.toISOString(), srsVersion: "fsrs-5.4.2",
      fsrs: { stability: 0, difficulty: 0, state: 0, lastReview: null } });
    expect(SRS_VERSION).toBe("fsrs-5.4.2");
  });
  it.each([["again", 1], ["hard", 6], ["good", 10]] as const)("%s uses short-term learning, not an arbitrary day interval", (grade, minutes) => {
    const state = scheduleReview(createInitialState("c", NOW), grade, NOW);
    expect(Date.parse(state.dueAt) - NOW.getTime()).toBe(minutes * 60_000);
    expect(state.fsrs?.state).toBe(1);
    expect(state.fsrs?.stability).toBeGreaterThan(0);
  });
  it("an easy card graduates and delayed failures lower memory stability", () => {
    const good = scheduleReview(createInitialState("c", NOW), "easy", NOW);
    expect(good.dueAt).toBe("2026-08-10T08:00:00.000Z");
    const failed = scheduleReview(good, "again", new Date(good.dueAt));
    expect(failed.fsrs?.stability).toBeLessThan(good.fsrs!.stability);
    expect(failed.fsrs?.lapses).toBe(1);
    expect(failed.fsrs?.state).toBe(3);
  });
  it("replays full legacy history while retaining its due date and legacy counters", () => {
    const old = { cardId: "c", ease: 1.3, intervalDays: 60, dueAt: "2026-10-01T08:00:00Z", reps: 2,
      lapses: 0, lastGrade: "easy" as const, updatedAt: "2026-08-03T08:00:00Z" };
    const migrated = migrateReviewHistory(old, [{ grade: "easy", occurredAt: old.updatedAt }, { grade: "good", occurredAt: NOW.toISOString() }]);
    expect(migrated.dueAt).toBe(old.dueAt);
    expect(migrated.fsrs?.reps).toBe(2);
    expect(migrated.fsrs?.lastReview).toBe("2026-08-03T08:00:00.000Z");
    expect(migrateReviewHistory(old, [])).toBe(old);
    expect(migrateReviewHistory(old, [{ grade: "good", occurredAt: NOW.toISOString() }])).toBe(old);
    const fresh = scheduleReview(old, "good", NOW);
    expect(fresh.reps).toBe(3);
    expect(fresh.fsrs?.reps).toBe(1);
    expect(fresh.fsrs?.stability).toBe(2.3065);
  });
  it("compresses against future exam dates but preserves explicit understanding mode", () => {
    const initial = createInitialState("c", NOW), deadline = { targetDate: "2026-08-06", today: "2026-08-02" };
    const compressed = scheduleReview(initial, "easy", NOW, deadline);
    expect(Date.parse(compressed.dueAt) - NOW.getTime()).toBe(40 / 24 * DAY);
    expect(compressed.fsrs?.scheduledDays).toBe(8); // Keep the model's interval distinct from the deadline cap.
    expect(scheduleReview(initial, "easy", NOW, { ...deadline, learningMode: "understand" }).dueAt).toBe("2026-08-10T08:00:00.000Z");
  });
  it.each(["2026-08-02", "2026-08-01"])("does not produce an overdue or endless immediate repeat for %s", targetDate => {
    const next = scheduleReview(createInitialState("c", NOW), "good", NOW, { targetDate, today: "2026-08-02" });
    expect(Date.parse(next.dueAt) - NOW.getTime()).toBe(10 * 60_000);
  });
  it("fits a late-night review before the next local exam day starts", () => {
    const late = new Date("2026-08-02T15:30:00Z"); // 23:30 in Shanghai
    const next = scheduleReview(createInitialState("c", late), "easy", late, { targetDate: "2026-08-03", today: "2026-08-02", timeZone: "Asia/Shanghai" });
    expect(next.dueAt).toBe("2026-08-02T15:45:00.000Z");
  });
  it("rejects a review before the last accepted review", () => {
    const state = scheduleReview(createInitialState("c", NOW), "good", NOW);
    expect(() => scheduleReview(state, "good", new Date(NOW.getTime() - 1))).toThrow("predates");
  });
});
