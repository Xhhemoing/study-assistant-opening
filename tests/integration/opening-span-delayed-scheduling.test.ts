import { randomUUID } from "node:crypto";
import type { RetestCandidate } from "@aistudy/contracts";
import { cancelOwnedSpanTutorRetests, createOpeningAdaptivePrefsRepository, createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningPlansRepository, createOpeningRetestRepository, createWorkspacePreferencesRepository } from "@aistudy/database";
import { getSpanProblem, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningRetestService } from "../../apps/web/src/features/opening/learning/retest-service";
import { createSpanDelayedRetestService } from "../../apps/web/src/features/opening/teaching/span/delayed-retest-service";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations,opening_tasks CASCADE`;
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope,
    { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
});
afterAll(async () => { await fixture?.close(); });

async function baseline() {
  const rows = backupRows(fixture.sql, fixture.scope), sourceId = await rows.source(), courseId = randomUUID();
  await rows.chunk(sourceId);
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${fixture.scope.workspaceId},'Span delayed race',${courseId})`;
  const learning = createOpeningLearningRepository(fixture.sql);
  const session = await learning.createSession(fixture.scope, { courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId] });
  const attempt = await createOpeningLearningAttemptRepository(fixture.sql).create(fixture.scope,
    { sessionId: session.id, clientKey: randomUUID(), spanExercise: { sourceId, problemId: "span-example-2d", version: 1 } });
  const problem = getSpanProblem("span-example-2d")!;
  const record = await learning.insertObservation(fixture.scope, { sessionId: session.id, courseId, skillLabel: SPAN_SKILL_LABEL,
    sourceIds: [sourceId], attemptId: attempt.id, problemId: attempt.problemId, clientKey: randomUUID(), assistance: "hinted",
    outcome: "unverified", verdictSource: "self_report", answer: JSON.stringify({ membership: "in_span", coefficients: ["3", "-1/2"],
      equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: ["3", "-1"] }) });
  expect(record).toMatchObject({ outcome: "correct", assistance: "hinted" });
  const candidate: RetestCandidate = { id: randomUUID(), courseId, skillLabel: SPAN_SKILL_LABEL, requirementKey: SPAN_REQUIREMENT_KEY,
    prompt: "隔天重做原题（先不看之前的答案）：旧练习提示", sourceIds: [sourceId],
    dueAt: new Date(Date.parse(record.recordedAt!) + 48 * 3600000).toISOString(), accepted: false,
    evidenceObservationIds: [record.id], evidenceRootIds: [record.rootObservationId ?? record.id], kind: "task" };
  return { record, sourceId, courseId, candidate, request: { observationId: record.id, clientKey: randomUUID() } };
}
async function assertScheduled(f: Awaited<ReturnType<typeof baseline>>, result: { candidateId: string; taskId: string; notBeforeAt: string }) {
  const [job] = await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${result.candidateId}`;
  expect(job!.payload).toMatchObject({ accepted: true, taskId: result.taskId, sourceIds: [f.sourceId],
    evidenceObservationIds: [f.record.id], evidenceRootIds: [f.record.rootObservationId],
    spanDelayedProtocol: { protocolId: "span-delayed-3d-v1", baselineObservationId: f.record.id,
      baselineRootId: f.record.rootObservationId, priorAnswerPolicy: "require_unseen_problem" } });
  expect(job!.payload.prompt).not.toBe(f.candidate.prompt);
  expect(Date.parse(result.notBeforeAt)).toBeGreaterThanOrEqual(Date.parse(f.record.recordedAt!) + 72 * 3600000);
  expect(await fixture.sql`SELECT id FROM opening_retest_activities WHERE workspace_id=${fixture.scope.workspaceId}
    AND owner_user_id=${fixture.scope.ownerUserId} AND course_id=${f.courseId} AND requirement_key=${SPAN_REQUIREMENT_KEY}
    AND status IN ('proposed','accepted','in_progress')`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_tasks WHERE candidate_id=${result.candidateId}`).toHaveLength(1);
}

