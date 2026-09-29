import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { reminderListSchema } from "@aistudy/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOpeningJobRepository,
  createOpeningPlansRepository,
  createOpeningReminderRepository,
  createOpeningRetestActivityRepository,
  createOpeningRetestRepository,
  createWorkspacePreferencesRepository,
  readOpeningCourseEvidence,
  setCourseLearningPreferences,
} from "@aistudy/database";
import { createRetestCandidateHandler } from "../../apps/worker/src/jobs/retest-candidate";
import { createRemindHandler } from "../../apps/worker/src/jobs/remind";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });

const enabled = {
  assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true,
};
const dueAt = "2020-01-01T00:00:00.000Z";

describe("learning preference consumers", () => {
  it("suppresses queued retest publication after shutdown and does not replay it on re-enable", async () => {
    const preferences = createWorkspacePreferencesRepository(fixture.sql);
    await preferences.setLearningPreferences(fixture.scope, enabled);
    const f = await learningAttemptFixture(fixture);
    const retests = createOpeningRetestRepository(fixture.sql);
    const jobs = createOpeningJobRepository(fixture.sql);
    const queued = await jobs.createOnce(fixture.scope, {
      key: `queued-retest-${randomUUID()}`, kind: "retest", payload: { courseId: f.courseId }, privacyEpoch: 0,
    });
    const candidate = {
      id: randomUUID(), courseId: f.courseId, skillLabel: "fractions", requirementKey: null,
      sourceIds: [f.sourceId], prompt: "Try again", dueAt, accepted: false,
    };

    await preferences.setLearningPreferences(fixture.scope, { ...enabled, retestSuggestionsEnabled: false });
    expect(await retests.saveCandidates(fixture.scope, [candidate], 0, queued.id)).toEqual([]);
    expect(await fixture.sql`SELECT id FROM opening_jobs WHERE id=${candidate.id}`).toEqual([]);

    await preferences.setLearningPreferences(fixture.scope, enabled);
    expect(await retests.saveCandidates(fixture.scope, [candidate], 0, queued.id)).toEqual([]);
    expect(await fixture.sql`SELECT id FROM opening_jobs WHERE id=${candidate.id}`).toEqual([]);

    const fresh = await jobs.createOnce(fixture.scope, {
      key: `fresh-retest-${randomUUID()}`, kind: "retest", payload: { courseId: f.courseId }, privacyEpoch: 0,
    });
    expect(await retests.saveCandidates(fixture.scope, [candidate], 0, fresh.id)).toHaveLength(1);
  });

  it("keeps an accepted candidate but blocks new publication for an archived course", async () => {
    const preferences = createWorkspacePreferencesRepository(fixture.sql);
    await preferences.setLearningPreferences(fixture.scope, enabled);
    const f = await learningAttemptFixture(fixture);
    const retests = createOpeningRetestRepository(fixture.sql);
    const accepted = {
      id: randomUUID(), courseId: f.courseId, skillLabel: "fractions", requirementKey: null,
      sourceIds: [f.sourceId], prompt: "Accepted retest", dueAt, accepted: false,
    };
    expect(await retests.saveCandidates(fixture.scope, [accepted])).toHaveLength(1);
    await retests.accept(fixture.scope, accepted.id, `accept-${randomUUID()}`);
    await fixture.sql`UPDATE courses SET archived_at=now(),updated_at=now() WHERE id=${f.courseId}`;
    const later = { ...accepted, id: randomUUID(), skillLabel: "ratios" };

    expect(await retests.saveCandidates(fixture.scope, [later])).toEqual([]);
    const [row] = await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${accepted.id}`;
    expect(row?.payload).toMatchObject({ accepted: true });
  });

  it("suppresses linked automatic reminders while keeping a manual reminder sendable", async () => {
    const preferences = createWorkspacePreferencesRepository(fixture.sql);
    await preferences.setLearningPreferences(fixture.scope, enabled);
    const courseId = randomUUID();
    await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES
      (${courseId},${fixture.scope.workspaceId},'Reminder course',${courseId})`;
    const plans = createOpeningPlansRepository(fixture.sql);
    const activities = createOpeningRetestActivityRepository(fixture.sql);
    const reminders = createOpeningReminderRepository(fixture.sql);
    const automaticTask = await plans.createTask(fixture.scope, {
      title: "Automatic retest", minutes: 20, dueAt, priority: 1,
      candidateId: null, clientKey: `auto-${randomUUID()}`,
    });
    const manualTask = await plans.createTask(fixture.scope, {
      title: "Manual homework", minutes: 20, dueAt, priority: 1,
      candidateId: null, clientKey: `manual-${randomUUID()}`,
    });
    const proposed = await activities.createProposed(fixture.scope, {
      cycleId: randomUUID(), taskId: automaticTask.id, courseId, skillLabel: "fractions",
      proposedAt: dueAt, recommendedAt: dueAt,
    });
    const acceptedAt = new Date().toISOString();
    await activities.accept(fixture.scope, proposed.activityId, automaticTask.id, acceptedAt);
    await reminders.saveExternalConfig(fixture.scope, {
      enabled: true, recipientId: fixture.scope.ownerUserId, quietHours: null,
    });
    const now = new Date();
    const queued = await reminders.enqueue(fixture.scope, { clientKey: `remind-${randomUUID()}`, channel: "feishu" }, now);
    expect(queued.map((item) => item.taskId)).toEqual(expect.arrayContaining([automaticTask.id, manualTask.id]));
    const claimed = await reminders.claimDue(20);
    const automaticJob = claimed.find((row) => (row.payload as { taskId: string }).taskId === automaticTask.id)!;
    const manualJob = claimed.find((row) => (row.payload as { taskId: string }).taskId === manualTask.id)!;
    expect(automaticJob).toBeDefined();
    expect(manualJob).toBeDefined();

    await preferences.setLearningPreferences(fixture.scope, { ...enabled, automaticRemindersEnabled: false });
    expect(await reminders.isCurrent(String(automaticJob.id), now)).toBe(false);
    expect(await reminders.isCurrent(String(manualJob.id), now)).toBe(true);
    const visible = await reminders.list(fixture.scope, now);
    expect(visible.reminders.some((item) => item.taskId === automaticTask.id)).toBe(false);
    expect(visible.reminders.some((item) => item.taskId === manualTask.id)).toBe(true);
    const sent: string[] = [];
    const handler = createRemindHandler({
      record: (id, input) => reminders.recordAttempt(id, input),
      isCurrent: (id, at) => reminders.isCurrent(id, at),
      send: async (input) => { sent.push(input.text); return { receiptId: `receipt-${sent.length}` }; },
      now: () => now,
    });
    const run = (row: Record<string, unknown>) => handler({
      id: String(row.id), workspaceId: String(row.workspace_id), ownerUserId: String(row.owner_user_id),
      key: String(row.key), kind: "remind", payload: row.payload, result: row.result ?? null,
      state: String(row.state), privacyEpoch: Number(row.privacy_epoch),
    }, row.payload);
    await run(automaticJob);
    await run(manualJob);
    expect(sent).toEqual(["Manual homework"]);
    const stillAccepted = await activities.get(fixture.scope, proposed.activityId);
    expect(stillAccepted.status).toBe("accepted");

    await preferences.setLearningPreferences(fixture.scope, enabled);
    expect((await reminders.enqueue(fixture.scope, { clientKey: `reenable-${randomUUID()}`, channel: "feishu" }, now))
      .some((item) => item.taskId === automaticTask.id)).toBe(false);
  });
});

