import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { PlannedBlock, Scope, TimeBlock } from "@aistudy/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readOpeningSprintBudgetConstraints } from "../../packages/database/src/repositories/opening-sprint-budget";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

// Uses the integration project's opening-test-db globalSetup and the fixture's
// loopback/test-name guard. No alternate connection or automatic skipped tests.
let f: OpeningFixture;
const courseId = randomUUID(), otherCourseId = randomUUID();
const input = { windowStart: "2026-10-23T00:00:00.000Z", windowEnd: "2026-10-25T00:00:00.000Z", now: "2026-10-23T10:00:00.000Z", taskIds: [] as string[] };
const planned = (taskId: string, start: string, end: string): PlannedBlock => ({ taskId, start, end, reason: "Already accepted" });
const sample = () => planned(randomUUID(), "2026-10-23T11:00:00.000Z", "2026-10-23T11:30:00.000Z");
const workspaceIds = () => [f.scope.workspaceId, f.otherScope.workspaceId];

beforeAll(async () => {
  f = await createOpeningFixture();
  for (const id of [courseId, otherCourseId]) {
    await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${f.scope.workspaceId},'Budget fixture',${id})`;
  }
});
beforeEach(async () => {
  await f.sql`DELETE FROM opening_plan_state WHERE workspace_id=ANY(${workspaceIds()}::uuid[])`;
  await f.sql`DELETE FROM opening_hard_blocks WHERE workspace_id=ANY(${workspaceIds()}::uuid[])`;
  await f.sql`DELETE FROM opening_tasks WHERE workspace_id=ANY(${workspaceIds()}::uuid[])`;
});
afterAll(async () => { await f?.close(); });

async function task(course = courseId, status: "pending" | "done" = "pending") {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,course_id,title,minutes,status)
    VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},${course},'Budget task',30,${status})`;
  return id;
}
async function seedPlan(day: string, blocks: unknown, scope: Scope = f.scope) {
  await f.sql`INSERT INTO opening_plan_state(workspace_id,day,accepted_version,accepted_blocks,hard_blocks_fingerprint)
    VALUES(${scope.workspaceId},${day}::date,7,${JSON.stringify(blocks)}::text::jsonb,'unchanged-fingerprint')`;
}
async function seedHard(block: TimeBlock, scope: Scope = f.scope, day = "2026-10-22", source = "user") {
  await f.sql`INSERT INTO opening_hard_blocks(id,workspace_id,owner_user_id,day,start_at,end_at,kind,source)
    VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${day}::date,${block.start},${block.end},${block.kind},${source})`;
}
async function snapshot() {
  const ids = workspaceIds();
  return f.sql`SELECT table_name,record FROM (
    SELECT 'state' AS table_name,to_jsonb(p) AS record FROM opening_plan_state p WHERE workspace_id=ANY(${ids}::uuid[])
    UNION ALL SELECT 'hard',to_jsonb(h) FROM opening_hard_blocks h WHERE workspace_id=ANY(${ids}::uuid[])
    UNION ALL SELECT 'tasks',to_jsonb(t) FROM opening_tasks t WHERE workspace_id=ANY(${ids}::uuid[])
    UNION ALL SELECT 'drafts',to_jsonb(d) FROM opening_plan_drafts d WHERE workspace_id=ANY(${ids}::uuid[])
    UNION ALL SELECT 'acceptances',to_jsonb(a) FROM opening_plan_acceptances a WHERE workspace_id=ANY(${ids}::uuid[])
    UNION ALL SELECT 'preferences',to_jsonb(p) FROM workspace_preferences p WHERE workspace_id=ANY(${ids}::uuid[])
    UNION ALL SELECT 'workspace',to_jsonb(w) FROM workspaces w WHERE id=ANY(${ids}::uuid[])
  ) snapshots ORDER BY table_name,record::text`;
}

describe("opening sprint budget constraints against guarded PostgreSQL", () => {
  it("reads all-course elapsed/cross-midnight occupancy and day-29 pending accepts, not historical carry or stale derivations, without writes", async () => {
    const futureId = await task(), carryId = await task(), elapsedId = await task(courseId, "done");
    const crossId = await task(otherCourseId), otherId = await task(otherCourseId);
    const cross = planned(crossId, "2026-10-22T23:30:00.000Z", "2026-10-23T00:30:00.000Z");
    const elapsed = planned(elapsedId, "2026-10-23T08:00:00.000Z", "2026-10-23T08:30:00.000Z");
    const other = planned(otherId, "2026-10-24T09:00:00.000Z", "2026-10-24T09:30:00.000Z");
    const far = planned(futureId.toUpperCase(), "2026-11-21T09:00:00.000Z", "2026-11-21T09:30:00.000Z");
    await seedPlan("2026-10-22", [cross,
      planned(carryId, "2026-10-22T18:00:00.000Z", "2026-10-22T18:30:00.000Z"),
      planned(randomUUID(), "2026-10-22T23:00:00.000Z", input.windowStart)]);
    await seedPlan("2026-10-23", [elapsed]);
    await seedPlan("2026-10-24", [other]);
    await seedPlan("2026-10-25", [planned(randomUUID(), input.windowEnd, "2026-10-25T00:30:00.000Z")]);
    await seedPlan("2026-11-21", [far, planned(otherId, "2026-11-21T10:00:00.000Z", "2026-11-21T10:30:00.000Z")]);
    const crossingLock: TimeBlock = { start: "2026-10-22T23:45:00.000Z", end: "2026-10-23T00:15:00.000Z", kind: "locked" };
    const innerLock: TimeBlock = { start: "2026-10-24T14:00:00.000Z", end: "2026-10-24T15:00:00.000Z", kind: "locked" };
    await seedHard(crossingLock);
    // A mismatching stored day must not hide an absolute-time lock either.
    await seedHard(innerLock, f.scope, "2026-10-01");
    await seedHard({ start: "2026-10-22T23:00:00.000Z", end: input.windowStart, kind: "locked" });
    await seedHard({ start: input.windowEnd, end: "2026-10-25T01:00:00.000Z", kind: "locked" });
    for (const kind of ["class", "sleep", "meal"] as const) {
      await seedHard({ start: "2026-10-23T12:00:00.000Z", end: "2026-10-23T13:00:00.000Z", kind }, f.scope, "2026-10-23", "derived");
    }

    const before = await snapshot();
    const result = await f.sql.begin("isolation level repeatable read read only", async tx => {
      const [writesBefore] = await tx`SELECT COALESCE(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::int AS writes FROM pg_stat_xact_user_tables`;
      const constraints = await readOpeningSprintBudgetConstraints(tx as unknown as Sql, f.scope, { ...input, taskIds: [futureId, carryId] });
      const [state] = await tx`SELECT current_setting('transaction_read_only') AS read_only,
        (SELECT COALESCE(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::int FROM pg_stat_xact_user_tables) AS writes`;
      expect(state?.read_only).toBe("on");
      expect(state?.writes).toBe(writesBefore?.writes);
      return constraints;
    });
    expect(result.accepted).toHaveLength(4);
    expect(result.accepted).toEqual(expect.arrayContaining([cross, elapsed, other, { ...far, taskId: futureId }]));
    expect(result.locked).toEqual([crossingLock, innerLock]);
    expect(result.accepted.some(block => block.taskId === carryId)).toBe(false);
    const [carry] = await f.sql`SELECT status,version FROM opening_tasks WHERE id=${carryId}`;
    expect(carry).toMatchObject({ status: "pending", version: 1 });
    expect(await snapshot()).toEqual(before);
  });

  it("uses strict end > now outside the window, with no future upper bound", async () => {
    const ended = await task(), ongoing = await task(), distant = await task();
    const ongoingBlock = planned(ongoing, "2026-10-23T09:00:00.000Z", "2026-10-23T10:01:00.000Z");
    const distantBlock = planned(distant, "2027-10-23T09:00:00.000Z", "2027-10-23T09:30:00.000Z");
    await seedPlan("2026-10-23", [planned(ended, "2026-10-23T09:30:00.000Z", input.now), ongoingBlock]);
    await seedPlan("2027-10-23", [distantBlock]);
    expect(await readOpeningSprintBudgetConstraints(f.sql, f.scope, {
      ...input, windowStart: "2026-10-24T00:00:00.000Z", taskIds: [ended, ongoing, distant],
    })).toEqual({ accepted: [ongoingBlock, distantBlock], locked: [] });
  });

  it("isolates workspaces and owners, including rows with a mismatched hard-block owner", async () => {
    const own = sample(), foreign = sample();
    const lock: TimeBlock = { start: own.start, end: own.end, kind: "locked" };
    const rogue: TimeBlock = { ...lock, start: "2026-10-23T12:00:00.000Z", end: "2026-10-23T12:30:00.000Z" };
    await seedPlan("2026-10-23", [own]);
    await seedPlan("2026-10-23", [foreign], f.otherScope);
    await seedHard(lock);
    await seedHard(lock, f.otherScope);
    const wrongOwner = { ...f.scope, ownerUserId: f.otherScope.ownerUserId };
    const wrongWorkspace = { ...f.otherScope, ownerUserId: f.scope.ownerUserId };
    await seedHard(rogue, wrongOwner);
    await seedHard(rogue, wrongWorkspace);
    expect(await readOpeningSprintBudgetConstraints(f.sql, f.scope, input)).toEqual({ accepted: [own], locked: [lock] });
    expect(await readOpeningSprintBudgetConstraints(f.sql, f.otherScope, input)).toEqual({ accepted: [foreign], locked: [lock] });
    for (const scope of [wrongOwner, wrongWorkspace]) {
      expect(await readOpeningSprintBudgetConstraints(f.sql, scope, input)).toEqual({ accepted: [], locked: [] });
    }
  });

  it("does not initialize missing state, drafts, preferences, tasks or locks", async () => {
    const before = await snapshot();
    expect(await readOpeningSprintBudgetConstraints(f.sql, f.scope, input)).toEqual({ accepted: [], locked: [] });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["non-array JSON", { invalid: true }],
    ["JSON null", null],
    ["invalid element", [null]],
    ["missing time", [{ taskId: randomUUID(), end: "2026-10-01T10:00:00.000Z", reason: "Bad" }]],
    ["invalid time", [{ ...sample(), start: "not-a-time" }]],
    ["zero interval outside window", [planned(randomUUID(), "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z")]],
    ["reversed interval outside window", [planned(randomUUID(), "2026-10-01T10:00:00.000Z", "2026-10-01T09:00:00.000Z")]],
    ["infinite time outside window", [{ ...sample(), start: "-infinity", end: "2026-10-01T09:00:00.000Z" }]],
    ["invalid identity", [{ ...sample(), taskId: "bad-id" }]],
  ])("fails closed for %s instead of filtering corrupt accepted data away", async (_name, raw) => {
    await seedPlan("2026-10-01", raw);
    const before = await snapshot();
    await expect(readOpeningSprintBudgetConstraints(f.sql, f.scope, input)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("rejects PostgreSQL infinite locks even outside the requested window", async () => {
    await f.sql`INSERT INTO opening_hard_blocks(id,workspace_id,owner_user_id,day,start_at,end_at,kind)
      VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'2026-10-01'::date,
        '-infinity'::timestamptz,'2026-10-01T09:00:00Z'::timestamptz,'locked')`;
    await expect(readOpeningSprintBudgetConstraints(f.sql, f.scope, input)).rejects.toThrow();
  });

  it.each(["accepted", "locked"] as const)("reports overflow rather than silently truncating real %s rows", async kind => {
    const block = sample();
    if (kind === "accepted") {
      await seedPlan("2026-10-23", Array.from({ length: 4001 }, () => block));
    } else {
      await f.sql`INSERT INTO opening_hard_blocks(id,workspace_id,owner_user_id,day,start_at,end_at,kind)
        SELECT gen_random_uuid(),${f.scope.workspaceId}::uuid,${f.scope.ownerUserId}::uuid,'2026-10-23'::date,
          ${block.start}::timestamptz,${block.end}::timestamptz,'locked' FROM generate_series(1,4001)`;
    }
    await expect(readOpeningSprintBudgetConstraints(f.sql, f.scope, input)).rejects.toThrow(`sprint budget ${kind} constraints exceed 4000`);
  });
});
