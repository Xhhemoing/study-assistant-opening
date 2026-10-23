import { describe, expect, it } from "vitest";
import type { PlannedBlock, TaskItem, TimeBlock } from "@aistudy/contracts";
import { forecastSprintBudget, type SprintBudgetForecastInput } from "./sprint-budget";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const courseId = id(900), otherCourseId = id(901);
const at = (date: string, clock: string) => `${date}T${clock}:00.000Z`;
const task = (n: number, changes: Partial<TaskItem> = {}): TaskItem => ({
  id: id(n), title: `任务${n}`, courseId, minutes: 30, dueAt: null, priority: 1, status: "pending", ...changes,
});
const retest = (n: number, recommendedAt: string, changes: Partial<TaskItem> = {}): TaskItem => task(n, {
  origin: "retest",
  retest: { candidateId: id(100 + n), activityId: id(200 + n), courseId, skillLabel: "积分", prompt: "独立复测", recommendedAt },
  ...changes,
});
const slot = (date: string, start: string, end: string, kind: TimeBlock["kind"] = "free"): TimeBlock => ({
  start: at(date, start), end: at(date, end), kind,
});
const accepted = (n: number, date: string, start: string, end: string): PlannedBlock => ({
  taskId: id(n), start: at(date, start), end: at(date, end), reason: "已有安排",
});
const day = (date: string, blocks: readonly TimeBlock[] = [slot(date, "09:00", "12:00")],
  committed: readonly PlannedBlock[] = []): SprintBudgetForecastInput["days"][number] => ({ date, blocks, accepted: committed });
