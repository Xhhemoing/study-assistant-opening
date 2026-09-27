import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningPlansRepository, createOpeningRetestRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

describe("opening retest → P02 task bridge", () => {
  let fixture: OpeningFixture;

  beforeAll(async () => {
    fixture = await createOpeningFixture();
  });

  beforeEach(async () => {
    await fixture.sql`TRUNCATE opening_jobs, opening_tasks, opening_plan_acceptances RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await fixture.close();
  });

  async function insertCandidate(kind: "task" | "memory") {
    const id = randomUUID();
    const sourceId = randomUUID();
    const payload = {
      kind,
      id,
      courseId: randomUUID(),
      skillLabel: "fractions",
      prompt: "Retest fractions from source stem",
      sourceIds: [sourceId],
      dueAt: "2026-09-14T10:00:00.000Z",
      accepted: false,
    };
    await fixture.sql`
      INSERT INTO opening_jobs (
        id, workspace_id, owner_user_id, key, kind, payload, state
      ) VALUES (
        ${id}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId},
        ${`retest:${id}`}, ${"retest"}, ${fixture.sql.json(payload as never)}, ${"succeeded"}
      )`;
    return { id, payload };
  }

  it("creates an opening task and consumes a kind=task candidate atomically", async () => {
    const candidate = await insertCandidate("task");
    const plans = createOpeningPlansRepository(fixture.sql);
    const task = await plans.createTask(fixture.scope, {
      title: candidate.payload.prompt,
      minutes: 20,
      dueAt: null,
      priority: 1,
      candidateId: candidate.id,
      clientKey: "retest-bridge-key-01",
      baseVersion: 0,
      inputSnapshot: {
        kind: "retest",
        candidateId: candidate.id,
        courseId: candidate.payload.courseId,
        skillLabel: "fractions",
        prompt: candidate.payload.prompt,
        sourceIds: candidate.payload.sourceIds,
        dueAt: candidate.payload.dueAt,
        heuristic: true,
      },
    });
    expect(task.title).toBe(candidate.payload.prompt);
    expect(task.dueAt).toBeNull();

    const jobs = await fixture.sql`SELECT payload FROM opening_jobs WHERE id = ${candidate.id}`;
    expect((jobs[0]?.payload as { accepted: boolean }).accepted).toBe(true);
    const replay = await plans.createTask(fixture.scope, {
      title: candidate.payload.prompt,
      minutes: 20,
      dueAt: null,
      priority: 1,
      candidateId: candidate.id,
      clientKey: "retest-bridge-key-01",
      baseVersion: 0,
      inputSnapshot: {
        kind: "retest",
        candidateId: candidate.id,
        courseId: candidate.payload.courseId,
        skillLabel: "fractions",
        prompt: candidate.payload.prompt,
        sourceIds: candidate.payload.sourceIds,
        dueAt: candidate.payload.dueAt,
        heuristic: true,
      },
    });
    expect(replay.id).toBe(task.id);
    const tasks = await fixture.sql`SELECT id FROM opening_tasks`;
    expect(tasks).toHaveLength(1);
  });

  it("does not consume a candidate whose payload.kind is not task", async () => {
    const candidate = await insertCandidate("memory");
    const plans = createOpeningPlansRepository(fixture.sql);
    await expect(
      plans.createTask(fixture.scope, {
        title: candidate.payload.prompt,
        minutes: 20,
        dueAt: null,
        priority: 1,
        candidateId: candidate.id,
        clientKey: "retest-bridge-key-02",
        baseVersion: 0,
        inputSnapshot: { kind: "retest", candidateId: candidate.id, heuristic: true },
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION|CONFLICT/) });
    const jobs = await fixture.sql`SELECT payload FROM opening_jobs WHERE id = ${candidate.id}`;
    expect((jobs[0]?.payload as { accepted: boolean }).accepted).toBe(false);
    expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(0);
  });

  it("conflicts when the same clientKey is reused with a different payload", async () => {
    const first = await insertCandidate("task");
    const second = await insertCandidate("task");
    const plans = createOpeningPlansRepository(fixture.sql);
    const snapshot = (id: string, courseId: string, sourceIds: string[], dueAt: string) => ({
      kind: "retest" as const,
      candidateId: id,
      courseId,
      skillLabel: "fractions",
      prompt: "Retest fractions from source stem",
      sourceIds,
      dueAt,
      heuristic: true as const,
    });
    await plans.createTask(fixture.scope, {
      title: first.payload.prompt,
      minutes: 20,
      dueAt: null,
      priority: 1,
      candidateId: first.id,
      clientKey: "retest-bridge-key-03",
      baseVersion: 0,
      inputSnapshot: snapshot(first.id, first.payload.courseId, first.payload.sourceIds, first.payload.dueAt),
    });
    await expect(
      plans.createTask(fixture.scope, {
        title: second.payload.prompt,
        minutes: 25,
        dueAt: null,
        priority: 1,
        candidateId: second.id,
        clientKey: "retest-bridge-key-03",
        baseVersion: 0,
        inputSnapshot: snapshot(second.id, second.payload.courseId, second.payload.sourceIds, second.payload.dueAt),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const still = await fixture.sql`SELECT payload FROM opening_jobs WHERE id = ${second.id}`;
    expect((still[0]?.payload as { accepted: boolean }).accepted).toBe(false);
  });

  it("keeps the retest repository from claiming calendar scheduling", async () => {
    const candidate = await insertCandidate("task");
    const retests = createOpeningRetestRepository(fixture.sql);
    const accepted = await retests.accept(fixture.scope, candidate.id, "retest-bridge-key-04");
    expect(accepted.accepted).toBe(true);
    expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(0);
  });
});
