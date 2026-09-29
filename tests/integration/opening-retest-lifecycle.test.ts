import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RetestActivity } from "@aistudy/contracts";
import { createOpeningPlansRepository, createOpeningRetestActivityRepository, createOpeningRetestRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
const now = "2026-09-29T12:00:00.000Z";

async function seedActivity(overrides: Partial<RetestActivity> = {}) {
  const courseId = randomUUID();
  const candidateId = randomUUID();
  const taskId = randomUUID();
  await fixture.sql`INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${fixture.scope.workspaceId}, 'Retest lifecycle', ${courseId})`;
  await fixture.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state, privacy_epoch)
    VALUES (${candidateId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${`retest:${candidateId}`}, 'retest', ${fixture.sql.json({ id: candidateId, kind: 'task', courseId, skillLabel: 'fractions', prompt: 'Try again', sourceIds: [], dueAt: '2026-09-29T10:00:00.000Z', accepted: false } as never)}, 'succeeded', 0)`;
  await fixture.sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, due_at, priority, status, version, candidate_id)
    VALUES (${taskId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, 'Retest', 20, NULL, 1, 'pending', 1, ${candidateId})`;
  const repo = createOpeningRetestActivityRepository(fixture.sql);
  return repo.createProposed(fixture.scope, {
    activityId: overrides.activityId ?? randomUUID(),
    cycleId: overrides.cycleId ?? candidateId,
    candidateId,
    taskId,
    courseId,
    skillLabel: 'fractions',
    requirementKey: null,
    proposedAt: '2026-09-29T09:00:00.000Z',
    notBeforeAt: overrides.times?.notBeforeAt ?? null,
    recommendedAt: overrides.times?.recommendedAt ?? '2026-09-29T10:00:00.000Z',
    scheduledStartAt: overrides.times?.scheduledStartAt ?? null,
    deadlineAt: overrides.times?.deadlineAt ?? null,
  });
}

beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_retest_activities, courses RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await fixture?.close(); });

describe("opening retest activity lifecycle (S4)", () => {
  it("does not list an accepted activity before its recommended time", async () => {
    const activity = await seedActivity({ times: { recommendedAt: "2026-09-30T10:00:00.000Z" } as RetestActivity["times"] });
    const repo = createOpeningRetestActivityRepository(fixture.sql);
    await repo.accept(fixture.scope, activity.activityId, activity.taskId!, "2026-09-29T09:30:00.000Z");
    expect(await repo.listDue(fixture.scope, activity.courseId, now)).toEqual([]);
  });

  it("completes a done task without an observation as unverified and suppresses reminders", async () => {
    const activity = await seedActivity();
    const repo = createOpeningRetestActivityRepository(fixture.sql);
    await repo.accept(fixture.scope, activity.activityId, activity.taskId!, "2026-09-29T09:30:00.000Z");
    const completed = await repo.completeForTask(fixture.scope, activity.taskId!, { type: "complete", at: now, result: "correct", hasObservation: false });
    expect(completed).toMatchObject({ status: "completed", result: "unverified" });
    expect(await repo.listDue(fixture.scope, activity.courseId, now)).toEqual([]);
  });

  it("returns only due activity identities while their linked task is pending", async () => {
    const activity = await seedActivity();
    const activities = createOpeningRetestActivityRepository(fixture.sql);
    const retests = createOpeningRetestRepository(fixture.sql);
    await activities.accept(fixture.scope, activity.activityId, activity.taskId!, "2026-09-29T09:30:00.000Z");

    expect(await retests.listDueEvidence(fixture.scope, activity.courseId, now)).toEqual([{
      courseId: activity.courseId,
      skillLabel: activity.skillLabel,
      requirementKey: activity.requirementKey,
    }]);

    await fixture.sql`UPDATE opening_tasks SET status='done' WHERE id=${activity.taskId}`;
    expect(await retests.listDueEvidence(fixture.scope, activity.courseId, now)).toEqual([]);
  });

  it("keeps snoozed activities out of due until the snooze instant and skips by cancelling", async () => {
    const activity = await seedActivity();
    const repo = createOpeningRetestActivityRepository(fixture.sql);
    await repo.accept(fixture.scope, activity.activityId, activity.taskId!, "2026-09-29T09:30:00.000Z");
    await repo.transition(fixture.scope, activity.activityId, { type: "snooze", until: "2026-09-30T10:00:00.000Z" });
    expect(await repo.listDue(fixture.scope, activity.courseId, now)).toEqual([]);
    const cancelled = await repo.transition(fixture.scope, activity.activityId, { type: "skip", at: now });
    expect(cancelled.status).toBe("cancelled");
  });

  it("completes the linked activity when the shared task entry is marked done", async () => {
    const activity = await seedActivity();
    const repo = createOpeningRetestActivityRepository(fixture.sql);
    await repo.accept(fixture.scope, activity.activityId, activity.taskId!, "2026-09-29T09:30:00.000Z");
    const plans = createOpeningPlansRepository(fixture.sql);

    const task = await plans.updateTaskStatus(fixture.scope, activity.taskId!, {
      status: "done",
      expectedVersion: 1,
      at: now,
    });

    expect(task.status).toBe("done");
    const [saved] = await fixture.sql`SELECT status, result FROM opening_retest_activities WHERE id=${activity.activityId}`;
    expect(saved).toEqual({ status: "completed", result: "unverified" });
  });

  it("rejects task decisions that contradict a terminal activity", async () => {
    const activity = await seedActivity();
    const repo = createOpeningRetestActivityRepository(fixture.sql);
    await repo.accept(fixture.scope, activity.activityId, activity.taskId!, "2026-09-29T09:30:00.000Z");
    await repo.completeForTask(fixture.scope, activity.taskId!, { type: "complete", at: now, hasObservation: false });
    const plans = createOpeningPlansRepository(fixture.sql);

    await expect(plans.updateTaskStatus(fixture.scope, activity.taskId!, {
      status: "skipped", expectedVersion: 2, at: now,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    await fixture.sql`UPDATE opening_tasks SET status='pending', version=3 WHERE id=${activity.taskId}`;
    await repo.transition(fixture.scope, activity.activityId, { type: "invalidate", at: now, reason: "evidence_changed" });
    await expect(plans.updateTaskStatus(fixture.scope, activity.taskId!, {
      status: "done", expectedVersion: 3, at: now,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps active business identity distinct for different skills", async () => {
    const first = await seedActivity();
    const activities = createOpeningRetestActivityRepository(fixture.sql);
    await expect(activities.createProposed(fixture.scope, {
      activityId: randomUUID(),
      cycleId: randomUUID(),
      courseId: first.courseId,
      skillLabel: "ratios",
      requirementKey: first.requirementKey,
      proposedAt: now,
      recommendedAt: now,
    })).resolves.toMatchObject({ status: "proposed", courseId: first.courseId, skillLabel: "ratios" });
  });
});