async function acceptedReminder(context = fixture) {
  await createWorkspacePreferencesRepository(context.sql).setLearningPreferences(context.scope, enabled);
  const f = await learningAttemptFixture(context);
  const plans = createOpeningPlansRepository(context.sql);
  const activities = createOpeningRetestActivityRepository(context.sql);
  const reminders = createOpeningReminderRepository(context.sql);
  const task = await plans.createTask(context.scope, {
    title: "Automatic reminder", minutes: 20, dueAt, priority: 1,
    candidateId: null, clientKey: randomUUID(),
  });
  const proposed = await activities.createProposed(context.scope, {
    cycleId: randomUUID(), taskId: task.id, courseId: f.courseId, skillLabel: "ratios",
    proposedAt: dueAt, recommendedAt: dueAt,
  });
  await activities.accept(context.scope, proposed.activityId, task.id, new Date().toISOString());
  await reminders.saveExternalConfig(context.scope, {
    enabled: true, recipientId: context.scope.ownerUserId, quietHours: null,
  });
  const queued = await reminders.enqueue(context.scope, { clientKey: randomUUID(), channel: "feishu" });
  const reminder = queued.find((item) => item.taskId === task.id)!;
  expect(reminder).toBeDefined();
  return { ...f, task, proposed, reminders, reminder };
}

