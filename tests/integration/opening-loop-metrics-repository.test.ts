import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository } from "@aistudy/database";
import { readOpeningLoopMetrics } from "../../packages/database/src/repositories/opening-loop-metrics";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { matrixAttemptFixture } from "./opening-matrix-attempt-fixture";

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
  const report = await readOpeningLoopMetrics(sql, scope, { now, days: 14 });
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

it.each([
  { answer: "[2,3]", outcome: "correct", correctCount: 1 },
  { answer: "[3,2]", outcome: "incorrect", correctCount: 0 },
] as const)("reads a real server-scored $outcome head and excludes current privacy sources without summary repair", async ({ answer, outcome, correctCount }) => {
  const course = await matrixAttemptFixture(fixture);
  const observation = await course.submit(await course.start(), { answer });
  expect(observation).toMatchObject({ verdictSource: "deterministic", outcome,
    eligibility: { independentAttempt: "yes", verifiedCorrect: correctCount ? "yes" : "no", usableForCurrentVersion: "yes" } });
  const clock = new Date(Date.now() + 1000);
  const before = await fixture.sql`SELECT * FROM opening_learning_eligibility WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY root_observation_id`;
  const initial = await readOpeningLoopMetrics(fixture.sql, fixture.scope, { now: clock });
  expect(initial.groups.learning.find(m => m.id === "learning.independent_check_coverage")).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
  expect(initial.groups.learning.find(m => m.id === "learning.deterministic_correct"))
    .toMatchObject({ value: correctCount, numerator: correctCount, denominator: 1 });
  expect(initial.groups.learning.find(m => m.id === "learning.checked_correct"))
    .toMatchObject({ value: null, numerator: 0, denominator: 0 });
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${fixture.scope.workspaceId},${course.sourceId})`;
  const excluded = await readOpeningLoopMetrics(fixture.sql, fixture.scope, { now: clock });
  expect(excluded.groups.learning.find(m => m.id === "learning.independent_check_coverage")).toMatchObject({ value: null, denominator: 0,
    excludedReasonCounts: { privacy_excluded: 1 } });
  expect(await fixture.sql`SELECT * FROM opening_learning_eligibility WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY root_observation_id`).toEqual(before);
  expect((await fixture.sql`SELECT id FROM opening_learning_observations WHERE id=${observation.id}`)).toHaveLength(1);
});

it("retains assisted and version-changed attempts in coverage denominators while counting only qualified success and error", async () => {
  const current = await matrixAttemptFixture(fixture);
  await current.submit(await current.start(), { answer: "[3,2]" });
  await current.submit(await current.start());
  const assisted = await current.start();
  await current.help(assisted);
  await current.submit(assisted);
  const changed = await matrixAttemptFixture(fixture);
  await changed.submit(await changed.start());
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${changed.sourceId}`;
  const before = await fixture.sql`SELECT * FROM opening_learning_eligibility WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY root_observation_id`;
  const report = await readOpeningLoopMetrics(fixture.sql, fixture.scope, { now: new Date(Date.now() + 1000) });
  expect(report.groups.learning.find(m => m.id === "learning.independent_check_coverage"))
    .toMatchObject({ value: 0.5, numerator: 2, denominator: 4,
      excludedReasonCounts: { help_before_submission: 1, version_changed_needs_check: 1 } });
  expect(report.groups.learning.find(m => m.id === "learning.deterministic_correct"))
    .toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
  expect(report.groups.learning.find(m => m.id === "learning.qualification_unknown"))
    .toMatchObject({ value: 0.25, numerator: 1, denominator: 4 });
  expect(await fixture.sql`SELECT * FROM opening_learning_eligibility WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY root_observation_id`).toEqual(before);
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
  const report = await readOpeningLoopMetrics(sql, scope, { now, days: 14 });
  expect(report.groups.burden.find(m => m.id === "suggestions.generated_acceptance")).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
  expect(report.groups.burden.find(m => m.id === "suggestions.generated_minutes")).toMatchObject({ value: 5 });
  expect(report.groups.burden.find(m => m.id === "suggestions.display_acceptance")).toMatchObject({ value: null, dataStatus: "not_collected" });
});
