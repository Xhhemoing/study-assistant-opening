import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET as assistantList } from "../../../apps/web/src/app/api/opening/candidates/route";
import { GET as retestList } from "../../../apps/web/src/app/api/opening/retests/route";
import { POST as discardAssistant } from "../../../apps/web/src/app/api/opening/candidates/[id]/discard/route";
import { POST as discardRetest } from "../../../apps/web/src/app/api/opening/retests/[id]/discard/route";
import { POST as acceptRetest } from "../../../apps/web/src/app/api/opening/retests/[id]/accept/route";
import { POST as createTask } from "../../../apps/web/src/app/api/opening/tasks/route";
import { createTodayResumeReader } from "../../../apps/web/src/features/opening/planning/today-service";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { taskCandidate } from "../opening-task-acceptance-fixture";
import { backupRows } from "../opening-backup-records-fixture";
import { seedReviewRetest } from "../opening-review-fixture";

let fixture: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    authCookieName: "aistudy_session", sessionCookieSecure: false, sessionTtlSeconds: 3600 });
  setAuthRuntimeForTests(runtime);
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_tasks, opening_conversations RESTART IDENTITY CASCADE`;
});
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await fixture?.close(); });
function request(body?: unknown, cookie = fixture.cookie) {
  return new Request("http://localhost/api/opening/review", { method: body ? "POST" : "GET", headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const decision = (id: string, origin: "assistant" | "retest") => ({ candidateRef: { id, origin, kind: origin === "assistant" ? "task" : "retest" }, clientKey: randomUUID() });

it("lists real task/memory/retest proposals and counts them together for Today", async () => {
  const task = await taskCandidate(fixture), memory = await taskCandidate(fixture), retest = await seedReviewRetest(fixture);
  await fixture.sql`UPDATE opening_assistant_candidates SET payload = ${fixture.sql.json({ kind: "memory", text: "习惯先尝试", temporary: false })} WHERE id = ${memory.id}`;
  expect((await assistantList(request())).status).toBe(200);
  expect((await (await assistantList(request())).json()).map((row: { id: string }) => row.id).sort()).toEqual([task.id, memory.id].sort());
  expect(await (await retestList(request())).json()).toMatchObject([{ id: retest.id, kind: "task", accepted: false }]);
  expect(await createTodayResumeReader(fixture.sql).pendingCandidateCount(fixture.scope)).toBe(3);
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(0);
});

it("requires authentication and hides foreign or currently excluded sources", async () => {
  expect((await retestList(request(undefined, ""))).status).toBe(401);
  const task = await taskCandidate(fixture, true), retest = await seedReviewRetest(fixture);
  await taskCandidate({ ...fixture, scope: fixture.otherScope });
  await seedReviewRetest(fixture, fixture.otherScope);
  await backupRows(fixture.sql, fixture.scope).exclude(task.sourceId!);
  await backupRows(fixture.sql, fixture.scope).exclude(retest.sourceId);
  expect(await (await assistantList(request())).json()).toEqual([]);
  expect(await (await retestList(request())).json()).toEqual([]);
  expect((await acceptRetest(request({ clientKey: randomUUID() }), params(retest.id))).status).toBe(404);
});

it("discards an assistant task idempotently but refuses memory, foreign, and mixed-origin targets", async () => {
  const task = await taskCandidate(fixture), memory = await taskCandidate(fixture), foreign = await taskCandidate({ ...fixture, scope: fixture.otherScope });
  await fixture.sql`UPDATE opening_assistant_candidates SET payload = ${fixture.sql.json({ kind: "memory", text: "不要误送", temporary: false })} WHERE id = ${memory.id}`;
  const body = decision(task.id, "assistant");
  expect((await discardAssistant(request(body), params(task.id))).status).toBe(200);
  expect(await (await discardAssistant(request(body), params(task.id))).json()).toEqual({ id: task.id, status: "discarded" });
  expect((await discardAssistant(request(decision(memory.id, "assistant")), params(memory.id))).status).toBe(409);
  expect((await discardAssistant(request(decision(foreign.id, "assistant")), params(foreign.id))).status).toBe(409);
  expect((await discardAssistant(request(decision(task.id, "retest")), params(task.id))).status).toBe(400);
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(0);
});

it("an ignored retest cannot later be accepted or reappear as pending", async () => {
  const retest = await seedReviewRetest(fixture), body = decision(retest.id, "retest");
  expect((await discardRetest(request(body), params(retest.id))).status).toBe(200);
  expect((await discardRetest(request(body), params(retest.id))).status).toBe(200);
  expect((await acceptRetest(request({ clientKey: randomUUID() }), params(retest.id))).status).toBe(409);
  expect(await (await retestList(request())).json()).toEqual([]);
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(0);
});

it("an accepted retest rejects ignore, preserves same-key replay, and checks current source access", async () => {
  const retest = await seedReviewRetest(fixture), clientKey = randomUUID();
  const accepted = await acceptRetest(request({ clientKey }), params(retest.id));
  expect(accepted.status).toBe(200);
  const first = await accepted.json();
  expect((await discardRetest(request(decision(retest.id, "retest")), params(retest.id))).status).toBe(409);
  expect(await (await acceptRetest(request({ clientKey }), params(retest.id))).json()).toMatchObject({ taskId: first.taskId });
  await backupRows(fixture.sql, fixture.scope).exclude(retest.sourceId);
  expect((await acceptRetest(request({ clientKey }), params(retest.id))).status).toBe(404);
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(1);
});

it("retains the full retest prompt in its snapshot when a task title needs shortening", async () => {
  const retest = await seedReviewRetest(fixture), prompt = "题".repeat(300);
  await fixture.sql`UPDATE opening_jobs SET payload = payload || ${fixture.sql.json({ prompt })} WHERE id = ${retest.id}`;
  expect((await acceptRetest(request({ clientKey: randomUUID() }), params(retest.id))).status).toBe(200);
  const [task] = await fixture.sql`SELECT title FROM opening_tasks`;
  const [job] = await fixture.sql`SELECT result FROM opening_jobs WHERE id = ${retest.id}`;
  expect(task?.title).toHaveLength(240);
  expect(job?.result.inputSnapshot.prompt).toBe(prompt);
});

it("refuses to accept or discard a retest job that has not succeeded", async () => {
  const retest = await seedReviewRetest(fixture);
  await fixture.sql`UPDATE opening_jobs SET state = 'failed' WHERE id = ${retest.id}`;
  expect(await (await retestList(request())).json()).toEqual([]);
  expect((await acceptRetest(request({ clientKey: randomUUID() }), params(retest.id))).status).toBe(404);
  expect((await discardRetest(request(decision(retest.id, "retest")), params(retest.id))).status).toBe(404);
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(0);
  const [job] = await fixture.sql`SELECT payload FROM opening_jobs WHERE id = ${retest.id}`;
  expect(job?.payload.accepted).toBe(false);
  expect(job?.payload.discarded).toBeUndefined();
});

function directTaskRequest(id: string, clientKey = randomUUID()) {
  return { title: "Retest task", minutes: 20, dueAt: null, priority: 1, candidateId: id, clientKey,
    inputSnapshot: { kind: "retest", candidateId: id, heuristic: true } };
}

it.each(["failed", "queued", "excluded", "foreign-course"] as const)("direct tasks route refuses a %s retest candidate", async (reason) => {
  const retest = await seedReviewRetest(fixture);
  if (reason === "excluded") await backupRows(fixture.sql, fixture.scope).exclude(retest.sourceId);
  else if (reason === "foreign-course") await fixture.sql`UPDATE courses SET workspace_id = ${fixture.otherScope.workspaceId} WHERE id = ${retest.courseId}`;
  else await fixture.sql`UPDATE opening_jobs SET state = ${reason} WHERE id = ${retest.id}`;
  expect((await createTask(request(directTaskRequest(retest.id)))).status).toBe(404);
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(0);
  const [job] = await fixture.sql`SELECT payload FROM opening_jobs WHERE id = ${retest.id}`;
  expect(job?.payload.accepted).toBe(false);
});

it.each(["failed", "excluded"] as const)("direct tasks route replays the original request but rechecks %s admission", async (reason) => {
  const retest = await seedReviewRetest(fixture), body = directTaskRequest(retest.id);
  const first = await createTask(request(body));
  expect(first.status).toBe(201);
  const task = await first.json();
  const replay = await createTask(request(body));
  expect(replay.status).toBe(201);
  expect(await replay.json()).toMatchObject({ id: task.id });
  if (reason === "excluded") await backupRows(fixture.sql, fixture.scope).exclude(retest.sourceId);
  else await fixture.sql`UPDATE opening_jobs SET state = 'failed' WHERE id = ${retest.id}`;
  expect((await createTask(request(body))).status).toBe(404);
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(1);
});