async function changeAutomation(courseId: string, boundary: "account" | "course" | "archive", on: boolean) {
  if (boundary === "account") {
    await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, {
      ...enabled, retestSuggestionsEnabled: on, automaticRemindersEnabled: on,
    });
  } else if (boundary === "course") {
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, {
      retestSuggestionsEnabled: on, automaticRemindersEnabled: on,
    });
  } else {
    await fixture.sql`UPDATE courses SET archived_at=${on ? null : new Date()},updated_at=now() WHERE id=${courseId}`;
  }
}

function reminderJob(row: Record<string, unknown>) {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), ownerUserId: String(row.owner_user_id),
    key: String(row.key), kind: "remind", payload: row.payload, result: row.result ?? null,
    state: String(row.state), privacyEpoch: Number(row.privacy_epoch),
  };
}

it.each(["default entry", "course title", "same preferences"] as const)(
  "keeps queued candidates and reminders valid after changing %s",
  async (change) => {
    const f = await acceptedReminder();
    const jobs = createOpeningJobRepository(fixture.sql);
    const queued = await jobs.createOnce(fixture.scope, {
      key: randomUUID(), kind: "retest", payload: { courseId: f.courseId }, privacyEpoch: 0,
    });
    if (change === "default entry") {
      await createWorkspacePreferencesRepository(fixture.sql).setDefaultEntry(fixture.scope.workspaceId, "learn");
    } else if (change === "course title") {
      await fixture.sql`UPDATE courses SET title='Renamed course',updated_at=now() WHERE id=${f.courseId}`;
    } else {
      await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, enabled);
      await setCourseLearningPreferences(fixture.sql, fixture.scope, f.courseId, {
        assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true,
      });
    }
    const candidate = {
      id: randomUUID(), courseId: f.courseId, skillLabel: "fractions", requirementKey: null,
      sourceIds: [f.sourceId], prompt: "Try again", dueAt, accepted: false,
    };
    expect(await createOpeningRetestRepository(fixture.sql).saveCandidates(fixture.scope, [candidate], 0, queued.id)).toHaveLength(1);
    const claimed = await f.reminders.claimDue(100);
    expect(claimed.some((row) => row.id === f.reminder.id)).toBe(true);
    expect(await f.reminders.isCurrent(f.reminder.id)).toBe(true);
    expect((await f.reminders.list(fixture.scope)).reminders.some((item) => item.id === f.reminder.id)).toBe(true);
  },
);

it.each(["account", "course", "archive"] as const)(
  "does not publish a pre-restart job on its first worker run after %s reopens",
  async (boundary) => {
    await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, enabled);
    const f = await learningAttemptFixture(fixture);
    await f.submit(await f.start());
    const jobs = createOpeningJobRepository(fixture.sql);
    const retests = createOpeningRetestRepository(fixture.sql);
    const payload = { courseId: f.courseId, promptsBySkill: { fractions: "Try another fraction problem" } };
    const old = await jobs.createOnce(fixture.scope, { key: randomUUID(), kind: "retest", payload, privacyEpoch: 0 });
    await changeAutomation(f.courseId, boundary, false);
    await changeAutomation(f.courseId, boundary, true);
    const worker = createRetestCandidateHandler({
      readCourseEvidence: (scope, courseId) => readOpeningCourseEvidence(fixture.sql, scope, courseId),
      listDueRetests: (scope, courseId) => retests.listDueEvidence(scope, courseId),
      saveCandidates: (scope, candidates, epoch, jobId) => retests.saveCandidates(scope, candidates, epoch, jobId),
    });
    expect((await worker(old, payload)).candidates).toEqual([]);
    const fresh = await jobs.createOnce(fixture.scope, { key: randomUUID(), kind: "retest", payload, privacyEpoch: 0 });
    expect((await worker(fresh, payload)).candidates).toHaveLength(1);
  },
);

it.each(["account", "course", "archive"] as const)(
  "does not send queued automatic reminders when %s reopens before the first worker run",
  async (boundary) => {
    const f = await acceptedReminder();
    await changeAutomation(f.courseId, boundary, false);
    await changeAutomation(f.courseId, boundary, true);
    const claimed = await f.reminders.claimDue(100);
    const row = claimed.find((item) => item.id === f.reminder.id)!;
    const sent: string[] = [];
    const worker = createRemindHandler({
      isCurrent: (id, at) => f.reminders.isCurrent(id, at),
      record: (id, input) => f.reminders.recordAttempt(id, input),
      send: async (input) => { sent.push(input.text); return { receiptId: "unexpected" }; },
    });
    expect(await worker(reminderJob(row), row.payload)).toMatchObject({ suppressed: true });
    expect(sent).toEqual([]);
    expect((await f.reminders.enqueue(fixture.scope, { clientKey: randomUUID(), channel: "feishu" }))
      .some((item) => item.taskId === f.task.id)).toBe(false);
    expect((await createOpeningRetestActivityRepository(fixture.sql).get(fixture.scope, f.proposed.activityId)).status).toBe("accepted");
  },
);

