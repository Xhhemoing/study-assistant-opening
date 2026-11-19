import type { Sql, TransactionSql } from "postgres";
import { expect, it } from "vitest";
import { proposeOpeningLocalPlan } from "./opening-local-replan";
import { validateOpeningLocalReplan } from "./opening-local-replan-validation";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(90), ownerUserId: id(91) }, day = "2026-10-17";
const at = (time: string) => `${day}T${time}:00.000Z`;
const baseline = [{ taskId: id(2), start: at("08:00"), end: at("08:30"), reason: "Confirmed" }];
const free = [{ start: at("09:00"), end: at("11:00"), kind: "free" as const }];
const now = new Date("2026-10-16T01:00:00Z");
function fixture() {
  let stored: Record<string, unknown> | undefined;
  let hard: Array<{ start_at: string; end_at: string; kind: string }> = [];
  const tasks = [1, 2].map(n => ({ id: id(n), version: 1, status: "pending", title: "Task", minutes: 30, due_at: null, not_before: null, priority: 1, origin: "manual" }));
  const db = Object.assign((parts: TemplateStringsArray, ...values: unknown[]) => {
    if (!parts.raw) return {};
    const query = parts.join("?");
    if (query.includes("INSERT INTO opening_plan_drafts")) {
      stored = { id: values[0], day, version: 0, base_version: 1, status: "draft", blocks: values[5],
        unscheduled_task_ids: values[6], input_snapshot: values[7], hard_blocks_fingerprint: values[8], origin: "user", suggested_tasks: [], strategy_version: "local-replan-v1" };
      return Promise.resolve([stored]);
    }
    if (query.includes("FROM opening_plan_drafts")) return Promise.resolve([]);
    if (query.includes("FROM opening_plan_state")) return Promise.resolve([{ accepted_version: 1, accepted_blocks: baseline }]);
    if (query.includes("planning_settings")) return Promise.resolve([{ planning_settings: null }]);
    if (query.includes("FROM opening_tasks")) return Promise.resolve(tasks);
    if (query.includes("FROM opening_hard_blocks")) return Promise.resolve(hard);
    if (query.includes("FROM opening_teaching_activities")) return Promise.resolve([]);
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId }]);
    if (query.includes("opening_workspace_history_revisions") || query.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    throw new Error(`Unexpected SQL: ${query}`);
  }, { json: (value: unknown) => value, begin: async (run: (tx: TransactionSql) => unknown) => run(db as unknown as TransactionSql) });
  return { sql: db as unknown as Sql, tx: db as unknown as TransactionSql, row: () => stored!, setHard: (value: typeof hard) => { hard = value; } };
}
it("keeps future accepted blocks and schedules only internal delta tasks in explicit windows without saved settings", async () => {
  const f = fixture();
  const result = await proposeOpeningLocalPlan(f.sql, scope, { date: day, expectedAcceptedVersion: 1, clientKey: "future-delta" },
    { now, allowOtherDay: true, taskIds: [id(1)], free });
  expect(result.kind).toBe("draft"); if (result.kind !== "draft") return;
  expect(result.draft.blocks).toEqual([...baseline, expect.objectContaining({ taskId: id(1), start: at("09:00"), end: at("09:30") })]);
  await expect(validateOpeningLocalReplan(f.tx, scope, { day, state: { accepted_version: 1, accepted_blocks: baseline },
    draft: f.row(), blocks: result.draft.blocks, now })).resolves.toBeUndefined();
  f.setHard([{ start_at: at("09:00"), end_at: at("09:30"), kind: "locked" }]);
  await expect(validateOpeningLocalReplan(f.tx, scope, { day, state: { accepted_version: 1, accepted_blocks: baseline },
    draft: f.row(), blocks: result.draft.blocks, now })).rejects.toMatchObject({ code: "CONFLICT" });
});
it("keeps the public option defaults closed without saved settings and validates internal window duration", async () => {
  const f = fixture(), input = { date: day, expectedAcceptedVersion: 1, clientKey: "public-closed" };
  await expect(proposeOpeningLocalPlan(f.sql, scope, input, { now })).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(proposeOpeningLocalPlan(f.sql, scope, input, { now, allowOtherDay: true,
    free: [{ start: at("10:00"), end: at("09:00"), kind: "free" }] })).rejects.toThrow();
});

