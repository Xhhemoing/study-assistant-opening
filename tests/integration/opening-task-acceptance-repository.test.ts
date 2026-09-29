import type { TaskCreateInput } from "@aistudy/contracts";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { acceptInput, taskCandidate } from "./opening-task-acceptance-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_tasks, opening_conversations RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await fixture?.close(); });
const accept = (input: TaskCreateInput) => createOpeningPlansRepository(fixture.sql).createTask(fixture.scope, input);

it("replays a lost response with the same task and the original expected version", async () => {
  const { id } = await taskCandidate(fixture);
  const input = { ...acceptInput(id), expectedVersion: 0 };
  const first = await accept(input);
  expect(first).toMatchObject({ reviewResult: { disposition: "applied", resultRef: { kind: "task", id: first.id } } });
  const replay = await accept(input);
  expect(replay).toMatchObject({ id: first.id, reviewResult: { disposition: "replayed" } });
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(1);
});

it.each([
  { title: "改变标题" }, { minutes: 21 }, { priority: 2 }, { dueText: "下周" },
  { dueAt: "2026-10-01T00:00:00.000Z" }, { baseVersion: 1 }, { expectedVersion: 1 },
])("rejects changed business intent for the same key: %j", async (change) => {
  const { id } = await taskCandidate(fixture);
  const input = acceptInput(id);
  await accept(input);
  await expect(accept({ ...input, ...change })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(1);
});

it("rejects key reuse for another candidate without consuming that candidate", async () => {
  const first = await taskCandidate(fixture), second = await taskCandidate(fixture);
  const input = acceptInput(first.id);
  await accept(input);
  await expect(accept(acceptInput(second.id, input.clientKey))).rejects.toMatchObject({ code: "CONFLICT" });
  const [row] = await fixture.sql`SELECT status FROM opening_assistant_candidates WHERE id = ${second.id}`;
  expect(row?.status).toBe("pending");
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(1);
});

it("reports the existing product for another key, without creating or changing it", async () => {
  const { id } = await taskCandidate(fixture);
  const task = await accept(acceptInput(id));
  const result = await accept({ ...acceptInput(id), title: "不会覆盖" });
  expect(result).toMatchObject({ id: task.id, title: "练习", reviewResult: { disposition: "already_processed" } });
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(1);
});

it("keeps old clients' flat task response and resolves historical accepted tasks", async () => {
  const { id } = await taskCandidate(fixture);
  const { candidateRef: _ref, clientKey: _key, ...oldInput } = acceptInput(id);
  const first = await createOpeningPlansRepository(fixture.sql).createTask(fixture.scope, oldInput);
  expect(first).not.toHaveProperty("reviewResult");
  // Simulate a pre-migration accepted record, which has no saved command metadata.
  await fixture.sql`UPDATE opening_assistant_candidates
    SET task_accept_client_key = NULL, task_accept_intent = NULL, task_result_ref = NULL WHERE id = ${id}`;
  const replay = await accept(acceptInput(id));
  expect(replay).toMatchObject({ id: first.id, reviewResult: { disposition: "already_processed" } });
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(1);
});

it("does not resurrect a deleted result or return another owner's task", async () => {
  const { id } = await taskCandidate(fixture);
  const input = acceptInput(id);
  const task = await accept(input);
  await fixture.sql`UPDATE opening_tasks SET owner_user_id = ${fixture.otherScope.ownerUserId} WHERE id = ${task.id}`;
  await expect(accept(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await fixture.sql`DELETE FROM opening_tasks WHERE id = ${task.id}`;
  await expect(accept(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(0);
});

it("normalizes absent metadata and datetime spelling when comparing intent", async () => {
  const { id } = await taskCandidate(fixture);
  const input = { ...acceptInput(id), dueAt: "2026-10-01T00:00:00Z" };
  const first = await accept(input);
  const replay = await accept({ ...input, dueAt: "2026-10-01T00:00:00.000Z", dueText: null, expectedVersion: 0 });
  expect(replay.id).toBe(first.id);
});

it("leaves a candidate pending if creation fails in the same transaction", async () => {
  const { id } = await taskCandidate(fixture);
  await expect(accept({ ...acceptInput(id), minutes: -1 })).rejects.toMatchObject({ code: "23514" });
  const [row] = await fixture.sql`SELECT status FROM opening_assistant_candidates WHERE id = ${id}`;
  expect(row?.status).toBe("pending");
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(0);
});