const input = (changes: Partial<SprintBudgetForecastInput> = {}): SprintBudgetForecastInput => ({
  tasks: [task(1)], days: [day("2026-10-23")], courseId, examDate: "2026-10-27", dailyMinutes: 60,
  timeZone: "UTC", now: new Date(at("2026-10-23", "08:00")), horizonTruncated: false, ...changes,
});
const projected = (result: ReturnType<typeof forecastSprintBudget>) => result.days.flatMap(value =>
  value.blocks.map(({ taskId, start, end }) => ({ taskId, start, end })));

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("forecastSprintBudget", () => {
  it("uses later accepted task identities without adding their dates to the bounded output", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1), task(2)], horizonTruncated: true,
      examDate: "2026-12-01", constraints: { accepted: [accepted(1, "2026-11-25", "09:00", "09:30")], locked: [] } }));
    expect(result.days.map(value => value.date)).toEqual(["2026-10-23"]);
    expect(result.scheduledTaskIds).toEqual([id(2)]);
    expect(result.unscheduled).toEqual([]);
    expect(result.days[0]?.committedMinutes).toBe(0);
  });

  it("clips absolute cross-midnight commitments and locks from outside the output days", () => {
    const result = forecastSprintBudget(input({ now: new Date(at("2026-10-23", "00:00")),
      days: [day("2026-10-23", [slot("2026-10-23", "00:00", "03:00")])], tasks: [task(1), task(2)], dailyMinutes: 120,
      constraints: {
        accepted: [{ taskId: id(1), start: at("2026-10-22", "23:30"), end: at("2026-10-23", "00:30"), reason: "跨午夜" }],
        locked: [{ start: at("2026-10-22", "23:00"), end: at("2026-10-23", "01:00"), kind: "locked" }],
      } }));
    expect(result.days[0]).toMatchObject({ committedMinutes: 30, plannedMinutes: 30 });
    expect(projected(result)).toEqual([{ taskId: id(2), start: at("2026-10-23", "01:00"), end: at("2026-10-23", "01:30") }]);
  });

  it("preserves after-exam accepts but warns rather than silently pulling them before the exam", () => {
    const result = forecastSprintBudget(input({ constraints: { accepted: [accepted(1, "2026-10-28", "09:00", "09:30")], locked: [] } }));
    expect(result.scheduledTaskIds).toEqual([]);
    expect(result.warnings).toContainEqual(expect.stringContaining("晚于考试"));
  });

  it("rejects malformed external constraints and stale derived block kinds", () => {
    expect(() => forecastSprintBudget(input({ constraints: { accepted: [], locked: [slot("2026-10-23", "09:00", "10:00", "class")] } }))).toThrow("explicit locks");
    expect(() => forecastSprintBudget(input({ constraints: { accepted: [accepted(1, "2026-10-23", "10:00", "09:00")], locked: [] } }))).toThrow();
  });
  it("forecasts only pending tasks in this course, including legacy retest course projections", () => {
    const result = forecastSprintBudget(input({ tasks: [
      task(1), task(2, { courseId: otherCourseId }), task(3, { status: "done" }),
      task(4, { status: "skipped" }), task(5, { courseId: undefined }),
      retest(6, at("2026-10-23", "09:00"), { courseId: undefined }),
      retest(7, at("2026-10-23", "09:00"), { courseId: otherCourseId }),
    ] }));
    expect(result.scheduledTaskIds).toEqual([id(1), id(6)]);
    expect(result.unscheduled).toEqual([]);
    expect(result.deferredTaskIds).toEqual([]);
    expect(result.days[0]).toMatchObject({ budgetMinutes: 60, committedMinutes: 0, plannedMinutes: 60 });
  });

  it("uses planDay deadline, priority, stable-id ordering rather than input order", () => {
    const result = forecastSprintBudget(input({ dailyMinutes: 150, tasks: [
      task(4, { priority: 100 }), task(3, { dueAt: at("2026-10-23", "12:00"), priority: 2 }),
      task(2, { dueAt: at("2026-10-23", "11:00") }), task(1, { dueAt: at("2026-10-23", "12:00"), priority: 2 }),
      task(5, { dueAt: at("2026-10-23", "12:00"), priority: 3 }),
    ] }));
    expect(result.scheduledTaskIds).toEqual([id(2), id(5), id(1), id(3), id(4)]);
    expect(result.days[0]?.plannedMinutes).toBe(150);
  });

  it("carries unplaced work into later days without scheduling a task twice", () => {
    const result = forecastSprintBudget(input({ tasks: [task(3), task(1), task(2)], dailyMinutes: 30,
      days: [day("2026-10-24"), day("2026-10-23")] }));
    expect(result.days.map(value => [value.date, value.plannedMinutes])).toEqual([
      ["2026-10-23", 30], ["2026-10-24", 30],
    ]);
    expect(result.scheduledTaskIds).toEqual([id(1), id(2)]);
    expect(result.unscheduled).toEqual([{ taskId: id(3), reason: "daily_budget_exceeded" }]);
  });

  it("does not reserve budget for an oversized task and still schedules a small one", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1, { minutes: 90 }), task(2)], dailyMinutes: 30 }));
    expect(result.scheduledTaskIds).toEqual([id(2)]);
    expect(result.days[0]?.plannedMinutes).toBe(30);
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "daily_budget_exceeded" }]);
  });

  it("does not reserve budget for a task that fits the budget but cannot fit any contiguous slot", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1, { minutes: 60 }), task(2)],
      days: [day("2026-10-23", [slot("2026-10-23", "09:00", "09:30"), slot("2026-10-23", "10:00", "10:30")])] }));
    expect(result.scheduledTaskIds).toEqual([id(2)]);
    expect(result.days[0]?.plannedMinutes).toBe(30);
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "duration_exceeds_free_slots" }]);
  });

  it("lets a smaller task use the budget left after a placed large task", () => {
    const result = forecastSprintBudget(input({ dailyMinutes: 60,
      tasks: [task(1, { minutes: 40 }), task(2, { minutes: 30 }), task(3, { minutes: 20 })] }));
    expect(result.scheduledTaskIds).toEqual([id(1), id(3)]);
    expect(result.days[0]?.plannedMinutes).toBe(60);
    expect(result.unscheduled).toEqual([{ taskId: id(2), reason: "daily_budget_exceeded" }]);
  });

  it("locks accepted work from every course but charges only this course's actual intervals", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1), task(2),
      task(10, { minutes: 120 }), task(11, { courseId: otherCourseId })],
    days: [day("2026-10-23", undefined, [accepted(10, "2026-10-23", "09:00", "09:30"),
      accepted(11, "2026-10-23", "09:30", "10:00")])] }));
    expect(result.days[0]).toMatchObject({ budgetMinutes: 60, committedMinutes: 30, plannedMinutes: 30 });
    expect(projected(result)).toEqual([{ taskId: id(1), start: at("2026-10-23", "10:00"), end: at("2026-10-23", "10:30") }]);
    expect(result.scheduledTaskIds).toEqual([id(1)]);
    expect(result.unscheduled).toEqual([{ taskId: id(2), reason: "daily_budget_exceeded" }]);
  });

  it("excludes a task accepted on a later day from every earlier prediction", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1), task(2)], dailyMinutes: 30,
      days: [day("2026-10-23"), day("2026-10-24", undefined, [accepted(1, "2026-10-24", "09:00", "09:30")])] }));
    expect(result.scheduledTaskIds).toEqual([id(2)]);
    expect(result.days[1]).toMatchObject({ committedMinutes: 30, plannedMinutes: 0, blocks: [] });
    expect(result.unscheduled).toEqual([]);
  });

  it("deduplicates identical accepted intervals and unions overlapping same-course commitments", () => {
    const first = accepted(10, "2026-10-23", "09:00", "09:30");
    const result = forecastSprintBudget(input({ tasks: [task(1, { minutes: 15 }), task(10), task(11)],
      days: [day("2026-10-23", undefined, [first, { ...first, reason: "重复的投影" },
        accepted(11, "2026-10-23", "09:15", "09:45")])] }));
    expect(result.days[0]).toMatchObject({ committedMinutes: 45, plannedMinutes: 15 });
    expect(projected(result)).toEqual([{ taskId: id(1), start: at("2026-10-23", "09:45"), end: at("2026-10-23", "10:00") }]);
    expect(result.scheduledTaskIds).toEqual([id(1)]);
  });

  it("preserves conflicting accepted occurrences across days without creating a third occurrence", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1), task(2)],
      days: [day("2026-10-23", undefined, [accepted(1, "2026-10-23", "09:00", "09:30")]),
        day("2026-10-24", undefined, [accepted(1, "2026-10-24", "10:00", "10:30")])] }));
    expect(result.scheduledTaskIds).toEqual([id(2)]);
    expect(result.days.map(value => value.committedMinutes)).toEqual([30, 30]);
    expect(result.warnings).toEqual([expect.stringContaining("多个已接受时段")]);
  });

  it("keeps unknown accepted tasks as blockers and explicitly warns that their course budget is unknown", () => {
    const result = forecastSprintBudget(input({ dailyMinutes: 30,
      days: [day("2026-10-23", [slot("2026-10-23", "09:00", "10:00")], [accepted(99, "2026-10-23", "09:00", "09:30")])] }));
    expect(result.days[0]).toMatchObject({ committedMinutes: 0, plannedMinutes: 30 });
    expect(result.days[0]?.blocks[0]?.start).toBe(at("2026-10-23", "09:30"));
    expect(result.warnings).toEqual([expect.stringContaining("缺少任务归属")]);
  });

  it("counts elapsed accepted work toward today's cap rather than resetting the budget at now", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1), task(10, { status: "done" })], dailyMinutes: 30,
      now: new Date(at("2026-10-23", "10:00")),
      days: [day("2026-10-23", undefined, [accepted(10, "2026-10-23", "09:00", "09:30")])] }));
    expect(result.days[0]).toMatchObject({ budgetMinutes: 30, committedMinutes: 30, plannedMinutes: 0, blocks: [] });
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "daily_budget_exceeded" }]);
  });

  it("does not subtract accepted time twice when it is also present as a locked constraint", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1), task(10)],
      days: [day("2026-10-23", [slot("2026-10-23", "09:00", "11:00"), slot("2026-10-23", "09:00", "09:30", "locked")],
        [accepted(10, "2026-10-23", "09:00", "09:30")])] }));
    expect(result.days[0]).toMatchObject({ budgetMinutes: 60, committedMinutes: 30, plannedMinutes: 30 });
    expect(result.days[0]?.blocks[0]?.start).toBe(at("2026-10-23", "09:30"));
  });

  it("reports an overcommitted day without changing old accepts or producing a negative budget", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1), task(10)], dailyMinutes: 30,
      days: [day("2026-10-23", undefined, [accepted(10, "2026-10-23", "09:00", "10:00")])] }));
    expect(result.days[0]).toMatchObject({ budgetMinutes: 30, committedMinutes: 60, plannedMinutes: 0, blocks: [] });
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "daily_budget_exceeded" }]);
    expect(result.warnings).toEqual([expect.stringContaining("超过每日预算")]);
  });

  it("protects exam eve for review_cards and retests while explaining other pending tasks", () => {
    const result = forecastSprintBudget(input({ examDate: "2026-10-24", dailyMinutes: 120, tasks: [
      task(1, { suggestionKind: "new_skill" }), task(2, { suggestionKind: "review_cards" }),
      retest(3, at("2026-10-23", "10:00")), task(4, { suggestionKind: "weak_skill" }),
    ] }));
    expect(result.scheduledTaskIds).toEqual([id(2), id(3)]);
    expect(result.unscheduled).toEqual([
      { taskId: id(1), reason: "exam_eve_review_only" }, { taskId: id(4), reason: "exam_eve_review_only" },
    ]);
    expect(result.days[0]?.plannedMinutes).toBe(60);
  });

  it("allows accepted ordinary tasks on exam eve to stay and consume budget, without reproposing them", () => {
    const result = forecastSprintBudget(input({ examDate: "2026-10-24", tasks: [task(1), task(2, { suggestionKind: "review_cards" }), task(3)],
      days: [day("2026-10-23", undefined, [accepted(1, "2026-10-23", "09:00", "09:30")])] }));
    expect(result.days[0]).toMatchObject({ committedMinutes: 30, plannedMinutes: 30 });
    expect(result.scheduledTaskIds).toEqual([id(2)]);
    expect(result.unscheduled).toEqual([{ taskId: id(3), reason: "exam_eve_review_only" }]);
  });

  it("never extends review deadlines to make them fit on exam eve", () => {
    const result = forecastSprintBudget(input({ examDate: "2026-10-24", dailyMinutes: 120, tasks: [
      task(1, { suggestionKind: "review_cards", dueAt: at("2026-10-23", "08:00") }),
      task(2, { suggestionKind: "review_cards", dueAt: at("2026-10-23", "09:20") }),
      task(3, { suggestionKind: "review_cards", dueAt: at("2026-10-23", "09:30") }),
      retest(4, at("2026-10-23", "11:00"), { dueAt: at("2026-10-23", "11:20") }),
    ] }));
    expect(projected(result)).toEqual([{ taskId: id(3), start: at("2026-10-23", "09:00"), end: at("2026-10-23", "09:30") }]);
    expect(result.unscheduled).toEqual([
      { taskId: id(1), reason: "deadline_passed" }, { taskId: id(2), reason: "no_slot_before_deadline" },
      { taskId: id(4), reason: "no_compliant_slot_after_not_before" },
    ]);
  });

  it("honors the later of retest recommendedAt and explicit notBefore, retaining earlier prefixes", () => {
    const result = forecastSprintBudget(input({ dailyMinutes: 90, tasks: [
      retest(1, at("2026-10-23", "10:00"), { notBefore: at("2026-10-23", "11:00"), priority: 3 }),
      retest(2, at("2026-10-23", "10:00"), { notBefore: at("2026-10-23", "09:00"), priority: 2 }), task(3),
    ] }));
    expect(projected(result)).toEqual([
      { taskId: id(3), start: at("2026-10-23", "09:00"), end: at("2026-10-23", "09:30") },
      { taskId: id(2), start: at("2026-10-23", "10:00"), end: at("2026-10-23", "10:30") },
      { taskId: id(1), start: at("2026-10-23", "11:00"), end: at("2026-10-23", "11:30") },
    ]);
  });

  it("defers tasks starting at or beyond the exclusive window end, not the end of the last free slot", () => {
    const result = forecastSprintBudget(input({ tasks: [
      retest(1, at("2026-10-24", "00:00")), task(2, { notBefore: at("2026-10-25", "09:00") }),
      retest(3, at("2026-10-23", "13:00")), task(4),
    ], horizonTruncated: true }));
    expect(result.deferredTaskIds).toEqual([id(1), id(2)]);
    expect(result.scheduledTaskIds).toEqual([id(4)]);
    expect(result.unscheduled).toEqual([{ taskId: id(3), reason: "no_compliant_slot_after_not_before" }]);
    expect(result.warnings).toEqual([expect.stringContaining("不代表已安排完")]);
  });

  it("schedules at next-day notBefore exactly, instead of bringing work forward to the previous day", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1, { notBefore: at("2026-10-24", "00:00") })],
      days: [day("2026-10-23"), day("2026-10-24", [slot("2026-10-24", "00:00", "00:30")])] }));
    expect(result.days[0]?.blocks).toEqual([]);
    expect(projected(result)).toEqual([{ taskId: id(1), start: at("2026-10-24", "00:00"), end: at("2026-10-24", "00:30") }]);
    expect(result.deferredTaskIds).toEqual([]);
  });

  it("reports a genuinely expired deadline before treating a contradictory future deferral as deferred", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1, { dueAt: at("2026-10-23", "07:59"),
      notBefore: at("2026-10-25", "09:00") })] }));
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "deadline_passed" }]);
    expect(result.deferredTaskIds).toEqual([]);
  });

  it("reports lack of availability even with a future deadline, without inventing free time", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1, { dueAt: at("2026-10-26", "10:00") })],
      days: [day("2026-10-23", [slot("2026-10-23", "09:00", "12:00", "class")])] }));
    expect(result.scheduledTaskIds).toEqual([]);
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "no_available_time" }]);
  });

  it("keeps a deadline-fit failure rather than labeling the task overdue on a later forecast day", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1, { dueAt: at("2026-10-23", "09:20") })],
      days: [day("2026-10-23"), day("2026-10-24")] }));
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "no_slot_before_deadline" }]);
  });

  it("clips to local day bounds, excludes past/exam/future days, and never creates cross-midnight tasks", () => {
    const span: TimeBlock = { start: at("2026-10-22", "23:45"), end: at("2026-10-24", "00:45"), kind: "free" };
    const result = forecastSprintBudget(input({ examDate: "2026-10-24", now: new Date(at("2026-10-23", "23:30")),
      tasks: [task(1, { minutes: 60, suggestionKind: "review_cards" }), task(2, { suggestionKind: "review_cards" })],
      days: [day("2026-10-22"), day("2026-10-23", [span]), day("2026-10-24"), day("2026-10-25")] }));
    expect(result.days.map(value => value.date)).toEqual(["2026-10-23"]);
    expect(projected(result)).toEqual([{ taskId: id(2), start: at("2026-10-23", "23:30"), end: at("2026-10-24", "00:00") }]);
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "duration_exceeds_free_slots" }]);
  });

  it("does not combine short slots on adjacent days into one indivisible task", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1, { minutes: 45 }), task(2)],
      days: [day("2026-10-23", [slot("2026-10-23", "23:30", "23:59")]),
        day("2026-10-24", [slot("2026-10-24", "00:00", "00:30")])] }));
    expect(result.scheduledTaskIds).toEqual([id(2)]);
    expect(result.days[0]?.blocks).toEqual([]);
    expect(result.days[1]?.blocks).toHaveLength(1);
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "duration_exceeds_free_slots" }]);
  });

  it("uses Shanghai local now/exam eve rather than the UTC date, with a half-open window end", () => {
    const result = forecastSprintBudget(input({ timeZone: "Asia/Shanghai", examDate: "2026-10-25",
      now: new Date(at("2026-10-23", "16:15")), tasks: [task(1),
        task(2, { suggestionKind: "review_cards" }), retest(3, at("2026-10-24", "16:00"))],
      days: [day("2026-10-23"), day("2026-10-24", [slot("2026-10-23", "16:00", "18:00")]), day("2026-10-25")] }));
    expect(result.days.map(value => value.date)).toEqual(["2026-10-24"]);
    expect(projected(result)).toEqual([{ taskId: id(2), start: at("2026-10-23", "16:15"), end: at("2026-10-23", "16:45") }]);
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "exam_eve_review_only" }]);
    expect(result.deferredTaskIds).toEqual([id(3)]);
  });

  it("resolves a 23-hour DST day before the next-day exam without using a fixed 24-hour end", () => {
    const result = forecastSprintBudget(input({ timeZone: "America/New_York", examDate: "2026-03-09",
      now: new Date(at("2026-03-08", "05:00")), tasks: [task(1, { suggestionKind: "review_cards", minutes: 60 }),
        task(2, { suggestionKind: "review_cards" }), retest(3, at("2026-03-09", "04:00"))],
      days: [day("2026-03-08", [{ start: at("2026-03-09", "03:30"), end: at("2026-03-09", "05:00"), kind: "free" }]), day("2026-03-09")] }));
    expect(projected(result)).toEqual([{ taskId: id(2), start: at("2026-03-09", "03:30"), end: at("2026-03-09", "04:00") }]);
    expect(result.deferredTaskIds).toEqual([id(3)]);
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "duration_exceeds_free_slots" }]);
  });

  it("clips cross-day accepted intervals per day and preserves cross-midnight hard constraints", () => {
    const result = forecastSprintBudget(input({ dailyMinutes: 60, now: new Date(at("2026-10-23", "00:00")),
      tasks: [task(1), task(2), task(10)], days: [day("2026-10-23", [slot("2026-10-23", "23:00", "23:59"),
        { start: at("2026-10-23", "23:45"), end: at("2026-10-24", "01:00"), kind: "sleep" }],
      [{ taskId: id(10), start: at("2026-10-23", "23:30"), end: at("2026-10-24", "00:30"), reason: "跨日已有安排" }]),
      day("2026-10-24", [slot("2026-10-24", "00:00", "02:00")])] }));
    expect(result.days.map(value => value.committedMinutes)).toEqual([30, 30]);
    expect(projected(result)).toEqual([
      { taskId: id(1), start: at("2026-10-23", "23:00"), end: at("2026-10-23", "23:30") },
      { taskId: id(2), start: at("2026-10-24", "01:00"), end: at("2026-10-24", "01:30") },
    ]);
  });

  it("counts the actual 25-hour fall-back day when accepted commitments fill the local day", () => {
    const result = forecastSprintBudget(input({ timeZone: "America/New_York", examDate: "2026-11-03",
      dailyMinutes: 1440, now: new Date(at("2026-11-01", "04:00")), tasks: [task(1), task(10)],
      days: [day("2026-11-01", [{ start: at("2026-11-01", "04:00"), end: at("2026-11-02", "05:00"), kind: "free" }],
        [{ taskId: id(10), start: at("2026-11-01", "04:00"), end: at("2026-11-02", "05:00"), reason: "已有整日安排" }])] }));
    expect(result.days[0]).toMatchObject({ budgetMinutes: 1440, committedMinutes: 1500, plannedMinutes: 0, blocks: [] });
    expect(result.scheduledTaskIds).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("超过每日预算")]);
  });

  it("does not round partial accepted minutes down to admit a task that exceeds the residual budget", () => {
    const result = forecastSprintBudget(input({ tasks: [task(1, { minutes: 31 }), task(2), task(10)],
      days: [day("2026-10-23", undefined, [{ ...accepted(10, "2026-10-23", "09:00", "09:30"),
        end: "2026-10-23T09:29:30.000Z" }])] }));
    expect(result.days[0]).toMatchObject({ committedMinutes: 29.5, plannedMinutes: 30 });
    expect(result.scheduledTaskIds).toEqual([id(2)]);
    expect(result.unscheduled).toEqual([{ taskId: id(1), reason: "daily_budget_exceeded" }]);
  });

  it("still warns about a truncated horizon when every supplied task fits", () => {
    const result = forecastSprintBudget(input({ horizonTruncated: true }));
    expect(result.scheduledTaskIds).toEqual([id(1)]);
    expect(result.unscheduled).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("窗口外任务尚未评估")]);
  });

  it("returns an explicit no-time result for an empty window and no proposals on or after the exam", () => {
    const empty = forecastSprintBudget(input({ days: [] }));
    expect(empty.days).toEqual([]);
    expect(empty.unscheduled).toEqual([{ taskId: id(1), reason: "no_available_time" }]);
    const exam = forecastSprintBudget(input({ examDate: "2026-10-23", days: [day("2026-10-23"), day("2026-10-24")] }));
    expect(exam.days).toEqual([]);
    expect(exam.scheduledTaskIds).toEqual([]);
    expect(exam.unscheduled).toEqual([{ taskId: id(1), reason: "exam_date_reached" }]);
  });

  it("is deterministic under input reordering and does not mutate even frozen inputs", () => {
    const value = input({ tasks: [task(3), task(1), task(2), task(10)],
      days: [day("2026-10-24"), day("2026-10-23", [slot("2026-10-23", "11:00", "12:00"), slot("2026-10-23", "09:00", "11:00")],
        [accepted(10, "2026-10-23", "09:00", "09:30"), accepted(99, "2026-10-23", "10:00", "10:30")])] });
    const before = structuredClone(value);
    deepFreeze(value);
    const first = forecastSprintBudget(value);
    expect(forecastSprintBudget({ ...value, tasks: [...value.tasks].reverse(), days: [...value.days].reverse().map(item => ({
      ...item, blocks: [...item.blocks].reverse(), accepted: [...item.accepted].reverse(),
    })) })).toEqual(first);
    expect(forecastSprintBudget(value)).toEqual(first);
    expect(value).toEqual(before);
  });

  it.each([0, -1, 0.5, NaN, Infinity, 1441])("rejects invalid daily budget %s", dailyMinutes => {
    expect(() => forecastSprintBudget(input({ dailyMinutes }))).toThrow();
  });

  it.each([0, -1, 0.5, NaN, Infinity, 1441])("rejects invalid task duration %s even without days", minutes => {
    expect(() => forecastSprintBudget(input({ tasks: [task(1, { minutes })], days: [] }))).toThrow();
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite task priority %s", priority => {
    expect(() => forecastSprintBudget(input({ tasks: [task(1, { priority })] }))).toThrow();
  });

  it.each(["2026-02-30", "2026-13-01", "23/10/2026", "not-a-date"])("rejects invalid calendar date %s", date => {
    expect(() => forecastSprintBudget(input({ examDate: date }))).toThrow();
    expect(() => forecastSprintBudget(input({ days: [day(date, [])] }))).toThrow();
  });

  it("rejects invalid clock, timezone, duplicate task ids and duplicate days before filtering", () => {
    expect(() => forecastSprintBudget(input({ now: new Date(NaN) }))).toThrow(/now/);
    expect(() => forecastSprintBudget(input({ timeZone: "Not/AZone", days: [] }))).toThrow();
    expect(() => forecastSprintBudget(input({ tasks: [task(1), task(1, { courseId: otherCourseId })] }))).toThrow(/duplicate task/);
    expect(() => forecastSprintBudget(input({ days: [day("2026-10-27"), day("2026-10-27")] }))).toThrow(/duplicate planning day/);
  });

  it("rejects invalid timestamps and nonpositive intervals rather than ignoring bad availability or accepts", () => {
    const badInstant = "2026-02-30T09:00:00.000Z";
    for (const changes of [{ dueAt: badInstant }, { notBefore: "not-a-date" }]) {
      expect(() => forecastSprintBudget(input({ tasks: [task(1, changes)] }))).toThrow();
    }
    expect(() => forecastSprintBudget(input({ tasks: [retest(1, badInstant)] }))).toThrow();
    expect(() => forecastSprintBudget(input({ days: [day("2026-10-23", [{ start: badInstant, end: at("2026-10-23", "10:00"), kind: "free" }])] }))).toThrow();
    expect(() => forecastSprintBudget(input({ days: [day("2026-10-23", [slot("2026-10-23", "09:00", "09:00")])] }))).toThrow();
    expect(() => forecastSprintBudget(input({ days: [day("2026-10-23", [], [accepted(1, "2026-10-23", "10:00", "09:00")])] }))).toThrow();
    expect(() => forecastSprintBudget(input({ days: [day("2026-10-27", [], [{ ...accepted(1, "2026-10-27", "09:00", "10:00"), start: "invalid" }])] }))).toThrow();
  });
});