it("preserves a same-day futureFixed retest reservation, releases it on user deferral, and rejects accept if cancelled after proposal", async () => {
  const friday = "2026-10-16";
  const fridayNow = new Date("2026-10-16T19:00:00.000Z");
  const reservedBlock = {
    taskId: id(20),
    start: "2026-10-16T19:15:00.000Z",
    end: "2026-10-16T19:40:00.000Z",
    reason: "Confirmed retest",
  };
  const extraTaskRow = {
    id: id(21),
    workspace_id: scope.workspaceId,
    owner_user_id: scope.ownerUserId,
    version: 1,
    status: "pending",
    title: "Extra task",
    minutes: 30,
    due_at: null,
    not_before: null,
    priority: 1,
    origin: "manual",
  };
  let retestRow: Record<string, unknown> = {
    id: id(20),
    workspace_id: scope.workspaceId,
    owner_user_id: scope.ownerUserId,
    version: 1,
    status: "pending",
    title: "Delayed retest",
    minutes: 25,
    due_at: "2026-10-26T19:00:00.000Z",
    not_before: "2026-10-15T19:00:00.000Z",
    priority: 1,
    origin: "retest",
    course_id: id(30),
    candidate_id: id(31),
    retest_activity_id: id(32),
    retest_workspace_id: scope.workspaceId,
    retest_owner_user_id: scope.ownerUserId,
    retest_task_id: id(20),
    retest_course_id: id(30),
    retest_purpose: "retest",
    retest_status: "accepted",
    retest_candidate_id: id(31),
    retest_skill_label: "矩阵秩",
    retest_prompt: "延迟复测",
    retest_not_before_at: "2026-10-15T19:00:00.000Z",
    retest_recommended_at: "2026-10-15T19:00:00.000Z",
    retest_scheduled_start_at: "2026-10-16T19:15:00.000Z",
    retest_snoozed_until: null,
    retest_deadline_at: "2026-10-26T19:00:00.000Z",
  };
  let storedDraft: Record<string, unknown> | undefined;
  const db = Object.assign((parts: TemplateStringsArray, ...values: unknown[]) => {
    if (!parts.raw) return {};
    const query = parts.join("?");
    if (query.includes("INSERT INTO opening_plan_drafts")) {
      storedDraft = {
        id: values[0],
        day: friday,
        version: 0,
        base_version: 1,
        status: "draft",
        blocks: values[5],
        unscheduled_task_ids: values[6],
        input_snapshot: values[7],
        hard_blocks_fingerprint: values[8],
        origin: "user",
        suggested_tasks: [],
        strategy_version: "local-replan-v1",
      };
      return Promise.resolve([storedDraft]);
    }
    if (query.includes("FROM opening_plan_drafts")) return Promise.resolve([]);
    if (query.includes("FROM opening_plan_state")) {
      return Promise.resolve([{ accepted_version: 1, accepted_blocks: [reservedBlock] }]);
    }
    if (query.includes("planning_settings")) {
      return Promise.resolve([{
        planning_settings: {
          weekOneMonday: "2026-09-07",
          periodTimes: {},
          dailyWindow: { start: "19:00", end: "21:00" },
          lunch: { start: "12:00", end: "13:00" },
          dinner: { start: "18:00", end: "19:00" },
          sleep: { start: "23:00", end: "07:00" },
          timeZone: "UTC",
        },
      }]);
    }
    if (query.includes("FROM opening_tasks")) {
      return Promise.resolve([retestRow, extraTaskRow]);
    }
    if (query.includes("FROM opening_hard_blocks")
      || query.includes("FROM opening_timetable_sessions")
      || query.includes("FROM opening_teaching_activities")) return Promise.resolve([]);
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId }]);
    if (query.includes("opening_workspace_history_revisions") || query.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    throw new Error(`Unexpected SQL: ${query}`);
  }, {
    json: (value: unknown) => value,
    begin: async (run: (tx: TransactionSql) => unknown) => run(db as unknown as TransactionSql),
  });

  // 1) At 19:00, accepted 19:15-19:40 reservation stays in futureFixed and validates cleanly.
  const kept = await proposeOpeningLocalPlan(
    db as unknown as Sql,
    scope,
    { date: friday, expectedAcceptedVersion: 1, clientKey: "keep-future-retest" },
    { now: fridayNow },
  );
  expect(kept.kind).toBe("draft");
  if (kept.kind !== "draft") return;
  expect(kept.draft.blocks).toEqual(expect.arrayContaining([reservedBlock]));
  await expect(validateOpeningLocalReplan(db as unknown as TransactionSql, scope, {
    day: friday,
    state: { accepted_version: 1, accepted_blocks: [reservedBlock] },
    draft: storedDraft!,
    blocks: kept.draft.blocks,
    now: fridayNow,
  })).resolves.toBeUndefined();

  // 2) Cancel the retest activity after proposal -> validation MUST fail on futureFixed.
  retestRow = { ...retestRow, retest_status: "cancelled" };
  await expect(validateOpeningLocalReplan(db as unknown as TransactionSql, scope, {
    day: friday,
    state: { accepted_version: 1, accepted_blocks: [reservedBlock] },
    draft: storedDraft!,
    blocks: kept.draft.blocks,
    now: fridayNow,
  })).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });

  // 3) Active retest deferred to 20:00 (> 19:15) -> local replan releases 19:15-19:40 block.
  retestRow = { ...retestRow, retest_status: "accepted", version: 2, not_before: "2026-10-16T20:00:00.000Z" };
  const released = await proposeOpeningLocalPlan(
    db as unknown as Sql,
    scope,
    { date: friday, expectedAcceptedVersion: 1, clientKey: "release-deferred-retest" },
    { now: fridayNow },
  );
  expect(released.kind).toBe("draft");
  if (released.kind !== "draft") return;
  expect(released.draft.blocks.some(b => b.taskId === id(20))).toBe(false);
  expect(released.draft.blocks.some(b => b.taskId === id(21))).toBe(true);
});