it.each([
  ["account", "acknowledged"], ["course", "acknowledged"], ["archive", "acknowledged"],
  ["account", "unknown"], ["course", "unknown"], ["archive", "unknown"],
] as const)("keeps an external %s shutdown reminder's %s outcome visible after send", async (boundary, outcome) => {
  const f = await acceptedReminder();
  const claimed = await f.reminders.claimDue(100);
  const row = claimed.find((item) => item.id === f.reminder.id)!;
  const worker = createRemindHandler({
    isCurrent: (id, at) => f.reminders.isCurrent(id, at),
    record: (id, input) => f.reminders.recordAttempt(id, input),
    send: async () => {
      await changeAutomation(f.courseId, boundary, false);
      return outcome === "acknowledged" ? { receiptId: "delivered-before-shutdown" } : { error: "unknown" };
    },
  });
  expect(await worker(reminderJob(row), row.payload)).toMatchObject({ outcome });
  expect((await f.reminders.list(fixture.scope)).reminders.find((item) => item.id === f.reminder.id))
    .toMatchObject({ outcome, status: outcome === "acknowledged" ? "sent" : "sending" });
  const [stored] = await fixture.sql`SELECT state,payload FROM opening_jobs WHERE id=${f.reminder.id}`;
  expect(stored).toMatchObject({
    state: outcome === "acknowledged" ? "succeeded" : "outcome_unknown",
    payload: { outcome, suppressed: false },
  });
});


it("excludes external configuration rows from the reminder list contract", async () => {
  const f = await acceptedReminder();
  const result = await f.reminders.list(fixture.scope);
  expect(reminderListSchema.safeParse(result).success).toBe(true);
  expect(result.reminders.every((item) => item.taskId && item.channel)).toBe(true);
});

it("keeps microsecond ordering for queued candidates and accepted reminder activities", async () => {
  const f = await acceptedReminder();
  const jobs = createOpeningJobRepository(fixture.sql);
  const retests = createOpeningRetestRepository(fixture.sql);
  const job = await jobs.createOnce(fixture.scope, {
    key: randomUUID(), kind: "retest", payload: { courseId: f.courseId }, privacyEpoch: 0,
  });
  const candidate = { id: randomUUID(), courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId],
    prompt: "Try another fraction problem", dueAt, accepted: false };
  await fixture.sql`UPDATE opening_jobs SET created_at=(
    SELECT GREATEST(p.retest_suggestions_enabled_at,c.retest_suggestions_enabled_at)-interval '1 microsecond'
    FROM workspace_preferences p JOIN courses c ON c.workspace_id=p.workspace_id WHERE c.id=${f.courseId}
  ) WHERE id=${job.id}`;
  expect(await retests.saveCandidates(fixture.scope, [candidate], 0, job.id)).toEqual([]);

  await fixture.sql`UPDATE opening_retest_activities SET accepted_at=(
    SELECT GREATEST(p.automatic_reminders_enabled_at,c.automatic_reminders_enabled_at)-interval '1 microsecond'
    FROM workspace_preferences p JOIN courses c ON c.workspace_id=p.workspace_id WHERE c.id=${f.courseId}
  ) WHERE id=${f.proposed.activityId}`;
  await f.reminders.claimDue(100);
  expect(await f.reminders.isCurrent(f.reminder.id)).toBe(false);
  expect((await f.reminders.enqueue(fixture.scope, { clientKey: randomUUID(), channel: "feishu" }))
    .some((item) => item.taskId === f.task.id)).toBe(false);

  await fixture.sql`UPDATE opening_retest_activities SET accepted_at=(
    SELECT GREATEST(p.automatic_reminders_enabled_at,c.automatic_reminders_enabled_at)+interval '1 microsecond'
    FROM workspace_preferences p JOIN courses c ON c.workspace_id=p.workspace_id WHERE c.id=${f.courseId}
  ) WHERE id=${f.proposed.activityId}`;
  expect(await f.reminders.isCurrent(f.reminder.id)).toBe(true);
  await fixture.sql`UPDATE opening_jobs SET created_at=(
    SELECT GREATEST(p.automatic_reminders_enabled_at,c.automatic_reminders_enabled_at)-interval '1 microsecond'
    FROM workspace_preferences p JOIN courses c ON c.workspace_id=p.workspace_id WHERE c.id=${f.courseId}
  ) WHERE id=${f.reminder.id}`;
  expect(await f.reminders.isCurrent(f.reminder.id)).toBe(false);
});

