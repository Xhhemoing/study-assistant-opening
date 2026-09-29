import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { taskCreateResultSchema, taskItemSchema } from "@aistudy/contracts";
import { POST } from "../../../apps/web/src/app/api/opening/tasks/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { acceptInput, taskCandidate } from "../opening-task-acceptance-fixture";
import { backupRows } from "../opening-backup-records-fixture";

let fixture: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    authCookieName: "aistudy_session", sessionCookieSecure: false, sessionTtlSeconds: 3600 });
  setAuthRuntimeForTests(runtime);
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_tasks, opening_conversations RESTART IDENTITY CASCADE`;
});
afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await fixture?.close();
});
function post(body: unknown, cookie = fixture.cookie) {
  return POST(new Request("http://localhost/api/opening/tasks", { method: "POST",
    headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
}

it("returns the same product after an HTTP response is lost and then reports another-key acceptance", async () => {
  const { id } = await taskCandidate(fixture), input = { ...acceptInput(id), expectedVersion: 0 };
  expect((await post(input)).status).toBe(201); // Deliberately discard the successful response body.
  const replay = await post(input);
  expect(replay.status).toBe(201);
  const body = taskCreateResultSchema.parse(await replay.json());
  expect(body.reviewResult).toEqual({ disposition: "replayed", resultRef: { kind: "task", id: body.id } });
  const repeat = await post(acceptInput(id));
  expect(repeat.status).toBe(201);
  expect(await repeat.json()).toMatchObject({ id: body.id, reviewResult: { disposition: "already_processed" } });
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_plan_drafts WHERE workspace_id = ${fixture.scope.workspaceId}`).toHaveLength(0);
});

it("maps same-key different intent to 409 without changing the task", async () => {
  const { id } = await taskCandidate(fixture), input = acceptInput(id);
  await post(input);
  const response = await post({ ...input, minutes: 40 });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "CONFLICT" } });
  expect(await fixture.sql`SELECT minutes FROM opening_tasks`).toEqual([{ minutes: 20 }]);
});

it("requires an authenticated owner even for a completed key", async () => {
  const { id } = await taskCandidate(fixture), input = acceptInput(id);
  await post(input);
  expect((await post(input, "")).status).toBe(401);
  const foreign = await taskCandidate({ ...fixture, scope: fixture.otherScope });
  expect((await post(acceptInput(foreign.id))).status).toBe(409);
});

it("checks current privacy before replay, even with an unchanged expectedVersion", async () => {
  const candidate = await taskCandidate(fixture, true), input = { ...acceptInput(candidate.id), expectedVersion: 0 };
  await post(input);
  await backupRows(fixture.sql, fixture.scope).exclude(candidate.sourceId!);
  expect((await post(input)).status).toBe(400);
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(1);
});

it("preserves legacy requests, 201 responses, and the strict flat TaskItem shape", async () => {
  const { id } = await taskCandidate(fixture);
  const input = { title: "legacy", minutes: 20, dueAt: null, priority: 1, candidateId: id };
  const first = await post(input);
  expect(first.status).toBe(201);
  const task = taskItemSchema.parse(await first.json());
  const second = await post(input);
  expect(taskItemSchema.parse(await second.json()).id).toBe(task.id);
});

it("rejects stale initial versions and wrong candidate kinds without creating a task", async () => {
  const { id } = await taskCandidate(fixture), input = acceptInput(id);
  expect((await post({ ...input, expectedVersion: 1 })).status).toBe(409);
  expect((await post({ ...input, candidateRef: { ...input.candidateRef, kind: "memory" } })).status).toBe(400);
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(0);
});
