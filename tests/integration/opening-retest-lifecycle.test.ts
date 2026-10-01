import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RetestActivity } from "@aistudy/contracts";
import { createOpeningLearningRepository, createOpeningPlansRepository, createOpeningRetestActivityRepository, createOpeningRetestRepository, createWorkspacePreferencesRepository } from "@aistudy/database";
import { reopenRetestActivity } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

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

  it("keeps a completed activity terminal and attaches a later observation without reopening reminders (E04)", async () => {
    const activity = await seedActivity();
    const repo = createOpeningRetestActivityRepository(fixture.sql);
    const retests = createOpeningRetestRepository(fixture.sql);
    await repo.accept(fixture.scope, activity.activityId, activity.taskId!, "2026-09-29T09:30:00.000Z");
    // Done through the shared task entry with no observation: completed/unverified.
    await repo.completeForTask(fixture.scope, activity.taskId!, { type: "complete", at: now, hasObservation: false });

    // A late observation for the same course/skill referencing the activity
    // must attach evidence without resurrecting the terminal activity.
    const learning = createOpeningLearningRepository(fixture.sql);
    const session = await learning.createSession(fixture.scope, { courseId: activity.courseId, skillLabel: "fractions", sourceIds: [] });
    const observation = await learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId: activity.courseId, skillLabel: "fractions", sourceIds: [],
      retestId: activity.activityId, answer: "1", outcome: "incorrect", assistance: "independent", clientKey: randomUUID(),
    });
    const [after] = await fixture.sql`SELECT status, result, task_id FROM opening_retest_activities WHERE id=${activity.activityId}`;
    expect(after).toEqual({ status: "completed", result: "unverified", task_id: activity.taskId });
    expect(await fixture.sql`SELECT retest_id FROM opening_learning_observations WHERE id=${observation.id}`)
      .toMatchObject([{ retest_id: activity.activityId }]);

    // The completed terminal activity is not a due identity, so no reminder can be generated from it.
    expect(await retests.listDueEvidence(fixture.scope, activity.courseId, now)).toEqual([]);
    // And the activity stays terminal: a direct transition command is rejected.
    await expect(repo.transition(fixture.scope, activity.activityId, { type: "complete", at: now, result: "correct", hasObservation: true }))
      .rejects.toThrow();
  });

  it("reopens a completed activity as a new evidence cycle without resurrecting the old measurement (E04)", async () => {
    const activity = await seedActivity();
    const repo = createOpeningRetestActivityRepository(fixture.sql);
    await repo.accept(fixture.scope, activity.activityId, activity.taskId!, "2026-09-29T09:30:00.000Z");
    await repo.completeForTask(fixture.scope, activity.taskId!, { type: "complete", at: now, hasObservation: false });

    const reopened = reopenRetestActivity(
      await repo.get(fixture.scope, activity.activityId),
      {
        activityId: randomUUID(),
        cycleId: randomUUID(),
        proposedAt: "2026-09-30T09:00:00.000Z",
        recommendedAt: "2026-09-30T10:00:00.000Z",
      },
    );
    const created = await repo.createProposed(fixture.scope, {
      activityId: reopened.activityId,
      cycleId: reopened.cycleId,
      courseId: reopened.courseId,
      skillLabel: reopened.skillLabel,
      requirementKey: reopened.requirementKey,
      proposedAt: reopened.times.proposedAt,
      recommendedAt: reopened.times.recommendedAt,
      reopenedFromActivityId: reopened.reopenedFromActivityId,
    });
    // A reopened cycle must bind to its own task: one task belongs to one activity.
    const reopenTaskId = randomUUID();
    await fixture.sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, due_at, priority, status, version, candidate_id)
      VALUES (${reopenTaskId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, 'Reopened retest', 20, NULL, 1, 'pending', 1, NULL)`;
    const persisted = await repo.transition(fixture.scope, created.activityId, { type: "accept", taskId: reopenTaskId, at: now });
    // The reopen link is persisted with the new proposal; the old activity keeps its terminal state.
    expect(persisted).toMatchObject({ status: "accepted", taskId: reopenTaskId });
    const [link] = await fixture.sql`SELECT reopened_from_activity_id FROM opening_retest_activities WHERE id=${created.activityId}`;
    expect(String(link.reopened_from_activity_id)).toBe(activity.activityId);
    const [previous] = await fixture.sql`SELECT status FROM opening_retest_activities WHERE id=${activity.activityId}`;
    expect(previous.status).toBe("completed");
  });

  it("does not regenerate a declined proposal while a worker retry replays unchanged evidence (E03)", async () => {
    await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
    const f = await learningAttemptFixture(fixture);
    const retests = createOpeningRetestRepository(fixture.sql);
    const initial = await f.submit(await f.start());
    const identity = { courseId: initial.courseId, skillLabel: initial.skillLabel, requirementKey: initial.requirementKey ?? null };
    const candidateShape = (id: string) => ({
      id, courseId: identity.courseId, skillLabel: identity.skillLabel, requirementKey: identity.requirementKey,
      sourceIds: initial.sourceIds, prompt: "Try again", dueAt: now, accepted: false, kind: "task" as const,
      evidenceObservationIds: [initial.id], evidenceRootIds: [initial.rootObservationId ?? initial.id],
    });
    const first = candidateShape(randomUUID());
    const [proposed] = await retests.saveCandidates(fixture.scope, [first as never]);
    const repo = createOpeningRetestActivityRepository(fixture.sql);
    const [activityRef] = await fixture.sql`SELECT id FROM opening_retest_activities WHERE candidate_id=${proposed.id}`;
    const activity = await repo.get(fixture.scope, String(activityRef.id));
    // User declines the proposal.
    await repo.transition(fixture.scope, activity.activityId, { type: "decline", at: now });

    // A policy upgrade and worker retry regenerate the same evidence: no new cycle.
    const replay = { ...first, id: randomUUID() };
    const saved = await retests.saveCandidates(fixture.scope, [replay as never]);
    expect(saved).toEqual([]);
    expect(await fixture.sql`SELECT id FROM opening_retest_activities WHERE course_id=${f.courseId}
      AND skill_label='fractions'`).toHaveLength(1);
    const [row] = await fixture.sql`SELECT status FROM opening_retest_activities WHERE id=${activity.activityId}`;
    expect(row.status).toBe("declined");
    expect(await retests.listDueEvidence(fixture.scope, f.courseId, now)).toEqual([]);

    // A genuinely new evidence root does authorize a new cycle.
    const secondObservation = await f.submit(await f.start());
    const fresh = {
      ...first, id: randomUUID(),
      evidenceObservationIds: [secondObservation.id], evidenceRootIds: [secondObservation.rootObservationId ?? secondObservation.id],
    };
    const newCycle = await retests.saveCandidates(fixture.scope, [fresh as never]);
    expect(newCycle).toHaveLength(1);
    expect(await fixture.sql`SELECT id FROM opening_retest_activities WHERE course_id=${f.courseId}
      AND skill_label='fractions' AND status='proposed'`).toHaveLength(1);
  });
});