it.each(["done", "skipped", "cancelled", "snoozed", "version"] as const)(
  "hides an unsent external reminder after its task or activity becomes %s",
  async (change) => {
    const f = await acceptedReminder();
    if (change === "done" || change === "skipped") {
      await createOpeningPlansRepository(fixture.sql).updateTaskStatus(fixture.scope, f.task.id, {
        status: change, expectedVersion: 1, at: new Date().toISOString(),
      });
    } else if (change === "version") {
      await fixture.sql`UPDATE opening_tasks SET version=version+1 WHERE id=${f.task.id}`;
    } else {
      await createOpeningRetestActivityRepository(fixture.sql).transition(fixture.scope, f.proposed.activityId,
        change === "cancelled" ? { type: "skip", at: new Date().toISOString() }
          : { type: "snooze", until: new Date(Date.now()+86_400_000).toISOString() });
    }
    expect((await f.reminders.list(fixture.scope)).reminders.some((item) => item.id === f.reminder.id)).toBe(false);
    const [stored] = await fixture.sql`SELECT state FROM opening_jobs WHERE id=${f.reminder.id}`;
    expect(stored?.state).toBe("queued");
  },
);

it("rechecks a reminder task completed after the initial enqueue read", async () => {
  const f = await acceptedReminder();
  await fixture.sql`DELETE FROM opening_jobs WHERE id=${f.reminder.id}`;
  let changed = false;
  const interleaved = new Proxy(fixture.sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return async (work: (tx: TransactionSql) => Promise<unknown>) => {
      if (!changed) {
        changed = true;
        await createOpeningPlansRepository(fixture.sql).updateTaskStatus(fixture.scope, f.task.id, {
          status: "done", expectedVersion: 1, at: new Date().toISOString(),
        });
      }
      return target.begin(work);
    };
  } }) as Sql;
  const result = await createOpeningReminderRepository(interleaved).enqueue(fixture.scope, {
    clientKey: randomUUID(), channel: "feishu",
  });
  expect(changed).toBe(true);
  expect(result.some((item) => item.taskId === f.task.id)).toBe(false);
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE kind='remind'
    AND workspace_id=${fixture.scope.workspaceId} AND payload->>'taskId'=${f.task.id}`).toEqual([]);
});

it.each(["completion", "enqueue"] as const)("serializes reminder enqueue and task completion with %s first", async (first) => {
  const context = await createOpeningFixture();
  const a = await openRaceSession().ready, b = await openRaceSession().ready;
  let release = () => undefined as void, entered = () => undefined as void;
  const opened = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const pending: Promise<unknown>[] = [];
  const gated = new Proxy(a.sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(async (tx) => {
      const result = await work(tx);
      entered();
      await held;
      return result;
    });
  } }) as Sql;
  try {
    const f = await acceptedReminder(context);
    await context.sql`DELETE FROM opening_jobs WHERE id=${f.reminder.id}`;
    const enqueue = (sql: Sql) => createOpeningReminderRepository(sql).enqueue(context.scope, { clientKey: randomUUID(), channel: "feishu" });
    const complete = (sql: Sql) => createOpeningPlansRepository(sql).updateTaskStatus(context.scope, f.task.id, {
      status: "done", expectedVersion: 1, at: new Date().toISOString(),
    });
    const winner = track(first === "completion" ? complete(gated) : enqueue(gated));
    pending.push(winner);
    await Promise.race([opened, winner.then(() => { throw new Error("commit barrier bypassed"); })]);
    const loser = track(first === "completion" ? enqueue(b.sql) : complete(b.sql));
    pending.push(loser);
    await waitUntilBlocked(context.sql, b.pid, a.pid, "reminder task mutation", /opening_retest_activities[\s\S]*FOR UPDATE/);
    release();
    await Promise.all(pending);
    expect((await f.reminders.list(context.scope)).reminders.some((item) => item.taskId === f.task.id)).toBe(false);
    expect(await context.sql`SELECT id FROM opening_jobs WHERE kind='remind' AND workspace_id=${context.scope.workspaceId}
      AND payload->>'taskId'=${f.task.id}`).toHaveLength(first === "enqueue" ? 1 : 0);
  } finally {
    release();
    await Promise.allSettled(pending);
    await closeRace(b.sql);
    await closeRace(a.sql);
    await context.close();
  }
}, 15_000);
