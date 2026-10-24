import { randomUUID } from "node:crypto";
import type { PlannedBlock } from "@aistudy/contracts";
import { DEFAULT_OPENING_PLANNING_SETTINGS } from "@aistudy/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSprintBudgetService } from "../../apps/web/src/features/opening/exam-sprint/sprint-budget-runtime";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
const courseId = randomUUID();
const now = "2026-10-23T00:00:00.000Z";
const review = (taskId: string, start: string, end: string): PlannedBlock => ({ taskId, start, end, reason: "已确认" });
beforeAll(async () => {
  f = await createOpeningFixture();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Budget runtime',${courseId})`;
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
  await f.sql`DELETE FROM opening_plan_state WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_hard_blocks WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_tasks WHERE workspace_id=${f.scope.workspaceId}`;
  const settings = { ...DEFAULT_OPENING_PLANNING_SETTINGS, timeZone: "UTC", weekOneMonday: "2026-10-19",
    dailyWindow: { start: "00:00", end: "05:00" }, sleep: { start: "06:00", end: "08:00" } };
  const prefs = { autonomy: "copilot", coachBudgetMinutes: 60, courseGoals: { [courseId]: { targetDate: "2026-12-01", weeklyMinutes: 420 } } };
  await f.sql`INSERT INTO workspace_preferences(workspace_id,planning_settings,adaptive_planning)
    VALUES(${f.scope.workspaceId},${JSON.stringify(settings)}::text::jsonb,${JSON.stringify(prefs)}::text::jsonb)
    ON CONFLICT(workspace_id) DO UPDATE SET planning_settings=EXCLUDED.planning_settings,adaptive_planning=EXCLUDED.adaptive_planning`;
});
afterAll(async () => { vi.useRealTimers(); await f?.close(); });
async function task() {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,course_id,title,minutes,status,origin)
    VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},'积分复习',30,'pending','course_seed')`;
  return id;
}
async function accept(day: string, blocks: PlannedBlock[]) {
  await f.sql`INSERT INTO opening_plan_state(workspace_id,day,accepted_blocks,accepted_version,hard_blocks_fingerprint)
    VALUES(${f.scope.workspaceId},${day}::date,${JSON.stringify(blocks)}::text::jsonb,1,'saved')`;
}
async function snapshot() {
  return f.sql`SELECT jsonb_build_object(
    'plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY day) FROM opening_plan_state p WHERE workspace_id=${f.scope.workspaceId}),
    'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM opening_tasks t WHERE workspace_id=${f.scope.workspaceId}),
    'preferences',(SELECT to_jsonb(p) FROM workspace_preferences p WHERE workspace_id=${f.scope.workspaceId}),
    'drafts',(SELECT count(*) FROM opening_plan_drafts WHERE workspace_id=${f.scope.workspaceId})) AS state`;
}

describe("budget runtime with real isolated repositories", () => {
  it("reads crossing occupancy, keeps later accepts, ignores stale derived rows and changes no learning state", async () => {
    const crossing = await task(), later = await task(), carry = await task();
    await accept("2026-10-22", [review(crossing, "2026-10-22T23:30:00.000Z", "2026-10-23T00:30:00.000Z"),
      review(carry, "2026-10-22T18:00:00.000Z", "2026-10-22T18:30:00.000Z")]);
    await accept("2026-11-25", [review(later, "2026-11-25T00:00:00.000Z", "2026-11-25T00:30:00.000Z")]);
    for (const kind of ["class", "sleep", "meal", "locked"]) {
      const end = kind === "locked" ? "2026-10-23T01:00:00.000Z" : "2026-10-23T05:00:00.000Z";
      await f.sql`INSERT INTO opening_hard_blocks(id,workspace_id,owner_user_id,day,start_at,end_at,kind)
        VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'2026-10-22'::date,
          '2026-10-22T23:00:00Z'::timestamptz,${end}::timestamptz,${kind})`;
    }
    const before = await snapshot();
    const result = await getSprintBudgetService(f.sql).read(f.scope, courseId.toUpperCase());
    expect(result).toMatchObject({ status: "ready", courseId, horizonTruncated: true, scheduledTaskIds: [carry] });
    expect(result.days).toHaveLength(28);
    expect(result.days[0]).toMatchObject({ date: "2026-10-23", committedMinutes: 30, plannedMinutes: 30 });
    expect(result.days[0]?.blocks[0]).toMatchObject({ taskId: carry, start: "2026-10-23T01:00:00.000Z" });
    expect(result.unscheduled).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects another owner's scope and archived courses through the actual factory", async () => {
    await expect(getSprintBudgetService(f.sql).read(f.otherScope, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getSprintBudgetService(f.sql).read({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
    try { await expect(getSprintBudgetService(f.sql).read(f.scope, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" }); }
    finally { await f.sql`UPDATE courses SET archived_at=NULL WHERE id=${courseId}`; }
  });
});
