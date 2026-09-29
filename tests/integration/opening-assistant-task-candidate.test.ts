import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningCandidateRepository, createOpeningPlansRepository, type OpeningScope } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { insertCandidate, insertOwnedConversation, insertTurn } from "./opening-memory-candidate-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_tasks, opening_conversations RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await fixture?.close(); });

async function pending(kind: "task" | "memory", scope: OpeningScope = fixture.scope) {
  const conversationId = await insertOwnedConversation(fixture.sql, scope);
  const sourceTurnId = await insertTurn(fixture.sql, scope, conversationId);
  return insertCandidate(fixture.sql, scope, {
    conversationId, sourceTurnId,
    payload: kind === "task"
      ? { kind, title: "练习", minutes: 20, dueText: null }
      : { kind, text: "偏好提示", temporary: false },
  });
}

function taskInput(candidateId: string) {
  return { title: "练习", minutes: 20, dueAt: null, priority: 1, candidateId };
}

async function expectUntouched(id: string) {
  expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(0);
  const [row] = await fixture.sql`SELECT status FROM opening_assistant_candidates WHERE id = ${id}`;
  expect(row?.status).toBe("pending");
}

describe("assistant task candidate admission", () => {
  it("accepts an owned task once and preserves atomic consumption", async () => {
    const id = await pending("task");
    const plans = createOpeningPlansRepository(fixture.sql);
    const task = await plans.createTask(fixture.scope, taskInput(id));
    expect(task.title).toBe("练习");
    const [row] = await fixture.sql`SELECT status FROM opening_assistant_candidates WHERE id = ${id}`;
    expect(row?.status).toBe("accepted");
    expect((await plans.createTask(fixture.scope, taskInput(id))).id).toBe(task.id);
    expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(1);
  });

  it("rejects a memory ID through the old task request shape", async () => {
    const id = await pending("memory");
    await expect(createOpeningPlansRepository(fixture.sql).createTask(fixture.scope, taskInput(id)))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expectUntouched(id);
  });

  it("rejects a foreign conversation owner even when workspaceId matches", async () => {
    const id = await pending("task");
    const forgedScope = { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId };
    await expect(createOpeningPlansRepository(fixture.sql).createTask(forgedScope, taskInput(id)))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expectUntouched(id);
  });

  it("does not allow a different workspace to consume an owned candidate", async () => {
    const id = await pending("task", fixture.otherScope);
    await expect(createOpeningPlansRepository(fixture.sql).createTask(fixture.scope, taskInput(id)))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expectUntouched(id);
  });

  it("does not consume an assistant candidate through the retest path", async () => {
    const id = await pending("task");
    await expect(createOpeningPlansRepository(fixture.sql).createTask(fixture.scope, {
      ...taskInput(id), clientKey: `wrong-origin-${randomUUID()}`,
      inputSnapshot: { kind: "retest", candidateId: id, heuristic: true },
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expectUntouched(id);
  });

  it("owner-scopes generic candidate decisions, not only the pending list", async () => {
    const id = await pending("task");
    const candidates = createOpeningCandidateRepository(fixture.sql);
    expect(await candidates.decide({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, id, "discarded")).toBeNull();
    await expectUntouched(id);
    expect(await candidates.decide(fixture.scope, id, "discarded")).toMatchObject({ id, status: "discarded" });
  });
});
