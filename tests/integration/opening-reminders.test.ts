import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createOpeningPlansRepository,
  createOpeningReminderRepository,
  createOpeningRetestActivityRepository,
  createSqlClient,
} from "@aistudy/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for reminder repository tests");

const sql = createSqlClient(databaseUrl);
const owner = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const other = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const pastDue = "2020-01-01T00:00:00.000Z";
const later = new Date("2026-09-14T12:00:00.000Z");

async function seedUser(scope: { workspaceId: string; ownerUserId: string }, label: string) {
  await sql`
    INSERT INTO users (id, email, display_name, password_hash)
    VALUES (${scope.ownerUserId}, ${`${label}-${scope.ownerUserId}@example.com`}, ${label}, 'test')`;
  await sql`
    INSERT INTO workspaces (id, owner_user_id)
    VALUES (${scope.workspaceId}, ${scope.ownerUserId})`;
}

beforeAll(async () => {
  await applyMigrations(sql);
  await seedUser(owner, "reminder-owner");
  await seedUser(other, "reminder-other");
});

beforeEach(async () => {
  await sql`DELETE FROM opening_jobs WHERE owner_user_id IN (${owner.ownerUserId}, ${other.ownerUserId})`;
  await sql`DELETE FROM opening_tasks WHERE owner_user_id IN (${owner.ownerUserId}, ${other.ownerUserId})`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("opening reminder repository (P03)", () => {
  it("lists an unenqueued due task for its owner only", async () => {
    const plans = createOpeningPlansRepository(sql);
    const reminders = createOpeningReminderRepository(sql);
    const task = await plans.createTask(owner, {
      title: "物理作业",
      minutes: 25,
      dueAt: pastDue,
      priority: 1,
      candidateId: null,
      clientKey: "task-key-0001",
    });
    await plans.createTask(other, {
      title: "别人的作业",
      minutes: 25,
      dueAt: pastDue,
      priority: 1,
      candidateId: null,
      clientKey: "task-key-0002",
    });

    const listed = await reminders.list(owner, later);

    expect(listed.externalDelivery).toBe("disabled");
    expect(listed.reminders).toEqual([{
      id: task.id,
      taskId: task.id,
      channel: "in_app",
      status: "due",
      receiptId: null,
      taskVersion: 1,
      dueAt: pastDue,
      outcome: null,
    }]);
  });

  it("does not list or enqueue a linked retest after its task is done", async () => {
    const plans = createOpeningPlansRepository(sql);
    const activities = createOpeningRetestActivityRepository(sql);
    const reminders = createOpeningReminderRepository(sql);
    const courseId = randomUUID();
    await sql`INSERT INTO courses (id, workspace_id, title, slug)
      VALUES (${courseId}, ${owner.workspaceId}, 'Reminder retest', ${`reminder-retest-${courseId}`})`;
    try {
      const task = await plans.createTask(owner, {
        title: "已完成的补测",
        minutes: 25,
        dueAt: null,
        priority: 1,
        candidateId: null,
        clientKey: "task-key-retest-01",
      });
      const proposed = await activities.createProposed(owner, {
        cycleId: randomUUID(),
        candidateId: null,
        taskId: task.id,
        courseId,
        skillLabel: "fractions",
        requirementKey: null,
        proposedAt: pastDue,
        recommendedAt: pastDue,
      });
      await activities.accept(owner, proposed.activityId, task.id, pastDue);
      await sql`UPDATE opening_tasks SET status='done', version=version + 1 WHERE id=${task.id}`;

      expect((await reminders.list(owner, later)).reminders).toEqual([]);
      expect(await reminders.enqueue(owner, { clientKey: "remind-retest-01", channel: "in_app" }, later)).toEqual([]);
    } finally {
      await sql`DELETE FROM courses WHERE id=${courseId}`;
    }
  });

  it("dedupes enqueue and records quiet, unknown, and rate-limited attempts", async () => {
    const plans = createOpeningPlansRepository(sql);
    const reminders = createOpeningReminderRepository(sql);
    await plans.createTask(owner, {
      title: "物理作业",
      minutes: 25,
      dueAt: pastDue,
      priority: 1,
      candidateId: null,
      clientKey: "task-key-0001",
    });

    const first = await reminders.enqueue(owner, { clientKey: "remind-key-01", channel: "in_app" }, later);
    const second = await reminders.enqueue(owner, { clientKey: "remind-key-02", channel: "in_app" }, later);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);

    const claimed = await reminders.claimDue(10);
    expect(claimed.map((row) => row.id)).toContain(first[0]?.id);
    const quiet = await reminders.recordAttempt(String(first[0]?.id), {
      receiptId: null,
      outcome: "quiet",
      state: "queued",
    });
    expect(quiet).toBe(true);

    const again = await reminders.claimDue(10);
    const rerun = again.find((row) => row.id === first[0]?.id);
    expect(rerun).toBeTruthy();
    await reminders.recordAttempt(String(first[0]?.id), {
      receiptId: null,
      outcome: "unknown",
      state: "outcome_unknown",
    });
    const visible = await reminders.list(owner, later);
    expect(visible.reminders[0]).toMatchObject({ outcome: "unknown", status: "sending", receiptId: null });

    const stuck = await reminders.claimDue(10);
    expect(stuck.find((row) => row.id === first[0]?.id)).toBeUndefined();
  });
});
