import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository } from "@aistudy/database";
import { readOpeningLoopMetrics } from "../../packages/database/src/repositories/opening-loop-metrics";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { await fixture?.close(); });
const now = new Date("2026-10-16T16:00:00.000Z");

it("hand-counts creation cohorts, separates zero-cost TTL from actual receipts and does not reconcile on GET", async () => {
  const { sql, scope, otherScope } = fixture;
  for (const [state, date, owner] of [
    ["succeeded", "2026-10-10", scope], ["failed", "2026-10-10", scope], ["outcome_unknown", "2026-10-10", scope],
    ["running", "2026-10-10", scope], ["succeeded", "2026-09-01", scope], ["succeeded", "2026-10-10", otherScope],
  ] as const) {
    await sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state,created_at)
      VALUES(${randomUUID()},${owner.workspaceId},${owner.ownerUserId},${randomUUID()},'tutor','{}',${state},${date + "T12:00:00Z"})`;
  }
  const seedBudget = async (state: string, amount: number, reconciled: boolean, unknown = false, late = false) => {
    const id = randomUUID();
    await sql`INSERT INTO opening_budget_reservations(id,workspace_id,purpose,amount_cents,request_id,state,created_at,
      reconciled_at,pending_reconcile_cents,reserved_amount_cents,outcome_unknown_at)
      VALUES(${id},${scope.workspaceId},'tutor',${amount},${randomUUID()},${state},'2026-10-10T12:00:00Z',
        ${reconciled ? now : null},${reconciled && !late ? amount : 0},${amount},${unknown ? now : null})`;
    if (late) await sql`INSERT INTO opening_budget_reconcile_events(reservation_id,workspace_id,kind,
      amount_before_cents,amount_after_cents,state_before,reported_actual_cents)
      VALUES(${id},${scope.workspaceId},'late_receipt',${amount},${amount},'completed',${amount})`;
  };
  await seedBudget("completed", 7, false);
  await seedBudget("completed", 0, true);
  await seedBudget("completed", 3, true, false, true);
  await seedBudget("reserved", 9, false, true);
  await seedBudget("reserved", 5, false);
  const before = await sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
  const report = await readOpeningLoopMetrics(sql, scope, { now });
  const metric = (id: string) => report.groups.runtime.find(item => item.id === id)!;
  expect(metric("jobs.tutor.succeeded_ratio")).toMatchObject({ value: 0.25, numerator: 1, denominator: 4 });
  expect(metric("jobs.tutor.outcome_unknown").value).toBe(1);
  expect(metric("budget.settled")).toMatchObject({ value: 10, sampleSize: 2 });
  expect(metric("budget.ttl_provisional")).toMatchObject({ value: 0, sampleSize: 1, dataStatus: "available" });
  expect(metric("budget.unknown_reserved").value).toBe(9);
  expect(metric("budget.active_reserved").value).toBe(5);
  expect(await sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} ORDER BY id`).toEqual(before);
  await expect(readOpeningLoopMetrics(sql, { ...scope, ownerUserId: otherScope.ownerUserId }, { now })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("reads current qualified heads directly, includes checked errors and excludes current privacy sources without summary repair", async () => {
  const course = await learningAttemptFixture(fixture);
  const attempt = await course.start({ requirementKey: "addition" });
  const observation = await course.submit(attempt, { answer: "2", outcome: "incorrect", verdictSource: "reference_checked",
    referenceSourceId: course.sourceId, referenceCheck: { referenceSourceId: course.sourceId, method: "reference comparison", scope: "whole_answer" } });
  const clock = new Date(Date.now() + 1000);
  const before = await fixture.sql`SELECT * FROM opening_learning_eligibility WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY root_observation_id`;
  const initial = await readOpeningLoopMetrics(fixture.sql, fixture.scope, { now: clock });
  expect(initial.groups.learning.find(m => m.id === "learning.independent_check_coverage")).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
  expect(initial.groups.learning.find(m => m.id === "learning.checked_correct")).toMatchObject({ value: 0, numerator: 0, denominator: 1 });
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${fixture.scope.workspaceId},${course.sourceId})`;
  const excluded = await readOpeningLoopMetrics(fixture.sql, fixture.scope, { now: clock });
  expect(excluded.groups.learning.find(m => m.id === "learning.independent_check_coverage")).toMatchObject({ value: null, denominator: 0,
    excludedReasonCounts: { privacy_excluded: 1 } });
  expect(await fixture.sql`SELECT * FROM opening_learning_eligibility WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY root_observation_id`).toEqual(before);
  expect((await fixture.sql`SELECT id FROM opening_learning_observations WHERE id=${observation.id}`)).toHaveLength(1);
});

it("counts task feedback as real actions with optional reasons and does not infer historic completion rates", async () => {
  const plans = createOpeningPlansRepository(fixture.sql);
  const task = await plans.createTask(fixture.scope, { title: "metrics", minutes: 10, priority: 1, dueAt: null, candidateId: null });
  await plans.deferTask(fixture.scope, task.id, { expectedVersion: 1, notBefore: "2099-01-01T00:00:00Z", feedback: { reason: "time_short" } });
  await plans.deferTask(fixture.scope, task.id, { expectedVersion: 2, notBefore: null });
  const report = await readOpeningLoopMetrics(fixture.sql, fixture.scope, { now: new Date(Date.now() + 1000) });
  expect(report.groups.burden.find(m => m.id === "feedback.deferred")).toMatchObject({ value: 1, denominator: 2 });
  expect(report.groups.burden.find(m => m.id === "feedback.resumed")).toMatchObject({ value: 1, denominator: 2 });
  expect(report.groups.burden.find(m => m.id === "feedback.reason_coverage")).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
  expect(report.groups.burden.find(m => m.id === "suggestions.display_acceptance")).toMatchObject({ value: null, dataStatus: "not_collected" });
});

it("deduplicates regenerated suggestions by stable key and never calls their ratio display adoption", async () => {
  const { sql, scope } = fixture;
  const id = randomUUID(), key = `metrics:${id}`;
  const suggestion = { id, key, kind: "review_cards", title: "Cards", minutes: 5, courseId: null, skillLabel: null,
    reasonCode: "review_cards", reason: "Due cards" };
  for (const minutes of [5, 10]) await sql`INSERT INTO opening_plan_drafts
    (id,workspace_id,owner_user_id,day,base_version,input_snapshot,hard_blocks_fingerprint,suggested_tasks,created_at)
    VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},'2026-10-10',0,'{}','test',
      ${sql.json([{ ...suggestion, minutes }])},${minutes === 5 ? "2026-10-10T10:00:00Z" : "2026-10-10T11:00:00Z"})`;
  await sql`INSERT INTO opening_plan_drafts
    (id,workspace_id,owner_user_id,day,base_version,input_snapshot,hard_blocks_fingerprint,suggested_tasks,origin,created_at)
    VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},'2026-10-10',0,'{}','test',
      ${sql.json([{ ...suggestion, id: randomUUID(), key: "conversation-only-key" }])},'agent','2026-10-10T11:00:00Z')`;
  await sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,title,minutes,origin,client_key,created_at)
    VALUES(${id},${scope.workspaceId},${scope.ownerUserId},'Cards',5,'planner',${key},'2026-10-10T12:00:00Z')`;
  const report = await readOpeningLoopMetrics(sql, scope, { now });
  expect(report.groups.burden.find(m => m.id === "suggestions.generated_acceptance")).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
  expect(report.groups.burden.find(m => m.id === "suggestions.generated_minutes")).toMatchObject({ value: 5 });
  expect(report.groups.burden.find(m => m.id === "suggestions.display_acceptance")).toMatchObject({ value: null, dataStatus: "not_collected" });
});
