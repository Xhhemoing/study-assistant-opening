import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createOpeningPlanningSettingsRepository } from "@aistudy/database";
import type { OpeningPlanningSettings, TaskItem } from "@aistudy/contracts";
import { localDateKeyInZone, zonedLocalInstant } from "@aistudy/domain";
import { createOpeningPlanService } from "../../../apps/web/src/features/opening/planning/plan-service";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";

/**
 * PR-B cross-midnight e2e on a real Postgres: today queue -> timetable -> auto draft
 * -> retest -> tomorrow, with the request clock injected (one `now` per request) and
 * the workspace zone Asia/Shanghai. No +8h arithmetic; instants come from wall clocks.
 */
const SH = "Asia/Shanghai";
const at = (local: string) => zonedLocalInstant(local, SH);
const settings: OpeningPlanningSettings = {
  weekOneMonday: "2026-09-07",
  periodTimes: { "1": { start: "08:00", end: "08:45" }, "2": { start: "08:55", end: "09:40" } },
  dailyWindow: { start: "07:30", end: "22:30" },
  lunch: { start: "12:00", end: "13:00" },
  dinner: { start: "17:30", end: "18:30" },
  sleep: { start: "23:00", end: "07:00" },
  timeZone: SH,
};
let f: OpeningFixture;