it("converts the scanner proposal using the explicit baseline and replays one task", async () => {
  const f = await baseline();
  expect(await createOpeningRetestRepository(fixture.sql).saveCandidates(fixture.scope, [f.candidate])).toHaveLength(1);
  const service = createSpanDelayedRetestService(fixture.sql), result = await service.schedule(fixture.scope, f.request);
  expect(result.candidateId).toBe(f.candidate.id);
  await assertScheduled(f, result);
  const [before] = await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${result.candidateId}`;
  expect(await service.schedule(fixture.scope, f.request)).toEqual(result);
  const [after] = await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${result.candidateId}`;
  expect(after!.payload).toEqual(before!.payload);
});

it("does not reinterpret an already accepted ordinary task", async () => {
  const f = await baseline();
  await createOpeningRetestRepository(fixture.sql).saveCandidates(fixture.scope, [f.candidate]);
  await createOpeningRetestService(fixture.sql).accept(fixture.scope, f.candidate.id, randomUUID());
  const before = await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${f.candidate.id}`;
  await expect(createSpanDelayedRetestService(fixture.sql).schedule(fixture.scope, f.request)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${f.candidate.id}`).toEqual(before);
  expect(await fixture.sql`SELECT id FROM opening_tasks WHERE candidate_id=${f.candidate.id}`).toHaveLength(1);
});

