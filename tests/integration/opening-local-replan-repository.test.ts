import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository, createOpeningPlanningSettingsRepository, createOpeningRetestActivityRepository, proposeOpeningLocalPlan } from "@aistudy/database";
import type { PlannedBlock } from "@aistudy/contracts";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { createOpeningPlanService } from "../../apps/web/src/features/opening/planning/plan-service";
let f: OpeningFixture;
const date = "2026-10-16", at = (clock: string) => `${date}T${clock}:00.000Z`, now = new Date(at("10:00"));
const settings = { weekOneMonday: "2026-09-07", periodTimes: {}, dailyWindow: { start: "08:00", end: "18:00" },
  lunch: { start: "12:00", end: "13:00" }, dinner: { start: "18:00", end: "19:00" }, sleep: { start: "23:00", end: "07:00" }, timeZone: "UTC" };
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.sql`DELETE FROM opening_plan_acceptances WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_plan_drafts WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_plan_state WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_retest_activities WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_tasks WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_hard_blocks WHERE workspace_id=${f.scope.workspaceId}`;
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, settings);
});
afterAll(async () => { await f?.close(); });
async function task() { return createOpeningPlansRepository(f.sql).createTask(f.scope, { title: "本地任务", minutes: 30, dueAt: null, priority: 1, candidateId: null }); }
async function seed(blocks: PlannedBlock[]) {
  await f.sql`INSERT INTO opening_plan_state(workspace_id, day, accepted_version, accepted_blocks, hard_blocks_fingerprint)
    VALUES(${f.scope.workspaceId}, ${date}::date, 1, ${f.sql.json(blocks)}, 'prior-constraints')`;
}
const block = (taskId: string, start: string, end: string): PlannedBlock => ({ taskId, start: at(start), end: at(end), reason: "用户已确认" });
async function propose() {
  const result = await proposeOpeningLocalPlan(f.sql, f.scope, { date, expectedAcceptedVersion: 1, clientKey: randomUUID() }, { now });
  expect(result.kind).toBe("draft");
  if (result.kind !== "draft") throw new Error("fixture must produce a draft");
  return result.draft;
}
it("preserves accepted history/future work, confirms separately and replays without incrementing twice", async () => {
  const a = await task(), b = await task();
  const baseline = [block(a.id, "09:00", "09:30"), block(b.id, "11:00", "11:30")]; await seed(baseline);
  const input = { date, expectedAcceptedVersion: 1, clientKey: randomUUID() };
  const first = await proposeOpeningLocalPlan(f.sql, f.scope, input, { now });
  expect(first.kind).toBe("draft"); if (first.kind !== "draft") return;
  expect(first.draft.blocks).toEqual(expect.arrayContaining(baseline));
  expect((await createOpeningPlansRepository(f.sql).getToday(f.scope, date))?.blocks).toEqual(baseline);
  expect(await proposeOpeningLocalPlan(f.sql, f.scope, input, { now })).toEqual(first);
  const plans = createOpeningPlansRepository(f.sql, { now: () => now });
  const accept = { draftId: first.draft.id, expectedBaseVersion: 1, clientKey: randomUUID() };
  expect(await plans.acceptPlan(f.scope, accept)).toMatchObject({ status: "accepted", version: 2 });
  expect(await plans.acceptPlan(f.scope, accept)).toMatchObject({ version: 2 });
  expect((await plans.getToday(f.scope, date))?.blocks).toEqual(first.draft.blocks);
});
it("rejects a new hard lock added after proposal without changing accepted blocks", async () => {
  const a = await task(); const baseline = [block(a.id, "09:00", "09:30")]; await seed(baseline);
  const draft = await propose(); const fresh = draft.blocks.find(item => item.start !== baseline[0]!.start)!;
  await createOpeningPlansRepository(f.sql).upsertHardBlocks(f.scope, date, [{ start: fresh.start, end: fresh.end, kind: "locked" }]);
  await expect(createOpeningPlansRepository(f.sql, { now: () => now }).acceptPlan(f.scope,
    { draftId: draft.id, expectedBaseVersion: 1, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await createOpeningPlansRepository(f.sql).getToday(f.scope, date))?.blocks).toEqual(baseline);
});
it.each(["missing_version", "duplicate_task", "drop_fixed", "duplicate_future", "forged_deferral"])("rejects forged stored metadata: %s", async kind => {
  const a = await task(), b = await task(); const baseline = [block(a.id, "09:00", "09:30"), block(b.id, "11:00", "11:30")]; await seed(baseline);
  const draft = await propose(); const [row] = await f.sql`SELECT input_snapshot FROM opening_plan_drafts WHERE id=${draft.id}`;
  const snapshot = row!.input_snapshot;
  let blocks = [...draft.blocks];
  if (kind === "missing_version") {
    snapshot.tasks = snapshot.tasks.map((item: { id: string }) => item.id === b.id ? { ...item, status: "done", version: undefined } : item);
    snapshot.localReplan.fixedBlocks = [baseline[0]]; snapshot.localReplan.releasedTaskVersions = [];
    blocks = blocks.filter(item => item.taskId !== b.id);
  }
  if (kind === "forged_deferral") {
    snapshot.tasks = snapshot.tasks.map((item: { id: string }) => item.id === b.id ? { ...item, notBefore: "2026-10-17T00:00:00.000Z" } : item);
    snapshot.localReplan.fixedBlocks = [baseline[0]];
    snapshot.localReplan.releasedTaskVersions = [{ id: b.id, version: 1, status: "pending" }];
    blocks = blocks.filter(item => item.taskId !== b.id);
  }
  if (kind === "duplicate_task") snapshot.tasks.push({ ...snapshot.tasks[0] });
  if (kind === "drop_fixed") blocks = blocks.filter(item => item.taskId !== b.id);
  if (kind === "duplicate_future") blocks.push(block(b.id, "14:00", "14:30"));
  await f.sql`UPDATE opening_plan_drafts SET input_snapshot=${f.sql.json(snapshot)}, blocks=${f.sql.json(blocks)} WHERE id=${draft.id}`;
  await expect(createOpeningPlansRepository(f.sql, { now: () => now }).acceptPlan(f.scope,
    { draftId: draft.id, expectedBaseVersion: 1, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await createOpeningPlansRepository(f.sql).getToday(f.scope, date))?.blocks).toEqual(baseline);
});
it("refuses a release-only proposal once the freed block has started", async () => {
  const a = await task(); await seed([block(a.id, "11:00", "11:30")]);
  await createOpeningPlansRepository(f.sql).updateTaskStatus(f.scope, a.id, { status: "done", expectedVersion: 1, at: now.toISOString() });
  const draft = await propose(); expect(draft.blocks).toEqual([]);
  await expect(createOpeningPlansRepository(f.sql, { now: () => new Date(at("11:01")) }).acceptPlan(f.scope,
    { draftId: draft.id, expectedBaseVersion: 1, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT", reason: "slot_expired" });
});
it("rechecks task versions and active learning between proposal and acceptance", async () => {
  const a = await task(); await seed([block(a.id, "09:00", "09:30")]); const draft = await propose();
  await f.sql`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,status,intent_kind,intent_summary,client_key,create_intent)
    VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'active','goal','学习',${randomUUID()},${f.sql.json({ source: "task", taskId: a.id.toUpperCase() })})`;
  await expect(createOpeningPlansRepository(f.sql, { now: () => now }).acceptPlan(f.scope,
    { draftId: draft.id, expectedBaseVersion: 1, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
});
it("excludes deferred tasks and preserves manual locks in a preview", async () => {
  const a = await task(), b = await task(); await seed([block(a.id, "09:00", "09:30")]);
  await createOpeningPlansRepository(f.sql).deferTask(f.scope, b.id, { expectedVersion: 1, notBefore: "2026-10-17T00:00:00.000Z" });
  await createOpeningPlansRepository(f.sql).upsertHardBlocks(f.scope, date, [{ start: at("10:00"), end: at("11:00"), kind: "locked" }]);
  const draft = await propose();
  expect(draft.blocks.some(item => item.taskId === b.id)).toBe(false);
  expect(draft.blocks.find(item => item.taskId === a.id && item.start !== at("09:00"))?.start).toBe(at("11:00"));
});

it("preserves future accepted plans through the legacy internal delta adapter with explicit windows and no saved settings", async () => {
  const a = await task(), b = await task(), future = "2026-10-17";
  const baseline = [{ taskId: b.id, start: `${future}T08:00:00.000Z`, end: `${future}T08:30:00.000Z`, reason: "Already accepted" }];
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, null);
  await f.sql`INSERT INTO opening_plan_state(workspace_id,day,accepted_version,accepted_blocks,hard_blocks_fingerprint)
    VALUES(${f.scope.workspaceId},${future}::date,1,${f.sql.json(baseline)},'original')`;
  const draft = await createOpeningPlanService(f.sql, { now: () => now }).proposeDeltaPlan(f.scope, { date: future,
    taskIds: [a.id], clientKey: randomUUID(), free: [{ start: `${future}T09:00:00.000Z`, end: `${future}T11:00:00.000Z`, kind: "free" }] });
  expect(draft.blocks).toEqual(expect.arrayContaining(baseline));
  expect(draft.blocks.filter(block => block.taskId === a.id)).toHaveLength(1);
  const plans = createOpeningPlansRepository(f.sql, { now: () => now });
  await plans.acceptPlan(f.scope, { draftId: draft.id, expectedBaseVersion: 1, clientKey: randomUUID() });
  expect((await plans.getToday(f.scope, future))?.blocks).toEqual(draft.blocks);
});

it("rejects a forged task duration and deadline in a persisted snapshot", async () => {
  const a = await task(); await seed([block(a.id, "09:00", "09:30")]);
  await f.sql`UPDATE opening_tasks SET due_at=${at("10:45")} WHERE id=${a.id}`;
  const draft = await propose(), [row] = await f.sql`SELECT input_snapshot FROM opening_plan_drafts WHERE id=${draft.id}`;
  const snapshot = row!.input_snapshot;
  snapshot.tasks = snapshot.tasks.map((item: { id: string }) => item.id === a.id ? { ...item, minutes: 60, dueAt: null } : item);
  const blocks = [block(a.id, "09:00", "09:30"), block(a.id, "11:00", "12:00")];
  await f.sql`UPDATE opening_plan_drafts SET input_snapshot=${f.sql.json(snapshot)},blocks=${f.sql.json(blocks)} WHERE id=${draft.id}`;
  await expect(createOpeningPlansRepository(f.sql, { now: () => now }).acceptPlan(f.scope,
    { draftId: draft.id, expectedBaseVersion: 1, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
});

async function seedLegacyCourseRouteRetest() {
  const courseId = randomUUID();
  const candidateId = randomUUID();
  const taskId = randomUUID();
  const retestId = randomUUID();
  const baselineObsId = randomUUID();
  const baselineRootId = randomUUID();
  const acceptClientKey = `legacy-retest:${randomUUID()}`;
  const payloadHash = `hash-${randomUUID()}`;
  const earliestAt = "2026-10-15T19:00:00.000Z";
  const deadline14d = "2026-10-26T19:00:00.000Z";
  const prompt = "矩阵秩：3天后离开原答案独立完成新题，按已确认的课程要求核对。";

  await f.sql`INSERT INTO courses(id, workspace_id, title, slug)
    VALUES(${courseId}, ${f.scope.workspaceId}, 'Course route replan', ${courseId})`;
  await f.sql`INSERT INTO opening_jobs(id, workspace_id, owner_user_id, key, kind, payload, result, state)
    VALUES(${candidateId}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, ${`retest:${candidateId}`}, 'retest',
      ${f.sql.json({
        id: candidateId,
        courseId,
        skillLabel: "矩阵秩",
        requirementKey: "rank-proof",
        prompt,
        sourceIds: [],
        dueAt: earliestAt,
        accepted: true,
        kind: "task",
        evidenceObservationIds: [baselineObsId],
        evidenceRootIds: [baselineRootId],
        acceptClientKey,
        acceptPayloadHash: payloadHash,
        taskId,
      })},
      ${f.sql.json({
        accepted: true,
        clientKey: acceptClientKey,
        payloadHash,
        taskId,
        baseVersion: 0,
        inputSnapshot: {
          kind: "retest",
          candidateId,
          courseId,
          skillLabel: "矩阵秩",
          prompt,
          sourceIds: [],
          dueAt: earliestAt,
          heuristic: true,
        },
        scheduled: false,
      })},
      'succeeded')`;
  await f.sql`INSERT INTO opening_tasks(
      id, workspace_id, owner_user_id, title, minutes, due_at, not_before,
      priority, status, version, candidate_id, course_id, skill_label, requirement_key, origin
    ) VALUES (
      ${taskId}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, ${prompt}, 25, ${earliestAt}, ${earliestAt},
      1, 'pending', 1, ${candidateId}, ${courseId}, '矩阵秩', 'rank-proof', 'retest'
    )`;
  await f.sql`INSERT INTO opening_retest_activities(
      id, workspace_id, owner_user_id, course_id, skill_label, requirement_key, purpose,
      evidence_cycle_id, candidate_id, candidate_reference_id, task_id, status, version,
      accept_client_key, learning_protocol, not_before_at, recommended_at, deadline_at
    ) VALUES (
      ${retestId}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, ${courseId}, '矩阵秩', 'rank-proof', 'retest',
      ${candidateId}, ${candidateId}, ${candidateId}, ${taskId}, 'accepted', 2,
      ${acceptClientKey},
      ${f.sql.json({
        protocolId: "course-route-delayed-v1",
        goalId: randomUUID(),
        goalRevision: 1,
        requirementId: randomUUID(),
        requirementRevision: 1,
        stableSkillId: randomUUID(),
        baselineObservationId: baselineObsId,
        baselineRootId,
        originActivityId: randomUUID(),
        minutes: 25,
      })},
      ${earliestAt}, ${earliestAt}, ${deadline14d}
    )`;

  return { courseId, candidateId, taskId, retestId, earliestAt, deadline14d };
}

it("accepts a legacy-miswritten course-route delayed retest through local replan without false task_changed", async () => {
  const fridayNow = new Date(at("19:00"));
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, {
    ...settings,
    dailyWindow: { start: "19:15", end: "19:40" },
  });
  const prior = await task();
  await createOpeningPlansRepository(f.sql).updateTaskStatus(f.scope, prior.id, {
    status: "done",
    expectedVersion: 1,
    at: at("09:30"),
  });
  const baseline = [block(prior.id, "09:00", "09:30")];
  await seed(baseline);

  const retest = await seedLegacyCourseRouteRetest();
  const proposed = await proposeOpeningLocalPlan(
    f.sql,
    f.scope,
    { date, expectedAcceptedVersion: 1, clientKey: randomUUID() },
    { now: fridayNow },
  );
  expect(proposed.kind).toBe("draft");
  if (proposed.kind !== "draft") return;
  expect(proposed.draft.blocks).toEqual([
    ...baseline,
    expect.objectContaining({ taskId: retest.taskId, start: at("19:15"), end: at("19:40") }),
  ]);

  const plans = createOpeningPlansRepository(f.sql, { now: () => fridayNow });
  const acceptKey = randomUUID();
  const accepted = await plans.acceptPlan(f.scope, {
    draftId: proposed.draft.id,
    expectedBaseVersion: 1,
    clientKey: acceptKey,
  });
  expect(accepted).toMatchObject({ status: "accepted", version: 2 });
  // Same-key replay returns original receipt without incrementing version again.
  expect(await plans.acceptPlan(f.scope, {
    draftId: proposed.draft.id,
    expectedBaseVersion: 1,
    clientKey: acceptKey,
  })).toMatchObject({ id: proposed.draft.id, status: "accepted", version: 2 });
  expect((await plans.getToday(f.scope, date))?.acceptedVersion).toBe(2);
});

it.each(["cancel", "snooze", "narrow_deadline"] as const)(
  "rejects local replan acceptance after delayed retest %s without changing accepted baseline",
  async (mutation) => {
    const fridayNow = new Date(at("19:00"));
    await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, {
      ...settings,
      dailyWindow: { start: "19:15", end: "19:40" },
    });
    const prior = await task();
    await createOpeningPlansRepository(f.sql).updateTaskStatus(f.scope, prior.id, {
      status: "done",
      expectedVersion: 1,
      at: at("09:30"),
    });
    const baseline = [block(prior.id, "09:00", "09:30")];
    await seed(baseline);

    const retest = await seedLegacyCourseRouteRetest();
    const proposed = await proposeOpeningLocalPlan(
      f.sql,
      f.scope,
      { date, expectedAcceptedVersion: 1, clientKey: randomUUID() },
      { now: fridayNow },
    );
    expect(proposed.kind).toBe("draft");
    if (proposed.kind !== "draft") return;

    const activities = createOpeningRetestActivityRepository(f.sql);
    if (mutation === "cancel") {
      await activities.transition(f.scope, retest.retestId, { type: "cancel", at: fridayNow.toISOString() });
    } else if (mutation === "snooze") {
      await activities.transition(f.scope, retest.retestId, { type: "snooze", until: "2026-10-17T19:00:00.000Z" });
    } else {
      await f.sql`UPDATE opening_retest_activities SET deadline_at=${at("19:30")} WHERE id=${retest.retestId}`;
    }

    const plans = createOpeningPlansRepository(f.sql, { now: () => fridayNow });
    await expect(plans.acceptPlan(f.scope, {
      draftId: proposed.draft.id,
      expectedBaseVersion: 1,
      clientKey: randomUUID(),
    })).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
    expect(await plans.getToday(f.scope, date)).toMatchObject({ acceptedVersion: 1, blocks: baseline });
  },
);

it("rejects a forged local replan block whose start is legal but end exceeds the real retest hard deadline", async () => {
  const fridayNow = new Date(at("19:00"));
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, {
    ...settings,
    dailyWindow: { start: "19:15", end: "19:40" },
  });
  const prior = await task();
  await createOpeningPlansRepository(f.sql).updateTaskStatus(f.scope, prior.id, {
    status: "done",
    expectedVersion: 1,
    at: at("09:30"),
  });
  const baseline = [block(prior.id, "09:00", "09:30")];
  await seed(baseline);

  const retest = await seedLegacyCourseRouteRetest();
  const proposed = await proposeOpeningLocalPlan(
    f.sql,
    f.scope,
    { date, expectedAcceptedVersion: 1, clientKey: randomUUID() },
    { now: fridayNow },
  );
  expect(proposed.kind).toBe("draft");
  if (proposed.kind !== "draft") return;

  // Narrow both DB deadline and forged draft snapshot to Friday 19:30 while keeping block 19:15-19:40.
  await f.sql`UPDATE opening_retest_activities SET deadline_at=${at("19:30")} WHERE id=${retest.retestId}`;
  const [row] = await f.sql`SELECT input_snapshot FROM opening_plan_drafts WHERE id=${proposed.draft.id}`;
  const snapshot = row!.input_snapshot;
  snapshot.tasks = snapshot.tasks.map((item: { id: string }) => item.id === retest.taskId ? { ...item, dueAt: at("19:30") } : item);
  await f.sql`UPDATE opening_plan_drafts SET input_snapshot=${f.sql.json(snapshot)} WHERE id=${proposed.draft.id}`;

  const plans = createOpeningPlansRepository(f.sql, { now: () => fridayNow });
  await expect(plans.acceptPlan(f.scope, {
    draftId: proposed.draft.id,
    expectedBaseVersion: 1,
    clientKey: randomUUID(),
  })).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
  expect(await plans.getToday(f.scope, date)).toMatchObject({ acceptedVersion: 1, blocks: baseline });
});

it("rejects local replan acceptance when a preserved futureFixed retest block is cancelled after proposal", async () => {
  const fridayNow = new Date(at("19:00"));
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, {
    ...settings,
    dailyWindow: { start: "19:00", end: "21:00" },
  });
  const retest = await seedLegacyCourseRouteRetest();
  await f.sql`UPDATE opening_retest_activities SET scheduled_start_at=${at("19:15")} WHERE id=${retest.retestId}`;
  const extra = await task();
  const baseline = [block(retest.taskId, "19:15", "19:40")];
  await seed(baseline);

  const proposed = await proposeOpeningLocalPlan(
    f.sql,
    f.scope,
    { date, expectedAcceptedVersion: 1, clientKey: randomUUID() },
    { now: fridayNow },
  );
  expect(proposed.kind).toBe("draft");
  if (proposed.kind !== "draft") return;
  expect(proposed.draft.blocks).toEqual(expect.arrayContaining([
    baseline[0],
    expect.objectContaining({ taskId: extra.id }),
  ]));

  // Cancel the retest activity only (opening_tasks.status stays pending).
  await createOpeningRetestActivityRepository(f.sql).transition(f.scope, retest.retestId, {
    type: "cancel",
    at: fridayNow.toISOString(),
  });

  const plans = createOpeningPlansRepository(f.sql, { now: () => fridayNow });
  await expect(plans.acceptPlan(f.scope, {
    draftId: proposed.draft.id,
    expectedBaseVersion: 1,
    clientKey: randomUUID(),
  })).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
  expect(await plans.getToday(f.scope, date)).toMatchObject({ acceptedVersion: 1, blocks: baseline });
});

it("preserves a same-day future retest reservation in local replan and releases it after user deferral", async () => {
  const fridayNow = new Date(at("19:00"));
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, {
    ...settings,
    dailyWindow: { start: "19:00", end: "21:00" },
  });
  const retest = await seedLegacyCourseRouteRetest();
  await f.sql`UPDATE opening_retest_activities SET scheduled_start_at=${at("19:15")} WHERE id=${retest.retestId}`;
  const extra = await task();
  const reservedBlock = block(retest.taskId, "19:15", "19:40");
  await seed([reservedBlock]);

  // 1) At 19:00, accepted 19:15-19:40 reservation stays in futureFixed while extra task fills remaining space.
  const kept = await proposeOpeningLocalPlan(
    f.sql,
    f.scope,
    { date, expectedAcceptedVersion: 1, clientKey: randomUUID() },
    { now: fridayNow },
  );
  expect(kept.kind).toBe("draft");
  if (kept.kind !== "draft") return;
  expect(kept.draft.blocks).toEqual(expect.arrayContaining([
    reservedBlock,
    expect.objectContaining({ taskId: extra.id }),
  ]));

  const plans = createOpeningPlansRepository(f.sql, { now: () => fridayNow });
  const accepted = await plans.acceptPlan(f.scope, {
    draftId: kept.draft.id,
    expectedBaseVersion: 1,
    clientKey: randomUUID(),
  });
  expect(accepted).toMatchObject({ status: "accepted", version: 2 });
  expect((await plans.getToday(f.scope, date))?.blocks).toEqual(kept.draft.blocks);

  // 2) User defers the retest task to 20:00 (> 19:15): next local replan releases the 19:15-19:40 block.
  await plans.deferTask(f.scope, retest.taskId, {
    expectedVersion: 1,
    notBefore: at("20:00"),
  });
  const released = await proposeOpeningLocalPlan(
    f.sql,
    f.scope,
    { date, expectedAcceptedVersion: 2, clientKey: randomUUID() },
    { now: fridayNow },
  );
  expect(released.kind).toBe("draft");
  if (released.kind !== "draft") return;
  expect(released.draft.blocks.some(item => item.taskId === retest.taskId)).toBe(false);
  expect(released.draft.blocks.some(item => item.taskId === extra.id)).toBe(true);
});

it.each([
  ["thursday", "2026-10-15", "2026-10-15T19:15:00.000Z"],
  ["saturday", "2026-10-17", "2026-10-17T19:15:00.000Z"],
] as const)(
  "rejects forged Friday local replan for a %s-reserved retest without altering either day",
  async (_label, otherDay, scheduledStartAt) => {
    const fridayNow = new Date(at("19:00"));
    await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, {
      ...settings,
      dailyWindow: { start: "19:00", end: "21:00" },
    });
    const retest = await seedLegacyCourseRouteRetest();
    const prior = await task();
    await createOpeningPlansRepository(f.sql).updateTaskStatus(f.scope, prior.id, {
      status: "done",
      expectedVersion: 1,
      at: at("09:30"),
    });
    const fridayBaseline = [block(prior.id, "09:00", "09:30")];
    const otherDayBaseline: PlannedBlock[] = [{
      taskId: retest.taskId,
      start: scheduledStartAt,
      end: new Date(Date.parse(scheduledStartAt) + 25 * 60_000).toISOString(),
      reason: "预约日已确认",
    }];
    await seed(fridayBaseline);
    await f.sql`INSERT INTO opening_plan_state(workspace_id, day, accepted_version, accepted_blocks, hard_blocks_fingerprint)
      VALUES(${f.scope.workspaceId}, ${otherDay}::date, 1, ${f.sql.json(otherDayBaseline)}, 'other-day-constraints')`;

    // Propose Friday local replan BEFORE explicit reservation is set, then set reservation to otherDay and forge snapshot.
    const proposed = await proposeOpeningLocalPlan(
      f.sql,
      f.scope,
      { date, expectedAcceptedVersion: 1, clientKey: randomUUID() },
      { now: fridayNow },
    );
    expect(proposed.kind).toBe("draft");
    if (proposed.kind !== "draft") return;
    expect(proposed.draft.blocks.some(item => item.taskId === retest.taskId)).toBe(true);

    await f.sql`UPDATE opening_retest_activities SET scheduled_start_at=${scheduledStartAt} WHERE id=${retest.retestId}`;
    const [row] = await f.sql`SELECT input_snapshot FROM opening_plan_drafts WHERE id=${proposed.draft.id}`;
    const snapshot = row!.input_snapshot;
    snapshot.tasks = snapshot.tasks.map((item: { id: string; retest?: Record<string, unknown> | null }) =>
      item.id === retest.taskId && item.retest
        ? { ...item, retest: { ...item.retest, scheduledStartAt } }
        : item);
    await f.sql`UPDATE opening_plan_drafts SET input_snapshot=${f.sql.json(snapshot)} WHERE id=${proposed.draft.id}`;

    const plans = createOpeningPlansRepository(f.sql, { now: () => fridayNow });
    await expect(plans.acceptPlan(f.scope, {
      draftId: proposed.draft.id,
      expectedBaseVersion: 1,
      clientKey: randomUUID(),
    })).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });

    // Both Friday and the reserved day remain completely untouched.
    expect(await plans.getToday(f.scope, date)).toMatchObject({ acceptedVersion: 1, blocks: fridayBaseline });
    expect(await plans.getToday(f.scope, otherDay)).toMatchObject({ acceptedVersion: 1, blocks: otherDayBaseline });
  },
);
