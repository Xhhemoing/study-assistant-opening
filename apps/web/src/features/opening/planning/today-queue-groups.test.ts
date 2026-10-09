import { describe, expect, it } from "vitest";
import { groupTodayQueue, type TodayQueueTask } from "./today-queue-groups";
import type { PlannedBlock } from "@aistudy/contracts";

function task(partial: Partial<TodayQueueTask> & Pick<TodayQueueTask, "id" | "title">): TodayQueueTask {
  return {
    minutes: 25,
    dueAt: null,
    priority: 1,
    status: "pending",
    version: 1,
    ...partial,
  };
}

describe("groupTodayQueue", () => {
  const shanghai = "Asia/Shanghai";

  it("places pending tasks from today's accepted blocks into confirmed", () => {
    const blocks: PlannedBlock[] = [
      {
        taskId: "11111111-1111-4111-8111-111111111111",
        start: "2026-10-09T01:00:00.000Z", // 09:00 Shanghai
        end: "2026-10-09T01:25:00.000Z",
        reason: "plan",
      },
    ];
    const tasks = [
      task({ id: "11111111-1111-4111-8111-111111111111", title: "确认中" }),
      task({ id: "22222222-2222-4222-8222-222222222222", title: "其他" }),
    ];
    const now = new Date("2026-10-09T04:00:00.000Z");
    const groups = groupTodayQueue(tasks, blocks, now, shanghai);
    expect(groups.confirmed.map((t) => t.id)).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(groups.other.map((t) => t.id)).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("uses the calendar day in the given time zone for confirmed blocks", () => {
    // Block at 2026-10-08T23:30Z = Oct 9 07:30 Shanghai, Oct 8 16:30 Los Angeles.
    // now at 2026-10-09T10:00Z = Oct 9 Shanghai and Oct 9 Los Angeles.
    const blocks: PlannedBlock[] = [
      {
        taskId: "11111111-1111-4111-8111-111111111111",
        start: "2026-10-08T23:30:00.000Z",
        end: "2026-10-08T23:55:00.000Z",
        reason: "plan",
      },
    ];
    const tasks = [task({ id: "11111111-1111-4111-8111-111111111111", title: "跨日" })];
    const now = new Date("2026-10-09T10:00:00.000Z");
    const inShanghai = groupTodayQueue(tasks, blocks, now, shanghai);
    expect(inShanghai.confirmed).toHaveLength(1);

    const inLa = groupTodayQueue(tasks, blocks, now, "America/Los_Angeles");
    expect(inLa.confirmed).toHaveLength(0);
    expect(inLa.other).toHaveLength(1);
  });

  it("marks overdue when dueAt is before now", () => {
    const tasks = [
      task({
        id: "11111111-1111-4111-8111-111111111111",
        title: "逾期",
        dueAt: "2026-10-08T12:00:00.000Z",
      }),
      task({
        id: "22222222-2222-4222-8222-222222222222",
        title: "未到期",
        dueAt: "2026-10-10T12:00:00.000Z",
      }),
    ];
    const now = new Date("2026-10-09T04:00:00.000Z");
    const groups = groupTodayQueue(tasks, [], now, shanghai);
    expect(groups.overdue.map((t) => t.title)).toEqual(["逾期"]);
    expect(groups.other.map((t) => t.title)).toEqual(["未到期"]);
  });

  it("counts future retests without listing them; due retests enter dueRetests", () => {
    const tasks = [
      task({
        id: "11111111-1111-4111-8111-111111111111",
        title: "到期补测",
        recommendedAt: "2026-10-09T02:00:00.000Z",
      }),
      task({
        id: "22222222-2222-4222-8222-222222222222",
        title: "未来补测",
        recommendedAt: "2026-10-12T02:00:00.000Z",
      }),
    ];
    const now = new Date("2026-10-09T04:00:00.000Z");
    const groups = groupTodayQueue(tasks, [], now, shanghai);
    expect(groups.dueRetests.map((t) => t.title)).toEqual(["到期补测"]);
    expect(groups.upcomingRetestCount).toBe(1);
    expect(groups.other).toHaveLength(0);
    expect(groups.overdue).toHaveLength(0);
  });

  it("puts done/skipped tasks referenced by confirmed blocks into done, not confirmed", () => {
    const blocks: PlannedBlock[] = [
      {
        taskId: "11111111-1111-4111-8111-111111111111",
        start: "2026-10-09T01:00:00.000Z",
        end: "2026-10-09T01:25:00.000Z",
        reason: "plan",
      },
    ];
    const tasks = [
      task({
        id: "11111111-1111-4111-8111-111111111111",
        title: "已完成计划项",
        status: "done",
      }),
      task({
        id: "22222222-2222-4222-8222-222222222222",
        title: "已跳过",
        status: "skipped",
      }),
    ];
    const now = new Date("2026-10-09T04:00:00.000Z");
    const groups = groupTodayQueue(tasks, blocks, now, shanghai);
    expect(groups.confirmed).toHaveLength(0);
    expect(groups.done.map((t) => t.title)).toEqual(["已完成计划项", "已跳过"]);
  });

  it("lets confirmed membership win over overdue and due retest", () => {
    const blocks: PlannedBlock[] = [
      {
        taskId: "11111111-1111-4111-8111-111111111111",
        start: "2026-10-09T01:00:00.000Z",
        end: "2026-10-09T01:25:00.000Z",
        reason: "plan",
      },
    ];
    const tasks = [
      task({
        id: "11111111-1111-4111-8111-111111111111",
        title: "计划内逾期补测",
        dueAt: "2026-10-08T00:00:00.000Z",
        recommendedAt: "2026-10-08T00:00:00.000Z",
      }),
    ];
    const now = new Date("2026-10-09T04:00:00.000Z");
    const groups = groupTodayQueue(tasks, blocks, now, shanghai);
    expect(groups.confirmed).toHaveLength(1);
    expect(groups.dueRetests).toHaveLength(0);
    expect(groups.overdue).toHaveLength(0);
  });

  it("reads recommendedAt from task.retest projection when top-level is absent", () => {
    const tasks = [
      task({
        id: "11111111-1111-4111-8111-111111111111",
        title: "投影到期补测",
        retest: {
          candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          activityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          courseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          skillLabel: "分数",
          prompt: "再做",
          recommendedAt: "2026-10-09T02:00:00.000Z",
        },
      }),
      task({
        id: "22222222-2222-4222-8222-222222222222",
        title: "投影未来补测",
        retest: {
          candidateId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          activityId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          courseId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          skillLabel: "分数",
          prompt: "稍后",
          recommendedAt: "2026-10-12T02:00:00.000Z",
        },
      }),
    ];
    const now = new Date("2026-10-09T04:00:00.000Z");
    const groups = groupTodayQueue(tasks, [], now, shanghai);
    expect(groups.dueRetests.map((t) => t.title)).toEqual(["投影到期补测"]);
    expect(groups.upcomingRetestCount).toBe(1);
  });

});
