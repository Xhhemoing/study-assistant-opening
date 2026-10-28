import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository } from "@aistudy/database";
import { createOpeningPlanService } from "../../apps/web/src/features/opening/planning/plan-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const date = "2026-10-09";
const now = () => new Date("2026-10-08T12:00:00.000Z");

it("keeps an explicit overnight window inside the requested workspace day through acceptance", async () => {
  const plans = createOpeningPlansRepository(f.sql, { now });
  const task = await plans.createTask(f.scope, { title: "日程边界", minutes: 30, priority: 1, dueAt: null, candidateId: null });
  const service = createOpeningPlanService(f.sql, { now });
  const draft = await service.proposePlan(f.scope, { date, free: [{
    start: "2026-10-08T15:45:00.000Z", end: "2026-10-08T17:00:00.000Z", kind: "free",
  }] });
  expect(draft.blocks).toEqual([expect.objectContaining({
    taskId: task.id, start: "2026-10-08T16:00:00.000Z", end: "2026-10-08T16:30:00.000Z",
  })]);
  await service.acceptPlan(f.scope, { draftId: draft.id, expectedBaseVersion: 0, clientKey: randomUUID() });
  expect((await plans.getToday(f.scope, date))?.blocks).toEqual(draft.blocks);
});

it("leaves a task unscheduled when only next-day time would make it fit", async () => {
  const plans = createOpeningPlansRepository(f.sql, { now });
  const task = await plans.createTask(f.scope, { title: "不跨日", minutes: 30, priority: 1, dueAt: null, candidateId: null });
  const draft = await createOpeningPlanService(f.sql, { now }).proposePlan(f.scope, { date, free: [{
    start: "2026-10-09T15:45:00.000Z", end: "2026-10-09T16:45:00.000Z", kind: "free",
  }] });
  expect(draft.blocks).toEqual([]);
  expect(draft.unscheduledTaskIds).toEqual([task.id]);
});