beforeAll(async () => { f = await createOpeningFixture(); await applyMigrations(f.sql); });
beforeEach(async () => {
  await f.sql`TRUNCATE opening_plan_acceptances, opening_plan_drafts, opening_plan_state, opening_hard_blocks, opening_timetable_sessions, opening_retest_activities, opening_tasks RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await f?.close(); });

const service = (now: Date) => createOpeningPlanService(f.sql, { now: () => now });

async function seedRetestTask(title: string, recommendedAt: Date): Promise<string> {
  const created = await service(new Date()).createTask(f.scope, { title, minutes: 30, dueAt: null, priority: 1, candidateId: null });
  const taskId = (created as { task?: TaskItem; id?: string }).task?.id ?? (created as { id: string }).id;
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses (id, workspace_id, title, slug) VALUES (${courseId}, ${f.scope.workspaceId}, 'PR-B course', ${courseId})`;
  const candidateId = randomUUID();
  await f.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state)
    VALUES (${candidateId}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, ${`retest:${candidateId}`}, ${"retest"},
      ${f.sql.json({ kind: "task", id: candidateId, courseId, skillLabel: title, prompt: title, sourceIds: [], dueAt: null, accepted: true } as never)}, ${"succeeded"})`;
  await f.sql`INSERT INTO opening_retest_activities (id, workspace_id, owner_user_id, course_id, skill_label, evidence_cycle_id,
      candidate_id, task_id, status, accepted_at, not_before_at, recommended_at)
    VALUES (${randomUUID()}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, ${courseId}, ${title}, ${randomUUID()},
      ${candidateId}, ${taskId}, 'accepted', now(), ${recommendedAt}, ${recommendedAt})`;
  return taskId;
}

async function seedTask(title: string): Promise<string> {
  const created = await service(new Date()).createTask(f.scope, { title, minutes: 30, dueAt: null, priority: 1, candidateId: null });
  return (created as { task?: TaskItem; id?: string }).task?.id ?? (created as { id: string }).id;
}

describe("PR-B cross-midnight e2e (real PG)", () => {
  it("today queue -> timetable -> draft -> retest -> tomorrow", async () => {
    await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, settings);
    // Timetable: Tuesday (2026-10-13 is week 6, weekday 2) periods 1-2 = 08:00-09:40 hard block.
    await service(new Date()).saveTimetable(f.scope, [{ courseName: "Math", weekday: 2, weeks: [6, 7], startPeriod: 1, endPeriod: 2 }]);
    const plain = await seedTask("plain");
    const retestToday = await seedRetestTask("retest-1600", at("2026-10-13T16:00"));
    const retestTomorrow = await seedRetestTask("retest-next-0700", at("2026-10-14T07:00"));

    // 00:30 Shanghai = 2026-10-12T16:30Z: the UTC date is still the 12th; business day is the 13th.
    const now = at("2026-10-13T00:30");
    expect(now.toISOString()).toBe("2026-10-12T16:30:00.000Z");
    const today = localDateKeyInZone(now, SH);
    expect(today).toBe("2026-10-13");

    const plan = await service(now).getToday(f.scope, today);
    expect(plan.hardBlocks.some((b) => b.start === at("2026-10-13T08:00").toISOString())).toBe(true);
    const blocks = plan.dailyDraft!.blocks;
    const byTask = Object.fromEntries(blocks.map((b) => [b.taskId, b]));
    expect(byTask[plain]).toBeDefined();
    expect(Date.parse(byTask[retestToday]!.start)).toBeGreaterThanOrEqual(at("2026-10-13T16:00").getTime());
    expect(byTask[retestTomorrow]).toBeUndefined();
    for (const b of blocks) {
      // Nothing overlaps the timetable block.
      expect(Date.parse(b.end) <= at("2026-10-13T08:00").getTime() || Date.parse(b.start) >= at("2026-10-13T09:40").getTime()).toBe(true);
    }

    // Tomorrow (00:30 on the 14th): the 07:00 retest now belongs to the day and is planned >= 07:30 window.
    const tomorrowNow = at("2026-10-14T00:30");
    const tomorrow = localDateKeyInZone(tomorrowNow, SH);
    expect(tomorrow).toBe("2026-10-14");
    const next = await service(tomorrowNow).getToday(f.scope, tomorrow);
    const nextBlock = next.dailyDraft!.blocks.find((b) => b.taskId === retestTomorrow);
    expect(nextBlock).toBeDefined();
    expect(Date.parse(nextBlock!.start)).toBeGreaterThanOrEqual(at("2026-10-14T07:30").getTime());
  });

  it("morning-only free time: 16:00 retest stays unscheduled with an explicit reason", async () => {
    await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, settings);
    const retest = await seedRetestTask("retest-1600", at("2026-10-13T16:00"));
    const draft = await service(at("2026-10-13T00:30")).proposePlan(f.scope, {
      date: "2026-10-13",
      free: [{ start: at("2026-10-13T10:00").toISOString(), end: at("2026-10-13T11:30").toISOString(), kind: "free" }],
      clientKey: `prb-morning-${randomUUID()}`,
    });
    expect(draft.blocks.find((b) => b.taskId === retest)).toBeUndefined();
    expect(draft.unscheduledTaskIds).toContain(retest);
    expect(draft.unscheduled).toContainEqual({ taskId: retest, reason: "no_compliant_slot_after_not_before" });
  });

  it("choosing an afternoon window schedules the retest there and keeps the morning gap for other work", async () => {
    await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, settings);
    const plain = await seedTask("plain");
    const retest = await seedRetestTask("retest-1600", at("2026-10-13T16:00"));
    const morning = { start: at("2026-10-13T10:00").toISOString(), end: at("2026-10-13T11:30").toISOString(), kind: "free" as const };
    const afternoon = { start: at("2026-10-13T16:00").toISOString(), end: at("2026-10-13T17:00").toISOString(), kind: "free" as const };
    const draft = await service(at("2026-10-13T00:30")).proposePlan(f.scope, { date: "2026-10-13", free: [morning, afternoon], clientKey: `prb-pm-${randomUUID()}` });
    const r = draft.blocks.find((b) => b.taskId === retest)!;
    const p = draft.blocks.find((b) => b.taskId === plain)!;
    expect(r.start).toBe(afternoon.start);
    expect(Date.parse(p.start)).toBeGreaterThanOrEqual(Date.parse(morning.start));
    expect(Date.parse(p.end)).toBeLessThanOrEqual(Date.parse(morning.end));
    expect(draft.unscheduled).toEqual([]);
  });
});