it.each(["completed", "cancelled"])("replays the exact original request after %s without reopening the cycle", async status => {
  const f = await baseline(), service = createSpanDelayedRetestService(fixture.sql);
  const result = await service.schedule(fixture.scope, f.request);
  await createOpeningPlansRepository(fixture.sql).updateTaskStatus(fixture.scope, result.taskId,
    { expectedVersion: 1, status: status === "completed" ? "done" : "skipped", at: new Date().toISOString() });
  const before = await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${result.candidateId}`;
  expect(await service.schedule(fixture.scope, f.request)).toMatchObject({ ...result, activityStatus: status,
    taskStatus: status === "completed" ? "done" : "skipped" });
  expect(await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${result.candidateId}`).toEqual(before);
  const [activity] = await fixture.sql`SELECT status FROM opening_retest_activities WHERE candidate_id=${result.candidateId}`;
  expect(activity!.status).toBe(status);
  await expect(service.schedule(fixture.scope, { ...f.request, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT id FROM opening_tasks WHERE candidate_id=${result.candidateId}`).toHaveLength(1);
});

it("refuses stale source versions without rewriting a proposed candidate", async () => {
  const f = await baseline();
  await createOpeningRetestRepository(fixture.sql).saveCandidates(fixture.scope, [f.candidate]);
  await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
  await expect(createSpanDelayedRetestService(fixture.sql).schedule(fixture.scope, f.request)).rejects.toMatchObject({ code: "CONFLICT" });
  const [row] = await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${f.candidate.id}`;
  expect(row!.payload).toEqual(f.candidate);
  expect(await fixture.sql`SELECT id FROM opening_tasks WHERE candidate_id=${f.candidate.id}`).toHaveLength(0);
});

it("rejects a foreign owner before changing or accepting the proposal", async () => {
  const f = await baseline();
  await createOpeningRetestRepository(fixture.sql).saveCandidates(fixture.scope, [f.candidate]);
  await expect(createSpanDelayedRetestService(fixture.sql).schedule({ ...fixture.scope, ownerUserId: randomUUID() }, f.request)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await fixture.sql`SELECT id FROM opening_tasks WHERE candidate_id=${f.candidate.id}`).toHaveLength(0);
});

function beforeCommit(sql: Sql) {
  let release = () => undefined as void, entered = () => undefined as void;
  const opened = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const gated = new Proxy(sql, { get(target, property, receiver) {
    return property === "begin" ? (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => {
      const result = await work(tx); entered(); await gate; return result;
    }) : Reflect.get(target, property, receiver);
  } });
  return { sql: gated, release, opened };
}

it.each(["scan", "schedule"] as const)("serializes scanner and explicit scheduling with %s committing first", async first => {
  const f = await baseline(), a = await openRaceSession().ready, b = await openRaceSession().ready;
  const gate = beforeCommit(a.sql);
  const scan = (sql: Sql) => createOpeningRetestRepository(sql).saveCandidates(fixture.scope, [f.candidate]);
  const schedule = (sql: Sql) => createSpanDelayedRetestService(sql).schedule(fixture.scope, f.request);
  const winner = track(first === "scan" ? scan(gate.sql) : schedule(gate.sql));
  const pending: Promise<unknown>[] = [winner];
  try {
    await Promise.race([gate.opened, winner.then(() => { throw new Error("commit barrier bypassed"); })]);
    const loser = track(first === "scan" ? schedule(b.sql) : scan(b.sql)); pending.push(loser);
    await waitUntilBlocked(fixture.sql, b.pid, a.pid, "span scheduling history lock", /opening_workspace_history_revisions/);
    gate.release(); await Promise.all(pending);
    const result = await schedule(fixture.sql);
    expect(result.candidateId).toBe(first === "scan" ? f.candidate.id : f.record.id);
    await assertScheduled(f, result);
  } finally {
    gate.release(); await Promise.allSettled(pending); await closeRace(b.sql); await closeRace(a.sql);
  }
}, 15_000);

async function tutorGrant(courseId: string, dailyMinutes = 30) {
  return createOpeningAdaptivePrefsRepository(fixture.sql).patch(fixture.scope, {
    spanTutorGrant: { courseId, enabled: true, dailyMinutes, expiresOn: null, expectedRevision: 0 },
  });
}
it("persists an automatic target-day budget in the ordinary acceptance and replays after account shutdown", async () => {
  const f = await baseline(); await tutorGrant(f.courseId);
  const service = createSpanDelayedRetestService(fixture.sql), request = { ...f.request, expectedGrantRevision: 1 };
  const result = await service.scheduleAutomatic(fixture.scope, request);
  await assertScheduled(f, result);
  const [activity] = await fixture.sql`SELECT learning_protocol FROM opening_retest_activities WHERE id=${result.activityId}`;
  expect(activity!.learning_protocol.tutorAutomation).toMatchObject({ minutes: 20, grantRevision: 1, createdTaskVersion: 1, timeZone: "Asia/Shanghai" });
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope,
    { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  const replay = await service.scheduleAutomatic(fixture.scope, request);
  expect(replay.taskId).toBe(result.taskId);
  expect(await fixture.sql`SELECT id FROM opening_tasks WHERE candidate_id=${result.candidateId}`).toHaveLength(1);
});

it("requires current course permission and rejects account-off before creating an automatic task", async () => {
  const f = await baseline(); await tutorGrant(f.courseId);
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope,
    { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  await expect(createSpanDelayedRetestService(fixture.sql).scheduleAutomatic(fixture.scope, { ...f.request, expectedGrantRevision: 1 }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT id FROM opening_tasks WHERE course_id=${f.courseId}`).toHaveLength(0);
});

it("serializes two courses against the same target-day balance", async () => {
  const a = await baseline(), b = await baseline();
  await tutorGrant(a.courseId); await tutorGrant(b.courseId);
  const service = createSpanDelayedRetestService(fixture.sql);
  const results = await Promise.allSettled([a, b].map(f => service.scheduleAutomatic(fixture.scope, { ...f.request, expectedGrantRevision: 1 })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  const [count] = await fixture.sql`SELECT count(*)::int AS count FROM opening_tasks WHERE course_id IN (${a.courseId},${b.courseId})`;
  expect(count!.count).toBe(1);
});

it("includes a manual span activity on the target day in the shared balance", async () => {
  const f = await baseline(); await tutorGrant(f.courseId);
  const created = new Date(Math.max(Date.parse(f.record.submittedAt!), Date.parse(f.record.recordedAt!)) + 72 * 3600000);
  await fixture.sql`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,status,generate_status,intent_kind,
    intent_summary,source_ids,goal_json,client_key,create_intent,created_at)
    VALUES(${randomUUID()},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},${f.courseId},'active','ready','course_continue',
      'manual span',${[f.sourceId]},'{}'::jsonb,${randomUUID()},${fixture.sql.json({ protocol: "span-lesson-v1", intent: { timeBudgetMinutes: 25 } })},${created})`;
  await expect(createSpanDelayedRetestService(fixture.sql).scheduleAutomatic(fixture.scope, { ...f.request, expectedGrantRevision: 1 }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT id FROM opening_tasks WHERE course_id=${f.courseId}`).toHaveLength(0);
});

it("conditionally closes only untouched unstarted automatically owned tasks with system provenance", async () => {
  const examples = [await baseline(), await baseline(), await baseline(), await baseline()];
  const results = [];
  for (const f of examples) {
    await tutorGrant(f.courseId, 180);
    results.push(await createSpanDelayedRetestService(fixture.sql).scheduleAutomatic(fixture.scope, { ...f.request, expectedGrantRevision: 1 }));
  }
  await fixture.sql`UPDATE opening_tasks SET title='learner edited',version=version+1 WHERE id=${results[1]!.taskId}`;
  await fixture.sql`UPDATE opening_retest_activities SET started_at=now() WHERE id=${results[2]!.activityId}`;
  await fixture.sql`INSERT INTO opening_plan_state(workspace_id,day,accepted_version,accepted_blocks)
    VALUES(${fixture.scope.workspaceId},'2099-01-01',1,${fixture.sql.json([{ taskId: results[3]!.taskId, start: "2099-01-01T01:00:00Z", end: "2099-01-01T01:20:00Z" }])})`;
  const closed = await fixture.sql.begin(tx => cancelOwnedSpanTutorRetests(tx, fixture.scope, { reason: "tutor_disabled" }));
  expect(closed).toEqual([results[0]!.taskId]);
  const rows = await fixture.sql`SELECT id,status,close_source FROM opening_tasks WHERE id IN ${fixture.sql(results.map(result => result.taskId))}`;
  expect(rows.find(row => row.id === results[0]!.taskId)).toMatchObject({ status: "skipped", close_source: "system" });
  expect(rows.filter(row => row.status === "pending")).toHaveLength(3);
  expect((await createSpanDelayedRetestService(fixture.sql).scheduleAutomatic(fixture.scope, { ...examples[0]!.request, expectedGrantRevision: 1 })).taskStatus).toBe("skipped");
});

it("closes only the evidence-invalidated automatic task, preserving edited and unrelated accepted tasks", async () => {
  const a = await baseline(), b = await baseline(), other = await baseline();
  const results = [];
  for (const f of [a, b, other]) {
    await tutorGrant(f.courseId, 180);
    results.push(await createSpanDelayedRetestService(fixture.sql).scheduleAutomatic(fixture.scope, { ...f.request, expectedGrantRevision: 1 }));
  }
  await fixture.sql`UPDATE opening_tasks SET title='learner owns this',version=version+1 WHERE id=${results[1]!.taskId}`;
  for (const f of [a, b]) await createOpeningLearningRepository(fixture.sql).reviseObservation(fixture.scope, {
    rootObservationId: f.record.rootObservationId ?? f.record.id, revisesObservationId: f.record.id, expectedHead: f.record.id,
    revisionKind: "retract", reason: "withdraw incorrect evidence", clientKey: randomUUID(),
  });
  const rows = await fixture.sql`SELECT t.id,t.status,t.close_source,r.status AS activity_status FROM opening_tasks t
    JOIN opening_retest_activities r ON r.task_id=t.id WHERE t.id IN ${fixture.sql(results.map(result => result.taskId))}`;
  expect(rows.find(row => row.id === results[0]!.taskId)).toMatchObject({ status: "skipped", close_source: "system", activity_status: "cancelled" });
  expect(rows.find(row => row.id === results[1]!.taskId)).toMatchObject({ status: "pending", activity_status: "invalidated" });
  expect(rows.find(row => row.id === results[2]!.taskId)).toMatchObject({ status: "pending", activity_status: "accepted" });
});
