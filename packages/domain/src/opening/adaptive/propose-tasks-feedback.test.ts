import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import type { TaskItem } from "@aistudy/contracts";
import { proposeAdaptiveTasks } from "./propose-tasks";
import { stableHash, suggestionIdentity, type CourseSignal, type LearnerSnapshot } from "./types";

const courseId = "00000000-0000-4000-8000-000000000001";
const date = "2026-10-21";
const cardIdentity = suggestionIdentity("review_cards", null, null);
const course = (overrides: Partial<CourseSignal> = {}): CourseSignal => ({
  courseId, title: "数学", skills: [], nextSkills: [], hasUsableMaterials: true,
  goal: null, minutesThisWeek: 0, ...overrides,
});
const snapshot = (overrides: Partial<LearnerSnapshot> = {}): LearnerSnapshot => ({
  date, timeZone: "Asia/Shanghai", courses: [], dueCardCount: 5, plannerHistory: [], ...overrides,
});
const skippedTwice = (identity: string) => [
  { date: "2026-10-20", identity, status: "skipped" as const },
  { date: "2026-10-19", identity, status: "skipped" as const },
];
const propose = (snap: LearnerSnapshot, options: Partial<Parameters<typeof proposeAdaptiveTasks>[1]> = {}) =>
  proposeAdaptiveTasks(snap, {
    autonomy: "copilot", capacityMinutes: 180, committedMinutes: 0, pendingTasks: [],
    idFor: (key) => `00000000-0000-4000-8000-${stableHash(key).padStart(12, "0")}`, ...options,
  }).suggestions;

// Fixtures are synthetic. No student records or provider calls are required.
describe("adaptive suggestions respect workload feedback", () => {
  for (const [cards, expected] of [[5, 3], [6, 3], [7, 4], [9, 5], [12, 6], [19, 10], [30, 15], [80, 15]] as const) {
    it(`reduces a ${cards}-card review to ${expected} minutes after two skips`, () => {
      const result = propose(snapshot({ dueCardCount: cards, plannerHistory: skippedTwice(cardIdentity) }));
      assert.equal(result.length, 1);
      assert.equal(result[0]!.minutes, expected);
      assert.equal(result[0]!.reasonCode, "repeatedly_skipped");
      assert.ok(result[0]!.reason.includes(`${expected} 分钟`));
    });
  }

  it("never increases card-review minutes when reducing workload", () => {
    for (let cards = 5; cards <= 80; cards += 1) {
      const original = propose(snapshot({ dueCardCount: cards }))[0]!;
      const reduced = propose(snapshot({ dueCardCount: cards, plannerHistory: skippedTwice(cardIdentity) }))[0]!;
      assert.ok(Number.isInteger(reduced.minutes) && reduced.minutes > 0);
      assert.ok(reduced.minutes < original.minutes, `card count ${cards}`);
    }
  });

  it("preserves the 25-to-13-minute study-block reduction", () => {
    const identity = suggestionIdentity("new_skill", courseId, "导数");
    const result = propose(snapshot({ dueCardCount: 0, courses: [course({ nextSkills: ["导数"] })], plannerHistory: skippedTwice(identity) }));
    assert.equal(result[0]!.minutes, 13);
  });

  it("fits the reduced review into the actual remaining suggestion budget", () => {
    // floor(10 * 0.8) - 5 = 3, enough for the reduced five-card review.
    const result = propose(snapshot({ plannerHistory: skippedTwice(cardIdentity) }), { capacityMinutes: 10, committedMinutes: 5 });
    assert.equal(result[0]!.minutes, 3);
  });

  it("keeps the existing minimum card count", () => {
    assert.deepEqual(propose(snapshot({ dueCardCount: 4, plannerHistory: skippedTwice(cardIdentity) })), []);
  });

  it("does not reduce after a single skip", () => {
    assert.equal(propose(snapshot({ plannerHistory: skippedTwice(cardIdentity).slice(0, 1) }))[0]!.minutes, 5);
  });

  it("preserves three-day suppression and the existing gap-reset rule", () => {
    const history = [...skippedTwice(cardIdentity), { date: "2026-10-18", identity: cardIdentity, status: "skipped" as const }];
    assert.deepEqual(propose(snapshot({ plannerHistory: history })), []);
    assert.equal(propose(snapshot({ plannerHistory: history.slice(1) }))[0]!.minutes, 5);
  });
});

describe("adaptive suggestions respect same-day decisions", () => {
  const scenarios: { kind: string; skillLabel: string | null; courses: CourseSignal[]; dueCardCount: number }[] = [
    { kind: "review_cards", skillLabel: null, courses: [], dueCardCount: 5 },
    { kind: "new_skill", skillLabel: "导数", courses: [course({ nextSkills: ["导数"] })], dueCardCount: 0 },
    { kind: "weak_skill", skillLabel: "极限", courses: [course({ skills: [
      { skillLabel: "极限", status: "needs_review", lastObservedAt: null, recentAssistance: [] },
    ] })], dueCardCount: 0 },
    { kind: "course_pace", skillLabel: null, courses: [course({ goal: { targetDate: null, weeklyMinutes: 210 } })], dueCardCount: 0 },
  ];

  for (const scenario of scenarios) {
    for (const status of ["done", "skipped", "pending"] as const) {
      it(`does not re-suggest ${scenario.kind} after today's ${status} task`, () => {
        const identity = suggestionIdentity(scenario.kind, scenario.courses.length ? courseId : null, scenario.skillLabel);
        let allocated = 0;
        const result = propose(snapshot({
          courses: scenario.courses, dueCardCount: scenario.dueCardCount,
          plannerHistory: [{ date, identity, status }],
        }), { idFor: () => { allocated += 1; return courseId; } });
        assert.deepEqual(result, []);
        assert.equal(allocated, 0);
      });
    }
  }

  it("allows a fresh day's review after a completed previous-day review", () => {
    assert.equal(propose(snapshot({ plannerHistory: [{ date: "2026-10-20", identity: cardIdentity, status: "done" }] })).length, 1);
  });

  it("continues to suppress an earlier still-pending task", () => {
    assert.deepEqual(propose(snapshot({ plannerHistory: [{ date: "2026-10-20", identity: cardIdentity, status: "pending" }] })), []);
  });

  it("does not suppress unrelated identities", () => {
    const identity = suggestionIdentity("new_skill", courseId, "其他知识点");
    assert.equal(propose(snapshot({ plannerHistory: [{ date, identity, status: "done" }] })).length, 1);
  });

  it("preserves manual mode and the committed-work capacity limit", () => {
    assert.deepEqual(propose(snapshot(), { autonomy: "manual" }), []);
    assert.deepEqual(propose(snapshot(), { capacityMinutes: 30, committedMinutes: 24 }), []);
  });

  it("preserves course-skill deduplication against the learner's own pending task", () => {
    const existing: TaskItem = { id: courseId, title: "导数练习", minutes: 25, dueAt: null, priority: 1,
      status: "pending", courseId, skillLabel: "导数" };
    assert.deepEqual(propose(snapshot({ dueCardCount: 0, courses: [course({ nextSkills: ["导数"] })] }), { pendingTasks: [existing] }), []);
  });

  it("is deterministic and does not mutate the snapshot", () => {
    const input = snapshot({ plannerHistory: skippedTwice(cardIdentity) });
    const before = JSON.stringify(input);
    assert.deepEqual(propose(input), propose(input));
    assert.equal(JSON.stringify(input), before);
  });
});
